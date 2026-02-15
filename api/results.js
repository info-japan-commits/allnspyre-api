export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      return res.status(405).json({ ok: false, error: "Method not allowed" });
    }

    const body = req.body || {};
    const plan = String(body.plan || "").toLowerCase() || "explorer";
    const prefs = Array.isArray(body.prefs) ? body.prefs : [];
    const areaGroups = Array.isArray(body.areaGroups) ? body.areaGroups : [];

    if (areaGroups.length === 0) {
      return res.status(400).json({ ok: false, error: "No areaGroups provided" });
    }

    const AIRTABLE_TOKEN = process.env.AIRTABLE_TOKEN;
    const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID;
    const AIRTABLE_TABLE = process.env.AIRTABLE_TABLE || "shops_master";

    if (!AIRTABLE_TOKEN || !AIRTABLE_BASE_ID) {
      return res.status(500).json({ ok: false, error: "Missing Airtable env vars" });
    }

    const STATUS_FIELD = "status";
    const AREA_GROUP_FIELD = "area_group";

    // area_group だけで絞る（社長の要望どおり全置換）
    const areaOr = areaGroups.map(a => `{${AREA_GROUP_FIELD}}="${escapeFormula(a)}"`).join(",");
    const formula = `AND({${STATUS_FIELD}}="active", OR(${areaOr}))`;

    const url = new URL(`https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${encodeURIComponent(AIRTABLE_TABLE)}`);
    url.searchParams.set("pageSize", "100");
    url.searchParams.set("filterByFormula", formula);

    // 必要フィールドだけ
    [
      "shop_id","shop_name","area_group","area_detail","genre","short_desc",
      "photo_status","source_note","status"
    ].forEach(f => url.searchParams.append("fields[]", f));

    const r = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${AIRTABLE_TOKEN}` }
    });

    const j = await r.json();
    if (!r.ok) {
      return res.status(500).json({ ok: false, error: "Airtable error", detail: j });
    }

    const records = (j.records || []).map(rec => rec.fields).filter(Boolean);

    // 7件ランダム（安定させたいならseed入れる）
    const shops = pickN(shuffle(records), 7);

    // debug（社長の画面に出る）
    const debug = {
      usedFormula: formula,
      usedAreaGroups: areaGroups,
      plan,
      prefsCount: prefs.length
    };

    return res.status(200).json({ ok: true, count: shops.length, shops, debug });

  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
}

function escapeFormula(s) {
  return String(s).replace(/"/g, '\\"');
}
function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
function pickN(arr, n) {
  return arr.slice(0, n);
}
