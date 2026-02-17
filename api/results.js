// /api/results.js
// DB優先（Airtable purchases）→ 無ければStripeでretrieve（フォールバック）→ paid以外は402
// 7件は area_groups に分散させて抽出（偏り防止）

const AIRTABLE_API = "https://api.airtable.com/v0";

function json(res, status, body) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(body));
}

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}

function normalizePaymentStatus(s) {
  const x = String(s || "").toLowerCase().trim();
  if (["paid", "succeeded", "success", "complete", "completed"].includes(x)) return "paid";
  if (["unpaid", "open", "pending", "failed", "canceled", "cancelled", "requires_payment_method"].includes(x))
    return "unpaid";
  return x || "unknown";
}

function parseAreaGroups(v) {
  if (Array.isArray(v)) return v.map(String).map(s => s.trim()).filter(Boolean);
  if (typeof v === "string" && v.trim()) {
    return v.split(",").map(s => s.trim()).filter(Boolean);
  }
  return [];
}

function uniq(arr) {
  const out = [];
  const seen = new Set();
  for (const x of (arr || [])) {
    const k = String(x || "").trim();
    if (!k) continue;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(k);
  }
  return out;
}

// session_id 依存で再現性あるシャッフル
function seededShuffle(arr, seedStr) {
  const a = arr.slice();
  let seed = 2166136261;
  for (let i = 0; i < seedStr.length; i++) {
    seed ^= seedStr.charCodeAt(i);
    seed = Math.imul(seed, 16777619);
  }
  let x = seed >>> 0;
  const rnd = () => {
    x ^= x << 13; x >>>= 0;
    x ^= x >>> 17; x >>>= 0;
    x ^= x << 5;  x >>>= 0;
    return (x >>> 0) / 4294967296;
  };
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

async function airtableGetRecords({ baseId, tableId, token, query }) {
  const url = new URL(`${AIRTABLE_API}/${baseId}/${tableId}`);
  Object.entries(query || {}).forEach(([k, v]) => {
    if (v === undefined || v === null) return;
    url.searchParams.set(k, String(v));
  });

  const r = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${token}` },
    method: "GET",
  });

  const text = await r.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch (_) {}

  if (!r.ok) {
    const msg =
      (data && data.error && (data.error.message || data.error.type)) ||
      `Airtable error (${r.status})`;
    const err = new Error(msg);
    err.status = r.status;
    err.airtable = data;
    throw err;
  }
  return data;
}

async function airtableCreateRecord({ baseId, tableId, token, fields }) {
  const url = `${AIRTABLE_API}/${baseId}/${tableId}`;
  const r = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ fields }),
  });

  const text = await r.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch (_) {}

  if (!r.ok) {
    const msg =
      (data && data.error && (data.error.message || data.error.type)) ||
      `Airtable create error (${r.status})`;
    const err = new Error(msg);
    err.status = r.status;
    err.airtable = data;
    throw err;
  }
  return data;
}

async function airtableUpdateRecord({ baseId, tableId, token, recordId, fields }) {
  const url = `${AIRTABLE_API}/${baseId}/${tableId}/${recordId}`;
  const r = await fetch(url, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ fields }),
  });

  const text = await r.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch (_) {}

  if (!r.ok) {
    const msg =
      (data && data.error && (data.error.message || data.error.type)) ||
      `Airtable update error (${r.status})`;
    const err = new Error(msg);
    err.status = r.status;
    err.airtable = data;
    throw err;
  }
  return data;
}

async function getPurchaseBySessionId({ baseId, purchasesTableId, token, sessionId }) {
  const safe = sessionId.replace(/'/g, "\\'");
  const formula = `{session_id}='${safe}'`;
  const data = await airtableGetRecords({
    baseId,
    tableId: purchasesTableId,
    token,
    query: { maxRecords: 1, filterByFormula: formula },
  });
  return (data.records || [])[0] || null;
}

async function upsertPurchase({ baseId, purchasesTableId, token, existingRecord, fields }) {
  if (existingRecord && existingRecord.id) {
    return airtableUpdateRecord({
      baseId,
      tableId: purchasesTableId,
      token,
      recordId: existingRecord.id,
      fields,
    });
  }
  return airtableCreateRecord({ baseId, tableId: purchasesTableId, token, fields });
}

async function stripeRetrieveCheckoutSession(sessionId) {
  const stripeKey = requireEnv("STRIPE_SECRET_KEY");
  const url = `https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(sessionId)}?expand[]=line_items&expand[]=customer`;

  const r = await fetch(url, {
    method: "GET",
    headers: { Authorization: `Bearer ${stripeKey}` },
  });

  const text = await r.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch (_) {}

  if (!r.ok) {
    const msg = (data && data.error && data.error.message) || `Stripe retrieve error (${r.status})`;
    const err = new Error(msg);
    err.status = r.status;
    err.stripe = data;
    throw err;
  }
  return data;
}

function inferPlanFromStripeSession(session) {
  const metaPlan = session?.metadata?.plan;
  if (metaPlan) return String(metaPlan).toLowerCase();

  const priceExplorer = process.env.STRIPE_PRICE_EXPLORER;
  const priceConnoisseur = process.env.STRIPE_PRICE_CONNOISSEUR;

  const items = session?.line_items?.data || [];
  for (const it of items) {
    const pid = it?.price?.id;
    if (pid && priceExplorer && pid === priceExplorer) return "explorer";
    if (pid && priceConnoisseur && pid === priceConnoisseur) return "connoisseur";
  }
  return "";
}

// 重要：statusフィールドが無いと式が死ぬので、ここでは参照しない（壊れない方を優先）
async function getShopsByArea({ baseId, shopsTableId, token, areaGroup }) {
  const safe = String(areaGroup).replace(/'/g, "\\'");
  const formula = `{area_group}='${safe}'`;

  const data = await airtableGetRecords({
    baseId,
    tableId: shopsTableId,
    token,
    query: {
      pageSize: 100,
      maxRecords: 200,
      filterByFormula: formula,
    },
  });

  const records = data.records || [];
  return records.map(r => ({ id: r.id, ...(r.fields || {}) }));
}

async function getShopsBalanced({ baseId, shopsTableId, token, areaGroups, total = 7, seed }) {
  const areas = uniq(areaGroups);
  if (!areas.length) return [];

  // エリアごとに候補取得
  const perAreaLists = {};
  for (const ag of areas) {
    perAreaLists[ag] = await getShopsByArea({ baseId, shopsTableId, token, areaGroup: ag });
    // 再現性ある順にしておく
    perAreaLists[ag] = seededShuffle(perAreaLists[ag], `${seed}:${ag}`);
  }

  // 均等割り当て（最低1）
  const baseN = Math.max(1, Math.floor(total / areas.length));
  let picks = [];

  for (const ag of areas) {
    const list = perAreaLists[ag] || [];
    picks = picks.concat(list.slice(0, baseN));
  }

  // 余りをプールから埋める（重複除外）
  const pickedIds = new Set(picks.map(s => s.id).filter(Boolean));
  const pool = [];
  for (const ag of areas) {
    const list = perAreaLists[ag] || [];
    for (const s of list) {
      if (!s?.id) continue;
      if (pickedIds.has(s.id)) continue;
      pool.push(s);
    }
  }

  const poolShuffled = seededShuffle(pool, `${seed}:pool`);
  for (const s of poolShuffled) {
    if (picks.length >= total) break;
    picks.push(s);
  }

  // 最終：totalに切る（再現性維持）
  picks = picks.slice(0, total);
  return picks;
}

module.exports = async (req, res) => {
  try {
    if (req.method !== "GET") return json(res, 405, { ok: false, error: "Method not allowed" });

    const baseId = requireEnv("AIRTABLE_BASE_ID");
    const token = requireEnv("AIRTABLE_TOKEN");
    const purchasesTableId = requireEnv("AIRTABLE_PURCHASES_TABLE_ID");
    const shopsTableId = requireEnv("AIRTABLE_TABLE_ID");

    const sessionId = String(req.query?.session_id || "").trim();
    if (!sessionId) return json(res, 400, { ok: false, error: "Missing session_id" });

    // ① DB優先
    let purchaseRec = null;
    try {
      purchaseRec = await getPurchaseBySessionId({ baseId, purchasesTableId, token, sessionId });
    } catch (e) {
      console.error("[/api/results] Airtable purchases lookup failed:", e?.message || e);
      return json(res, 500, { ok: false, error: "Server error (purchases lookup)" });
    }

    let fields = purchaseRec?.fields || {};
    let paymentStatus = normalizePaymentStatus(fields.payment_status);

    // ② 無ければStripeフォールバック → paidならself-heal保存
    if (!purchaseRec) {
      let session = null;
      try {
        session = await stripeRetrieveCheckoutSession(sessionId);
      } catch (e) {
        return json(res, 402, { ok: false, error: "Unpaid (session not found)" });
      }

      const stripePaid =
        session?.payment_status === "paid" ||
        session?.status === "complete" ||
        session?.payment_status === "succeeded";

      if (!stripePaid) return json(res, 402, { ok: false, error: "Unpaid" });

      const plan = inferPlanFromStripeSession(session) || "";
      const who = session?.metadata?.who || "";
      const vibes = session?.metadata?.vibes || "";
      const area_groups = session?.metadata?.area_groups || session?.metadata?.areas || "";

      try {
        const nowIso = new Date().toISOString();
        const upsertFields = {
          session_id: sessionId,
          payment_status: "paid",
          amount_total: session?.amount_total ?? null,
          currency: session?.currency ?? null,
          plan: plan || null,
          created_at: nowIso,
          customer_email: session?.customer_details?.email || session?.customer_email || null,
          area_groups: area_groups || null,
          who: who || null,
          vibes: vibes || null,
        };
        const created = await upsertPurchase({
          baseId, purchasesTableId, token,
          existingRecord: null,
          fields: upsertFields,
        });
        purchaseRec = created;
        fields = created.fields || {};
        paymentStatus = "paid";
      } catch (e) {
        console.error("[/api/results] Airtable purchases self-heal save failed:", e?.message || e);
        fields = { session_id: sessionId, payment_status: "paid", plan, who, vibes, area_groups };
        paymentStatus = "paid";
      }
    }

    // ③ paid以外は402
    if (paymentStatus !== "paid") return json(res, 402, { ok: false, error: "Unpaid" });

    const plan = String(fields.plan || "").toLowerCase().trim() || "explorer";
    const who = fields.who || "";
    const vibes = fields.vibes || "";
    const areaGroups = parseAreaGroups(fields.area_groups);

    // ④ エリア分散で7件
    let shops = [];
    try {
      shops = await getShopsBalanced({
        baseId,
        shopsTableId,
        token,
        areaGroups,
        total: 7,
        seed: sessionId,
      });
    } catch (e) {
      console.error("[/api/results] Airtable shops lookup failed:", e?.message || e);
      return json(res, 500, { ok: false, error: "Server error (shops lookup)" });
    }

    return json(res, 200, {
      ok: true,
      plan,
      who: who || vibes || "",
      shops: Array.isArray(shops) ? shops : [],
    });
  } catch (e) {
    console.error("[/api/results] Fatal:", e?.message || e);
    return json(res, 500, { ok: false, error: "Server error" });
  }
};
