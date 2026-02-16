import Stripe from "stripe";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      return res.status(405).json({ error: "Method not allowed" });
    }

    const {
      plan,
      prefectures = [],
      area_groups = [],
      who,
      vibes = [],
      friction = [],
      no_preference = false,
    } = req.body || {};

    if (!plan || !["explorer", "connoisseur"].includes(plan)) {
      return res.status(400).json({ error: "Invalid plan" });
    }

    // 最小の入力検証（事故防止）
    const requiredAreas = plan === "connoisseur" ? 4 : 1;
    if (!Array.isArray(area_groups) || area_groups.length !== requiredAreas) {
      return res.status(400).json({ error: `area_groups must be ${requiredAreas}` });
    }
    if (!who) return res.status(400).json({ error: "Missing who" });
    if (!Array.isArray(vibes) || vibes.length < 1 || vibes.length > 2) {
      return res.status(400).json({ error: "vibes must be 1-2" });
    }

    const price =
      plan === "explorer"
        ? process.env.STRIPE_PRICE_EXPLORER
        : process.env.STRIPE_PRICE_CONNOISSEUR;

    if (!price) return res.status(500).json({ error: "Missing Stripe price env" });

    const baseUrl = process.env.BASE_URL || `https://${req.headers.host}`;

    // hearing回答をmetadataに保存（webhookで使える）
    const metadata = {
      plan,
      prefectures: JSON.stringify(prefectures),
      area_groups: JSON.stringify(area_groups),
      who,
      vibes: JSON.stringify(vibes),
      friction: JSON.stringify(friction),
      no_preference: String(!!no_preference),
    };

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      line_items: [{ price, quantity: 1 }],
      success_url: `${baseUrl}/results.html?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${baseUrl}/hearing.html?plan=${plan}`,
      metadata,
      // ここは後でメール回収を入れたければ追加
      // customer_email: ...
    });

    return res.status(200).json({ url: session.url });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "Checkout session failed" });
  }
}
