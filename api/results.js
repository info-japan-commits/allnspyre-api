import Stripe from "stripe";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

function safeJsonParse(s, fallback) {
  try {
    return JSON.parse(s);
  } catch {
    return fallback;
  }
}

export default async function handler(req, res) {
  try {
    // GET /api/results?session_id=...
    const session_id = req.query?.session_id;
    if (!session_id) return res.status(400).json({ error: "Missing session_id" });

    // Stripeからセッション取得（metadataを読む）
    const session = await stripe.checkout.sessions.retrieve(session_id);

    const md = session?.metadata || {};

    const plan = md.plan || null;
    const prefectures = safeJsonParse(md.prefectures || "[]", []);
    const area_groups = safeJsonParse(md.area_groups || "[]", []);
    const who = md.who || null;
    const vibes = safeJsonParse(md.vibes || "[]", []);
    const friction = safeJsonParse(md.friction || "[]", []);
    const no_preference = md.no_preference === "true";

    // ここで必須チェック（いまの画面エラーの根本）
    if (!Array.isArray(area_groups) || area_groups.length === 0) {
      return res.status(400).json({ error: "No areaGroups provided" });
    }

    // いったん「復元できた」ことを返す（次にAirtable抽出を足す）
    return res.status(200).json({
      ok: true,
      plan,
      prefectures,
      area_groups,
      who,
      vibes,
      friction,
      no_preference,
      session_id,
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "results failed" });
  }
}
