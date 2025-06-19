const express = require("express");
const multer = require("multer");
const fs = require("fs/promises");
const path = require("path");
const sharp = require("sharp");
const mammoth = require("mammoth");
const OpenAI = require("openai");

const app = express();
const upload = multer({ dest: "uploads/" });
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Health check route
app.get("/status", (req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

app.post("/analyze", upload.single("file"), async (req, res) => {
  try {
    const file = req.file;
    const fileType = path.extname(file.originalname).toLowerCase();
    let images = [];

    if (fileType === ".pdf") {
      const pdfToPngModule = await import('pdf-to-png-converter');
const images = await pdfToPngModule.default.fromPath(file.path, {
  outputType: "png",
  responseType: "base64",
});


      const results = [];
      for (const page of images) {
        const gptResult = await analyzeImageWithGPT(page.content);
        results.push(gptResult);
      }

      const combined = aggregateExtractedData(results);
      return res.json({ extracted: combined });
    } else if (fileType === ".docx") {
      const result = await mammoth.extractRawText({ path: file.path });
      const gptResponse = await analyzeTextWithGPT(result.value);
      return res.json({ extracted: gptResponse });
    } else if ([".jpg", ".jpeg", ".png"].includes(fileType)) {
      const imageBuffer = await fs.readFile(file.path);
      const pngBuffer = await sharp(imageBuffer).png().toBuffer();
      const base64 = pngBuffer.toString("base64");

      const gptResult = await analyzeImageWithGPT(base64);
      return res.json({ extracted: gptResult });
    } else {
      return res.status(400).json({ error: "Unsupported file type" });
    }
  } catch (err) {
    console.error("❌ Error in /analyze:", err);
    res.status(500).json({ error: "Processing failed" });
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
