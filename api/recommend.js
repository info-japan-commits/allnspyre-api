export default async function handler(req, res) {
  try {
    const baseId = process.env.AIRTABLE_BASE_ID;
    const apiKey = process.env.AIRTABLE_API_KEY;

    if (!baseId || !apiKey) {
      return res.status(500).json({
        success: false,
        error: "Missing Airtable environment variables",
      });
    }

    const response = await fetch(
      `https://api.airtable.com/v0/${baseId}/tblRTY6o0oGqrXXW?view=explorer_only`,
      {
        headers: {
          Authorization: `Bearer ${apiKey}`,
        },
      }
    );

    if (!response.ok) {
      const text = await response.text();
      return res.status(500).json({
        success: false,
        error: "Airtable API error",
        detail: text,
      });
    }

    const data = await response.json();

    if (!data.records) {
      return res.status(500).json({
        success: false,
        error: "No records found in Airtable response",
        raw: data,
      });
    }

    return res.status(200).json({
      success: true,
      count: data.records.length,
      records: data.records.slice(0, 7), // 7枠
    });

  } catch (error) {
    return res.status(500).json({
      success: false,
      error: error.message,
    });
  }
}
