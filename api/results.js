<script>
async function loadResults() {
  const params = new URLSearchParams(window.location.search);
  const areaIds = params.get("areaIds");
  const plan = params.get("plan");

  if (!areaIds) {
    document.querySelector("#result").innerHTML = "No area selected.";
    return;
  }

  try {
    const res = await fetch("/api/results", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        areaIds: areaIds.split(","),
        who: null,
        mood: null,
        friction: null
      })
    });

    const data = await res.json();

    if (!data.shops) {
      document.querySelector("#result").innerHTML = "No shops returned.";
      return;
    }

    let html = "<h2>Your 7 Matches</h2>";
    data.shops.forEach(shop => {
      html += `
        <div style="margin-bottom:20px;padding:15px;border:1px solid #eee;border-radius:12px;">
          <h3>${shop.shop_name}</h3>
          <p>${shop.area_detail}</p>
          <p>${shop.genre}</p>
          <p>${shop.short_desc}</p>
        </div>
      `;
    });

    document.querySelector("#result").innerHTML = html;

  } catch (err) {
    document.querySelector("#result").innerHTML = "Error loading results.";
  }
}

loadResults();
</script>
