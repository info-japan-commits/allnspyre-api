// /api/affiliate-register.js
const AIRTABLE_API = "https://api.airtable.com/v0";

function json(res, status, body) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(body));
}

function generateId(name) {
  const base = name.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 10);
  const rand = Math.random().toString(36).slice(2, 6);
  return `${base}-${rand}`;
}

module.exports = async (req, res) => {
  try {
    if (req.method !== "POST") return json(res, 405, { ok: false, error: "Method not allowed" });

    const baseId = process.env.AIRTABLE_BASE_ID;
    const token = process.env.AIRTABLE_TOKEN;
    const affiliatesTableId = process.env.AIRTABLE_AFFILIATES_TABLE_ID;

    const { name, email, paypal_or_wise } = req.body || {};

    if (!name || !email) return json(res, 400, { ok: false, error: "Missing name or email" });

    // メール重複チェック
    const formula = encodeURIComponent(`LOWER({email})="${email.toLowerCase()}"`);
    const checkUrl = `${AIRTABLE_API}/${baseId}/${affiliatesTableId}?filterByFormula=${formula}&maxRecords=1`;
    const checkRes = await fetch(checkUrl, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const checkData = await checkRes.json();

    if ((checkData.records || []).length > 0) {
      const existing = checkData.records[0].fields;
      return json(res, 200, {
        ok: true,
        affiliate_id: existing.affiliate_id,
        message: "Already registered",
      });
    }

    // 新規登録
    const affiliate_id = generateId(name);

    const createUrl = `${AIRTABLE_API}/${baseId}/${affiliatesTableId}`;
    await fetch(createUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        records: [{
          fields: {
            affiliate_id,
            name: String(name),
            email: String(email).toLowerCase(),
            paypal_or_wise: String(paypal_or_wise || ""),
            total_clicks: 0,
            total_purchases: 0,
            total_earnings: 0,
            paid_amount: 0,
            status: "active",
          },
        }],
      }),
    });

    return json(res, 200, { ok: true, affiliate_id });
  } catch (e) {
    console.error("[/api/affiliate-register] error:", e?.message || e);
    return json(res, 500, { ok: false, error: "Server error" });
  }
};
```

---

## 作業手順
```
① affiliate.html をGitHubのルートに追加
② api/affiliate-register.js をGitHubに追加
③ pushしてVercelに自動デプロイ
