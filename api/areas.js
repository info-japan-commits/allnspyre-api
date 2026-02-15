// /api/areas.js
// GET /api/areas?pref=Tokyo
// Returns unique area_detail values for the given prefecture keyword.

const AIRTABLE_TOKEN = process.env.AIRTABLE_TOKEN;
const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID;

// ★最優先：テーブルID（tbl〜）で叩く。無ければ名前にフォールバック
const AIRTABLE_TABLE_ID = process.env.AIRTABLE_TABLE_ID; // e.g. "tblRTY6o0o0GqrXXW"
const TABLE_FALLBACK_NAME = "explorer_only";

function json(res, status, data) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(data, null, 2));
}

function airtableQuote(value) {
  return String(value ?? "").replace(/"/g, '\\"');
}

function normalizePref(raw) {
  const v = String(raw ?? "").trim();
  if (!v) return "";
  const map = {
    Tokyo: "Tokyo", 東京: "Tokyo",
    Kanagawa: "Kanagawa", 神奈川: "Kanagawa",
    Osaka: "Osaka", 大阪: "Osaka",
    Kyoto: "Kyoto", 京都: "Kyoto",
    Hyogo: "Hyogo", 兵庫: "Hyogo",
    Nara: "Nara", 奈良: "Nara",
    Fukuoka: "Fukuoka", 福岡: "Fukuoka",
    Ishikawa: "Ishikawa", 石川: "Ishikawa",
  };
  return map[v] || v;
}

module.exports = async (req, res) => {
  try {
    if (!AIRTABLE_TOKEN) return json(res, 500, { ok: false, error: "Missing AIRTABLE_TOKEN" });
    if (!AIRTABLE_BASE_ID) return json(res, 500, { ok: false, error: "Missing AIRTABLE_BASE_ID" });

    const prefRaw = req.query?.pref;
    const pref = normalizePref(prefRaw);
    if (!pref) return json(res, 400, { ok: false, error: "Missing pref" });

    const tableRef = AIRTABLE_TABLE_ID || TABLE_FALLBACK_NAME;

    const prefQ = airtableQuote(pref);
    const formula = `AND(FIND("${prefQ}", {area_group})>0, {status}="active")`;

    const url =
      `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${encodeURIComponent(tableRef)}` +
      `?pageSize=100` +
      `&filterByFormula=${encodeURIComponent(formula)}` +
      `&fields%5B%5D=area_detail` +
      `&fields%5B%5D=area_group` +
      `&fields%5B%5D=status`;

    const r = await fetch(url, { headers: { Authorization: `Bearer ${AIRTABLE_TOKEN}` } });
    const text = await r.text();

    if (!r.ok) {
      return json(res, r.status, {
        ok: false,
        error: "Airtable request failed",
        status: r.status,
        details: text.slice(0, 500),
        debug: {
          tableRef,
          prefRaw,
          prefNormalized: pref,
          formula,
        },
      });
    }

    const data = JSON.parse(text);
    const records = Array.isArray(data.records) ? data.records : [];

    const set = new Set();
    for (const rec of records) {
      const v = rec?.fields?.area_detail;
      if (typeof v === "string" && v.trim()) set.add(v.trim());
    }

    const areaDetails = Array.from(set).sort((a, b) => a.localeCompare(b));

    return json(res, 200, { ok: true, pref, count: areaDetails.length, areaDetails });
  } catch (err) {
    return json(res, 500, { ok: false, error: "Server error", message: String(err?.message || err) });
  }
};
