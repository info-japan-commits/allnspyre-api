// /api/results.js
// POST /api/results
// body: { areaDetails: string[] }
// Airtable: table=shops_master, field=area_detail (Single select)

const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID;
const AIRTABLE_TOKEN = process.env.AIRTABLE_TOKEN;
const TABLE_NAME = "shops_master";

function json(res, status, payload) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST,GET,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.end(JSON.stringify(payload));
}

function airtableQuote(str) {
  // Airtableの式内で ' をエスケープ
  return String(str).replace(/'/g, "\\'");
}

export default async function handler(req, res) {
  if (req.method === "OPTIONS") return json(res, 200, { ok: true });

  if (!AIRTABLE_BASE_ID || !AIRTABLE_TOKEN) {
    return json(res, 500, {
      error: "Missing env vars",
      need: ["AIRTABLE_BASE_ID", "AIRTABLE_TOKEN"],
      got: {
        AIRTABLE_BASE_ID: Boolean(process.env.AIRTABLE_BASE_ID),
        AIRTABLE_TOKEN: Boolean(process.env.AIRTABLE_TOKEN),
      },
    });
  }

  try {
    let areaDetails = [];

    // ① POST（results.html から呼ぶ）
    if (req.method === "POST") {
      const body = req.body || {};
      areaDetails = Array.isArray(body.areaDetails) ? body.areaDetails : [];
    }
    // ② GET（ブラウザ直叩きでテストしやすい）
    else if (req.method === "GET") {
      const url = new URL(req.url, "http://dummy.local");
      const raw = url.searchParams.get("areaDetails") || "";
      areaDetails = raw
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    } else {
      return json(res, 405, { error: "Method not allowed" });
    }

    if (!Array.isArray(areaDetails) || areaDetails.length === 0) {
      return json(res, 400, { error: "No area selected" });
    }

    // Airtable filterByFormula: OR({area_detail}='Fushimi-Momoyama', {area_detail}='Kyoto City', ...)
    const conditions = areaDetails.map(
      (v) => `{area_detail}='${airtableQuote(v)}'`
    );
    const formula = `OR(${conditions.join(",")})`;

    const endpoint =
      `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${encodeURIComponent(
        TABLE_NAME
      )}` +
      `?filterByFormula=${encodeURIComponent(formula)}` +
      `&maxRecords=100`;

    const airtableRes = await fetch(endpoint, {
      headers: { Authorization: `Bearer ${AIRTABLE_TOKEN}` },
    });

    if (!airtableRes.ok) {
      const text = await airtableRes.text();
      return json(res, 500, {
        error: "Airtable request failed",
        status: airtableRes.status,
        details: text.slice(0, 500),
      });
    }

    const data = await airtableRes.json();
    const records = Array.isArray(data.records) ? data.records : [];

    // 最大7件に絞る（必要ならランダム化も可）
    const shops = records.slice(0, 7).map((r) => {
      const f = r.fields || {};
      return {
        shop_id: f.shop_id || "",
        shop_name: f.shop_name || "",
        area_group: f.area_group || "",
        area_detail: f.area_detail || "",
        genre: f.genre || "",
        short_desc: f.short_desc || "",
        photo_status: f.photo_status || "",
        source_note: f.source_note || "",
        status: f.status || "",
      };
    });

    return json(res, 200, {
      ok: true,
      count: shops.length,
      shops,
      debug: { usedFormula: formula, usedAreas: areaDetails },
    });
  } catch (err) {
    return json(res, 500, { error: "Server error", message: String(err) });
  }
}
