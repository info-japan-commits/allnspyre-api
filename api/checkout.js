// /api/checkout.js
const STRIPE_API = "https://api.stripe.com/v1";

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

function getBaseUrl(req) {
  if (process.env.BASE_URL) return process.env.BASE_URL.replace(/\/$/, "");

  const proto =
    (req.headers["x-forwarded-proto"] || "").toString().split(",")[0].trim() || "https";
  const host = (req.headers["x-forwarded-host"] || req.headers.host || "").toString();
  return `${proto}://${host}`.replace(/\/$/, "");
}

function pickPriceId(plan) {
  const p = String(plan || "").toLowerCase().trim();
  if (p === "connoisseur") return requireEnv("STRIPE_PRICE_CONNOISSEUR");
  return requireEnv("STRIPE_PRICE_EXPLORER");
}

// hearing からの入力を metadata に詰める（壊れないよう “あるものだけ”）
function buildMetadata(body, plan) {
  const md = {};
  md.plan = String(plan || "").toLowerCase().trim() || "explorer";

  const who = body?.who ?? body?.prefs ?? body?.with ?? "";
  const vibes = body?.vibes ?? body?.vibe ?? "";
  const areas = body?.area_groups ?? body?.areas ?? body?.area_group ?? "";

  // ✅ 追加：GA client_id（Measurement Protocol 用）
  const gaClientId = body?.ga_client_id ?? body?.gaClientId ?? "";

  if (who) md.who = String(who);
  if (vibes) md.vibes = Array.isArray(vibes) ? vibes.join(",") : String(vibes);
  if (areas) md.area_groups = Array.isArray(areas) ? areas.join(",") : String(areas);

  if (gaClientId) md.ga_client_id = String(gaClientId);

  return md;
}

async function stripePostForm(path, token, params) {
  const url = `${STRIPE_API}${path}`;
  const body = new URLSearchParams();

  Object.entries(params || {}).forEach(([k, v]) => {
    if (v === undefined || v === null) return;
    body.append(k, String(v));
  });

  const r = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });

  const text = await r.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch (_) {}

  if (!r.ok) {
    const msg = data?.error?.message || `Stripe error (${r.status})`;
    const err = new Error(msg);
    err.status = r.status;
    err.stripe = data;
    throw err;
  }
  return data;
}

module.exports = async (req, res) => {
  try {
    if (req.method !== "GET" && req.method !== "POST") {
      return json(res, 405, { ok: false, error: "Method not allowed" });
    }

    const stripeKey = requireEnv("STRIPE_SECRET_KEY");

    const plan = String(req.query?.plan || (req.body?.plan ?? "")).toLowerCase().trim() || "explorer";
    const priceId = pickPriceId(plan);

    let metadata = { plan };
    if (req.method === "POST") {
      metadata = buildMetadata(req.body || {}, plan);
    }

    const baseUrl = getBaseUrl(req);

    const successUrl = `${baseUrl}/results.html?session_id={CHECKOUT_SESSION_ID}&plan=${encodeURIComponent(plan)}`;
    const cancelUrl = `${baseUrl}/hearing.html?plan=${encodeURIComponent(plan)}`;

    const params = {
      mode: "payment",
      success_url: successUrl,
      cancel_url: cancelUrl,
      billing_address_collection: "auto",

      // metadata[*]
      ...Object.fromEntries(Object.entries(metadata).map(([k, v]) => [`metadata[${k}]`, v])),

      // line_items[0]
      "line_items[0][price]": priceId,
      "line_items[0][quantity]": 1,
    };

    const session = await stripePostForm("/checkout/sessions", stripeKey, params);

    return json(res, 200, { ok: true, url: session.url, id: session.id });
  } catch (e) {
    console.error("[/api/checkout] error:", e?.message || e);
    return json(res, 500, { ok: false, error: e?.message || "Server error" });
  }
};
