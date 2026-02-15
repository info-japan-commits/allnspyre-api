export default async function handler(req, res) {
  try {
    const plan = String(req.query.plan || "").toLowerCase() || "explorer";
    const pref = String(req.query.pref || "");
    const prefs = pref.split(",").map(s => s.trim()).filter(Boolean);

    if (prefs.length === 0) {
      return res.status(200).json({ ok: true, plan, prefs: [], count: 0, areaGroups: [] });
    }

    const AIRTABLE_TOKEN = process.env.AIRTABLE_TOKEN;
    const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID;
    const AIRTABLE_TABLE = process.env.AIRTABLE_TABLE || "shops_master";

    if (!AIRTABLE_TOKEN || !AIRTABLE_BASE_ID) {
      return res.status(500).json({ ok: false, error: "Missing Airtable env vars" });
    }

    // Airtable: prefecture が prefs に含まれる active 行の area_group をユニーク抽出
    // ※ prefecture列名はあなたのAirtableに合わせて調整して（例: pref / prefecture）
    const PREF_FIELD = "pref";       // ←必要なら "prefecture" に変えて
    const STATUS_FIELD = "status";
    const AREA_GROUP_FIELD = "area_group";

    const prefOr = prefs.map(p => `{${PREF_FIELD}}="${escapeFormula(p)}"`).join(",");
    const formula = `AND({${STATUS_FIELD}}="active", OR(${prefOr}))`;

    const url = new URL(`https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${encodeURIComponent(AIRTABLE_TABLE)}`);
    url.searchParams.set("pageSize", "100");
    url.searchParams.set("filterByFormula", formula);
    url.searchParams.append("fields[]", AREA_GROUP_FIELD);

    const r = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${AIRTABLE_TOKEN}` }
    });

    const j = await r.json();
    if (!r.ok) {
      return res.status(500).json({ ok: false, error: "Airtable error", detail: j });
    }

    const set = new Set();
    (j.records || []).forEach(rec => {
      const g = rec.fields?.[AREA_GROUP_FIELD];
      if (g) set.add(g);
    });

    const areaGroups = Array.from(set).sort();
    res.status(200).json({ ok: true, plan, prefs, count: areaGroups.length, areaGroups });

  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
}

function escapeFormula(s) {
  return String(s).replace(/"/g, '\\"');
}
