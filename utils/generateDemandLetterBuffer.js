const fs = require("fs/promises");
const path = require("path");

const pipClinics = [/* your clinic list */];

function isPipClinicMatch(providerName = "") {
  const name = providerName.toLowerCase();
  return pipClinics.some((clinic) => name.includes(clinic));
}

async function generateDemandLetterBuffer(structuredData = {}, options = {}) {
  if (structuredData.raw_text) {
    try {
      const match = structuredData.raw_text.match(/```json\s*([\s\S]+?)\s*```|({[\s\S]+})/);
      const jsonStr = match?.[1] || match?.[0];
      if (jsonStr) {
        structuredData = JSON.parse(jsonStr.trim());
      }
    } catch (err) {
      console.warn("⚠️ Failed to parse raw_text in generateDemandLetterBuffer:", err);
    }
  }

  const {
    "Claimant Name": name,
    "Insured Name": insuredName,
    Provider: provider,
    "Claim Number": claimNumber,
    "Insurance Company": insuranceCompany,
    "Dates of Service": dos,
    "Bill Amount": billAmount,
  } = structuredData;

  const replacements = {
    current_date_long: new Date().toLocaleDateString("en-US", {
      month: "long",
      day: "numeric",
      year: "numeric",
    }),
    Plaintiff_full_name: name || "N/A",
    Defendant_Insurance_Co_insured: insuredName || "N/A",
    Clinic_company_sk: provider || "N/A",
    Defendant_Insurance_Co_claim_number: claimNumber || "N/A",
    matter_number: `AUTO-GEN-${Date.now()}`,
    Defendant_Insurance_Co_company_sk: insuranceCompany || "N/A",
    service_date_range: Array.isArray(dos) ? dos.join(" - ") : dos || "N/A",
    bill_amount: `$${(parseFloat(String(billAmount)) || 0).toFixed(2)}`,
  };

  const useTemplate2 = isPipClinicMatch(provider);

  if (!options.asHtml) {
    throw new Error("DOCX generation is currently disabled. Use options.asHtml = true for preview.");
  }

  const htmlTemplatePath = path.join(
    __dirname,
    "..",
    "assets",
    useTemplate2 ? "2.0_letter_template.html" : "1.0_LETTER_TEMPLATE.html"
  );
  let html = await fs.readFile(htmlTemplatePath, "utf8");

  for (const [key, value] of Object.entries(replacements)) {
    const regex = new RegExp(`{{\\s*${key}\\s*}}`, "g");
    html = html.replace(regex, value);
  }

  return html;
}

module.exports = generateDemandLetterBuffer;
