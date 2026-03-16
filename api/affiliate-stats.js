// /api/affiliate-stats.js
const AIRTABLE_API = "https://api.airtable.com/v0";

function json(res, status, body) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(body));
}

module.exports = async (req, res) => {
  try {
    if (req.method !== "GET") return json(res, 405, { ok: false, error: "Method not allowed" });

    const baseId = process.env.AIRTABLE_BASE_ID;
    const token = process.env.AIRTABLE_TOKEN;
    const affiliatesTableId = process.env.AIRTABLE_AFFILIATES_TABLE_ID;

    const ref = String(req.query?.id || "").trim().toLowerCase();
    const email = String(req.query?.email || "").trim().toLowerCase();

    if (!ref || !email) return json(res, 400, { ok: false, error: "Missing id or email" });

    const formula = encodeURIComponent(
      `AND({affiliate_id}="${ref}",LOWER({email})="${email}")`
    );
    const url = `${AIRTABLE_API}/${baseId}/${affiliatesTableId}?filterByFormula=${formula}&maxRecords=1`;

    const r = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = await r.json();
    const record = (data.records || [])[0];

    if (!record) return json(res, 404, { ok: false, error: "Not found" });

    const f = record.fields || {};
    return json(res, 200, {
      ok: true,
      affiliate_id: f.affiliate_id || "",
      name: f.name || "",
      total_clicks: f.total_clicks || 0,
      total_purchases: f.total_purchases || 0,
      total_earnings: f.total_earnings || 0,
      paid_amount: f.paid_amount || 0,
      unpaid: (f.total_earnings || 0) - (f.paid_amount || 0),
      status: f.status || "active",
    });
  } catch (e) {
    console.error("[/api/affiliate-stats] error:", e?.message || e);
    return json(res, 500, { ok: false, error: "Server error" });
  }
};
