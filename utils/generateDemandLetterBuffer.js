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

  if (!name && structuredData.patient?.name) {
    replacements.Plaintiff_full_name = structuredData.patient.name;
  }
  if (!insuredName && structuredData.insured?.name) {
    replacements.Defendant_Insurance_Co_insured = structuredData.insured.name;
  }
  if (!provider && structuredData.header?.provider) {
    replacements.Clinic_company_sk = structuredData.header.provider;
  }
  if (!claimNumber && structuredData.insured?.policy) {
    replacements.Defendant_Insurance_Co_claim_number = structuredData.insured.policy;
  }
  if (!insuranceCompany && structuredData.insurance_carrier?.name) {
    replacements.Defendant_Insurance_Co_company_sk = structuredData.insurance_carrier.name;
  }
  if (!dos && structuredData.header?.date) {
    replacements.service_date_range = structuredData.header.date;
  }
  if (!billAmount && structuredData.financial_summary?.total_charges) {
    replacements.bill_amount = `$${parseFloat(structuredData.financial_summary.total_charges).toFixed(2)}`;
  }

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

  const wrappedHtml = `
  <!DOCTYPE html>
  <html>
    <head>
      <meta charset="UTF-8">
      <style>
        body {
          font-family: 'Times New Roman', serif;
          font-size: 12pt;
          line-height: 1.5;
          margin: 1in;
        }
        h1, h2, h3 {
          margin-bottom: 0.5em;
        }
        p {
          margin: 0.5em 0;
        }
      </style>
    </head>
    <body>
      ${html}
    </body>
  </html>
`;

return wrappedHtml;

}

module.exports = generateDemandLetterBuffer;
