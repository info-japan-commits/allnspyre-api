// /api/areas.js
export default async function handler(req, res) {
  try {
    const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID;
    const AIRTABLE_TABLE_ID = process.env.AIRTABLE_TABLE_ID; // tblxxxx
    const AIRTABLE_TOKEN = process.env.AIRTABLE_TOKEN;

    if (!AIRTABLE_BASE_ID || !AIRTABLE_TABLE_ID || !AIRTABLE_TOKEN) {
      return res.status(500).json({
        ok: false,
        error: "Missing Airtable env vars",
        debug: {
          hasBase: !!AIRTABLE_BASE_ID,
          hasTable: !!AIRTABLE_TABLE_ID,
          hasToken: !!AIRTABLE_TOKEN,
        },
      });
    }

    // ---- helpers
    const json = (status, body) => {
      res.status(status);
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.setHeader("Cache-Control", "no-store");
      return res.end(JSON.stringify(body));
    };

    // URL混入対策：入力から "http" 以降を全部捨てる + 許可リストで最終確定
    const stripUrlJunk = (s) => String(s || "").split("http")[0].trim();

    const ALLOWED_PREFS = [
      "Tokyo",
      "Kanagawa",
      "Osaka",
      "Kyoto",
      "Hyogo",
      "Nara",
      "Fukuoka",
      "Ishikawa",
    ];

    // prefecture → area_group に含まれうるキーワード（ここが “Kanagawa=Yokohama” 問題の本丸）
    // ※必要なら後で増やせばOK。まずは現状データに合わせて。
    const PREF_KEYWORDS = {
      Tokyo: ["Tokyo"],
      Kanagawa: ["Yokohama", "Kanagawa"],
      Osaka: ["Osaka", "Hokusetu", "Hokusetsu"],
      Kyoto: ["Kyoto", "Fushimi", "Momoyama"],
      Hyogo: ["Kobe", "Hyogo", "Akashi", "Awaji"],
      Nara: ["Nara", "Ikoma"],
      Fukuoka: ["Fukuoka", "Tenjin", "Hakata", "Nishijin", "Itoshima", "Dazaifu"],
      Ishikawa: ["Ishikawa", "Kanazawa", "Nonoichi"],
    };

    const airtableQuote = (s) => String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"');

    // ---- inputs
    const plan = (req.query.plan || "explorer").toString().toLowerCase();
    const tier = plan === "connoisseur" ? "connoisseur" : "explorer";

    // prefs: "Tokyo|Osaka" もしくは pref: "Tokyo"
    const rawPrefsStr =
      (req.query.prefs ? String(req.query.prefs) : "") ||
      (req.query.pref ? String(req.query.pref) : "");

    const rawPrefs = rawPrefsStr
      .split("|")
      .map(stripUrlJunk)
      .map((s) => s.trim())
      .filter(Boolean);

    // 許可リストで確定（これで URL混入・変な文字列は完全排除）
    const prefs = rawPrefs.filter((p) => ALLOWED_PREFS.includes(p));

    if (prefs.length === 0) {
      return json(400, { ok: false, error: "Missing or invalid prefs", debug: { rawPrefsStr, rawPrefs } });
    }

    // prefectureを keywords に展開
    const keywords = [];
    for (const p of prefs) {
      const ks = PREF_KEYWORDS[p] || [p];
      for (const k of ks) keywords.push(k);
    }

    // filterByFormula 組み立て：OR(FIND("Tokyo",{area_group})>0, FIND("Yokohama",{area_group})>0, ...)
    const findParts = keywords.map((k) => `FIND("${airtableQuote(k)}",{area_group})>0`);
    const areaMatch = findParts.length ? `OR(${findParts.join(",")})` : "TRUE()";
    const formula = `AND(${areaMatch}, {status}="active", {tier}="${tier}")`;

    const url =
      `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${AIRTABLE_TABLE_ID}` +
      `?pageSize=100` +
      `&filterByFormula=${encodeURIComponent(formula)}` +
      `&fields%5B%5D=area_group` +
      `&fields%5B%5D=status` +
      `&fields%5B%5D=tier`;

    const r = await fetch(url, {
      headers: { Authorization: `Bearer ${AIRTABLE_TOKEN}` },
    });

    const text = await r.text();

    if (!r.ok) {
      return json(r.status, {
        ok: false,
        error: "Airtable request failed",
        status: r.status,
        details: text.slice(0, 800),
        debug: {
          prefs,
          keywords,
          tier,
          formula,
          url,
        },
      });
    }

    let data;
    try {
      data = JSON.parse(text);
    } catch (e) {
      return json(500, { ok: false, error: "Bad Airtable JSON", details: text.slice(0, 800) });
    }

    const records = Array.isArray(data.records) ? data.records : [];

    // area_group をユニークに
    const set = new Set();
    for (const rec of records) {
      const v = rec?.fields?.area_group;
      if (typeof v === "string" && v.trim()) set.add(v.trim());
    }

    const areaGroups = Array.from(set).sort((a, b) => a.localeCompare(b));

    return json(200, {
      ok: true,
      plan,
      tier,
      prefs,
      count: areaGroups.length,
      areaGroups,
    });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: "Server error",
      message: String(err?.message || err),
    });
  }
}
