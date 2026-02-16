import Stripe from "stripe";
import Airtable from "airtable";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const base = new Airtable({
  apiKey: process.env.AIRTABLE_TOKEN,
}).base(process.env.AIRTABLE_BASE_ID);

export default async function handler(req, res) {
  try {
    const { session_id } = req.query;
    if (!session_id) {
      return res.status(400).json({ error: "Missing session_id" });
    }

    const session = await stripe.checkout.sessions.retrieve(session_id);
    const metadata = session.metadata;

    if (!metadata || !metadata.area_groups) {
      return res.status(400).json({ error: "No area_groups provided" });
    }

    const areaGroups = JSON.parse(metadata.area_groups);

    const records = await base(process.env.AIRTABLE_TABLE_ID)
      .select({
        filterByFormula: `OR(${areaGroups
          .map((g) => `{area_group}='${g}'`)
          .join(",")})`,
        maxRecords: 7,
      })
      .all();

    const shops = records.map((r) => r.fields);

    return res.status(200).json({
      ok: true,
      plan: metadata.plan,
      shops,
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "results failed" });
  }
}
