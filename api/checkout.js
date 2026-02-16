import Stripe from "stripe";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

function norm(v) {
  return typeof v === "string" ? v.trim() : "";
}
function toArray(v) {
  return Array.isArray(v) ? v : [];
}
function uniq(arr) {
  return [...new Set(arr)];
}

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      return res.status(405).json({ ok: false, error: "METHOD_NOT_ALLOWED" });
    }

    const body = req.body || {};
    const plan = body.plan;

    // ---- plan validation ----
    if (!plan || !["explorer", "connoisseur"].includes(plan)) {
      return res.status(400).json({ ok: false, error: "INVALID_PLAN" });
    }

    // ---- payload (fixed contract) ----
    const prefectures = toArray(body.prefectures);
    const area_groups_raw = toArray(body.area_groups);
    const who = body.who;
    const vibes = toArray(body.vibes);
    const friction = body.friction; // payloadはstring想定だが互換で保持
    const no_preference = !!body.no_preference;

    // ---- required validations (fixed) ----
    const requiredAreas = plan === "connoisseur" ? 4 : 1;

    // area_groups count
    if (!Array.isArray(area_groups_raw) || area_groups_raw.length !== requiredAreas) {
      return res.status(400).json({
        ok: false,
        error: "INVALID_AREA_GROUPS_COUNT",
        message: `area_groups must be ${requiredAreas}`,
      });
    }

    // normalize + uniqueness
    const area_groups = area_groups_raw.map(norm).filter(Boolean);
    const area_unique = uniq(area_groups);

    // explorer: 1 and unique 1
    if (plan === "explorer") {
      if (area_groups.length !== 1 || area_unique.length !== 1) {
        return res.status(400).json({
          ok: false,
          error: "INVALID_AREA_GROUPS_EXPLORER",
          message: "Explorer requires exactly 1 area group.",
        });
      }
    }

    // connoisseur: 4 and unique 4  ← ★ここが今回の最優先
    if (plan === "connoisseur") {
      if (area_groups.length !== 4) {
        return res.status(400).json({
          ok: false,
          error: "INVALID_AREA_GROUPS_COUNT_CONNOISSEUR",
          message: "Connoisseur requires exactly 4 area groups.",
        });
      }
      if (area_unique.length !== 4) {
        return res.status(400).json({
          ok: false,
          error: "DUPLICATE_AREA_GROUPS",
          message: "Connoisseur requires 4 unique area groups.",
        });
      }
    }

    // who required
    if (!who || typeof who !== "string" || !who.trim()) {
      return res.status(400).json({ ok: false, error: "MISSING_WHO" });
    }

    // vibes 1-2 required
    if (!Array.isArray(vibes) || vibes.length < 1 || vibes.length > 2) {
      return res.status(400).json({ ok: false, error: "INVALID_VIBES_COUNT", message: "vibes must be 1-2" });
    }

    // ---- price env ----
    const price =
      plan === "explorer" ? process.env.STRIPE_PRICE_EXPLORER : process.env.STRIPE_PRICE_CONNOISSEUR;

    if (!price) {
      return res.status(500).json({ ok: false, error: "MISSING_STRIPE_PRICE_ENV" });
    }

    // ---- base url ----
    const baseUrl = process.env.BASE_URL || `https://${req.headers.host}`;

    // ---- metadata (backward compatible) ----
    // 既存resultsが metadata.area_groups / metadata.who / metadata.vibes を読むので維持
    // 将来のために metadata.hearing も追加（互換拡張：壊さない）
    const hearing = {
      plan,
      prefectures,
      area_groups: plan === "connoisseur" ? area_unique : area_groups, // connoisseurはユニークを確実に保存
      who: who.trim(),
      vibes: vibes.map(norm).filter(Boolean),
      friction: friction ?? "",
      no_preference,
      source: "hearing.html",
    };

    const metadata = {
      plan,
      prefectures: JSON.stringify(prefectures),
      area_groups: JSON.stringify(hearing.area_groups),
      who: hearing.who,
      vibes: JSON.stringify(hearing.vibes),
      friction: JSON.stringify(friction ?? ""),
      no_preference: String(!!no_preference),

      // 互換拡張（results側があれば優先して読める）
      hearing: JSON.stringify(hearing),
    };

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      line_items: [{ price, quantity: 1 }],
      success_url: `${baseUrl}/results.html?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${baseUrl}/hearing.html?plan=${encodeURIComponent(plan)}`,
      metadata,
    });

    return res.status(200).json({ ok: true, url: session.url });
  } catch (e) {
    console.error("checkout failed", e);
    return res.status(500).json({ ok: false, error: "CHECKOUT_SESSION_FAILED" });
  }
}
