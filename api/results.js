import Stripe from "stripe";
import Airtable from "airtable";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const base = new Airtable({ apiKey: process.env.AIRTABLE_TOKEN }).base(
  process.env.AIRTABLE_BASE_ID
);

// ---------------- helpers ----------------
function norm(v) {
  return v ? String(v).trim().toLowerCase() : null;
}
function arr(v) {
  return Array.isArray(v) ? v : v ? [v] : [];
}

// area_group normalize
function asStr(v) {
  if (Array.isArray(v)) return v[0] ? String(v[0]) : "";
  if (v && typeof v === "object") {
    if ("name" in v) return String(v.name || "");
    if ("value" in v) return String(v.value || "");
  }
  return v ? String(v) : "";
}
function areaStr(shop) {
  return asStr(shop.area_group).trim();
}

function matchesWho(shop, hearing) {
  const target = norm(hearing.who);
  if (!target) return false;
  const bw = arr(shop.best_with).map(norm).filter(Boolean);
  return bw.includes(target);
}

function matchesAnyVibe(shop, hearing) {
  if (hearing.no_preference) return true;
  const targets = arr(hearing.vibes).map(norm).filter(Boolean);
  if (targets.length === 0) return true; // vibes欠損は緩和
  const bv = arr(shop.best_vibe).map(norm).filter(Boolean);
  return bv.some((v) => targets.includes(v));
}

function uniquePush(picked, candidates, limit) {
  const seen = new Set(picked.map((x) => x.shop_id));
  for (const s of candidates) {
    if (picked.length >= limit) break;
    if (!s.shop_id || !s.shop_name) continue;
    if (seen.has(s.shop_id)) continue;
    seen.add(s.shop_id);
    picked.push(s);
  }
}

function reasonFor(shop, hearing) {
  const area = areaStr(shop) || "";
  const who = norm(hearing.who) || "you";
  const bv = arr(shop.best_vibe).map(norm).filter(Boolean);
  const vibe = bv[0] || arr(hearing.vibes)[0] || "local";

  const whoMatch = matchesWho(shop, hearing);
  const vibeMatch =
    !hearing.no_preference &&
    arr(hearing.vibes).length > 0 &&
    matchesAnyVibe(shop, hearing);

  if (whoMatch && vibeMatch) return `Best for ${who} + ${vibe} in ${area}.`;
  if (whoMatch) return `Fits ${who} in ${area}.`;
  if (vibeMatch) return `${vibe} vibe pick in ${area}.`;
  return `Local daily staple in ${area}.`;
}

// ✅ 1エリア内で「思想順序」で7件作る（Explorerと同等）
function select7InArea(areaActive, hearing) {
  const base = areaActive.filter((s) => norm(s.status) === "active");
  const picked = [];

  uniquePush(
    picked,
    base.filter((s) => matchesWho(s, hearing) && matchesAnyVibe(s, hearing)),
    7
  );
  if (picked.length < 7)
    uniquePush(picked, base.filter((s) => matchesWho(s, hearing)), 7);
  if (picked.length < 7)
    uniquePush(picked, base.filter((s) => matchesAnyVibe(s, hearing)), 7);
  if (picked.length < 7) uniquePush(picked, base, 7);

  return picked.slice(0, 7).map((s) => ({ ...s, reason: reasonFor(s, hearing) }));
}

function escapeAirtableValue(s) {
  return String(s).replace(/'/g, "\\'");
}

// ---------------- handler ----------------
export default async function handler(req, res) {
  try {
    const { session_id } = req.query;
    if (!session_id)
      return res.status(400).json({ ok: false, error: "Missing session_id" });

    const session = await stripe.checkout.sessions.retrieve(session_id);

    // 暫定：決済済みのみ（Webhook前）
    const paid =
      session.payment_status === "paid" || session.status === "complete";
    if (!paid) return res.status(402).json({ ok: false, error: "NOT_PAID" });

    const metadata = session.metadata || {};

    // hearing 復元（hearing優先）
    let hearing = null;
    if (metadata.hearing) {
      try {
        hearing = JSON.parse(metadata.hearing);
      } catch {
        hearing = null;
      }
    }

    // 互換：metadata.area_groups でも動く
    if (!hearing) {
      if (!metadata.plan || !metadata.area_groups) {
        return res.status(400).json({
          ok: false,
          error: "Missing metadata.plan or metadata.area_groups",
        });
      }
      hearing = {
        plan: metadata.plan,
        area_groups: JSON.parse(metadata.area_groups),
        who: metadata.who || "solo",
        vibes: metadata.vibes ? JSON.parse(metadata.vibes) : [],
        no_preference:
          metadata.no_preference === "true" || metadata.no_preference === true,
      };
    }

    // plan制約（hearing UI固定）
    if (hearing.plan === "explorer" && hearing.area_groups.length !== 1) {
      return res
        .status(400)
        .json({ ok: false, error: "Explorer requires exactly 1 area_group" });
    }
    if (hearing.plan === "connoisseur" && hearing.area_groups.length !== 4) {
      return res
        .status(400)
        .json({ ok: false, error: "Connoisseur requires exactly 4 area_groups" });
    }

    const table = base(process.env.AIRTABLE_TABLE_ID);

    // ---------------- Explorer：1エリア7件 ----------------
    if (hearing.plan === "explorer") {
      const ag = hearing.area_groups[0];
      const formula = `AND({status}='active',{area_group}='${escapeAirtableValue(
        ag
      )}')`;

      const records = await table.select({ filterByFormula: formula }).all();
      const all = records.map((r) => r.fields);

      const shops = select7InArea(all, hearing);

      // 7件に満たないなら商品不成立（事故防止）
      if (shops.length !== 7) {
        return res.status(409).json({ ok: false, error: "INSUFFICIENT_INVENTORY" });
      }

      return res.status(200).json({
        ok: true,
        plan: hearing.plan,
        who: hearing.who,
        shops,
      });
    }

    // ---------------- Connoisseur：4エリア×7件 = 28件 ----------------
    const out = [];
    for (const ag of hearing.area_groups) {
      const formula = `AND({status}='active',{area_group}='${escapeAirtableValue(
        ag
      )}')`;
      const records = await table.select({ filterByFormula: formula }).all();
      const all = records.map((r) => r.fields);

      const picks = select7InArea(all, hearing);

      // 各エリア7件固定（要件：4エリア28件）
      if (picks.length !== 7) {
        return res.status(409).json({
          ok: false,
          error: "INSUFFICIENT_INVENTORY",
          area_group: ag,
        });
      }

      out.push(...picks);
    }

    return res.status(200).json({
      ok: true,
      plan: hearing.plan,
      who: hearing.who,
      shops: out, // ✅ 28件
    });
  } catch (e) {
    console.error("results failed", e);
    return res.status(500).json({ ok: false, error: "results failed" });
  }
}
