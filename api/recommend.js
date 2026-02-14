export default async function handler(req, res) {
  try {
    const baseId = process.env.AIRTABLE_BASE_ID;
    const apiKey = process.env.AIRTABLE_API_KEY;

    const response = await fetch(
      `https://api.airtable.com/v0/${baseId}/explorer_only?view=explorer_only`,
      {
        headers: {
          Authorization: `Bearer ${apiKey}`,
        },
      }
    );

    const data = await response.json();

    if (!data.records) {
      return res.status(500).json({
        success: false,
        error: "Airtable API error",
        detail: data,
      });
    }

    res.status(200).json({
      success: true,
      count: data.records.length,
      records: data.records,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
}
