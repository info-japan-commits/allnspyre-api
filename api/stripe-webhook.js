// api/stripe_webhook.js
// Vercel Serverless Function (Node) / CommonJS
// URL: https://allnspyre-api.vercel.app/api/stripe_webhook
// Required ENV:
// - STRIPE_SECRET_KEY
// - STRIPE_WEBHOOK_SECRET
// - AIRTABLE_TOKEN
// - AIRTABLE_BASE_ID
// - AIRTABLE_PURCHASES_TABLE_ID

const Stripe = require("stripe");

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: "2023-10-16",
});

// raw body を読む（Stripe署名検証に必須）
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

  // Node 18+ なら fetch がある。無い場合は node-fetch にフォールバック。
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

// upsert + 二重登録防止（最終的に1行だけ残す）
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
        // 要件：console.error のみ
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

module.exports = async (req, res) => {
  // GETで叩いたときに 404 にならず生存確認できるようにする（でも405）
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

  // checkout.session.completed のみ処理
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

    // ✅ plan 正規化（Airtable single select事故防止）
    const rawPlan = (md.plan || "").toString().trim().toLowerCase();
    const plan =
      rawPlan === "connoisseur"
        ? "Connoisseur"
        : rawPlan === "explorer"
          ? "Explorer"
          : safeString(md.plan || "");

    const paymentStatus = safeString(session.payment_status || "unpaid");

    const createdAt = session.created
      ? new Date(session.created * 1000).toISOString()
      : new Date().toISOString();

    const amountTotal =
      typeof session.amount_total === "number" ? session.amount_total : 0;

    const currency = safeString(session.currency || "");
    const customerEmail = safeString(
      (session.customer_details && session.customer_details.email) ||
        session.customer_email ||
        ""
    );

    const areaGroups = safeString(md.area_groups || md.areaGroups || "");
    const who = safeString(md.who || "");
    const vibes = safeString(md.vibes || "");

    await upsertPurchaseBySessionId(sessionId, {
      payment_status: paymentStatus,
      amount_total: amountTotal,
      currency,
      plan, // ✅ ここが正規化済み
      created_at: createdAt,
      customer_email: customerEmail,
      area_groups: areaGroups,
      who,
      vibes,
    });

    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ received: true }));
  } catch (e) {
    console.error("[stripe-webhook] handler error:", e?.message || e);
    // Stripeは 2xx 以外だと再送するので、取りこぼし防止で500返す
    res.statusCode = 500;
    res.end("Internal Error");
  }
};
