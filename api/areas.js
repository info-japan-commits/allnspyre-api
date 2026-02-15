// api/areas.js
export default async function handler(req, res) {
  const json = (status, body) => {
    res.status(status);
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.end(JSON.stringify(body));
  };

  try {
    const AIRTABLE_TOKEN = process.env.AIRTABLE_TOKEN;
    const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID;
    // 今の実装に合わせてテーブル名を使う（explorer_only が見えてるので）
    const AIRTABLE_TABLE = process.env.AIRTABLE_TABLE_AREAS || "explorer_only";

    if (!AIRTABLE_TOKEN) return json(500, { ok: false, error: "Missing AIRTABLE_TOKEN" });
    if (!AIRTABLE_BASE_ID) return json(500, { ok: false, error: "Missing AIRTABLE_BASE_ID" });

    const prefRaw = (req.query.pref || "").toString().trim();
    if (!prefRaw) return json(400, { ok: false, error: "Missing pref" });

    // ✅ pref→ area_groupに含まれうるキーワードへ変換（表記ゆれ吸収）
    // ここを増やせばエリアが増える
    const PREF_KEYWORDS = {
      Tokyo: ["Tokyo"],
      Kanagawa: ["Kanagawa", "Yokohama"],     // ← Kanagawaが出ない主因を救う
      Osaka: ["Osaka"],
      Kyoto: ["Kyoto"],
      Hyogo: ["Hyogo", "Kobe", "Akashi", "Awaji"],
      Nara: ["Nara", "Ikoma"],
      Fukuoka: ["Fukuoka", "Tenjin", "Hakata", "Nishijin", "Itoshima", "Dazaifu"],
      Ishikawa: ["Ishikawa", "Kanazawa", "Nonoichi"],
    };

    // 入力が "tokyo" みたいな時も正規化
    const prefNormalized =
      Object.keys(PREF_KEYWORDS).find(k => k.toLowerCase() === prefRaw.toLowerCase()) || prefRaw;

    const keywords = PREF_KEYWORDS[prefNormalized] || [prefNormalized];

    // AirtableのfilterByFormulaを作る
    // OR(FIND("Yokohama",{area_group})>0, FIND("Kanagawa",{area_group})>0, ...)
    const esc = (s) => String(s).replace(/"/g, '\\"');
    const findParts = keywords.map(k => `FIND("${esc(k)}",{area_group})>0`);
    const formula = `AND(OR(${findParts.join(",")}), {status}="active")`;

    const url =
      `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${encodeURIComponent(AIRTABLE_TABLE)}` +
      `?pageSize=100&filterByFormula=${encodeURIComponent(formula)}` +
      `&fields%5B%5D=area_detail&fields%5B%5D=area_group&fields%5B%5D=status`;

    const r = await fetch(url, {
      headers: { Authorization: `Bearer ${AIRTABLE_TOKEN}` },
    });

    const text = await r.text();

    if (!r.ok) {
      return json(r.status, {
        ok: false,
        error: "Airtable request failed",
        status: r.status,
        details: text.slice(0, 600),
        debug: {
          table: AIRTABLE_TABLE,
          pref: prefRaw,
          prefNormalized,
          keywords,
          formula,
          url,
        },
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

    return json(200, {
      ok: true,
      pref: prefRaw,
      prefNormalized,
      keywords,
      count: areaDetails.length,
      areaDetails,
    });
  } catch (e) {
    return json(500, { ok: false, error: "Server error", message: String(e?.message || e) });
  }
}
