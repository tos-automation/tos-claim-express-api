// server.js
const express = require("express");
const multer = require("multer");
const fs = require("fs/promises");
const path = require("path");
const sharp = require("sharp");
const mammoth = require("mammoth");
const OpenAI = require("openai");
const axios = require("axios");
const { createClient } = require("@supabase/supabase-js");

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const app = express();
const upload = multer({ dest: "uploads/" });

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const PDFCO_API_KEY =
  process.env.PDFCO_API_KEY ||
  "mark.neil.u.cordero@gmail.com_aPtqQULO5OcnapLI3yTCKximITDXIEFNoFNSyev0blNUhMAsoS874RTu0fy9QmVz";

// Health check
app.get("/status", (req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

app.post("/analyze", upload.single("file"), async (req, res) => {
  const file = req.file;
  const fileType = path.extname(file.originalname).toLowerCase();
  const documentId = req.body.documentId;

  try {
    let combined;

    if (fileType === ".pdf") {
      // 🧠 Check cache first
      const existingImages = await checkIfImagesExist(documentId);

      let base64Images = [];

      if (existingImages) {
        console.log("⚡️ Using cached images from Supabase...");
        for (const img of existingImages) {
          const { data: download, error } = await supabase.storage
            .from("documents")
            .download(img.image_path);

          if (download) {
            const buffer = await download.arrayBuffer();
            base64Images.push(Buffer.from(buffer).toString("base64"));
          }
        }
      } else {
        // 🔁 Fallback to PDF.co
        const presignRes = await axios.get(
          `https://api.pdf.co/v1/file/upload/get-presigned-url?contenttype=application/octet-stream&name=${encodeURIComponent(
            path.basename(file.originalname)
          )}`,
          { headers: { "x-api-key": PDFCO_API_KEY } }
        );

        const uploadUrl = presignRes.data.presignedUrl;
        const uploadedUrl = presignRes.data.url;

        const fileStream = await fs.readFile(file.path);
        await axios.put(uploadUrl, fileStream, {
          headers: { "Content-Type": "application/octet-stream" },
        });

        const { data } = await axios.post(
          "https://api.pdf.co/v1/pdf/convert/to/png",
          {
            url: uploadedUrl,
            name: file.originalname,
            async: false,
            pages: "0-",
          },
          {
            headers: {
              "x-api-key": PDFCO_API_KEY,
              "Content-Type": "application/json",
            },
          }
        );

        if (!data?.urls?.length) {
          return res.status(500).json({ error: "PDF.co conversion failed." });
        }

        for (let i = 0; i < data.urls.length; i++) {
          const url = data.urls[i];
          const imgRes = await axios.get(url, { responseType: "arraybuffer" });
          const buffer = Buffer.from(imgRes.data);
          const filePath = `converted-images/${documentId}/page-${i + 1}.png`;

          // 💾 Upload to Supabase Storage
          await supabase.storage.from("documents").upload(filePath, buffer, {
            contentType: "image/png",
            upsert: true,
          });

          // 📝 Save record in `converted_images` table
          await supabase.from("converted_images").insert({
            document_id: documentId,
            image_path: filePath,
            page_number: i + 1,
          });

          base64Images.push(buffer.toString("base64"));
        }
      }

      // ✨ Analyze with GPT
      const results = [];
      for (const base64 of base64Images) {
        const gptResult = await analyzeImageWithGPT(base64);
        results.push(gptResult);
      }

      combined = aggregateExtractedData(results);
    }

    if (fileType === ".docx") {
      const result = await mammoth.extractRawText({ path: file.path });
      combined = await analyzeTextWithGPT(result.value);
    }

    if ([".jpg", ".jpeg", ".png"].includes(fileType)) {
      const imageBuffer = await fs.readFile(file.path);
      const pngBuffer = await sharp(imageBuffer).png().toBuffer();
      const base64 = pngBuffer.toString("base64");
      combined = await analyzeImageWithGPT(base64);
    }

    if (!combined) {
      return res.status(400).json({ error: "Unsupported file type" });
    }

    if (documentId) {
      await supabase
        .from("documents")
        .update({
          extracted_data: combined,
          analysis_status: "complete",
          analyzed_at: new Date().toISOString(),
        })
        .eq("id", documentId);
    }

    return res.json({ extracted: combined });
  } catch (err) {
    console.error("❌ Error in /analyze:", err.response?.data || err);
    res.status(500).json({ error: "Processing failed" });
  } finally {
    if (file) await fs.unlink(file.path);
  }
});

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

async function checkIfImagesExist(documentId) {
  const { data, error } = await supabase
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

const PORT = process.env.PORT || 3001;
app.listen(PORT, () =>
  console.log(`🚀 Express server running on port ${PORT}`)
);
