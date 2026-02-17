// /api/checkout.js
// Stripe Checkout セッション作成（Live/TestどちらでもEnvに従って動く）
// hearing.html から呼ばれる想定：/api/checkout?plan=explorer など

const STRIPE_API = "https://api.stripe.com/v1";
const DEFAULT_CURRENCY = "usd";

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
  // BASE_URL があれば最優先（本番で確実）
  if (process.env.BASE_URL) return process.env.BASE_URL.replace(/\/$/, "");

  // ない場合はHostから推定（ただしCDN/プロキシでズレる可能性あるので本番はBASE_URL推奨）
  const proto =
    (req.headers["x-forwarded-proto"] || "").toString().split(",")[0].trim() || "https";
  const host = (req.headers["x-forwarded-host"] || req.headers.host || "").toString();
  return `${proto}://${host}`.replace(/\/$/, "");
}

function pickPriceId(plan) {
  const p = String(plan || "").toLowerCase().trim();
  if (p === "connoisseur") return requireEnv("STRIPE_PRICE_CONNOISSEUR");
  return requireEnv("STRIPE_PRICE_EXPLORER"); // default explorer
}

// hearing からの入力を metadata に詰める（任意）
// ※ UIのfield名が違っても壊れないように“あるものだけ”詰める
function buildMetadata(body, plan) {
  const md = {};
  md.plan = String(plan || "").toLowerCase().trim() || "explorer";

  const who = body?.who ?? body?.prefs ?? body?.with ?? "";
  const vibes = body?.vibes ?? body?.vibe ?? "";
  const areas = body?.area_groups ?? body?.areas ?? body?.area_group ?? "";

  if (who) md.who = String(who);
  if (vibes) md.vibes = String(vibes);
  if (areas) md.area_groups = Array.isArray(areas) ? areas.join(",") : String(areas);

  return md;
}

async function stripePostForm(path, token, params) {
  const url = `${STRIPE_API}${path}`;
  const body = new URLSearchParams();

  Object.entries(params || {}).forEach(([k, v]) => {
    if (v === undefined || v === null) return;
    if (Array.isArray(v)) {
      // Stripe form-encode array (e.g. line_items[0][price])
      // ここでは callers 側でキーを flatten して渡す設計にしてるので通常ここは来ない
      v.forEach((vv) => body.append(k, String(vv)));
    } else {
      body.append(k, String(v));
    }
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

    // metadata（POSTならbodyから拾う / GETなら空でOK）
    let metadata = { plan };
    if (req.method === "POST") {
      metadata = buildMetadata(req.body || {}, plan);
    }

    const baseUrl = getBaseUrl(req);

    // success/cancel は UI固定方針に沿って results.html / hearing.html を使う
    const successUrl = `${baseUrl}/results.html?session_id={CHECKOUT_SESSION_ID}&plan=${encodeURIComponent(plan)}`;
    const cancelUrl = `${baseUrl}/hearing.html?plan=${encodeURIComponent(plan)}`;

    // Stripe: Checkout Session 作成
    // line_items は form-encode で index指定が必要
    const params = {
      mode: "payment",
      success_url: successUrl,
      cancel_url: cancelUrl,
      // これ入れると自動領収/メール等の体験が安定する（任意）
      billing_address_collection: "auto",
      // metadata
      ...Object.fromEntries(Object.entries(metadata).map(([k, v]) => [`metadata[${k}]`, v])),
      // line_items[0]
      "line_items[0][price]": priceId,
      "line_items[0][quantity]": 1,
    };

    const session = await stripePostForm("/checkout/sessions", stripeKey, params);

    // hearing.html 側は {url} を受け取って location.href する想定
    return json(res, 200, { ok: true, url: session.url, id: session.id });
  } catch (e) {
    // 例外時のみログ
    console.error("[/api/checkout] error:", e?.message || e);
    return json(res, 500, { ok: false, error: e?.message || "Server error" });
  }
};
