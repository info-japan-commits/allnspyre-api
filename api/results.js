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
    if (!s.shop_id || !s.shop_name) continue; // 必須欠損は除外
    if (seen.has(s.shop_id)) continue;        // 重複排除
    seen.add(s.shop_id);
    picked.push(s);
  }
}

function reasonFor(shop, hearing) {
  const area = shop.area_group || "";
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

// Explorer: 1 area -> 7 (S0..S3)
function select7Explorer(areaActive, hearing) {
  const base = areaActive.filter((s) => norm(s.status) === "active");
  const picked = [];

  // S0: who + vibe
  uniquePush(
    picked,
    base.filter((s) => matchesWho(s, hearing) && matchesAnyVibe(s, hearing)),
    7
  );
  // S1: who
  if (picked.length < 7)
    uniquePush(picked, base.filter((s) => matchesWho(s, hearing)), 7);
  // S2: vibe
  if (picked.length < 7)
    uniquePush(picked, base.filter((s) => matchesAnyVibe(s, hearing)), 7);
  // S3: relaxed
  if (picked.length < 7) uniquePush(picked, base, 7);

  return picked.slice(0, 7).map((s) => ({ ...s, reason: reasonFor(s, hearing) }));
}

// Connoisseur: 4 areas -> 7 total (min viable allocation)
function select7Connoisseur(areaMap, hearing) {
  const areas = hearing.area_groups;
  const picked = [];
  const perArea = {};

  const score = (s) => {
    let sc = 0;
    if (matchesWho(s, hearing)) sc += 2;
    if (matchesAnyVibe(s, hearing)) sc += 2;
    return sc;
  };

  // 1) min 1 per area
  for (const ag of areas) {
    const base = (areaMap[ag] || []).filter((s) => norm(s.status) === "active");
    if (base.length === 0) continue;
    const sorted = [...base].sort((a, b) => score(b) - score(a));
    uniquePush(picked, sorted, 7);
    perArea[ag] = picked.filter((x) => x.area_group === ag).length;
  }

  // 2) fill remaining by global score with cap 3 per area
  if (picked.length < 7) {
    const pool = areas
      .flatMap((ag) => areaMap[ag] || [])
      .filter((s) => norm(s.status) === "active");
    const sorted = [...pool].sort((a, b) => score(b) - score(a));
    const seen = new Set(picked.map((x) => x.shop_id));

    for (const s of sorted) {
      if (picked.length >= 7) break;
      if (!s.shop_id || !s.shop_name) continue;
      if (seen.has(s.shop_id)) continue;

      const ag = s.area_group;
      const cnt =
        perArea[ag] ?? picked.filter((x) => x.area_group === ag).length;
      if (cnt >= 3) continue;

      seen.add(s.shop_id);
      picked.push(s);
      perArea[ag] = cnt + 1;
    }
  }

  // 3) last resort fill
  if (picked.length < 7) {
    const pool = areas
      .flatMap((ag) => areaMap[ag] || [])
      .filter((s) => norm(s.status) === "active");
    uniquePush(picked, pool, 7);
  }

  return picked.slice(0, 7).map((s) => ({ ...s, reason: reasonFor(s, hearing) }));
}

function escapeAirtableValue(s) {
  return String(s).replace(/'/g, "\\'");
}

// ---------------- handler ----------------
export default async function handler(req, res) {
  try {
    const { session_id } = req.query;
    if (!session_id) return res.status(400).json({ ok: false, error: "Missing session_id" });

    const session = await stripe.checkout.sessions.retrieve(session_id);

    // 暫定：決済済みのみ（Webhook前）
    const paid = session.payment_status === "paid" || session.status === "complete";
    if (!paid) return res.status(402).json({ ok: false, error: "NOT_PAID" });

    const metadata = session.metadata || {};

    // hearing 復元（hearing優先）
    let hearing = null;
    if (metadata.hearing) {
      try {
        hearing = JSON.parse(metadata.hearing);
      } catch (e) {
        hearing = null;
      }
    }

    // 互換：metadata.area_groups でも動く
    if (!hearing) {
      if (!metadata.plan || !metadata.area_groups) {
        return res
          .status(400)
          .json({ ok: false, error: "Missing metadata.plan or metadata.area_groups" });
      }
      hearing = {
        plan: metadata.plan,
        area_groups: JSON.parse(metadata.area_groups),
        who: metadata.who || "solo",
        vibes: metadata.vibes ? JSON.parse(metadata.vibes) : [],
        no_preference: metadata.no_preference === "true" || metadata.no_preference === true,
      };
    }

    // ---- DEBUG LOGS (this phase) ----
    console.log("RESULTS_META_HAS_HEARING", !!metadata.hearing);
    console.log("RESULTS_HEARING_AREAS", hearing.area_groups);
    console.log("RESULTS_PLAN", hearing.plan, "WHO", hearing.who, "VIBES", hearing.vibes);

    // plan制約
    if (hearing.plan === "explorer" && hearing.area_groups.length !== 1) {
      return res.status(400).json({ ok: false, error: "Explorer requires exactly 1 area_group" });
    }
    if (hearing.plan === "connoisseur" && hearing.area_groups.length !== 4) {
      return res.status(400).json({ ok: false, error: "Connoisseur requires exactly 4 area_groups" });
    }

    const table = base(process.env.AIRTABLE_TABLE_ID);

    // ---------------- Explorer ----------------
    if (hearing.plan === "explorer") {
      const ag = hearing.area_groups[0];
      const formula = `AND({status}='active',{area_group}='${escapeAirtableValue(ag)}')`;

      const records = await table.select({ filterByFormula: formula }).all();
      const all = records.map((r) => r.fields);
      const shops = select7Explorer(all, hearing);

      return res.status(200).json({
        ok: true,
        plan: hearing.plan,
        who: hearing.who,
        shops,
      });
    }

    // ---------------- Connoisseur ----------------
    const areaMap = {};
    for (const ag of hearing.area_groups) {
      const formula = `AND({status}='active',{area_group}='${escapeAirtableValue(ag)}')`;
      const records = await table.select({ filterByFormula: formula }).all();
      areaMap[ag] = records.map((r) => r.fields);
    }

    // ---- DEBUG LOGS: data reality + picked distribution ----
    console.log(
      "AREA_COUNTS",
      hearing.area_groups.map((ag) => [ag, (areaMap[ag] || []).length])
    );
    for (const ag of hearing.area_groups) {
      const bad = (areaMap[ag] || []).filter((s) => !s.shop_id || !s.shop_name).length;
      console.log("BAD_ROWS", ag, bad);
    }

    const shops = select7Connoisseur(areaMap, hearing);

    const dist = shops.reduce((m, s) => {
      const k = s.area_group || "UNKNOWN";
      m[k] = (m[k] || 0) + 1;
      return m;
    }, {});
    console.log("PICKED_DIST", dist);

    return res.status(200).json({
      ok: true,
      plan: hearing.plan,
      who: hearing.who,
      shops,
    });
  } catch (e) {
    console.error("results failed", e);
    return res.status(500).json({ ok: false, error: "results failed" });
  }
}
