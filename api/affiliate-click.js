// /api/affiliate-click.js
const AIRTABLE_API = "https://api.airtable.com/v0";

function json(res, status, body) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(body));
}

async function getAffiliateByRef(baseId, token, affiliatesTableId, affiliateId) {
  const formula = encodeURIComponent(`{affiliate_id}="${affiliateId}"`);
  const url = `${AIRTABLE_API}/${baseId}/${affiliatesTableId}?filterByFormula=${formula}&maxRecords=1`;
  const r = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const data = await r.json();
  return (data.records || [])[0] || null;
}

async function incrementClicks(baseId, token, affiliatesTableId, record) {
  const current = Number(record.fields?.total_clicks || 0);
  const url = `${AIRTABLE_API}/${baseId}/${affiliatesTableId}/${record.id}`;
  await fetch(url, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ fields: { total_clicks: current + 1 } }),
  });
}

module.exports = async (req, res) => {
  try {
    const baseId = process.env.AIRTABLE_BASE_ID;
    const token = process.env.AIRTABLE_TOKEN;
    const affiliatesTableId = process.env.AIRTABLE_AFFILIATES_TABLE_ID;

    const ref = String(req.query?.ref || "").trim().toLowerCase();
    if (!ref) return json(res, 400, { ok: false, error: "Missing ref" });

    if (baseId && token && affiliatesTableId) {
      const record = await getAffiliateByRef(baseId, token, affiliatesTableId, ref);
      if (record) {
        await incrementClicks(baseId, token, affiliatesTableId, record);
      }
    }

    return json(res, 200, { ok: true });
  } catch (e) {
    console.error("[/api/affiliate-click] error:", e?.message || e);
    return json(res, 500, { ok: false, error: "Server error" });
  }
};
