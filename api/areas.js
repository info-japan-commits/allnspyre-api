export default async function handler(req, res) {
  try {
    const plan = String(req.query.plan || "explorer").toLowerCase() === "connoisseur"
      ? "connoisseur"
      : "explorer";

    const prefParam = String(req.query.pref || "");
    const prefs = prefParam.split(",").map(s => s.trim()).filter(Boolean);

    if (prefs.length === 0) {
      return res.status(200).json({ ok: true, plan, prefs: [], areaGroups: [] });
    }

    // Env: どっちでも動くように両対応
    const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID;
    const AIRTABLE_TOKEN = process.env.AIRTABLE_TOKEN || process.env.AIRTABLE_API_KEY;
    const AIRTABLE_TABLE = process.env.AIRTABLE_TABLE || "shops_master";

    if (!AIRTABLE_BASE_ID || !AIRTABLE_TOKEN) {
      return res.status(500).json({ ok: false, error: "Missing env: AIRTABLE_BASE_ID / AIRTABLE_TOKEN(or AIRTABLE_API_KEY)" });
    }

    const FIELD_AREA_GROUP = "area_group";
    const FIELD_STATUS = "status";
    const FIELD_TIER = "tier";

    // Prefecture判定は area_group に「Tokyo」等が含まれる前提（これまでの実装の通り）
    const prefOr = prefs
      .map(p => `FIND("${escapeFormula(p)}",{${FIELD_AREA_GROUP}})>0`)
      .join(",");

    // tierフィルタ：Explorerは explorer/free、Connoisseurは全部
    let tierClause = "";
    if (plan === "explorer") {
      tierClause = `AND(OR({${FIELD_TIER}}="explorer",{${FIELD_TIER}}="free",{${FIELD_TIER}}=""),`;
    }

    const baseFormula = `AND({${FIELD_STATUS}}="active",OR(${prefOr}))`;
    const filterByFormula = (plan === "explorer")
      ? `${tierClause}${baseFormula})`
      : baseFormula;

    const url = new URL(`https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${encodeURIComponent(AIRTABLE_TABLE)}`);
    url.searchParams.set("pageSize", "100");
    url.searchParams.set("filterByFormula", filterByFormula);
    url.searchParams.append("fields[]", FIELD_AREA_GROUP);
    url.searchParams.append("fields[]", FIELD_STATUS);
    url.searchParams.append("fields[]", FIELD_TIER);

    const r = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${AIRTABLE_TOKEN}` }
    });

    const j = await r.json();

    if (!r.ok) {
      return res.status(500).json({
        ok: false,
        error: "Airtable request failed",
        status: r.status,
        details: j
      });
    }

    const set = new Set();
    for (const rec of (j.records || [])) {
      const g = rec?.fields?.[FIELD_AREA_GROUP];
      if (g) set.add(g);
    }

    const areaGroups = Array.from(set).sort();

    return res.status(200).json({ ok: true, plan, prefs, areaGroups });

  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e) });
  }
}

function escapeFormula(s) {
  return String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}
