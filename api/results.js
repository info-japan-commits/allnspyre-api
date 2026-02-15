// /api/results.js
export default async function handler(req, res) {
  try {
    const sessionId = (req.query.session_id || "").toString().trim();
    if (!sessionId) {
      return res.status(400).json({ success: false, error: "Missing session_id" });
    }

    // ENV
    const stripeKey = process.env.STRIPE_SECRET_KEY;
    const baseId = process.env.AIRTABLE_BASE_ID;
    const airtableKey = process.env.AIRTABLE_API_KEY;

    if (!stripeKey) return res.status(500).json({ success: false, error: "Missing STRIPE_SECRET_KEY" });
    if (!baseId || !airtableKey) return res.status(500).json({ success: false, error: "Missing Airtable env vars" });

    // 1) Stripe Checkout Session → client_reference_id を取得
    const stripeSession = await stripeGetCheckoutSession(sessionId, stripeKey);

    // Payment Links checkout session should contain client_reference_id (set from hearing)
    const ref = stripeSession?.client_reference_id;
    if (!ref) {
      return res.status(400).json({
        success: false,
        error: "client_reference_id not found on Checkout Session (hearing payload missing)."
      });
    }

    const payload = decodePayload(ref);
    const plan = (payload?.plan || "").toLowerCase();

    if (plan !== "explorer" && plan !== "connoisseur") {
      return res.status(400).json({ success: false, error: "Invalid plan in payload" });
    }

    // 2) Airtable filter 条件作成
    const allowedAreaDetails = expandAreasFromPayload(payload);
    const who = payload?.who || null;
    const vibes = Array.isArray(payload?.vibes) ? payload.vibes : [];

    // Safety: Explorer = 7 shops, Connoisseur = 7 shops（固定）
    const wantCount = 7;

    // Airtable table/view
    const tableName = "Imported%20table"; // encode済み
    const viewName = plan === "explorer" ? "explorer_only" : "connoisseur_only";

    // Build Airtable formula:
    // AND(
    //  {status}="active",
    //  {tier}="explorer|connoisseur",
    //  OR({area_detail}="...", ...),
    //  (optional) {best_with}="solo|partner|friends|family",
    //  (optional) OR({best_vibe}="...", ...)
    // )
    const andParts = [];
    andParts.push(`{status}="active"`);
    andParts.push(`{tier}="${escapeAirtable(plan)}"`);

    if (allowedAreaDetails.length) {
      const areaOr = allowedAreaDetails
        .map(v => `{area_detail}="${escapeAirtable(v)}"`)
        .join(",");
      andParts.push(`OR(${areaOr})`);
    }

    if (who) {
      andParts.push(`{best_with}="${escapeAirtable(who)}"`);
    }

    if (vibes.length) {
      const vibeOr = vibes
        .map(v => `{best_vibe}="${escapeAirtable(v)}"`)
        .join(",");
      andParts.push(`OR(${vibeOr})`);
    }

    const formula = `AND(${andParts.join(",")})`;

    // 3) Airtable fetch
    const url =
      `https://api.airtable.com/v0/${baseId}/${tableName}` +
      `?view=${encodeURIComponent(viewName)}` +
      `&filterByFormula=${encodeURIComponent(formula)}` +
      `&pageSize=100`;

    const at = await fetch(url, {
      headers: { Authorization: `Bearer ${airtableKey}` }
    });

    const atData = await at.json();
    if (!at.ok || !Array.isArray(atData?.records)) {
      return res.status(500).json({ success: false, error: "Airtable API error", detail: atData });
    }

    // 4) Shuffle & take 7
    const picked = shuffle(atData.records).slice(0, wantCount);

    // 5) Response format for results.html
    const shops = picked.map(r => ({
      id: r.id,
      shop_id: r.fields?.shop_id,
      shop_name: r.fields?.shop_name,
      area_group: r.fields?.area_group,
      area_detail: r.fields?.area_detail,
      short_desc: r.fields?.short_desc
    }));

    return res.status(200).json({
      success: true,
      plan,
      count: shops.length,
      shops,
      debug: `areas=${allowedAreaDetails.length}, who=${who || "-"}, vibes=${vibes.length}`
    });

  } catch (e) {
    return res.status(500).json({ success: false, error: String(e?.message || e) });
  }
}

// --------------------------
// Stripe helpers (no SDK)
// --------------------------
async function stripeGetCheckoutSession(sessionId, stripeKey) {
  const url = `https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(sessionId)}`;
  const resp = await fetch(url, {
    headers: {
      Authorization: `Bearer ${stripeKey}`,
      "Content-Type": "application/x-www-form-urlencoded"
    }
  });
  const data = await resp.json();
  if (!resp.ok) {
    throw new Error(`Stripe error: ${data?.error?.message || "unknown"}`);
  }
  return data;
}

// --------------------------
// Payload decode (base64url)
// --------------------------
function decodePayload(b64url) {
  const b64 = b64url.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((b64url.length + 3) % 4);
  const json = Buffer.from(b64, "base64").toString("utf8");
  return JSON.parse(json);
}

// --------------------------
// Areas expansion
// --------------------------
function expandAreasFromPayload(payload) {
  const where = Array.isArray(payload?.where) ? payload.where : [];

  // Map prefecture → allowed Airtable area_detail values
  // (must match Airtable single select values exactly)
  const PREF_AREA_DETAILS = {
    tokyo: ["Tokyo 23 Wards", "Kichijoji / Mitaka / Musashisakai"],
    kanagawa: ["Yokohama", "Suburban Yokohama"],
    osaka: ["Osaka City", "Hokusetsu"],
    kyoto: ["Kyoto City", "Fushimi-Momoyama"],
    hyogo: ["Kobe", "Akashi / Awaji"],
    nara: ["Ikoma"],
    fukuoka: ["Tenjin + Hakata", "Nishijin / Itoshima / Dazaifu"],
    ishikawa: ["Kanazawa area", "Nonoichi"]
  };

  // any_pick_for_me: allow all
  if (where.some(x => x?.type === "any_pick_for_me")) {
    return Object.values(PREF_AREA_DETAILS).flat();
  }

  const out = [];

  for (const w of where) {
    if (!w || typeof w !== "object") continue;

    if (w.type === "area" && w.area_detail) {
      out.push(String(w.area_detail));
      continue;
    }

    if (w.type === "pick_one" && w.prefectureId) {
      const list = PREF_AREA_DETAILS[w.prefectureId];
      if (list?.length) out.push(...list);
      continue;
    }
  }

  // de-dup
  return Array.from(new Set(out));
}

// --------------------------
// Utility
// --------------------------
function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function escapeAirtable(s) {
  return String(s).replaceAll('"', '\\"');
}
