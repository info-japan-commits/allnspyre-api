// /api/recommend.js

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

    const tableName = "Imported%20table";
    const viewName = "explorer_only";

    const url = `https://api.airtable.com/v0/${baseId}/${tableName}?view=${viewName}&filterByFormula=AND({status}='active',{tier}='explorer')`;

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
      });
    }

    // 🔥 ランダム7件抽出
    const shuffled = data.records.sort(() => 0.5 - Math.random());
    const selected = shuffled.slice(0, 7);

    // 🔥 フロントに渡すデータを軽量化
    const result = selected.map(record => ({
      id: record.id,
      shop_id: record.fields.shop_id,
      shop_name: record.fields.shop_name,
      area_group: record.fields.area_group,
      area_detail: record.fields.area_detail,
      best_vibe: record.fields.best_vibe,
    }));

    return res.status(200).json({
      success: true,
      count: result.length,
      shops: result,
    });

  } catch (error) {
    return res.status(500).json({
      success: false,
      error: error?.message || String(error),
    });
  }
}
