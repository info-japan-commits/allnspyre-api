// api/areas.js  (multi-prefecture version)
export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type,Authorization");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  // supports ?prefecture=Tokyo  OR  ?prefectures=Tokyo,Osaka
  const one = (req.query.prefecture || "").toString().trim();
  const many = (req.query.prefectures || "").toString().trim();

  const prefs = (many ? many.split(",") : (one ? [one] : []))
    .map(s => s.trim())
    .filter(Boolean);

  if (prefs.length === 0) return res.status(400).json({ error: "Missing prefecture(s)" });

  const AIRTABLE_TOKEN = process.env.AIRTABLE_TOKEN;
  const BASE_ID = process.env.AIRTABLE_BASE_ID;
  const TABLE_ID = process.env.AIRTABLE_TABLE_ID;

  if (!AIRTABLE_TOKEN || !BASE_ID || !TABLE_ID) {
    return res.status(500).json({ error: "Missing Airtable env vars" });
  }

  const FIELD_AREA_GROUP = "area_group";

  // Hyogo has "Kobe ..." in your actual options
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

  const baseUrl = `https://api.airtable.com/v0/${BASE_ID}/${TABLE_ID}`;
  const headers = { Authorization: `Bearer ${AIRTABLE_TOKEN}` };

  const all = new Set();
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
        if (typeof v === "string" && v.trim()) all.add(v.trim());
      }

      offset = data.offset;
      if (!offset) break;
    }

    const allAreas = [...all];

    const areasByPrefecture = {};
    for (const p of prefs) {
      const prefixes = PREFIX_MAP[p] || [p];
      areasByPrefecture[p] = allAreas
        .filter(v => prefixes.some(px => v.startsWith(px + " ")))
        .sort((a, b) => a.localeCompare(b, "en"));
    }

    // flat list (dedup) for convenience
    const flat = [...new Set(Object.values(areasByPrefecture).flat())]
      .sort((a, b) => a.localeCompare(b, "en"));

    return res.status(200).json({ areasByPrefecture, areas: flat });
  } catch (e) {
    return res.status(500).json({ error: "Server error", detail: String(e?.message || e) });
  }
}
