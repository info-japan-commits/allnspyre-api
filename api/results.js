// /api/results.js
// POST /api/results
// body: { areaDetails: string[] , plan?: string, who?: string, mood?: string, friction?: string }
// GET  /api/results?areaDetails=Fushimi-Momoyama,Kyoto%20City (test用)

const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID;
const AIRTABLE_TOKEN = process.env.AIRTABLE_TOKEN; // もしくは AIRTABLE_API_KEY を使っててもOK（下で吸収）
const AIRTABLE_API_KEY = process.env.AIRTABLE_API_KEY;

const TABLE_NAME = "shops_master";

function json(res, status, payload) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST,GET,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.end(JSON.stringify(payload));
}

// Airtableの式用：ダブルクオートをエスケープ
function quoteForAirtable(str) {
  return String(str).replace(/"/g, '\\"');
}

export default async function handler(req, res) {
  // preflight
  if (req.method === "OPTIONS") return json(res, 200, { ok: true });

  const token = AIRTABLE_TOKEN || AIRTABLE_API_KEY;

  if (!AIRTABLE_BASE_ID || !token) {
    return json(res, 500, {
      ok: false,
      error: "Missing env vars",
      need: ["AIRTABLE_BASE_ID", "AIRTABLE_TOKEN (or AIRTABLE_API_KEY)"],
      got: {
        AIRTABLE_BASE_ID: Boolean(AIRTABLE_BASE_ID),
        AIRTABLE_TOKEN: Boolean(AIRTABLE_TOKEN),
        AIRTABLE_API_KEY: Boolean(AIRTABLE_API_KEY),
      },
    });
  }

  try {
    let areaDetails = [];

    if (req.method === "GET") {
      const raw = req.query?.areaDetails || "";
      areaDetails = String(raw)
        .split(",")
        .map((s) => decodeURIComponent(s).trim())
        .filter(Boolean);
    } else if (req.method === "POST") {
      // VercelはJSONを自動でパースしてくれることが多いが、念のため吸収
      const body = req.body && typeof req.body === "object" ? req.body : {};
      areaDetails = Array.isArray(body.areaDetails) ? body.areaDetails : [];
      // 互換：昔の areaIds を送ってる場合でも受ける（ただし中身がslugなら一致しない）
      if (areaDetails.length === 0 && Array.isArray(body.areaIds)) {
        areaDetails = body.areaIds;
      }
    } else {
      return json(res, 405, { ok: false, error: "Method not allowed" });
    }

    areaDetails = areaDetails.map((s) => String(s).trim()).filter(Boolean);

    if (areaDetails.length === 0) {
      return json(res, 400, { ok: false, error: "No areaDetails provided" });
    }

    // ▼ ここが最重要：Airtableに存在する "area_detail" の文字列で検索する
    // OR({area_detail}="Fushimi-Momoyama",{area_detail}="Kyoto City")
    const conditions = areaDetails.map(
      (name) => `{area_detail}="${quoteForAirtable(name)}"`
    );

    // 任意：公開データだけ返したいなら status='active' を噛ませる
    // AND( OR(...), {status}="active" )
    const baseFormula = `OR(${conditions.join(",")})`;
    const formula = `AND(${baseFormula}, {status}="active")`;

    const url =
      `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${encodeURIComponent(
        TABLE_NAME
      )}` +
      `?filterByFormula=${encodeURIComponent(formula)}` +
      `&maxRecords=100`;

    const airtableRes = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (!airtableRes.ok) {
      const text = await airtableRes.text();
      return json(res, 500, {
        ok: false,
        error: "Airtable request failed",
        status: airtableRes.status,
        details: text,
        debug: { formula, areaDetails },
      });
    }

    const data = await airtableRes.json();
    const records = Array.isArray(data.records) ? data.records : [];

    // 7件に絞る（必要ならrecommend.jsのロジックに差し替え）
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
    return json(res, 500, {
      ok: false,
      error: "Server error",
      message: err?.message || String(err),
    });
  }
}
