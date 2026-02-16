// /pages/api/stripe-webhook.js
import Stripe from "stripe";

export const config = {
  api: { bodyParser: false },
};

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: "2023-10-16",
});

async function readRawBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

async function airtableRequest(path, { method = "GET", body } = {}) {
  // ✅ あなたのEnv名に合わせる
  const baseId = process.env.AIRTABLE_BASE_ID;
  const apiKey = process.env.AIRTABLE_TOKEN; // Airtable Personal Access Token を想定
  if (!baseId || !apiKey) throw new Error("Missing AIRTABLE_BASE_ID or AIRTABLE_TOKEN");

  const url = `https://api.airtable.com/v0/${baseId}${path}`;

  const _fetch = globalThis.fetch || (await import("node-fetch")).default;

  const res = await _fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
  let json = {};
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { raw: text };
  }

  if (!res.ok) throw new Error(`Airtable error ${res.status}: ${text}`);
  return json;
}

async function findBySessionId(sessionId) {
  // ✅ purchases用テーブルID
  const tableId = process.env.AIRTABLE_PURCHASES_TABLE_ID;
  if (!tableId) throw new Error("Missing AIRTABLE_PURCHASES_TABLE_ID");

  const formula = encodeURIComponent(`{session_id}="${sessionId}"`);
  const data = await airtableRequest(`/${tableId}?filterByFormula=${formula}&maxRecords=10`);
  return data.records || [];
}

async function upsertBySessionId(sessionId, fields) {
  const tableId = process.env.AIRTABLE_PURCHASES_TABLE_ID;
  const records = await findBySessionId(sessionId);

  if (records.length === 0) {
    await airtableRequest(`/${tableId}`, {
      method: "POST",
      body: { records: [{ fields: { session_id: sessionId, ...fields } }] },
    });
    return;
  }

  const keep = records[0];
  await airtableRequest(`/${tableId}/${keep.id}`, {
    method: "PATCH",
    body: { fields: { session_id: sessionId, ...fields } },
  });

  // 二重登録防止：余分を削除して「1行のみ」
  if (records.length > 1) {
    for (const r of records.slice(1)) {
      try {
        await airtableRequest(`/${tableId}/${r.id}`, { method: "DELETE" });
      } catch (e) {
        console.error("[stripe-webhook] delete duplicate failed:", e?.message || e);
      }
    }
  }
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).send("Method Not Allowed");

  const sig = req.headers["stripe-signature"];
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!sig || !secret) return res.status(400).send("Missing signature/secret");

  let event;
  try {
    const raw = await readRawBody(req);
    event = stripe.webhooks.constructEvent(raw, sig, secret);
  } catch (e) {
    console.error("[stripe-webhook] signature verify failed:", e?.message || e);
    return res.status(400).send("Webhook Error");
  }

  if (event.type !== "checkout.session.completed") {
    return res.status(200).json({ received: true });
  }

  try {
    const session = event.data.object;
    const md = session.metadata || {};

    const createdAt = session.created
      ? new Date(session.created * 1000).toISOString()
      : new Date().toISOString();

    await upsertBySessionId(session.id, {
      payment_status: session.payment_status || "unpaid",
      amount_total: typeof session.amount_total === "number" ? session.amount_total : 0,
      currency: session.currency || "",
      plan: md.plan || "",
      created_at: createdAt,
      customer_email: session.customer_details?.email || session.customer_email || "",
      area_groups: md.area_groups || "",
      who: md.who || "",
      vibes: md.vibes || "",
    });

    return res.status(200).json({ received: true });
  } catch (e) {
    console.error("[stripe-webhook] handler error:", e?.message || e);
    return res.status(500).send("Internal Error");
  }
}
