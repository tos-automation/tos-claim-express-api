// utils/generateDemandLetterBuffer.js
const fs = require("fs/promises");
const path = require("path");
const { createReport } = require("docx-templates");

const pipClinics = [
  "quantum chiropractic", "total injury", "good health medical",
  "naples family health", "advanced wellness", "a1 medical",
  "441 chiropractic", "pompano beach healing", "brofsky accident",
  "renewed health", "grassam family", "spine & extremity",
  "flex medical", "med plus", "bentin", "tropical chiropractic",
  "mohammad t. javed", "florida orthopedic", "shree mri", "revive chiropractic",
  "tamarac chiropractic", "sunlight chiropractic", "dr. craig selinger",
  "margate medical", "napoli chiropractic", "behnam meyers", "glenn v. quintana",
  "advanced orthopedics", "amos", "gady abramson", "back to mind", "premier wellness"
];

function isPipClinicMatch(providerName = "") {
  const name = providerName.toLowerCase();
  return pipClinics.some(clinic => name.includes(clinic));
}

async function generateDemandLetterBuffer(structuredData = {}) {
  const {
    "Claimant Name": name,
    "Insured Name": insuredName,
    "Provider": provider,
    "Claim Number": claimNumber,
    "Insurance Company": insuranceCompany,
    "Dates of Service": dos,
    "Bill Amount": billAmount,
  } = structuredData;

  const replacements = {
    "«current_date_long»": new Date().toLocaleDateString("en-US", {
      month: "long",
      day: "numeric",
      year: "numeric",
    }),
    "«Plaintiff_full_name»": name || "",
    "«Defendant_Insurance_Co_insured»": insuredName || "",
    "«Clinic_company_sk»": provider || "",
    "«Defendant_Insurance_Co_claim_number»": claimNumber || "",
    "«matter_number»": `AUTO-GEN-${Date.now()}`,
    "«Defendant_Insurance_Co_company_sk»": insuranceCompany || "",
    "«service_date_range»": Array.isArray(dos) ? dos.join(" - ") : dos || "",
    "$0": `$${(parseFloat(String(billAmount)) || 0).toFixed(2)}`,
  };

  const useTemplate2 = isPipClinicMatch(provider);
  const templatePath = path.join(
    __dirname,
    "..",
    "assets",
    useTemplate2 ? "2.0_letter_template.docx" : "1.0_LETTER_TEMPLATE.docx"
  );

  const templateBuffer = await fs.readFile(templatePath);

  const docBuffer = await createReport({
    template: templateBuffer,
    data: replacements,
  });

  return docBuffer;
}

module.exports = generateDemandLetterBuffer;
