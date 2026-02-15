import fetch from "node-fetch";

const AIRTABLE_BASE = process.env.AIRTABLE_BASE_ID;
const AIRTABLE_TOKEN = process.env.AIRTABLE_TOKEN;

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const { areaIds, who, mood, friction } = req.body;

    if (!areaIds || areaIds.length === 0) {
      return res.status(400).json({ error: "No area selected" });
    }

    // Airtable filter formula
    const areaFilter = areaIds
      .map(id => `{area_id}='${id}'`)
      .join(",");

    const formula = `OR(${areaFilter})`;

    const url = `https://api.airtable.com/v0/${AIRTABLE_BASE}/shops_master?filterByFormula=${encodeURIComponent(formula)}&maxRecords=7`;

    const airtableRes = await fetch(url, {
      headers: {
        Authorization: `Bearer ${AIRTABLE_TOKEN}`,
      },
    });

    const data = await airtableRes.json();

    const shops = data.records.map(r => ({
      shop_name: r.fields.shop_name,
      area_detail: r.fields.area_detail,
      genre: r.fields.genre,
      short_desc: r.fields.short_desc,
    }));

    return res.status(200).json({ shops });

  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Server error" });
  }
}
