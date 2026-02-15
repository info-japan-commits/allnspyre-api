export default async function handler(req, res) {
  try {
    const plan = req.query.plan || "explorer"; // explorer / connoisseur
    const prefsRaw = req.query.prefs || req.query.pref; // 互換: prefも許可
    if (!prefsRaw) {
      return res.status(400).json({ ok: false, error: "prefs is required" });
    }

    // prefs の受け方:
    // - prefs=Tokyo|Osaka|Kanagawa
    // - pref=Tokyo (旧)
    const prefs = String(prefsRaw)
      .split("|")
      .map((s) => s.trim())
      .filter(Boolean);

    if (prefs.length === 0) {
      return res.status(400).json({ ok: false, error: "prefs is required" });
    }

    const baseId = process.env.AIRTABLE_BASE_ID;
    const tableId = process.env.AIRTABLE_TABLE_ID;
    const token = process.env.AIRTABLE_TOKEN;

    if (!baseId || !tableId || !token) {
      return res.status(500).json({
        ok: false,
        error: "Missing env vars",
        debug: {
          hasBaseId: !!baseId,
          hasTableId: !!tableId,
          hasToken: !!token,
        },
      });
    }

    // 複数都道府県 OR 条件
    const prefOr = prefs
      .map((p) => `FIND("${p}", {area_group}) > 0`)
      .join(", ");

    // tier は multi-select なので ARRAYJOIN で contains 判定
    const formula = `AND(
      FIND("${plan}", ARRAYJOIN({tier})) > 0,
      OR(${prefOr}),
      {status} = "active"
    )`;

    const url =
      `https://api.airtable.com/v0/${baseId}/${tableId}` +
      `?pageSize=100` +
      `&filterByFormula=${encodeURIComponent(formula)}` +
      `&fields[]=area_group`;

    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
    });

    const data = await response.json();

    if (!response.ok) {
      return res.status(response.status).json({
        ok: false,
        error: "Airtable request failed",
        details: data,
        debug: { plan, prefs, formula, url },
      });
    }

    const areaGroups = [
      ...new Set((data.records || []).map((r) => r.fields?.area_group).filter(Boolean)),
    ].sort((a, b) => a.localeCompare(b));

    return res.status(200).json({
      ok: true,
      plan,
      prefs,
      count: areaGroups.length,
      areaGroups,
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
}
