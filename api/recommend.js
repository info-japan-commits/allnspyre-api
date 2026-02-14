// /api/recommend.js

export default async function handler(req, res) {
  try {
    const baseId = process.env.AIRTABLE_BASE_ID;
    const apiKey = process.env.AIRTABLE_API_KEY;

    if (!baseId) {
      return res.status(500).json({
        success: false,
        error: "Missing env: AIRTABLE_BASE_ID",
        version: "2026-02-14-final",
      });
    }

    if (!apiKey) {
      return res.status(500).json({
        success: false,
        error: "Missing env: AIRTABLE_API_KEY",
        version: "2026-02-14-final",
      });
    }

    const tableName = "Imported%20table";
    const viewName = "explorer_only";

    const url = `https://api.airtable.com/v0/${baseId}/${tableName}?view=${viewName}&filterByFormula={status}='active'`;

    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
    });

    const data = await response.json();

    if (!response.ok || !data.records) {
      return res.status(500).json({
        success: false,
        error: "Airtable API error",
        detail: data,
        request: { tableName, viewName },
        version: "2026-02-14-final",
      });
    }

    return res.status(200).json({
      success: true,
      count: data.records.length,
      records: data.records,
      version: "2026-02-14-final",
    });

  } catch (error) {
    return res.status(500).json({
      success: false,
      error: error?.message || String(error),
      version: "2026-02-14-final",
    });
  }
}
