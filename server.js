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
  console.error("❌ Failed to upload file to Supabase:", uploadError.message);
  return res.status(500).json({ error: "Failed to upload file to storage" });
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

app.post('/reanalyze-images', express.json(), async (req, res) => {
  const { documentId, userId } = req.body;
  if (!documentId) return res.status(400).json({ error: 'Missing documentId' });

  try {
    const job = await documentQueue.add("reanalyze-images", {
      documentId,
      userId: userId || 'manual-retry'
    });

    await supabase.from("jobs").insert({
      job_id: job.id,
      user_id: userId || 'manual-retry',
      document_id: documentId,
      status: "queued"
    });

    await supabase.from("documents")
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
app.post("/generate-demand-letter", express.json(), async (req, res) => {
  const { extractedData } = req.body;

  if (!extractedData || typeof extractedData !== "object") {
    return res.status(400).json({ error: "Missing extracted data" });
  }

  const { claimantInfo, accidentDetails, medicalProviders, medicalExpenses } =
    extractedData;

  const totalBillAmount =
    medicalExpenses?.reduce((sum, item) => sum + (item.amount || 0), 0) || 0;

  const replacements = {
    "«current_date_long»": new Date().toLocaleDateString("en-US", {
      month: "long",
      day: "numeric",
      year: "numeric",
    }),
    "«Plaintiff_full_name»": claimantInfo?.name || "",
    "«Defendant_Insurance_Co_insured»": accidentDetails?.insuredName || "",
    "«Clinic_company_sk»": medicalProviders?.[0] || "",
    "«Defendant_Insurance_Co_claim_number»": accidentDetails?.claimNumber || "",
    "«matter_number»": accidentDetails?.matterNumber || "",
    "«Defendant_Insurance_Co_company_sk»":
      accidentDetails?.insuranceCompany || "",
    _____: accidentDetails?.serviceDateRange || "",
    $0: `$${totalBillAmount.toFixed(2)}`,
  };

  try {
    const templatePath = path.join(
      __dirname,
      "assets",
      "2.0_letter_template.docx"
    );
    const templateBuffer = await fs.readFile(templatePath);

    const docBuffer = await createReport({
      template: templateBuffer,
      data: replacements,
    });

    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    );
    res.setHeader(
      "Content-Disposition",
      "attachment; filename=demand-letter.docx"
    );
    res.send(docBuffer);
  } catch (err) {
    console.error("❌ Failed to generate .docx:", err);
    res.status(500).json({ error: "Docx generation failed" });
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () =>
  console.log(`🚀 Express server running on port ${PORT}`)
);

// Start worker alongside the server
require('./worker');