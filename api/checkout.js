import Stripe from "stripe";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

function uniq(arr){ return [...new Set(arr)]; }

export default async function handler(req, res) {
  try {
    if (req.method !== "POST")
      return res.status(405).json({ ok:false, error:"METHOD_NOT_ALLOWED" });

    const body = req.body || {};

    // ===== hearing payload（固定）=====
    const hearing = {
      plan: body.plan,
      prefectures: Array.isArray(body.prefectures) ? body.prefectures : [],
      area_groups: Array.isArray(body.area_groups) ? body.area_groups : [],
      who: body.who,
      vibes: Array.isArray(body.vibes) ? body.vibes : [],
      friction: body.friction ?? "",
      no_preference: !!body.no_preference,
      source: "hearing.html",
    };
console.log("AREAS_IN", hearing.area_groups, "UNIQ", [...new Set(hearing.area_groups)]);

    if (!["explorer","connoisseur"].includes(hearing.plan))
      return res.status(400).json({ ok:false, error:"INVALID_PLAN" });

    // ===== area validation =====
    const required = hearing.plan === "connoisseur" ? 4 : 1;

    if (hearing.area_groups.length !== required)
      return res.status(400).json({ ok:false, error:"INVALID_AREA_COUNT" });

    if (uniq(hearing.area_groups).length !== required)
      return res.status(400).json({ ok:false, error:"DUPLICATE_AREA_GROUPS" });

    if (!hearing.who)
      return res.status(400).json({ ok:false, error:"MISSING_WHO" });

    if (hearing.vibes.length < 1 || hearing.vibes.length > 2)
      return res.status(400).json({ ok:false, error:"INVALID_VIBES" });

    // ===== price selection =====
    const price =
      hearing.plan === "explorer"
        ? process.env.STRIPE_PRICE_EXPLORER
        : process.env.STRIPE_PRICE_CONNOISSEUR;

    if (!price)
      return res.status(500).json({ ok:false, error:"MISSING_PRICE_ENV" });

    const baseUrl =
      process.env.BASE_URL || `https://${req.headers.host}`;

    console.log("FINAL_PLAN", hearing.plan, "PRICE", price);

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      line_items: [{ price, quantity: 1 }],
      success_url: `${baseUrl}/results.html?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${baseUrl}/hearing.html?plan=${hearing.plan}`,
      metadata: {
        plan: hearing.plan,
        hearing: JSON.stringify(hearing),
        area_groups: JSON.stringify(hearing.area_groups),
        who: hearing.who,
        vibes: JSON.stringify(hearing.vibes),
        no_preference: String(hearing.no_preference),
      },
    });

    return res.status(200).json({ ok:true, url: session.url });
  } catch (e) {
    console.error("checkout error", e);
    return res.status(500).json({ ok:false, error:"CHECKOUT_FAILED" });
  }
}
