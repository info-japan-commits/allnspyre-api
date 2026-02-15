// /api/results.js
// POST /api/results
// body: { areaDetails: string[] }  ※ Airtableの area_detail と完全一致させる
// (テスト用) GET /api/results?areaDetails=Fushimi-Momoyama

const AIRTABLE_BASE = process.env.AIRTABLE_BASE_ID;
const AIRTABLE_TOKEN = process.env.AIRTABLE_TOKEN;

// あなたのAirtableで実際に存在する「テーブル名」に合わせる（今は explorer_only）
const TABLE_NAME = "explorer_only";

function json(res, status, payload) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(payload));
}

function escapeAirtableString(str) {
  // Airtable formula 文字列用に " をエスケープ
  return String(str).replace(/"/g, '\\"');
}

export default async function handler(req, res) {
  // CORS（Studioなど別ドメインから叩くなら必要）
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return json(res, 200, { ok: true });

  if (!AIRTABLE_BASE || !AIRTABLE_TOKEN) {
    return json(res, 500, {
      ok: false,
      error: "Missing env vars",
      needed: ["AIRTABLE_BASE_ID", "AIRTABLE_TOKEN"],
      got: {
        AIRTABLE_BASE_ID: Boolean(AIRTABLE_BASE),
        AIRTABLE_TOKEN: Boolean(AIRTABLE_TOKEN),
      },
    });
  }

  try {
    let areaDetails = [];

    // GETテスト対応: ?areaDetails=Fushimi-Momoyama,Kyoto%20City
    if (req.method === "GET") {
      const q = req.query?.areaDetails;
      if (q) {
        areaDetails = String(q)
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
      }
    } else if (req.method === "POST") {
      // Vercel Node runtime: JSON bodyはそのまま req.body に入る想定
      // （もし文字列で来る環境なら自前でJSON.parseが必要だが、今の運用では不要）
      areaDetails = req.body?.areaDetails || [];
    } else {
      return json(res, 405, { ok: false, error: "Method not allowed" });
    }

    if (!Array.isArray(areaDetails) || areaDetails.length === 0) {
      return json(res, 400, { ok: false, error: "No areaDetails provided" });
    }

    // Airtable formula:
    // AND( OR({area_detail}="Fushimi-Momoyama", ...), {status}="active" )
    const conditions = areaDetails.map(
      (v) => `{area_detail}="${escapeAirtableString(v)}"`
    );
    const formula = `AND(OR(${conditions.join(",")}), {status}="active")`;

    const url =
      `https://api.airtable.com/v0/${AIRTABLE_BASE}/${encodeURIComponent(
        TABLE_NAME
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
      return json(res, 500, {
        ok: false,
        error: "Airtable request failed",
        status: airtableRes.status,
        details: text,
        debug: { table: TABLE_NAME, formula, areaDetails },
      });
    }

    const data = await airtableRes.json();
    const records = Array.isArray(data.records) ? data.records : [];

    // 7件に絞る（必要ならランダム化も後で入れられる）
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
      debug: { table: TABLE_NAME, formula, areaDetails },
    });
  } catch (err) {
    return json(res, 500, {
      ok: false,
      error: "Server error",
      message: err?.message || String(err),
    });
  }
}
