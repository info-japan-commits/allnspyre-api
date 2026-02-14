// /api/recommend.js

export default async function handler(req, res) {
  // Studio等から叩く前提でCORSを許可（必要最低限）
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type,Authorization");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") {
    return res.status(405).json({ success: false, error: "Method Not Allowed" });
  }

  try {
    const baseId = process.env.AIRTABLE_BASE_ID;
    const apiKey = process.env.AIRTABLE_API_KEY;

    const VERSION = "2026-02-14-final";

    // envチェック
    if (!baseId) {
      return res.status(500).json({
        success: false,
        error: "Missing env: AIRTABLE_BASE_ID",
        version: VERSION,
      });
    }
    if (!apiKey) {
      return res.status(500).json({
        success: false,
        error: "Missing env: AIRTABLE_API_KEY",
        version: VERSION,
      });
    }

    // --- ▼ ここが「最適解の肝」：URLパラメータで条件を受け取れる ---
    // 例）/api/recommend?area_group=Tokyo%20Urban&tier=explorer&time_slot=evening&limit=7
    const {
      area_group,
      area_detail,
      tier,
      time_slot,
      status,
      limit,
    } = req.query;

    const LIMIT = Math.min(parseInt(limit || "7", 10) || 7, 20); // 最大20に制限（安全）

    // Airtable: 今動いてるテーブル/エンドポイントをそのまま使う（ここは変えない）
    const tableName = "explorer_only";
    const viewName = "explorer_only";

    // filterByFormula を組み立て
    // ※ Airtableのフィールド名は画面に見えてる列名に合わせる（shop_id, area_group, tier, statusなど）
    const conditions = [];

    // 既定：activeだけ返す（運用で死なない最適解）
    // status を明示指定されたらそれを優先
    const statusValue = (status || "active").toString();
    conditions.push(`{status}='${escapeAirtableString(statusValue)}'`);

    if (area_group) conditions.push(`{area_group}='${escapeAirtableString(area_group)}'`);
    if (area_detail) conditions.push(`{area_detail}='${escapeAirtableString(area_detail)}'`);
    if (tier) conditions.push(`{tier}='${escapeAirtableString(tier)}'`);
    if (time_slot) conditions.push(`{time_slot}='${escapeAirtableString(time_slot)}'`);

    const filterByFormula =
      conditions.length === 1 ? conditions[0] : `AND(${conditions.join(",")})`;

    // まずは多めに取って（最大100）、サーバー側でランダムに7件選ぶ
    const url = new URL(`https://api.airtable.com/v0/${baseId}/${encodeURIComponent(tableName)}`);
    url.searchParams.set("view", viewName);
    url.searchParams.set("maxRecords", "100");
    url.searchParams.set("filterByFormula", filterByFormula);

    const response = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${apiKey}` },
    });

    const data = await response.json();

    // Airtableエラーはそのまま返す（原因が一発で出る）
    if (!response.ok || !data.records) {
      return res.status(500).json({
        success: false,
        error: "Airtable API error",
        detail: data,
        request: {
          tableName,
          viewName,
          filterByFormula,
        },
        version: VERSION,
      });
    }

    // ランダムに LIMIT 件だけ返す
    const picked = pickRandom(data.records, LIMIT);

    return res.status(200).json({
      success: true,
      count: picked.length,
      records: picked,
      debug: {
        totalMatched: data.records.length,
        filterByFormula,
      },
      version: VERSION,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: error?.message || String(error),
      version: "2026-02-14-final",
    });
  }
}

// Airtableの式に安全に入れるための最低限エスケープ
function escapeAirtableString(v) {
  return String(v).replace(/'/g, "\\'");
}

// 配列からランダムにN個（重複なし）
function pickRandom(arr, n) {
  const a = Array.isArray(arr) ? [...arr] : [];
  // Fisher–Yates
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a.slice(0, n);
}
