// /api/results.js
// DB優先（Airtable purchases）→ 無ければStripeでretrieve（フォールバック）→ paid以外は402
// results.html が期待する形式: { ok:true, plan, who, shops:[...] } に統一

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
  // Airtable側の表記ゆれ吸収（必要なら追加）
  if (["paid", "succeeded", "success", "complete", "completed"].includes(x)) return "paid";
  if (["unpaid", "open", "pending", "failed", "canceled", "cancelled", "requires_payment_method"].includes(x))
    return "unpaid";
  return x || "unknown";
}

function parseAreaGroups(v) {
  if (Array.isArray(v)) return v.map(String).map(s => s.trim()).filter(Boolean);
  if (typeof v === "string") {
    return v
      .split(",")
      .map(s => s.trim())
      .filter(Boolean);
  }
  return [];
}

// session_id 文字列に依存して “毎回同じ7件” を選ぶ（手動運用ゼロ/再現性重視）
function seededPick(arr, n, seedStr) {
  if (!Array.isArray(arr)) return [];
  if (arr.length <= n) return arr;

  // xorshift32
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

  // Fisher-Yates (seeded)
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a.slice(0, n);
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
  // Airtable: filterByFormula で完全一致検索
  const safe = sessionId.replace(/'/g, "\\'");
  const formula = `{session_id}='${safe}'`;

  const data = await airtableGetRecords({
    baseId,
    tableId: purchasesTableId,
    token,
    query: {
      maxRecords: 1,
      filterByFormula: formula,
      // created_at で並び替えたい場合は sort[0][field]=created_at 等も追加できる
    },
  });

  const rec = (data.records || [])[0];
  return rec || null;
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
  return airtableCreateRecord({
    baseId,
    tableId: purchasesTableId,
    token,
    fields,
  });
}

async function stripeRetrieveCheckoutSession(sessionId) {
  const stripeKey = requireEnv("STRIPE_SECRET_KEY");
  const url = `https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(sessionId)}?expand[]=line_items&expand[]=customer`;

  const r = await fetch(url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${stripeKey}`,
    },
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
  // 1) metadata.plan があれば最優先
  const metaPlan = session?.metadata?.plan;
  if (metaPlan) return String(metaPlan).toLowerCase();

  // 2) line_items の price id で判定（Envの price_ を使う）
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

async function getShopsByAreas({ baseId, shopsTableId, token, areaGroups, max = 7, seed }) {
  if (!areaGroups.length) return [];

  // Airtable filterByFormula: OR( {area_group}='A', {area_group}='B', ... ) AND status='active'（あれば）
  const parts = areaGroups.map(g => `{area_group}='${String(g).replace(/'/g, "\\'")}'`);
  const areaOr = `OR(${parts.join(",")})`;

  // status フィールドが無い/空でも落ちないように、存在前提にはしない（ただしあれば効く）
  // 「statusが空ならOK」も含めたい場合は OR({status}='', {status}='active') などに変える
  const statusClause = `OR({status}='active',{status}='')`;
  const formula = `AND(${areaOr},${statusClause})`;

  // まず多めに取ってから seededPick で7件にする
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
  const shops = records.map(r => ({ id: r.id, ...(r.fields || {}) }));

  // 7件固定抽出（再現性）
  return seededPick(shops, max, seed);
}

module.exports = async (req, res) => {
  try {
    if (req.method !== "GET") {
      return json(res, 405, { ok: false, error: "Method not allowed" });
    }

    const baseId = requireEnv("AIRTABLE_BASE_ID");
    const token = requireEnv("AIRTABLE_TOKEN");
    const purchasesTableId = requireEnv("AIRTABLE_PURCHASES_TABLE_ID");
    const shopsTableId = requireEnv("AIRTABLE_TABLE_ID");

    const sessionId = String(req.query?.session_id || "").trim();
    if (!sessionId) {
      return json(res, 400, { ok: false, error: "Missing session_id" });
    }

    // ① DB優先：purchases から session_id 検索
    let purchaseRec = null;
    try {
      purchaseRec = await getPurchaseBySessionId({
        baseId,
        purchasesTableId,
        token,
        sessionId,
      });
    } catch (e) {
      // Airtable自体が死んでる時は例外扱い → 500（ただし console.error は例外時のみ）
      console.error("[/api/results] Airtable purchases lookup failed:", e?.message || e);
      return json(res, 500, { ok: false, error: "Server error (purchases lookup)" });
    }

    let fields = purchaseRec?.fields || {};
    let paymentStatus = normalizePaymentStatus(fields.payment_status);

    // ② purchases に無ければ Stripe でフォールバック確認（そして self-heal で保存）
    if (!purchaseRec) {
      let session = null;
      try {
        session = await stripeRetrieveCheckoutSession(sessionId);
      } catch (e) {
        // session_id が不正 or Stripe側で見つからない等 → 未決済扱い（不正アクセス防止）
        return json(res, 402, { ok: false, error: "Unpaid (session not found)" });
      }

      const stripePaid =
        session?.payment_status === "paid" ||
        session?.status === "complete" ||
        session?.payment_status === "succeeded";

      if (!stripePaid) {
        return json(res, 402, { ok: false, error: "Unpaid" });
      }

      const plan = inferPlanFromStripeSession(session) || "";
      const who = session?.metadata?.who || "";
      const vibes = session?.metadata?.vibes || "";
      const area_groups = session?.metadata?.area_groups || session?.metadata?.areas || "";

      // self-heal: purchases に保存（手動運用ゼロのため）
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
          baseId,
          purchasesTableId,
          token,
          existingRecord: null,
          fields: upsertFields,
        });
        purchaseRec = created;
        fields = created.fields || {};
        paymentStatus = "paid";
      } catch (e) {
        // 保存失敗でも results を止めない（取得はできてるので返す）
        console.error("[/api/results] Airtable purchases self-heal save failed:", e?.message || e);
        fields = {
          session_id: sessionId,
          payment_status: "paid",
          plan,
          who,
          vibes,
          area_groups,
        };
        paymentStatus = "paid";
      }
    }

    // ③ paid 以外は 402（未決済session_id直叩き対策）
    if (paymentStatus !== "paid") {
      return json(res, 402, { ok: false, error: "Unpaid" });
    }

    const plan = String(fields.plan || "").toLowerCase().trim() || "explorer";
    const who = fields.who || "";
    const vibes = fields.vibes || "";
    const areaGroups = parseAreaGroups(fields.area_groups);

    // ④ shops を Airtable (shops_master) から取得して 7件返す
    let shops = [];
    try {
      shops = await getShopsByAreas({
        baseId,
        shopsTableId,
        token,
        areaGroups,
        max: 7,
        seed: sessionId,
      });
    } catch (e) {
      console.error("[/api/results] Airtable shops lookup failed:", e?.message || e);
      return json(res, 500, { ok: false, error: "Server error (shops lookup)" });
    }

    return json(res, 200, {
      ok: true,
      plan,
      who: who || vibes || "", // results.html は who を PREFS に使うので、空なら vibes を代替
      shops: Array.isArray(shops) ? shops : [],
    });
  } catch (e) {
    console.error("[/api/results] Fatal:", e?.message || e);
    return json(res, 500, { ok: false, error: "Server error" });
  }
};
