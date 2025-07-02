// server.js
const express = require("express");
const multer = require("multer");
const fs = require("fs/promises");
const path = require("path");
const sharp = require("sharp");
const mammoth = require("mammoth");
const OpenAI = require("openai");
const axios = require("axios");
axios.defaults.timeout = 30000;
const { createClient } = require("@supabase/supabase-js");
const { createReport } = require("docx-templates");
const cors = require("cors");

// ✅ then use middleware

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const app = express();
app.use(cors());
const upload = multer({ dest: "uploads/" });

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const PDFCO_API_KEY =
  process.env.PDFCO_API_KEY ||
  "mark.neil.u.cordero@gmail.com_aPtqQULO5OcnapLI3yTCKximITDXIEFNoFNSyev0blNUhMAsoS874RTu0fy9QmVz";

const { Job } = require("bullmq");
const { documentQueue } = require("./jobQueue");

app.get("/job-status/:id", async (req, res) => {
  const job = await Job.fromId(documentQueue, req.params.id);
  if (!job) return res.status(404).json({ error: "Job not found" });

  const state = await job.getState(); // 'completed', 'waiting', 'failed', etc.
  const result = job.returnvalue;
  const failedReason = job.failedReason;

  res.json({ state, result, failedReason });
});

// Health check
app.get("/status", (req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

app.post("/analyze", upload.single("file"), async (req, res) => {
  const file = req.file;
  const documentId = req.body.documentId;
  if (!file) return res.status(400).json({ error: "No file uploaded." });

  try {
    const supabasePath = `${documentId}/${file.originalname}`;

    const fileBuffer = await fs.readFile(file.path);

    const { error: uploadError } = await supabase.storage
      .from("documents")
      .upload(supabasePath, fileBuffer, {
        contentType: file.mimetype,
        upsert: true,
      });

    if (uploadError) {
      console.error(
        "❌ Failed to upload file to Supabase:",
        uploadError.message
      );
      return res
        .status(500)
        .json({ error: "Failed to upload file to storage" });
    }

    // ✅ Update the document's file_path field
    await supabase
      .from("documents")
      .update({ file_path: supabasePath })
      .eq("id", documentId);

    // ✅ Then enqueue job with Supabase path
    const job = await documentQueue.add("analyze-document", {
      userId: req.body.userId || "unknown",
      filePath: supabasePath, // 🔄 Now sending Supabase path
      fileName: file.originalname,
      fileType: path.extname(file.originalname).toLowerCase(),
      documentId,
    });

    await supabase.from("jobs").insert({
      job_id: job.id,
      user_id: req.body.userId,
      document_id: documentId,
      status: "queued",
    });

    if (documentId) {
      await supabase
        .from("documents")
        .update({
          analysis_status: "queued",
        })
        .eq("id", documentId);
    }

    res.json({ message: "File enqueued for processing", jobId: job.id });
  } catch (err) {
    console.error("❌ Failed to enqueue job:", err);
    res.status(500).json({ error: "Failed to enqueue job" });
  }
});

app.post("/reanalyze-images", express.json(), async (req, res) => {
  const { documentId, userId } = req.body;
  if (!documentId) return res.status(400).json({ error: "Missing documentId" });

  try {
    const job = await documentQueue.add("reanalyze-images", {
      documentId,
      userId: userId || "manual-retry",
    });

    await supabase.from("jobs").insert({
      job_id: job.id,
      user_id: userId || "manual-retry",
      document_id: documentId,
      status: "queued",
    });

    await supabase
      .from("documents")
      .update({ analysis_status: "queued" })
      .eq("id", documentId);

    res.json({ message: "Reanalysis enqueued", jobId: job.id });
  } catch (err) {
    console.error("❌ Failed to enqueue retry job:", err);
    res.status(500).json({ error: "Retry failed" });
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

const pipClinics = [
  "quantum chiropractic",
  "total injury",
  "good health medical",
  "naples family health",
  "advanced wellness",
  "a1 medical",
  "441 chiropractic",
  "pompano beach healing",
  "brofsky accident",
  "renewed health",
  "grassam family",
  "spine & extremity",
  "flex medical",
  "med plus",
  "bentin",
  "tropical chiropractic",
  "mohammad t. javed",
  "florida orthopedic",
  "shree mri",
  "revive chiropractic",
  "tamarac chiropractic",
  "sunlight chiropractic",
  "dr. craig selinger",
  "margate medical",
  "napoli chiropractic",
  "behnam meyers",
  "glenn v. quintana",
  "advanced orthopedics",
  "amos",
  "gady abramson",
  "back to mind",
  "premier wellness",
];

function isPipClinicMatch(providerName) {
  const name = providerName?.toLowerCase() || "";
  return pipClinics.some((clinic) => name.includes(clinic));
}

const generateDemandLetterBuffer = require("./utils/generateDemandLetterBuffer");

app.post("/generate-demand-letter", express.json(), async (req, res) => {
  const { documentId, extractedData, mode } = req.body;

  let structured = extractedData;

  if (!structured && !documentId) {
    return res
      .status(400)
      .json({ error: "Missing documentId or extractedData" });
  }

  try {
    if (!structured && documentId) {
      const { data: pages, error: pageError } = await supabase
        .from("extracted_pages")
        .select("content")
        .eq("document_id", documentId);

      if (pageError || !pages || pages.length === 0) {
        return res
          .status(404)
          .json({ error: "No extracted data found for document" });
      }

      // Merge extracted data from all pages
      const merged = {};
      for (const page of pages) {
        let content = page.content || {};
        if (content.raw_text) {
          try {
            const match = content.raw_text.match(
              /```json\s*([\s\S]+?)\s*```|({[\s\S]+})/
            );
            const jsonStr = match?.[1] || match?.[0];
            if (jsonStr) content = JSON.parse(jsonStr.trim());
          } catch (err) {
            console.warn(
              "❌ Failed to parse raw_text from extracted_pages:",
              err
            );
          }
        }

        for (const key in content) {
          const val = content[key];
          if (Array.isArray(val)) {
            merged[key] = [...new Set([...(merged[key] || []), ...val])];
          } else {
            merged[key] = merged[key] || val;
          }
        }
      }

      structured = merged;

      // Optional: cache the result back into documents.extracted_data
      await supabase
        .from("documents")
        .update({ extracted_data: structured })
        .eq("id", documentId);
    }

    if (mode === "html") {
      // ✅ Return HTML for preview
      const html = await generateDemandLetterBuffer(structured, {
        asHtml: true,
      }); // You'll need to support this in your template function
      return res.json({ html });
    }

    // Default: return .docx
    const docBuffer = await generateDemandLetterBuffer(structured);

    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    );
    res.setHeader(
      "Content-Disposition",
      `attachment; filename=demand-letter-${Date.now()}.docx`
    );
    res.send(docBuffer);
  } catch (err) {
    console.error("❌ Failed to generate demand letter:", err);
    res.status(500).json({ error: "Demand letter generation failed" });
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () =>
  console.log(`🚀 Express server running on port ${PORT}`)
);

// Start worker alongside the server
require("./worker");
