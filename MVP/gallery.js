// Blue Dot motion gallery: every saved animation plays as a live preview card,
// using the same keyframes and timing as the exported code.
(() => {
  const KEY = "dsx:gallery";
  const hasChrome = typeof chrome !== "undefined" && chrome.storage && chrome.storage.local;
  const load = () => new Promise((res) => {
    if (hasChrome) chrome.storage.local.get(KEY, (o) => res((o && o[KEY]) || []));
    else { try { res(JSON.parse(localStorage.getItem(KEY) || "[]")); } catch (e) { res([]); } }
  });
  const save = (list) => new Promise((res) => {
    if (hasChrome) chrome.storage.local.set({ [KEY]: list }, res);
    else { try { localStorage.setItem(KEY, JSON.stringify(list)); } catch (e) {} res(); }
  });
  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  let items = [], filter = "All", query = "", slow = false;
  const players = new Map(); // card -> player

  const toast = (msg) => { const t = $("#toast"); t.textContent = msg; t.classList.add("show"); clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.remove("show"), 2200); };

  /* fit the saved element into a stage and play its animation in a loop */
  const mount = (stage, it) => {
    stage.querySelectorAll(".fit").forEach((n) => n.remove());
    const fit = document.createElement("div"); fit.className = "fit";
    fit.innerHTML = it.html;
    const el = fit.firstElementChild;
    if (!el) return null;
    stage.appendChild(fit);
    const sw = stage.clientWidth || 320, sh = stage.clientHeight || 240;
    const w = Math.max(8, it.w), h = Math.max(8, it.h);
    const pad = 0.28; // room for the element to move around
    const sc = Math.min(1.6, (sw * (1 - pad)) / w, (sh * (1 - pad)) / h);
    fit.style.width = w + "px"; fit.style.height = h + "px";
    fit.style.transform = `translate(-50%, -50%) scale(${sc})`;
    let anim = null, alive = true, wait = 0;
    const timing = Object.assign({}, it.timing);
    if (timing.iterations === "Infinity" || timing.iterations === "infinite") timing.iterations = Infinity;
    const once = timing.iterations !== Infinity;
    if (it.hover) Object.assign(timing, { iterations: Infinity, direction: "alternate", endDelay: 500 });
    const play = () => {
      if (!alive) return;
      try { anim && anim.cancel(); } catch (e) {}
      anim = el.animate(it.kfs, Object.assign({}, timing, { delay: Math.min(timing.delay || 0, 1200), fill: "both" }));
      anim.playbackRate = slow ? 0.25 : 1;
      if (once && !it.hover) anim.onfinish = () => { wait = setTimeout(play, 900); };
    };
    if (!reduce) play();
    return {
      replay: play,
      rate: (r) => { if (anim) anim.playbackRate = r; },
      pause: () => { if (anim && anim.playState === "running") anim.pause(); },
      resume: () => { if (anim && anim.playState === "paused") anim.play(); },
      destroy: () => { alive = false; clearTimeout(wait); try { anim && anim.cancel(); } catch (e) {} fit.remove(); }
    };
  };

  /* pause cards that are off screen */
  const io = new IntersectionObserver((ents) => ents.forEach((e) => { const p = players.get(e.target); if (p) e.isIntersecting ? p.resume() : p.pause(); }), { rootMargin: "100px" });

  const allTags = () => { const m = new Map(); items.forEach((it) => (it.tags || []).forEach((t) => { if (/^\d/.test(t)) return; m.set(t, (m.get(t) || 0) + 1); })); return [...m].sort((a, b) => b[1] - a[1]).slice(0, 12); };
  const matches = (it) => (filter === "All" || (it.tags || []).includes(filter)) && (!query || [it.name, it.desc, it.site, ...(it.tags || [])].join(" ").toLowerCase().includes(query));

  const render = () => {
    players.forEach((p, card) => { p.destroy(); io.unobserve(card); }); players.clear();
    const grid = $("#grid"); grid.innerHTML = "";
    const fl = $("#filters");
    fl.innerHTML = items.length ? [["All", items.length], ...allTags()].map(([t, n]) => `<button class="${t === filter ? "on" : ""}" data-f="${esc(t)}">${esc(t)}<i>${n}</i></button>`).join("") : "";
    fl.querySelectorAll("[data-f]").forEach((b) => b.onclick = () => { filter = b.dataset.f; render(); });
    const list = items.filter(matches);
    $("#empty").hidden = items.length > 0;
    if (items.length && !list.length) grid.innerHTML = `<p style="color:var(--fg3);padding:24px 0">Nothing matches “${esc(query || filter)}”.</p>`;
    list.forEach((it, i) => {
      const lib = (it.tags || [])[0];
      const card = document.createElement("article");
      card.className = "card"; card.tabIndex = 0; card.style.animationDelay = Math.min(i, 12) * 40 + "ms";
      card.setAttribute("aria-label", it.name + ", open details");
      card.innerHTML = `<div class="stage">${lib ? `<span class="badge">${esc(lib)}</span>` : ""}${it.hover ? `<span class="hoverhint">Hover effect</span>` : ""}</div>
        <div class="meta"><div class="row"><h3>${esc(it.name)}</h3><span class="site" title="${esc(it.page)}">${esc(it.site || "")}</span></div>
        ${it.desc ? `<p>${esc(it.desc)}</p>` : ""}<div class="tags">${(it.tags || []).slice(1).map((t) => `<span class="tag">${esc(t)}</span>`).join("")}</div></div>`;
      grid.appendChild(card);
      const p = mount(card.querySelector(".stage"), it);
      if (p) { players.set(card, p); io.observe(card); }
      const open = () => openDrawer(it);
      card.onclick = open; card.onkeydown = (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); } };
    });
  };

  /* details: big preview, code tabs, copy, delete */
  let dPlayer = null, dItem = null, dTab = "css", delArm = 0;
  const TABS = [["css", "CSS"], ["js", "JavaScript"], ["react", "React"], ["gsap", "GSAP"], ["prompt", "AI prompt"]];
  const openDrawer = (it) => {
    dItem = it; delArm = 0;
    $("#dTitle").textContent = it.name; $("#dDesc").textContent = it.desc || "";
    $("#dTags").innerHTML = (it.tags || []).map((t, i) => `<span class="tag${i === 0 ? " lib" : ""}">${esc(t)}</span>`).join("");
    const src = $("#dSrc"); src.href = it.page; src.textContent = "From " + (it.title || it.site || it.page);
    const tabs = TABS.filter(([k]) => it.code && it.code[k]);
    if (!tabs.some(([k]) => k === dTab)) dTab = tabs[0] ? tabs[0][0] : "css";
    const drawTabs = () => {
      $("#dTabs").innerHTML = tabs.map(([k, l]) => `<button role="tab" aria-selected="${k === dTab}" data-t="${k}">${l}</button>`).join("");
      $("#dTabs").querySelectorAll("[data-t]").forEach((b) => b.onclick = () => { dTab = b.dataset.t; drawTabs(); });
      $("#dCode").textContent = (it.code && it.code[dTab]) || "";
      $("#dCopy").textContent = "Copy " + (tabs.find(([k]) => k === dTab) || [0, "code"])[1];
    };
    drawTabs();
    $("#dDel").textContent = "Delete";
    const dlg = $("#drawer");
    if (!dlg.open) dlg.showModal();
    requestAnimationFrame(() => { if (dPlayer) dPlayer.destroy(); dPlayer = mount($("#dStage"), it); });
  };
  $("#dClose").onclick = () => $("#drawer").close();
  $("#drawer").addEventListener("close", () => { if (dPlayer) { dPlayer.destroy(); dPlayer = null; } });
  $("#drawer").addEventListener("click", (e) => { if (e.target === $("#drawer")) $("#drawer").close(); });
  $("#dReplay").onclick = () => dPlayer && dPlayer.replay();
  $("#dCopy").onclick = () => {
    const txt = (dItem && dItem.code && dItem.code[dTab]) || "";
    navigator.clipboard.writeText(txt).then(() => toast("Copied to clipboard")).catch(() => toast("The browser blocked the clipboard"));
  };
  $("#dDel").onclick = async () => {
    if (!dItem) return;
    if (Date.now() - delArm > 4000) { delArm = Date.now(); $("#dDel").textContent = "Click again to delete"; return; }
    items = items.filter((x) => x.id !== dItem.id); await save(items);
    $("#drawer").close(); render(); toast("Deleted");
  };
  $("#q").addEventListener("input", (e) => { query = e.target.value.trim().toLowerCase(); render(); });
  $("#speed").onclick = (e) => {
    slow = !slow; e.currentTarget.setAttribute("aria-pressed", String(slow));
    players.forEach((p) => p.rate(slow ? 0.25 : 1)); if (dPlayer) dPlayer.rate(slow ? 0.25 : 1);
  };
  if (hasChrome && chrome.storage.onChanged) chrome.storage.onChanged.addListener((ch, area) => { if (area === "local" && ch[KEY]) { items = ch[KEY].newValue || []; render(); } });
  let rt = 0; addEventListener("resize", () => { clearTimeout(rt); rt = setTimeout(render, 200); });

  load().then((l) => { items = l; render(); });
})();
