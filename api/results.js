// /api/results.js
// DB優先（Airtable purchases）→ 無ければStripeでretrieve（フォールバック）→ paid以外は402
// エリア版: area_groups に分散させて抽出（偏り防止）
// GPS版: lat/lngから距離計算して近い順に7件返す

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

// Haversine距離計算（km）
function haversineKm(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLng / 2) * Math.sin(dLng / 2);
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
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

  const perAreaLists = {};
  for (const ag of areas) {
    perAreaLists[ag] = await getShopsByArea({ baseId, shopsTableId, token, areaGroup: ag });
    perAreaLists[ag] = seededShuffle(perAreaLists[ag], `${seed}:${ag}`);
  }

  const baseN = Math.max(1, Math.floor(total / areas.length));
  let picks = [];

  for (const ag of areas) {
    const list = perAreaLists[ag] || [];
    picks = picks.concat(list.slice(0, baseN));
  }

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

  picks = picks.slice(0, total);
  return picks;
}

// GPS版: 都道府県判定 → Who/Vibe絞り込み → 距離順7件

// ① GPS座標 → Airtableのarea_groupのprefixを返す
function getPrefectureFromCoords(lat, lng) {
  if (lat > 42.8 && lat < 43.3 && lng > 141.0 && lng < 141.6) return "Hokkaido";
  if (lat > 41.6 && lat < 41.9 && lng > 140.5 && lng < 141.0) return "Hokkaido";
  if (lat > 41.3 && lat < 45.6 && lng > 139.3 && lng < 145.9) return "Hokkaido";
  if (lat > 35.5 && lat < 35.85 && lng > 139.4 && lng < 139.95) return "Tokyo";
  if (lat > 35.1 && lat < 35.6 && lng > 139.3 && lng < 139.8) return "Kanagawa";
  // 大阪を先に判定（KyotoやHyogoより前）
  if (lat > 34.3 && lat < 35.1 && lng > 135.2 && lng < 135.9) return "Osaka";
  if (lat > 34.9 && lat < 35.3 && lng > 135.6 && lng < 136.0) return "Kyoto";
  if (lat > 34.5 && lat < 35.0 && lng > 134.6 && lng < 135.3) return "Hyogo";
  if (lat > 34.2 && lat < 34.6 && lng > 132.2 && lng < 132.8) return "Hiroshima";
  if (lat > 33.3 && lat < 33.9 && lng > 130.1 && lng < 130.7) return "Fukuoka";
  return null;
}

// ② 都道府県 + Who/Vibeでフィルタしてショップ取得
async function getShopsByPrefectureAndPrefs({ baseId, shopsTableId, token, prefecture, who, vibes }) {
  const prefSafe = String(prefecture).replace(/'/g, "\\'");
  const whoPart = who ? `FIND("${who}", {best_with}) > 0` : "";
  const vibeParts = vibes && vibes.length > 0
    ? vibes.map(v => `FIND("${v}", {best_vibe}) > 0`).join(", ")
    : "";

  let formula = `FIND("${prefSafe}", {area_group}) > 0`;
  if (whoPart) formula = `AND(${formula}, ${whoPart})`;
  if (vibeParts) formula = `AND(${formula}, OR(${vibeParts}))`;

  const allShops = [];
  let offset;

  while (true) {
    const query = { pageSize: 100, maxRecords: 500, filterByFormula: formula };
    if (offset) query.offset = offset;

    const data = await airtableGetRecords({ baseId, tableId: shopsTableId, token, query });
    for (const r of (data.records || [])) {
      const fields = r.fields || {};
      if (fields.lat && fields.lng) allShops.push({ id: r.id, ...fields });
    }
    offset = data.offset;
    if (!offset) break;
  }

  return allShops;
}

// GPS版メイン: 都道府県絞り込み → Who/Vibe絞り込み → 距離順7件
async function getShopsByGps({ baseId, shopsTableId, token, lat, lng, who, vibes, total = 7 }) {
  const prefecture = getPrefectureFromCoords(lat, lng);
  let candidates = [];

  if (prefecture) {
    // Who/Vibe込みで取得
    candidates = await getShopsByPrefectureAndPrefs({
      baseId, shopsTableId, token, prefecture, who, vibes,
    });
    // 候補が少なすぎる場合はWho/Vibeを外して再取得
    if (candidates.length < total) {
      candidates = await getShopsByPrefectureAndPrefs({
        baseId, shopsTableId, token, prefecture, who: "", vibes: [],
      });
    }
  }

  // 都道府県判定不能 or 候補0件 → 全国から近い順（フォールバック）
  if (candidates.length === 0) {
    const data = await airtableGetRecords({
      baseId, tableId: shopsTableId, token,
      query: { pageSize: 100, maxRecords: 200, filterByFormula: "AND({lat}!='', {lng}!='')" },
    });
    candidates = (data.records || []).map(r => ({ id: r.id, ...(r.fields || {}) }));
  }

  // ③ 距離計算して近い順にソート
  return candidates
    .filter(s => s.lat && s.lng)
    .map(s => ({ ...s, _distanceKm: haversineKm(lat, lng, Number(s.lat), Number(s.lng)) }))
    .sort((a, b) => a._distanceKm - b._distanceKm)
    .slice(0, total);
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
      const source = session?.metadata?.source || "";
      const latRaw = session?.metadata?.lat ? parseFloat(session.metadata.lat) : null;
      const lngRaw = session?.metadata?.lng ? parseFloat(session.metadata.lng) : null;
      const lat = latRaw !== null && !isNaN(latRaw) ? latRaw : null;
      const lng = lngRaw !== null && !isNaN(lngRaw) ? lngRaw : null;

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
          source: source || null,
          lat: lat,
          lng: lng,
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
        fields = { session_id: sessionId, payment_status: "paid", plan, who, vibes, area_groups, source, lat, lng };
        paymentStatus = "paid";
      }
    }

    // ③ paid以外は402
    if (paymentStatus !== "paid") return json(res, 402, { ok: false, error: "Unpaid" });

    const plan = String(fields.plan || "").toLowerCase().trim() || "explorer";
    const who = fields.who || "";
    const vibes = fields.vibes || "";
    const source = String(fields.source || "").trim();
    const isGps = source === "hearing_gps";
    const lat = parseFloat(fields.lat || "");
    const lng = parseFloat(fields.lng || "");

    let shops = [];

    // ④ GPS版 or エリア版で分岐
    if (isGps && !isNaN(lat) && !isNaN(lng)) {
      // GPS版: 距離順で7件
      try {
        shops = await getShopsByGps({
          baseId,
          shopsTableId,
          token,
          lat,
          lng,
          who,
          vibes: vibes ? vibes.split(",").map(s => s.trim()).filter(Boolean) : [],
          total: 7,
        });
      } catch (e) {
        console.error("[/api/results] GPS shops lookup failed:", e?.message || e);
        return json(res, 500, { ok: false, error: "Server error (GPS shops lookup)" });
      }
    } else {
      // エリア版: area_groupsで分散抽出
      const areaGroups = parseAreaGroups(fields.area_groups);
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
    }

    return json(res, 200, {
      ok: true,
      plan,
      who: who || vibes || "",
      source,
      shops: Array.isArray(shops) ? shops : [],
    });
  } catch (e) {
    console.error("[/api/results] Fatal:", e?.message || e);
    return json(res, 500, { ok: false, error: "Server error" });
  }
};
