// api/areas.js
export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type,Authorization");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  const prefecture = (req.query.prefecture || "").toString().trim();
  if (!prefecture) return res.status(400).json({ error: "Missing prefecture" });

  const AIRTABLE_TOKEN = process.env.AIRTABLE_TOKEN;
  const BASE_ID = process.env.AIRTABLE_BASE_ID;
  const TABLE_ID = process.env.AIRTABLE_TABLE_ID;

  if (!AIRTABLE_TOKEN || !BASE_ID || !TABLE_ID) {
    return res.status(500).json({ error: "Missing Airtable env vars" });
  }

  // Airtableのフィールド名（スクショで確定）
  const FIELD_AREA_GROUP = "area_group";

  // Hyogoに「Kobe」が混ざる仕様対応
  const PREFIX_MAP = {
    Tokyo: ["Tokyo"],
    Kanagawa: ["Kanagawa"],
    Osaka: ["Osaka"],
    Kyoto: ["Kyoto"],
    Hyogo: ["Hyogo", "Kobe"],
    Nara: ["Nara"],
    Fukuoka: ["Fukuoka"],
    Ishikawa: ["Ishikawa"],
  };
  const prefixes = PREFIX_MAP[prefecture] || [prefecture];

  const baseUrl = `https://api.airtable.com/v0/${BASE_ID}/${TABLE_ID}`;
  const headers = { Authorization: `Bearer ${AIRTABLE_TOKEN}` };

  const set = new Set();
  let offset;

  try {
    while (true) {
      const url = new URL(baseUrl);
      url.searchParams.set("pageSize", "100");
      url.searchParams.append("fields[]", FIELD_AREA_GROUP);
      if (offset) url.searchParams.set("offset", offset);

      const r = await fetch(url.toString(), { headers });
      if (!r.ok) {
        const t = await r.text();
        return res.status(500).json({ error: "Airtable error", detail: t.slice(0, 500) });
      }
      const data = await r.json();

      for (const rec of (data.records || [])) {
        const v = rec.fields?.[FIELD_AREA_GROUP];
        if (typeof v === "string" && v.trim()) set.add(v.trim());
      }

      offset = data.offset;
      if (!offset) break;
    }

    const areas = [...set]
      .filter(v => prefixes.some(p => v.startsWith(p + " "))) // "Tokyo Urban" など
      .sort((a, b) => a.localeCompare(b, "en"));

    return res.status(200).json({ areas });
  } catch (e) {
    return res.status(500).json({ error: "Server error", detail: String(e?.message || e) });
  }
}
