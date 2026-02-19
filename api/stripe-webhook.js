// api/stripe_webhook.js
// URL: https://allnspyre-api.vercel.app/api/stripe_webhook
// Required ENV:
// - STRIPE_SECRET_KEY
// - STRIPE_WEBHOOK_SECRET
// - AIRTABLE_TOKEN
// - AIRTABLE_BASE_ID
// - AIRTABLE_PURCHASES_TABLE_ID
//
// Optional ENV (GA4 purchase):
// - GA4_MEASUREMENT_ID
// - GA4_API_SECRET
//
// Optional ENV (payments DB ingest via internal API):
// - PAYMENTS_INGEST_URL
// - PAYMENTS_INGEST_SECRET

const Stripe = require("stripe");

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: "2023-10-16",
});

async function readRawBody(req) {
  return await new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

async function airtableRequest(path, { method = "GET", body } = {}) {
  const baseId = process.env.AIRTABLE_BASE_ID;
  const token = process.env.AIRTABLE_TOKEN;

  if (!baseId || !token) {
    throw new Error("Missing AIRTABLE_BASE_ID or AIRTABLE_TOKEN");
  }

  const url = `https://api.airtable.com/v0/${baseId}${path}`;

  const _fetch =
    global.fetch ||
    (await import("node-fetch").then((m) => m.default).catch(() => null));

  if (!_fetch) throw new Error("fetch is not available");

  const res = await _fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { raw: text };
  }

  if (!res.ok) {
    throw new Error(`Airtable error ${res.status}: ${text}`);
  }
  return json;
}

async function findPurchasesBySessionId(sessionId) {
  const tableId = process.env.AIRTABLE_PURCHASES_TABLE_ID;
  if (!tableId) throw new Error("Missing AIRTABLE_PURCHASES_TABLE_ID");

  const formula = encodeURIComponent(`{session_id}="${sessionId}"`);
  const data = await airtableRequest(
    `/${tableId}?filterByFormula=${formula}&maxRecords=10`,
    { method: "GET" }
  );
  return Array.isArray(data.records) ? data.records : [];
}

async function createPurchase(fields) {
  const tableId = process.env.AIRTABLE_PURCHASES_TABLE_ID;
  return airtableRequest(`/${tableId}`, {
    method: "POST",
    body: { records: [{ fields }] },
  });
}

async function updatePurchase(recordId, fields) {
  const tableId = process.env.AIRTABLE_PURCHASES_TABLE_ID;
  return airtableRequest(`/${tableId}/${recordId}`, {
    method: "PATCH",
    body: { fields },
  });
}

async function deletePurchase(recordId) {
  const tableId = process.env.AIRTABLE_PURCHASES_TABLE_ID;
  return airtableRequest(`/${tableId}/${recordId}`, { method: "DELETE" });
}

async function upsertPurchaseBySessionId(sessionId, fields) {
  const records = await findPurchasesBySessionId(sessionId);

  if (records.length === 0) {
    await createPurchase({ session_id: sessionId, ...fields });
    return;
  }

  const keep = records[0];
  await updatePurchase(keep.id, { session_id: sessionId, ...fields });

  if (records.length > 1) {
    for (const r of records.slice(1)) {
      try {
        await deletePurchase(r.id);
      } catch (e) {
        console.error("[stripe-webhook] delete duplicate failed:", e?.message || e);
      }
    }
  }
}

function safeString(v) {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

function normalizePlan(mdPlan) {
  const raw = (mdPlan || "").toString().trim().toLowerCase();
  if (raw === "connoisseur") return "Connoisseur";
  if (raw === "explorer") return "Explorer";
  return safeString(mdPlan || "");
}

function toUsdAmount(amountMinor, currency) {
  // Stripe amount_total is in the smallest currency unit (e.g. cents for USD).
  // For GA4 value, send decimal major units.
  const cur = (currency || "").toLowerCase();
  const minor = typeof amountMinor === "number" ? amountMinor : 0;

  // For now we assume USD only in your business model.
  // If you later support 0-decimal currencies, handle here.
  const major = minor / 100;
  return Math.round(major * 100) / 100;
}

async function sendGa4Purchase({ clientId, transactionId, value, currency, plan }) {
  const measurementId = process.env.GA4_MEASUREMENT_ID;
  const apiSecret = process.env.GA4_API_SECRET;

  if (!measurementId || !apiSecret) return; // GA4送信を有効にしてない

  if (!clientId) {
    // client_id が無いと GA4 MP は受け付けるが、計測が弱くなる/紐付かない可能性
    // ただし“ゼロよりマシ”なので送るかは方針次第。ここでは送らない（確実性優先）
    console.error("[stripe-webhook] GA4 client_id missing; skip purchase MP");
    return;
  }

  const endpoint = `https://www.google-analytics.com/mp/collect?measurement_id=${encodeURIComponent(measurementId)}&api_secret=${encodeURIComponent(apiSecret)}`;

  const payload = {
    client_id: clientId,
    events: [
      {
        name: "purchase",
        params: {
          transaction_id: transactionId,
          currency: (currency || "usd").toUpperCase(),
          value: value,
          items: [
            {
              item_id: (plan || "").toString().toLowerCase(),
              item_name: plan,
              price: value,
              quantity: 1
            }
          ]
        }
      }
    ]
  };

  const _fetch =
    global.fetch ||
    (await import("node-fetch").then((m) => m.default).catch(() => null));
  if (!_fetch) throw new Error("fetch is not available");

  const res = await _fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });

  if (!res.ok) {
    const t = await res.text().catch(() => "");
    console.error("[stripe-webhook] GA4 MP failed:", res.status, t);
  }
}

async function postPaymentIngest(payment) {
  const url = process.env.PAYMENTS_INGEST_URL;
  const secret = process.env.PAYMENTS_INGEST_SECRET;
  if (!url || !secret) return;

  const _fetch =
    global.fetch ||
    (await import("node-fetch").then((m) => m.default).catch(() => null));
  if (!_fetch) throw new Error("fetch is not available");

  const res = await _fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Ingest-Secret": secret
    },
    body: JSON.stringify(payment)
  });

  if (!res.ok) {
    const t = await res.text().catch(() => "");
    console.error("[stripe-webhook] payments ingest failed:", res.status, t);
  }
}

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    res.statusCode = 405;
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.end("Method Not Allowed");
    return;
  }

  const sig = req.headers["stripe-signature"];
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  if (!sig || !webhookSecret) {
    res.statusCode = 400;
    res.end("Missing stripe-signature or STRIPE_WEBHOOK_SECRET");
    return;
  }

  let event;
  try {
    const rawBody = await readRawBody(req);
    event = stripe.webhooks.constructEvent(rawBody, sig, webhookSecret);
  } catch (e) {
    console.error("[stripe-webhook] signature verify failed:", e?.message || e);
    res.statusCode = 400;
    res.end("Webhook Error");
    return;
  }

  if (event.type !== "checkout.session.completed") {
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ received: true }));
    return;
  }

  try {
    const session = event.data.object || {};
    const md = session.metadata || {};

    const sessionId = session.id;
    if (!sessionId || typeof sessionId !== "string") {
      console.error("[stripe-webhook] missing session.id");
      res.statusCode = 200;
      res.end(JSON.stringify({ received: true }));
      return;
    }

    const paymentStatus = safeString(session.payment_status || "unpaid");
    const createdAt = session.created
      ? new Date(session.created * 1000).toISOString()
      : new Date().toISOString();

    const amountTotalMinor =
      typeof session.amount_total === "number" ? session.amount_total : 0;

    const currency = safeString(session.currency || "usd");
    const customerEmail = safeString(
      (session.customer_details && session.customer_details.email) ||
        session.customer_email ||
        ""
    );

    const plan = normalizePlan(md.plan || "");
    const areaGroups = safeString(md.area_groups || md.areaGroups || "");
    const who = safeString(md.who || "");
    const vibes = safeString(md.vibes || "");
    const gaClientId = safeString(md.ga_client_id || "");

    // 1) Airtable (現行の動作を維持)
    await upsertPurchaseBySessionId(sessionId, {
      payment_status: paymentStatus,
      amount_total: amountTotalMinor,
      currency,
      plan,
      created_at: createdAt,
      customer_email: customerEmail,
      area_groups: areaGroups,
      who,
      vibes,
      ga_client_id: gaClientId,
    });

    // 2) GA4 purchase（確定時のみ）
    const value = toUsdAmount(amountTotalMinor, currency);
    await sendGa4Purchase({
      clientId: gaClientId,
      transactionId: sessionId,
      value,
      currency,
      plan
    });

    // 3) payments保存（DB側に寄せたい場合：任意）
    //   → 本体側で transaction_id=sessionId を unique にして upsert すれば二重耐性もOK
    await postPaymentIngest({
      provider: "stripe",
      plan: (plan || "").toString().toLowerCase(), // "explorer"/"connoisseur"寄せ
      amount: amountTotalMinor,
      currency: currency,
      status: paymentStatus,
      transaction_id: sessionId,
      customer_email: customerEmail,
      created_at: createdAt,
      meta: {
        area_groups: areaGroups,
        who,
        vibes,
        ga_client_id: gaClientId
      }
    });

    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ received: true }));
  } catch (e) {
    console.error("[stripe-webhook] handler error:", e?.message || e);
    res.statusCode = 500;
    res.end("Internal Error");
  }
};
