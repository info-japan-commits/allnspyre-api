// /api/checkout.js
import Stripe from "stripe";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || "", {
  apiVersion: "2025-01-27.acacia", // 多少違ってもOK（Stripe側で互換）
});

function json(res, status, obj) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(obj));
}

function getBaseUrl(req) {
  // BASE_URLがあれば最優先（例: https://allnspyre-api.vercel.app）
  const envBase = process.env.BASE_URL;
  if (envBase && typeof envBase === "string" && envBase.startsWith("http")) return envBase.replace(/\/$/, "");

  // なければリクエストから推定（Vercelで動く）
  const proto = (req.headers["x-forwarded-proto"] || "https").toString();
  const host = (req.headers["x-forwarded-host"] || req.headers.host || "").toString();
  return `${proto}://${host}`.replace(/\/$/, "");
}

function normalizePlan(v) {
  const s = (v ?? "").toString().trim().toLowerCase();
  if (s === "explorer") return "explorer";
  if (s === "connoisseur") return "connoisseur";
  return "";
}

function asString(v) {
  if (v === undefined || v === null) return "";
  if (Array.isArray(v)) return v.map(x => String(x)).join(","); // metadataはstring only
  return String(v);
}

export default async function handler(req, res) {
  // GETで叩いたらMETHOD_NOT_ALLOWEDにする（今まで通り）
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return json(res, 405, { ok: false, error: "METHOD_NOT_ALLOWED" });
  }

  // Stripeキーがない場合は即死
  if (!process.env.STRIPE_SECRET_KEY) {
    console.error("[checkout] missing STRIPE_SECRET_KEY");
    return json(res, 500, { ok: false, error: "SERVER_MISCONFIG" });
  }

  try {
    // bodyはJSON想定（Studio/フロントがPOSTする）
    const body = req.body || {};

    // planは「body優先」→「query」→（それでも無ければNG）
    const plan = normalizePlan(body.plan || req.query?.plan);
    if (!plan) {
      // ★ここが最重要：デフォルト禁止（誤課金防止）
      return json(res, 400, { ok: false, error: "INVALID_PLAN" });
    }

    const priceExplorer = process.env.STRIPE_PRICE_EXPLORER;
    const priceConnoisseur = process.env.STRIPE_PRICE_CONNOISSEUR;
    if (!priceExplorer || !priceConnoisseur) {
      console.error("[checkout] missing STRIPE_PRICE_EXPLORER or STRIPE_PRICE_CONNOISSEUR");
      return json(res, 500, { ok: false, error: "SERVER_MISCONFIG_PRICE" });
    }

    const priceId = plan === "explorer" ? priceExplorer : priceConnoisseur;

    // hearingから来る値（無ければ空でOK）
    // ※ metadataはstringしか入れられないので正規化する
    const who = asString(body.who);
    const vibes = asString(body.vibes); // 例: ["quiet_reflective","deeply_local"] or "quiet_reflective,deeply_local"
    const areaGroups = asString(body.area_groups || body.areas || body.areaGroups);

    const customerEmail = asString(body.customer_email || body.email);

    const baseUrl = getBaseUrl(req);

    // success/cancel（results UIは固定なので results.html へ）
    // results.html は ?session_id=... を読む仕様なので必ず付与
    const successUrl = `${baseUrl}/results.html?session_id={CHECKOUT_SESSION_ID}&plan=${encodeURIComponent(plan)}`;
    const cancelUrl = `${baseUrl}/hearing.html?plan=${encodeURIComponent(plan)}`;

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: successUrl,
      cancel_url: cancelUrl,

      // 任意：メールが取れるなら設定（Stripe側でも入力される）
      ...(customerEmail ? { customer_email: customerEmail } : {}),

      // ★Webhook / resultsで使うために必ず入れる
      metadata: {
        plan,
        who,
        vibes,
        area_groups: areaGroups,
      },
    });

    // フロントはこのURLへリダイレクトするだけ
    return json(res, 200, { ok: true, url: session.url, id: session.id, plan });
  } catch (e) {
    console.error("[checkout] handler error:", e?.message || e);
    return json(res, 500, { ok: false, error: "CHECKOUT_FAILED" });
  }
}
