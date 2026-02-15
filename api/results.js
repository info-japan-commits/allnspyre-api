const AIRTABLE_BASE = process.env.AIRTABLE_BASE_ID;
const AIRTABLE_TOKEN = process.env.AIRTABLE_TOKEN;

const TABLE_NAME = "explorer_only";

function json(res, status, payload) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(payload));
}

export default async function handler(req, res) {
  if (req.method !== "GET") {
    return json(res, 405, { error: "Method not allowed" });
  }

  try {
    const { areaDetails } = req.query;

    if (!areaDetails) {
      return json(res, 400, { error: "No area selected" });
    }

    const areas = areaDetails
      .split(",")
      .map(s => s.trim())
      .filter(Boolean);

    const conditions = areas
      .map(a => `{area_detail}="${a}"`)
      .join(",");

    const formula = `AND(OR(${conditions}), {status}="active")`;

    const url =
      `https://api.airtable.com/v0/${AIRTABLE_BASE}/${encodeURIComponent(TABLE_NAME)}?` +
      `filterByFormula=${encodeURIComponent(formula)}&maxRecords=7`;

    const airtableRes = await fetch(url, {
      headers: {
        Authorization: `Bearer ${AIRTABLE_TOKEN}`
      }
    });

    if (!airtableRes.ok) {
      const text = await airtableRes.text();
      return json(res, airtableRes.status, {
        error: "Airtable request failed",
        details: text
      });
    }

    const data = await airtableRes.json();

    const shops = (data.records || []).map(r => ({
      shop_id: r.fields.shop_id || "",
      shop_name: r.fields.shop_name || "",
      area_detail: r.fields.area_detail || "",
      genre: r.fields.genre || "",
      short_desc: r.fields.short_desc || ""
    }));

    return json(res, 200, {
      ok: true,
      count: shops.length,
      shops
    });

  } catch (err) {
    return json(res, 500, {
      error: "Server error",
      message: err.message
    });
  }
}
