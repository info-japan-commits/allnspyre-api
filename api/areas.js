// api/areas.js
// Returns unique area_group list for a given prefecture.
// Explorer: shows tier=explorer only
// Connoisseur: shows tier in (explorer, connoisseur)

function json(res, status, data) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(data));
}

const PREFS = ["Tokyo","Kanagawa","Osaka","Kyoto","Hyogo","Nara","Fukuoka","Ishikawa"];

function normalizePref(raw) {
  if (!raw) return "";
  let s = String(raw).trim();

  // hearingの事故（"Tokyohttps://..."）を救済
  const httpIdx = s.indexOf("http");
  if (httpIdx > 0) s = s.slice(0, httpIdx);

  // "pref=Tokyo" みたいな混入も救済
  if (s.includes("pref=")) s = s.split("pref=").pop();

  s = s.replace(/\s+/g, " ").trim();

  for (const p of PREFS) {
    if (s === p) return p;
    if (s.includes(p)) return p;
  }
  return s;
}

function escapeAirtable(str) {
  return String(str).replace(/"/g, '\\"');
}

export default async function handler(req, res) {
  try {
    if (req.method !== "GET") {
      return json(res, 405, { ok: false, error: "Method not allowed" });
    }

    const AIRTABLE_TOKEN = process.env.AIRTABLE_TOKEN;
    const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID;
    const AIRTABLE_TABLE_ID = process.env.AIRTABLE_TABLE_ID; // tblXXXX...

    if (!AIRTABLE_TOKEN || !AIRTABLE_BASE_ID || !AIRTABLE_TABLE_ID) {
      return json(res, 500, {
        ok: false,
        error: "Missing Airtable env vars",
        need: ["AIRTABLE_TOKEN", "AIRTABLE_BASE_ID", "AIRTABLE_TABLE_ID"],
      });
    }

    const prefRaw = req.query.pref;
    const pref = normalizePref(prefRaw);
    if (!pref) {
      return json(res, 400, { ok: false, error: "Invalid pref", prefRaw });
    }

    const plan = String(req.query.plan || "explorer").toLowerCase().trim();
    const allowed =
      plan === "connoisseur" ? new Set(["explorer", "connoisseur"]) : new Set(["explorer"]);

    // prefで絞る（area_groupに prefecture名が入っている運用前提）
    const formula = `AND(FIND("${escapeAirtable(pref)}",{area_group})>0, {status}="active")`;

    const url =
      `https://api.airtable.com/v0/${encodeURIComponent(AIRTABLE_BASE_ID)}/${encodeURIComponent(AIRTABLE_TABLE_ID)}` +
      `?pageSize=100` +
      `&filterByFormula=${encodeURIComponent(formula)}` +
      `&fields%5B%5D=area_group&fields%5B%5D=tier&fields%5B%5D=status`;

    const r = await fetch(url, {
      headers: { Authorization: `Bearer ${AIRTABLE_TOKEN}` },
    });

    const text = await r.text();
    if (!r.ok) {
      return json(res, r.status, {
        ok: false,
        error: "Airtable request failed",
        status: r.status,
        details: text.slice(0, 800),
        debug: { pref, plan, formula, url },
      });
    }

    const data = JSON.parse(text);
    const records = Array.isArray(data.records) ? data.records : [];

    const set = new Set();
    for (const rec of records) {
      const f = rec.fields || {};
      const tier = String(f.tier || "").toLowerCase().trim();
      if (!allowed.has(tier)) continue;

      const g = String(f.area_group || "").trim();
      if (g) set.add(g);
    }

    const areaGroups = Array.from(set).sort((a, b) => a.localeCompare(b));

    return json(res, 200, {
      ok: true,
      pref,
      plan,
      count: areaGroups.length,
      areaGroups,
    });
  } catch (err) {
    return json(res, 500, { ok: false, error: "Server error", message: String(err?.message || err) });
  }
}
