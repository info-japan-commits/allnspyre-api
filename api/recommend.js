export default async function handler(req, res) {
  try {
    const baseId = process.env.AIRTABLE_BASE_ID;
    const apiKey = process.env.AIRTABLE_API_KEY;

    const response = await fetch(
      `https://api.airtable.com/v0/${baseId}/explorer_only`,
      {
        headers: {
          Authorization: `Bearer ${apiKey}`,
        },
      }
    );

    const data = await response.json();

    res.status(200).json({
      success: true,
      count: data.records.length,
      records: data.records.slice(0, 5),
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
}
