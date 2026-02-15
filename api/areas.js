// api/areas.js
// Returns area_detail list for a given prefecture (pref)
// Uses Airtable table ID if provided (AIRTABLE_TABLE_ID) to avoid name mismatch.

function json(res, status, data) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(data));
}

function normalizePref(raw) {
  if (!raw) return "";
  let s = String(raw).trim();

  // hearing側の不具合でURLがくっつくケースを切り捨て
  // 例: "Tokyohttps://allnspyre-api.vercel.app/api/areas?pref=Tokyo"
  const httpIdx = s.indexOf("http");
  if (httpIdx > 0) s = s.slice(0, httpIdx);

  // 余計な記号/改行を除去
  s = s.replace(/\s+/g, " ").trim();

  // 許可する都道府県（ここにないものは弾く）
  const allowed = new Set([
    "Tokyo",
    "Kanagawa",
    "Osaka",
    "Kyoto",
    "Hyogo",
    "Nara",
    "Fukuoka",
    "Ishikawa",
  ]);

  // 大文字小文字ブレ吸収
  const title = s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
  if (allowed.has(s)) return s;
  if (allowed.has(title)) return title;

  // それでも合わなければ空で返す
  return "";
}

function airtableQuote(str) {
  // Airtable filterByFormula のダブルクォートエスケープ
  return String(str).replace(/"/g, '\\"');
}

export default async function handler(req, res) {
  try {
    if (req.method !== "GET") {
      return json(res, 405, { ok: false, error: "Method not allowed" });
    }

    const AIRTABLE_TOKEN = process.env.AIRTABLE_TOKEN;
    const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID;

    // ★最重要：ここは「テーブルID優先」
    // 例: tblRTY6o0o0GqrXXW
    const AIRTABLE_TABLE_ID =
      process.env.AIRTABLE_TABLE_ID || process.env.AIRTABLE_TABLE || "";

    if (!AIRTABLE_TOKEN) {
      return json(res, 500, { ok: false, error: "Missing AIRTABLE_TOKEN" });
    }
    if (!AIRTABLE_BASE_ID) {
      return json(res, 500, { ok: false, error: "Missing AIRTABLE_BASE_ID" });
    }
    if (!AIRTABLE_TABLE_ID) {
      return json(res, 500, {
        ok: false,
        error: "Missing AIRTABLE_TABLE_ID",
        hint:
          "Set AIRTABLE_TABLE_ID to your tbl... in Vercel Environment Variables",
      });
    }

    const prefRaw = req.query.pref;
    const pref = normalizePref(prefRaw);

    if (!pref) {
      return json(res, 400, {
        ok: false,
        error: "Invalid pref",
        debug: { prefRaw },
      });
    }

    // Airtable内のカラム area_group に "Tokyo Urban" / "Tokyo Suburban" などが入ってる前提
    // pref が含まれるものを拾う
    const p = airtableQuote(pref);
    const formula = `AND(FIND("${p}", {area_group})>0, {status}="active")`;

    const url =
      `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${encodeURIComponent(
        AIRTABLE_TABLE_ID
      )}` +
      `?pageSize=100` +
      `&filterByFormula=${encodeURIComponent(formula)}` +
      `&fields%5B%5D=area_detail&fields%5B%5D=area_group&fields%5B%5D=status`;

    const r = await fetch(url, {
      headers: { Authorization: `Bearer ${AIRTABLE_TOKEN}` },
    });

    const text = await r.text();

    if (!r.ok) {
      return json(res, r.status, {
        ok: false,
        error: "Airtable request failed",
        status: r.status,
        details: text.slice(0, 400),
        debug: { table: AIRTABLE_TABLE_ID, pref, prefRaw, formula, url },
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
      pref,
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
}
