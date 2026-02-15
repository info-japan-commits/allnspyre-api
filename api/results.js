// /api/results.js
// POST /api/results
// body: { areaDetails: string[] } もしくは { areaDetail: string } も許容

const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID;
const AIRTABLE_TOKEN = process.env.AIRTABLE_TOKEN;

// ★ここが重要：テーブル“名”じゃなく“ID”で叩く（ズレない）
const AIRTABLE_TABLE_ID = process.env.AIRTABLE_TABLE_ID;

function sendJson(res, status, payload) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(payload, null, 2));
}

function airtableQuote(str) {
  // Airtableの式で使うために " をエスケープ
  return String(str).replace(/"/g, '\\"');
}

export default async function handler(req, res) {
  // CORS（results.html から呼ぶ想定）
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST,GET,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (req.method === "OPTIONS") return res.status(204).end();

  if (!AIRTABLE_BASE_ID || !AIRTABLE_TOKEN || !AIRTABLE_TABLE_ID) {
    return sendJson(res, 500, {
      ok: false,
      error: "Missing env vars",
      needed: ["AIRTABLE_BASE_ID", "AIRTABLE_TOKEN", "AIRTABLE_TABLE_ID"],
      got: {
        AIRTABLE_BASE_ID: Boolean(AIRTABLE_BASE_ID),
        AIRTABLE_TOKEN: Boolean(AIRTABLE_TOKEN),
        AIRTABLE_TABLE_ID: Boolean(AIRTABLE_TABLE_ID),
      },
    });
  }

  try {
    // GETでも動く（ブラウザ直叩きテスト用）
    // /api/results?areaDetails=Fushimi-Momoyama
    let areaDetails = [];

    if (req.method === "POST") {
      const body = req.body || {};
      if (Array.isArray(body.areaDetails)) areaDetails = body.areaDetails;
      else if (typeof body.areaDetail === "string") areaDetails = [body.areaDetail];
      else if (typeof body.areaDetails === "string") areaDetails = [body.areaDetails];
    } else if (req.method === "GET") {
      const raw = req.query?.areaDetails ?? req.query?.areaDetail;
      if (typeof raw === "string" && raw.trim()) areaDetails = [raw.trim()];
      if (Array.isArray(raw)) areaDetails = raw.map((s) => String(s).trim()).filter(Boolean);
    } else {
      return sendJson(res, 405, { ok: false, error: "Method not allowed" });
    }

    if (!Array.isArray(areaDetails) || areaDetails.length === 0) {
      return sendJson(res, 400, { ok: false, error: "No areaDetails provided" });
    }

    // Airtable filter:
    // AND( OR({area_detail}="Fushimi-Momoyama", ...), {status}="active")
    const conditions = areaDetails.map(
      (v) => `{area_detail}="${airtableQuote(v)}"`
    );

    const formula = `AND(OR(${conditions.join(",")}), {status}="active")`;

    const url =
      `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${encodeURIComponent(
        AIRTABLE_TABLE_ID
      )}` +
      `?filterByFormula=${encodeURIComponent(formula)}` +
      `&maxRecords=100`;

    const airtableRes = await fetch(url, {
      headers: {
        Authorization: `Bearer ${AIRTABLE_TOKEN}`,
      },
    });

    if (!airtableRes.ok) {
      const text = await airtableRes.text();
      return sendJson(res, 500, {
        ok: false,
        error: "Airtable request failed",
        status: airtableRes.status,
        details: text,
        debug: { url: url.slice(0, 180) + "...", formula, areaDetails },
      });
    }

    const data = await airtableRes.json();
    const records = Array.isArray(data.records) ? data.records : [];

    // 7件に絞る
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

    return sendJson(res, 200, {
      ok: true,
      count: shops.length,
      shops,
      debug: { usedFormula: formula, usedAreas: areaDetails },
    });
  } catch (err) {
    return sendJson(res, 500, {
      ok: false,
      error: "Server error",
      message: err?.message || String(err),
    });
  }
}
