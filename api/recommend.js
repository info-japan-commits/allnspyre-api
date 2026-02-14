// /api/recommend.js

export default async function handler(req, res) {
  try {
    const baseId = process.env.AIRTABLE_BASE_ID;
    const apiKey = process.env.AIRTABLE_API_KEY;

    // envチェック（ここで落ちると原因が即わかる）
    if (!baseId) {
      return res.status(500).json({
        success: false,
        error: "Missing env: AIRTABLE_BASE_ID",
        version: "2026-02-14-aaa",
      });
    }
    if (!apiKey) {
      return res.status(500).json({
        success: false,
        error: "Missing env: AIRTABLE_API_KEY",
        version: "2026-02-14-aaa",
      });
    }

    // ✅ 正しい指定：テーブル名 = Imported table / view=explorer_only
    // explorer_only は「テーブル名」ではなく「View名」
    const url = `https://api.airtable.com/v0/${baseId}/Imported%20table?view=explorer_only`;

    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
    });

    const data = await response.json();

    // Airtable側のエラー詳細をそのまま返す（原因特定用）
    if (!response.ok || !data.records) {
      return res.status(500).json({
        success: false,
        error: "Airtable API error",
        detail: data,
        version: "2026-02-14-aaa",
      });
    }

    return res.status(200).json({
      success: true,
      count: data.records.length,
      records: data.records,
      version: "2026-02-14-aaa",
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: error?.message || String(error),
      version: "2026-02-14-aaa",
    });
  }
}
