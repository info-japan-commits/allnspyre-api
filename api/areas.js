export default async function handler(req, res) {
  try {
    const pref = req.query.pref;
    const plan = req.query.plan || "explorer"; // explorer / connoisseur

    if (!pref) {
      return res.status(400).json({ ok: false, error: "pref is required" });
    }

    const baseId = process.env.AIRTABLE_BASE_ID;
    const tableId = process.env.AIRTABLE_TABLE_ID;
    const token = process.env.AIRTABLE_TOKEN;

    const formula = `
      AND(
        FIND("${plan}", ARRAYJOIN({tier})) > 0,
        FIND("${pref}", {area_group}) > 0,
        {status} = "active"
      )
    `;

    const url = `https://api.airtable.com/v0/${baseId}/${tableId}?pageSize=100&filterByFormula=${encodeURIComponent(
      formula
    )}&fields[]=area_group`;

    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });

    const data = await response.json();

    if (!response.ok) {
      return res.status(response.status).json({
        ok: false,
        error: "Airtable request failed",
        details: data,
      });
    }

    // 重複除去
    const areaGroups = [
      ...new Set(data.records.map((r) => r.fields.area_group)),
    ];

    res.status(200).json({
      ok: true,
      pref,
      plan,
      count: areaGroups.length,
      areaGroups,
    });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
}
