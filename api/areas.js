// /api/areas.js
// Returns available "area_detail" options for a given prefecture (pref).
// Example: GET /api/areas?pref=Tokyo
//
// Requires env vars on Vercel:
// - AIRTABLE_TOKEN
// - AIRTABLE_BASE_ID
//
// Airtable table must include fields:
// - area_group (e.g., "Tokyo Urban", "Tokyo Suburban")
// - area_detail (e.g., "Shibuya", "Kichijoji / Mitaka / Musashisakai")
// - status (e.g., "active")

const AIRTABLE_TOKEN = process.env.AIRTABLE_TOKEN;
const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID;

// ★★★ ここが今回の本命修正：Airtableの実テーブル名に合わせる ★★★
const TABLE_NAME = "explorer_only";

// Utility: send JSON response
function json(res, status, data) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(data, null, 2));
}

// Utility: safe Airtable string quoting (escape " as \")
function airtableQuote(value) {
  return String(value ?? "").replace(/"/g, '\\"');
}

// Map prefecture -> keyword used to filter area_group
// (We match by FIND(pref, {area_group}) > 0, so "Tokyo" matches "Tokyo Urban" etc.)
function normalizePref(raw) {
  const v = String(raw ?? "").trim();
  if (!v) return "";

  // Accept both English/Japanese inputs if you ever send them
  const map = {
    Tokyo: "Tokyo",
    東京: "Tokyo",

    Kanagawa: "Kanagawa",
    神奈川: "Kanagawa",

    Osaka: "Osaka",
    大阪: "Osaka",

    Kyoto: "Kyoto",
    京都: "Kyoto",

    Hyogo: "Hyogo",
    兵庫: "Hyogo",

    Nara: "Nara",
    奈良: "Nara",

    Fukuoka: "Fukuoka",
    福岡: "Fukuoka",

    Ishikawa: "Ishikawa",
    石川: "Ishikawa",
  };

  return map[v] || v; // fallback: use as-is
}

module.exports = async (req, res) => {
  try {
    if (!AIRTABLE_TOKEN) {
      return json(res, 500, { ok: false, error: "Missing AIRTABLE_TOKEN" });
    }
    if (!AIRTABLE_BASE_ID) {
      return json(res, 500, { ok: false, error: "Missing AIRTABLE_BASE_ID" });
    }

    const prefRaw = req.query?.pref;
    const pref = normalizePref(prefRaw);

    if (!pref) {
      return json(res, 400, { ok: false, error: "Missing pref" });
    }

    // Only active records; match pref keyword inside area_group
    const prefQ = airtableQuote(pref);
    const formula = `AND(FIND("${prefQ}", {area_group})>0, {status}="active")`;

    const url =
      `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${encodeURIComponent(TABLE_NAME)}` +
      `?pageSize=100` +
      `&filterByFormula=${encodeURIComponent(formula)}` +
      `&fields%5B%5D=area_detail` +
      `&fields%5B%5D=area_group` +
      `&fields%5B%5D=status`;

    const r = await fetch(url, {
      headers: {
        Authorization: `Bearer ${AIRTABLE_TOKEN}`,
      },
    });

    const text = await r.text();

    if (!r.ok) {
      // Return a readable error with debug info
      return json(res, r.status, {
        ok: false,
        error: "Airtable request failed",
        status: r.status,
        details: text.slice(0, 500),
        debug: {
          table: TABLE_NAME,
          pref: prefRaw,
          prefNormalized: pref,
          formula,
          url: url.slice(0, 500),
        },
      });
    }

    const data = JSON.parse(text);
    const records = Array.isArray(data.records) ? data.records : [];

    // Unique + sort area_detail
    const set = new Set();
    for (const rec of records) {
      const v = rec?.fields?.area_detail;
      if (typeof v === "string" && v.trim()) set.add(v.trim());
    }
    const areaDetails = Array.from(set).sort((a, b) => a.localeCompare(b));

    return json(res, 200, {
      ok: true,
      pref: pref,
      count: areaDetails.length,
      areaDetails,
    });
  } catch (err) {
    return json(res, 500, {
      ok: false,
      error: "Server error",
      message: String(err?.message || err),
    });
  }
};
