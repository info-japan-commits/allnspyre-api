// /api/areas.js
// GET /api/areas?pref=Kyoto
// Airtableの shops_master から「pref（都道府県）に紐づく area_detail の候補」を抽出して返す

const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID || "";
const AIRTABLE_TOKEN = process.env.AIRTABLE_TOKEN || "";
const TABLE_NAME = "shops_master";

function json(res, status, payload) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.end(JSON.stringify(payload));
}

function airtableQuote(str) {
  return String(str).replace(/'/g, "\\'");
}

export default async function handler(req, res) {
  if (req.method === "OPTIONS") return json(res, 200, { ok: true });

  if (req.method !== "GET") {
    return json(res, 405, { ok: false, error: "Method not allowed" });
  }

  if (!AIRTABLE_BASE_ID || !AIRTABLE_TOKEN) {
    return json(res, 500, {
      ok: false,
      error: "Missing Airtable env",
      needed: ["AIRTABLE_BASE_ID", "AIRTABLE_TOKEN"],
      got: {
        AIRTABLE_BASE_ID: Boolean(AIRTABLE_BASE_ID),
        AIRTABLE_TOKEN: Boolean(AIRTABLE_TOKEN),
      },
    });
  }

  const prefRaw = (req.query.pref || "").toString().trim();
  if (!prefRaw) return json(res, 400, { ok: false, error: "Missing pref" });

  // area_group に pref を含むものを拾う（例: "Kyoto Suburban", "Tokyo Urban" など）
  // status=active のみ対象
  const pref = airtableQuote(prefRaw);
  const formula = `AND(FIND('${pref}', {area_group})>0, {status}='active')`;

  const url =
    `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${encodeURIComponent(TABLE_NAME)}` +
    `?pageSize=100&filterByFormula=${encodeURIComponent(formula)}` +
    `&fields%5B%5D=area_detail&fields%5B%5D=area_group`;

  try {
    const r = await fetch(url, {
      headers: { Authorization: `Bearer ${AIRTABLE_TOKEN}` },
    });

    const text = await r.text();
    if (!r.ok) {
      return json(res, r.status, {
        ok: false,
        error: "Airtable request failed",
        status: r.status,
        details: text.slice(0, 300),
        debug: { formula, pref: prefRaw },
      });
    }

    const data = JSON.parse(text);
    const records = Array.isArray(data.records) ? data.records : [];

    // area_detail をユニークに
    const set = new Set();
    for (const rec of records) {
      const v = rec?.fields?.area_detail;
      if (typeof v === "string" && v.trim()) set.add(v.trim());
    }

    const areaDetails = Array.from(set).sort((a, b) => a.localeCompare(b));

    return json(res, 200, {
      ok: true,
      pref: prefRaw,
      count: areaDetails.length,
      areaDetails,
    });
  } catch (err) {
    return json(res, 500, { ok: false, error: "Server error", message: String(err?.message || err) });
  }
}
