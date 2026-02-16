import Stripe from "stripe";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

function getPlanFromReferer(req) {
  const ref = req.headers?.referer || "";
  try {
    const u = new URL(ref);
    const p = u.searchParams.get("plan");
    return p === "explorer" || p === "connoisseur" ? p : null;
  } catch {
    return null;
  }
}

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
    if (req.method !== "POST") return res.status(405).json({ ok:false, error:"METHOD_NOT_ALLOWED" });

    const body = req.body || {};

    // 1) plan確定：body.plan → referer plan の順で採用（UI変更なしで事故を吸収）
    let plan = body.plan;
    if (plan !== "explorer" && plan !== "connoisseur") {
      const refPlan = getPlanFromReferer(req);
      if (refPlan) plan = refPlan;
    }
    if (plan !== "explorer" && plan !== "connoisseur") {
      return res.status(400).json({ ok:false, error:"INVALID_PLAN" });
    }

    // 2) payload（固定）
    const prefectures = toArray(body.prefectures);
    const area_groups_raw = toArray(body.area_groups);
    const who = body.who;
    const vibes = toArray(body.vibes);
    const friction = body.friction ?? "";
    const no_preference = !!body.no_preference;

    // 3) area_groups count + uniqueness
    const requiredAreas = plan === "connoisseur" ? 4 : 1;

    if (!Array.isArray(area_groups_raw) || area_groups_raw.length !== requiredAreas) {
      return res.status(400).json({ ok:false, error:"INVALID_AREA_GROUPS_COUNT", message:`area_groups must be ${requiredAreas}` });
    }

    const area_groups = area_groups_raw.map(norm).filter(Boolean);
    const area_unique = uniq(area_groups);

    if (plan === "explorer") {
      if (area_unique.length !== 1) {
        return res.status(400).json({ ok:false, error:"INVALID_AREA_GROUPS_EXPLORER" });
      }
    } else {
      if (area_unique.length !== 4) {
        return res.status(400).json({ ok:false, error:"DUPLICATE_AREA_GROUPS" });
      }
    }

    // 4) who/vibes
    if (!who || typeof who !== "string" || !who.trim()) return res.status(400).json({ ok:false, error:"MISSING_WHO" });
    if (!Array.isArray(vibes) || vibes.length < 1 || vibes.length > 2) {
      return res.status(400).json({ ok:false, error:"INVALID_VIBES_COUNT" });
    }

    // 5) price決定（ここでplanが確定してるので間違いようがない）
    const price = plan === "explorer"
      ? process.env.STRIPE_PRICE_EXPLORER
      : process.env.STRIPE_PRICE_CONNOISSEUR;

    if (!price) return res.status(500).json({ ok:false, error:"MISSING_STRIPE_PRICE_ENV", plan });

    const baseUrl = process.env.BASE_URL || `https://${req.headers.host}`;

    // 6) metadata（互換＋hearing）
    const hearing = {
      plan,
      prefectures,
      area_groups: plan === "connoisseur" ? area_unique : area_groups,
      who: who.trim(),
      vibes: vibes.map(norm).filter(Boolean),
      friction,
      no_preference,
      source: "hearing.html",
    };

    const metadata = {
      plan,
      prefectures: JSON.stringify(prefectures),
      area_groups: JSON.stringify(hearing.area_groups),
      who: hearing.who,
      vibes: JSON.stringify(hearing.vibes),
      friction: JSON.stringify(friction),
      no_preference: String(!!no_preference),
      hearing: JSON.stringify(hearing),
    };

    console.log("CHECKOUT_PLAN_FINAL", plan, "PRICE", price);

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      line_items: [{ price, quantity: 1 }],
      success_url: `${baseUrl}/results.html?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${baseUrl}/hearing.html?plan=${encodeURIComponent(plan)}`,
      metadata,
    });

    return res.status(200).json({ ok:true, url: session.url });
  } catch (e) {
    console.error("checkout failed", e);
    return res.status(500).json({ ok:false, error:"CHECKOUT_SESSION_FAILED" });
  }
}
