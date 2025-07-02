const { Worker } = require("bullmq");
const IORedis = require("ioredis");
const fs = require("fs/promises");
const path = require("path");
const sharp = require("sharp");
const mammoth = require("mammoth");
const OpenAI = require("openai");
const axios = require("axios");
const { createClient } = require("@supabase/supabase-js");

const connection = new IORedis(process.env.REDIS_URL, {
  maxRetriesPerRequest: null,
});

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
axios.defaults.timeout = 30000;

// ✅ MAIN WORKER
const worker = new Worker(
  "document-processing",
  async (job) => {
    if (job.name === "reanalyze-images") {
      return await handleReanalyzeImages(job.data, job.id);
    } else {
      return await handleNewUpload({ ...job.data, job });
    }
  },
  { connection, concurrency: 1 }
);

// ✅ HANDLE NEW UPLOAD
async function handleNewUpload({ filePath, fileType, documentId, job }) {
  let combined;

  try {
    if (fileType === ".pdf") {
      let base64Images = [];
      const existingImages = await checkIfImagesExist(documentId);

      if (existingImages) {
        for (const img of existingImages) {
          const { data: download } = await supabase.storage
            .from("documents")
            .download(img.image_path);
          if (download) {
            const buffer = await download.arrayBuffer();
            base64Images.push(Buffer.from(buffer).toString("base64"));
          }
        }
      } else {
        const presignRes = await axios.get(
          `https://api.pdf.co/v1/file/upload/get-presigned-url?contenttype=application/octet-stream&name=${encodeURIComponent(
            path.basename(filePath)
          )}`,
          { headers: { "x-api-key": process.env.PDFCO_API_KEY } }
        );

        const uploadUrl = presignRes.data.presignedUrl;
        const uploadedUrl = presignRes.data.url;
        // 🛡️ Sanity check: must NOT start with `/`, and must match actual Supabase key
        const sanitizedPath = filePath; // Remove leading slashes
        console.log(
          "📦 Attempting download from Supabase path:",
          sanitizedPath
        );

        const { data: download, error } = await supabase.storage
          .from("documents")
          .download(sanitizedPath);

        if (error || !download) {
          throw new Error(
            `❌ Failed to download file from Supabase at path "${sanitizedPath}": ${
              error?.message || "No file returned"
            }`
          );
        }

        console.log("✅ File downloaded successfully from Supabase.");

        const fileStream = Buffer.from(await download.arrayBuffer());

        await axios.put(uploadUrl, fileStream, {
          headers: { "Content-Type": "application/octet-stream" },
        });

        const conversionRes = await axios.post(
          "https://api.pdf.co/v1/pdf/convert/to/png",
          {
            url: uploadedUrl,
            name: path.basename(filePath),
            async: false,
            pages: "0-",
          },
          {
            headers: {
              "x-api-key": process.env.PDFCO_API_KEY,
              "Content-Type": "application/json",
            },
          }
        );

        for (let i = 0; i < conversionRes.data.urls.length; i++) {
          const url = conversionRes.data.urls[i];
          const imgRes = await axios.get(url, {
            responseType: "arraybuffer",
          });
          const buffer = Buffer.from(imgRes.data);
          const filePathRemote = `converted-images/${documentId}/page-${
            i + 1
          }.png`;

          await supabase.storage
            .from("documents")
            .upload(filePathRemote, buffer, {
              contentType: "image/png",
              upsert: true,
            });

          await supabase.from("converted_images").insert({
            document_id: documentId,
            image_path: filePathRemote,
            page_number: i + 1,
          });

          base64Images.push(buffer.toString("base64"));
        }
      }

      const results = [];
      for (let i = 0; i < base64Images.length; i++) {
        const gptResultRaw = await analyzeImageWithGPT(base64Images[i]);

        let parsed;
        try {
          parsed =
            typeof gptResultRaw === "string"
              ? JSON.parse(gptResultRaw)
              : gptResultRaw;
        } catch {
          parsed = { raw_text: gptResultRaw };
        }

        await supabase.from("extracted_pages").insert({
          document_id: documentId,
          page_number: i + 1,
          content: parsed,
        });

        results.push(parsed);
      }

      combined = aggregateExtractedData(results);
    }

    if (fileType === ".docx") {
      const { data: download, error } = await supabase.storage
        .from("documents")
        .download(filePath);

      if (error || !download) {
        throw new Error(
          `❌ Failed to download DOCX from Supabase: ${error?.message}`
        );
      }

      const buffer = Buffer.from(await download.arrayBuffer());
      const result = await mammoth.extractRawText({ buffer });

      combined = await analyzeTextWithGPT(result.value);
    }

    if ([".jpg", ".jpeg", ".png"].includes(fileType)) {
      const { data: download, error } = await supabase.storage
        .from("documents")
        .download(filePath);

      if (error || !download) {
        throw new Error(
          `❌ Failed to download image from Supabase: ${error?.message}`
        );
      }

      const imageBuffer = Buffer.from(await download.arrayBuffer());

      const pngBuffer = await sharp(imageBuffer).png().toBuffer();
      const base64 = pngBuffer.toString("base64");
      combined = await analyzeImageWithGPT(base64);
    }

    await updateDocumentStatus(documentId, job.id, "complete", combined);
    return combined;
  } catch (err) {
    console.error("❌ Job failed:", err);
    await markJobFailed(job.id, err.message);
    throw err;
  } finally {
    try {
      if (filePath && filePath.startsWith("/tmp")) await fs.unlink(filePath);
    } catch (e) {
      console.warn(`⚠️ Could not delete temp file: ${filePath}`);
    }
  }
}

// ✅ HANDLE RETRY FROM IMAGES
async function handleReanalyzeImages(data, jobId) {
  const { documentId } = data;
  const existingImages = await checkIfImagesExist(documentId);
  if (!existingImages || existingImages.length === 0)
    throw new Error("No converted images found.");

  const results = [];
  for (const img of existingImages) {
    const { data: download } = await supabase.storage
      .from("documents")
      .download(img.image_path);
    const buffer = await download.arrayBuffer();
    const base64 = Buffer.from(buffer).toString("base64");
    const result = await analyzeImageWithGPT(base64);

    // Insert or upsert page result
    await supabase.from("extracted_pages").insert({
      document_id: documentId,
      page_number: img.page_number,
      content: result,
    });

    results.push(result);
  }

  const combined = aggregateExtractedData(results);
  await updateDocumentStatus(documentId, jobId, "complete", combined);
  return combined;
}

// ✅ HELPERS

async function updateDocumentStatus(documentId, jobId, status, data) {
  await supabase
    .from("documents")
    .update({
      extracted_data: data,
      analysis_status: status,
      analyzed_at: new Date().toISOString(),
    })
    .eq("id", documentId);

  await supabase
    .from("jobs")
    .update({
      status,
      completed_at: new Date().toISOString(),
    })
    .eq("job_id", jobId);
}

async function markJobFailed(jobId, message) {
  await supabase
    .from("jobs")
    .update({
      status: "failed",
      error_message: message,
    })
    .eq("job_id", jobId);
}

async function analyzeTextWithGPT(text) {
  const result = await openai.chat.completions.create({
    model: "gpt-4o",
    messages: [
      {
        role: "user",
        content: `Extract structured legal data from the following text:\n\n${text}\n\nReturn the result in JSON format.`,
      },
    ],
  });

  const content = result.choices[0].message.content;
  try {
    return JSON.parse(content);
  } catch {
    return { raw_text: content };
  }
}

async function analyzeImageWithGPT(base64Image) {
  const result = await openai.chat.completions.create({
    model: "gpt-4o",
    messages: [
      {
        role: "user",
        content: [
          {
            type: "image_url",
            image_url: { url: `data:image/png;base64,${base64Image}` },
          },
          {
            type: "text",
            text: `Extract structured legal data such as:
- Claimant Name
- Insured Name
- Provider
- Dates of Service
- Claim Number
- Bill Amount
- Injuries
- Treatments
- Insurance Company

Return the data in JSON format only.`,
          },
        ],
      },
    ],
  });

  const content = result.choices[0].message.content;
  try {
    return JSON.parse(content);
  } catch {
    return { raw_text: content };
  }
}

async function checkIfImagesExist(documentId) {
  const { data } = await supabase
    .from("converted_images")
    .select("*")
    .eq("document_id", documentId);
  return data && data.length > 0 ? data : null;
}

function aggregateExtractedData(results) {
  const merged = {};
  for (const result of results) {
    for (const key in result) {
      if (!merged[key]) {
        merged[key] = result[key];
      } else if (Array.isArray(result[key])) {
        merged[key] = [...new Set([...(merged[key] || []), ...result[key]])];
      }
    }
  }
  return merged;
}
