import Stripe from "stripe";
import Airtable from "airtable";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY as string);
const base = new Airtable({ apiKey: process.env.AIRTABLE_TOKEN as string }).base(
  process.env.AIRTABLE_BASE_ID as string
);

// ---------- helpers ----------
type Shop = {
  shop_id: string;
  shop_name: string;
  area_group: string;
  area_detail?: string;
  tier?: string;
  time_slot?: string | null;
  best_with?: string | null;
  best_vibe?: string | null;
  status: string;
  [k: string]: any;
};

type HearingLike = {
  plan: "explorer" | "connoisseur";
  area_groups: string[];
  who: string;      // best_with slug
  vibes: string[];  // best_vibe slug(s) 1-2
  no_preference?: boolean;
  source?: string;
};

type ShopOut = Shop & { reason: string };

const norm = (v?: string | null) => (v ? String(v).trim().toLowerCase() : null);

function matchesWho(s: Shop, h: HearingLike) {
  return norm(s.best_with) === norm(h.who);
}
function matchesAnyVibe(s: Shop, h: HearingLike) {
  if (h.no_preference) return true;
  const sv = norm(s.best_vibe);
  if (!sv) return false;
  const vs = (h.vibes ?? []).map(norm).filter(Boolean) as string[];
  if (vs.length === 0) return true;
  return vs.includes(sv);
}
function timeSlotMatch(_s: Shop, _h: HearingLike) {
  // hearing payloadに time_slot は無い（固定payload）なので常に false。
  // 将来追加されてもUI固定のため、ここは互換で残す。
  return false;
}
function stableSortByTime(cands: Shop[], _h: HearingLike) {
  // time_slot 優先は「入力側にtime_slotが無い」ので現状は無効。
  // 将来追加されてもフィルタではなく“優先ソート”として使えるように関数だけ残す。
  return cands;
}
function uniquePush(picked: Shop[], cands: Shop[], limit: number) {
  const seen = new Set(picked.map((x) => x.shop_id));
  for (const s of cands) {
    if (picked.length >= limit) break;
    if (!s.shop_id || !s.shop_name) continue;
    if (seen.has(s.shop_id)) continue;
    seen.add(s.shop_id);
    picked.push(s);
  }
}

function reasonFor(s: Shop, h: HearingLike): string {
  const area = s.area_group;
  const who = norm(h.who) ?? "you";
  const vibe = norm(s.best_vibe) ?? (h.vibes?.[0] ?? "local");

  const whoMatch = matchesWho(s, h);
  const vibeMatch = !h.no_preference && (h.vibes?.length ?? 0) > 0 && matchesAnyVibe(s, h);

  if (whoMatch && vibeMatch) return `Best for ${who} + ${vibe} in ${area}.`;
  if (whoMatch) return `Fits ${who} in ${area}.`;
  if (vibeMatch) return `${vibe} vibe pick in ${area}.`;
  if (timeSlotMatch(s, h)) return `Reliable option in ${area}.`;
  return `Local daily staple in ${area}.`;
}

function select7Explorer(areaActive: Shop[], h: HearingLike): ShopOut[] {
  const base = areaActive.filter((s) => norm(s.status) === "active");
  const picked: Shop[] = [];

  // S0: area fixed (caller) + who + vibe
  uniquePush(picked, stableSortByTime(base.filter((s) => matchesWho(s, h) && matchesAnyVibe(s, h)), h), 7);
  // S1: who only
  if (picked.length < 7) uniquePush(picked, stableSortByTime(base.filter((s) => matchesWho(s, h)), h), 7);
  // S2: vibe only
  if (picked.length < 7) uniquePush(picked, stableSortByTime(base.filter((s) => matchesAnyVibe(s, h)), h), 7);
  // S3: relaxed
  if (picked.length < 7) uniquePush(picked, stableSortByTime(base, h), 7);

  return picked.slice(0, 7).map((s) => ({ ...s, reason: reasonFor(s, h) }));
}

function select7Connoisseur(areaMap: Record<string, Shop[]>, h: HearingLike): ShopOut[] {
  const areas = h.area_groups;
  const picked: Shop[] = [];
  const perArea: Record<string, number> = {};

  const score = (s: Shop) => {
    let sc = 0;
    if (matchesWho(s, h)) sc += 2;
    if (matchesAnyVibe(s, h)) sc += 2;
    if (timeSlotMatch(s, h)) sc += 1;
    return sc;
  };

  // min 1 per area
  for (const ag of areas) {
    const base = (areaMap[ag] ?? []).filter((s) => norm(s.status) === "active");
    if (base.length === 0) continue;
    const sorted = stableSortByTime([...base].sort((a, b) => score(b) - score(a)), h);
    uniquePush(picked, sorted, 7);
    perArea[ag] = picked.filter((x) => x.area_group === ag).length;
  }

  // fill remaining by global score with cap 3 per area
  if (picked.length < 7) {
    const pool = areas.flatMap((ag) => (areaMap[ag] ?? [])).filter((s) => norm(s.status) === "active");
    const sorted = stableSortByTime([...pool].sort((a, b) => score(b) - score(a)), h);
    const seen = new Set(picked.map((x) => x.shop_id));

    for (const s of sorted) {
      if (picked.length >= 7) break;
      if (!s.shop_id || !s.shop_name) continue;
      if (seen.has(s.shop_id)) continue;

      const ag = s.area_group;
      const cnt = perArea[ag] ?? picked.filter((x) => x.area_group === ag).length;
      if (cnt >= 3) continue;

      seen.add(s.shop_id);
      picked.push(s);
      perArea[ag] = cnt + 1;
    }
  }

  // last resort fill
  if (picked.length < 7) {
    const pool = areas.flatMap((ag) => (areaMap[ag] ?? [])).filter((s) => norm(s.status) === "active");
    uniquePush(picked, stableSortByTime(pool, h), 7);
  }

  return picked.slice(0, 7).map((s) => ({ ...s, reason: reasonFor(s, h) }));
}

function escapeAirtableValue(s: string) {
  // minimal escaping for single quotes in filterByFormula
  return String(s).replace(/'/g, "\\'");
}

function buildOrFormula(field: string, values: string[]) {
  const parts = values.map((v) => `{${field}}='${escapeAirtableValue(v)}'`);
  return `OR(${parts.join(",")})`;
}

// ---------- handler ----------
export default async function handler(req: any, res: any) {
  try {
    const { session_id } = req.query;
    if (!session_id) return res.status(400).json({ ok: false, error: "Missing session_id" });

    const session = await stripe.checkout.sessions.retrieve(session_id as string);

    // ✅ 暫定「決済済みのみ」ガード（Webhook前）
    const paid = session.payment_status === "paid" || session.status === "complete";
    if (!paid) return res.status(402).json({ ok: false, error: "NOT_PAID" });

    const metadata: any = session.metadata || {};

    // hearing互換：metadata.hearing があれば優先、なければ既存の metadata.area_groups を使う
    let hearing: HearingLike | null = null;
    if (metadata.hearing) {
      try {
        const parsed = JSON.parse(metadata.hearing);
        // hearing payload は固定なので、この形に寄せる
        hearing = {
          plan: parsed.plan,
          area_groups: parsed.area_groups,
          who: parsed.who,
          vibes: parsed.vibes,
          no_preference: parsed.no_preference,
          source: parsed.source,
        };
      } catch {
        // fallthrough
      }
    }

    if (!hearing) {
      // 現行実装互換
      if (!metadata.plan || !metadata.area_groups) {
        return res.status(400).json({ ok: false, error: "Missing metadata.plan or metadata.area_groups" });
      }
      const areaGroups = JSON.parse(metadata.area_groups);
      hearing = {
        plan: metadata.plan,
        area_groups: areaGroups,
        // 既存metadataに who/vibes が無い場合でも商品成立は継続（vibe緩和扱い）
        who: metadata.who || "solo",
        vibes: metadata.vibes ? JSON.parse(metadata.vibes) : [],
        no_preference: metadata.no_preference === "true" || metadata.no_preference === true,
      };
    }

    // ✅ planごとのarea制約チェック（UI/仕様固定）
    if (hearing.plan === "explorer" && hearing.area_groups.length !== 1) {
      return res.status(400).json({ ok: false, error: "Explorer requires exactly 1 area_group" });
    }
    if (hearing.plan === "connoisseur" && hearing.area_groups.length !== 4) {
      return res.status(400).json({ ok: false, error: "Connoisseur requires exactly 4 area_groups" });
    }

    // ✅ Airtable取得：status=active を必ず含める
    const table = base(process.env.AIRTABLE_TABLE_ID as string);

    // Explorer: 1エリア全件（active）を取ってから選ぶ
    if (hearing.plan === "explorer") {
      const ag = hearing.area_groups[0];

      const formula = `AND({status}='active', {area_group}='${escapeAirtableValue(ag)}')`;
      const records = await table
        .select({
          filterByFormula: formula,
          // maxRecordsは “母集団” では付けない（思想通りの選定のため）
        })
        .all();

      const all = records.map((r: any) => r.fields as Shop);
      const shops = select7Explorer(all, hearing);

      return res.status(200).json({
        ok: true,
        plan: hearing.plan,
        who: hearing.who, // ✅ UI互換
        shops,
      });
    }

    // Connoisseur: 4エリアをそれぞれ取得して配分
    const areaMap: Record<string, Shop[]> = {};
    for (const ag of hearing.area_groups) {
      const formula = `AND({status}='active', {area_group}='${escapeAirtableValue(ag)}')`;
      const records = await table.select({ filterByFormula: formula }).all();
      areaMap[ag] = records.map((r: any) => r.fields as Shop);
    }

    const shops = select7Connoisseur(areaMap, hearing);

    return res.status(200).json({
      ok: true,
      plan: hearing.plan,
      who: hearing.who, // ✅ UI互換
      shops,
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ ok: false, error: "results failed" });
  }
}
