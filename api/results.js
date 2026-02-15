<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>Allnspyre — Results</title>
  <style>
    body { font-family: system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif; margin: 0; background:#f6f7fb; color:#0b1220; }
    .wrap { max-width: 980px; margin: 40px auto; padding: 0 18px; }
    .card { background: #fff; border: 1px solid #e6e8ef; border-radius: 16px; padding: 18px; box-shadow: 0 8px 30px rgba(10,20,40,.06); }
    .muted { color:#5b6476; }
    .row { display:flex; gap:14px; flex-wrap:wrap; }
    .shop { border:1px solid #eceef5; border-radius:14px; padding:14px; background:#fff; }
    h1 { font-size: 28px; margin: 0 0 6px; }
    h2 { font-size: 18px; margin: 14px 0 10px; }
    .pill { display:inline-block; padding: 4px 10px; border-radius: 999px; background:#f0f2f9; font-size:12px; margin-right:6px; }
    .btn { display:inline-block; padding:10px 14px; border-radius: 12px; border:1px solid #e1e5f0; background:#fff; cursor:pointer; }
    .err { background:#fff2f2; border:1px solid #ffd2d2; padding:12px; border-radius: 12px; color:#8b1e1e; }
    .loading { opacity: .7; }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="card">
      <div class="muted">Allnspyre</div>
      <h1>Your Selection</h1>
      <div id="status" class="muted">We’re generating your results…</div>
      <div style="margin-top:12px;">
        <button class="btn" id="reloadBtn">Reload</button>
      </div>
    </div>

    <div style="height:14px;"></div>

    <div id="out"></div>
  </div>

  <script>
    const $status = document.getElementById("status");
    const $out = document.getElementById("out");
    document.getElementById("reloadBtn").addEventListener("click", () => location.reload());

    function getParams() {
      const p = new URLSearchParams(location.search);
      return {
        plan: p.get("plan") || "",
        // hearing から: areaIds=Fushimi-Momoyama,Kyoto City ... （Airtableのarea_detail文字列）
        areaIdsRaw: p.get("areaIds") || ""
      };
    }

    function renderError(msg, detail) {
      $out.innerHTML = `
        <div class="err">
          <div><b>${msg}</b></div>
          ${detail ? `<div style="margin-top:6px; font-size:12px; white-space:pre-wrap;">${detail}</div>` : ""}
        </div>
      `;
      $status.textContent = "Error";
    }

    function renderShops(shops, debug) {
      const items = shops.map(s => `
        <div class="shop">
          <div style="font-weight:700; font-size:16px;">${escapeHtml(s.shop_name || "")}</div>
          <div class="muted" style="margin-top:4px;">
            <span class="pill">${escapeHtml(s.area_group || "")}</span>
            <span class="pill">${escapeHtml(s.area_detail || "")}</span>
            <span class="pill">${escapeHtml(s.genre || "")}</span>
          </div>
          <div style="margin-top:10px; line-height:1.55;">
            ${escapeHtml(s.short_desc || "")}
          </div>
        </div>
      `).join("");

      $out.innerHTML = `
        <div class="card">
          <h2>Your 7 Matches</h2>
          <div class="muted" style="margin-top:-6px;">
            Areas: ${escapeHtml((debug?.usedAreas || []).join(", "))}
          </div>
          <div style="height:10px;"></div>
          <div class="row">${items}</div>
        </div>
      `;
      $status.textContent = "Done";
    }

    function escapeHtml(str) {
      return String(str).replace(/[&<>"']/g, m => ({
        "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"
      }[m]));
    }

    async function main() {
      const { plan, areaIdsRaw } = getParams();

      // plan は表示上だけ（今はAPIに渡してない）
      if (!plan) {
        renderError("Missing plan", "Add ?plan=explorer or ?plan=connoisseur");
        return;
      }

      if (!areaIdsRaw) {
        renderError("No area selected", "Missing ?areaIds=...");
        return;
      }

      // URLではカンマ区切り想定
      const areaIds = areaIdsRaw.split(",").map(s => s.trim()).filter(Boolean);

      $status.textContent = "Loading…";
      $out.classList.add("loading");

      try {
        const res = await fetch("/api/results", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ areaIds })
        });

        const data = await res.json().catch(() => null);

        if (!res.ok || !data || !data.ok) {
          renderError(
            "API error",
            (data && (data.details || data.message || JSON.stringify(data, null, 2))) || `HTTP ${res.status}`
          );
          return;
        }

        renderShops(data.shops || [], data.debug || {});
      } catch (e) {
        renderError("Network / runtime error", e?.message || String(e));
      } finally {
        $out.classList.remove("loading");
      }
    }

    main();
  </script>
</body>
</html>
