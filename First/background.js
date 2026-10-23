chrome.action.onClicked.addListener(async (tab) => {
  if (!tab.id || !/^https?:|^file:/.test(tab.url || "")) return;
  try {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content.js"] });
  } catch (e) { console.warn("Blue Dot cannot run on this page:", e); }
});

// Full-page screenshot: the page script asks for one visible-area capture at a time.
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.type !== "dsx-capture" || !sender.tab) return;
  chrome.tabs.captureVisibleTab(sender.tab.windowId, { format: "png" })
    .then((dataUrl) => sendResponse({ ok: true, dataUrl }))
    .catch((e) => sendResponse({ ok: false, error: String(e && e.message || e) }));
  return true;
});

// Figma paste: load the bundled converter (MIT, see THIRD_PARTY_LICENSES.txt) only when needed.
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.type !== "dsx-load-figma" || !sender.tab) return;
  chrome.scripting.executeScript({ target: { tabId: sender.tab.id }, files: ["figma.js"] })
    .then(() => sendResponse({ ok: true })).catch((e) => sendResponse({ ok: false, error: String(e && e.message || e) }));
  return true;
});

// Motion inspector: read animation libraries and tween data from the page's own JS world.
function dsxProbe() {
  const w = window, libs = [], out = { libs, gsap: [], st: [], framer: null };
  const add = (name, version) => { if (!libs.some((l) => l.name === name)) libs.push({ name, version: version || "" }); };
  const safe = (v, d) => {
    if (v == null) return v;
    const t = typeof v;
    if (t === "function" || t === "symbol") return undefined;
    if (t !== "object") return v;
    if (v.nodeType) return undefined;
    if (d > 2) return undefined;
    if (Array.isArray(v)) return v.slice(0, 12).map((x) => safe(x, d + 1)).filter((x) => x !== undefined);
    const o = {}; let n = 0;
    for (const k of Object.keys(v)) { if (n++ > 24) break; const x = safe(v[k], d + 1); if (x !== undefined) o[k] = x; }
    return o;
  };
  try {
    if (w.gsap) add("GSAP", w.gsap.version);
    const STc = w.ScrollTrigger || (w.gsap && w.gsap.core && w.gsap.core.globals && w.gsap.core.globals().ScrollTrigger);
    if (STc) add("GSAP ScrollTrigger", STc.version);
    if (w.AOS || document.querySelector("[data-aos]")) add("AOS");
    if (w.Lenis || w.lenis || document.documentElement.classList.contains("lenis")) add("Lenis", w.Lenis && w.Lenis.version);
    if (w.LocomotiveScroll || document.documentElement.classList.contains("has-scroll-smooth")) add("Locomotive Scroll");
    if (w.anime) add("anime.js", w.anime.version);
    if (w.lottie || w.bodymovin) add("Lottie");
    if (w.Swiper) add("Swiper");
    if (w.THREE) add("Three.js", w.THREE.REVISION);
    if (w.ScrollReveal) add("ScrollReveal");
    if (w.WOW) add("WOW.js");
    if (w.__NEXT_DATA__ || document.getElementById("__next")) add("Next.js");
    if (document.querySelector("[data-framer-appear-id],[data-framer-name]")) add("Framer (published site)");
    const el = document.querySelector("[data-dsx-probe]");
    if (el) {
      if (w.gsap && w.gsap.getTweensOf) {
        let node = el, depth = 0;
        while (node && depth < 4) {
          const ts = w.gsap.getTweensOf(node);
          for (const t of ts.slice(0, 6)) out.gsap.push({ on: depth === 0 ? "this element" : "ancestor " + depth, duration: t.duration(), delay: t.delay(), vars: safe(t.vars, 0) });
          node = node.parentElement; depth++;
        }
      }
      if (STc && STc.getAll) for (const s of STc.getAll()) { try { if (s.trigger === el || (s.trigger && (s.trigger.contains(el) || el.contains(s.trigger)))) out.st.push(safe({ start: s.vars.start, end: s.vars.end, scrub: s.vars.scrub, pin: !!s.vars.pin, toggleActions: s.vars.toggleActions, markers: !!s.vars.markers }, 0)); } catch (e) {} }
      const fk = Object.keys(el).find((k) => k.startsWith("__reactFiber$"));
      if (fk) {
        add("React");
        let f = el[fk], hops = 0;
        while (f && hops < 14) {
          const p = f.memoizedProps;
          if (p && typeof p === "object" && ("animate" in p || "initial" in p || "whileInView" in p || "whileHover" in p || "variants" in p)) {
            out.framer = safe({ initial: p.initial, animate: p.animate, whileInView: p.whileInView, whileHover: p.whileHover, whileTap: p.whileTap, exit: p.exit, transition: p.transition, viewport: p.viewport, variants: p.variants }, 0);
            add("Framer Motion (motion props found)");
            break;
          }
          f = f.return; hops++;
        }
      }
    }
    if (!libs.some((l) => l.name === "React") && (document.querySelector("[data-reactroot]") || [...document.querySelectorAll("body > div")].some((d) => Object.keys(d).some((k) => k.startsWith("__reactContainer$"))))) add("React");
  } catch (e) { out.error = String(e && e.message || e); }
  return out;
}
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.type !== "dsx-probe" || !sender.tab) return;
  chrome.scripting.executeScript({ target: { tabId: sender.tab.id }, world: "MAIN", func: dsxProbe })
    .then((r) => sendResponse({ ok: true, data: r && r[0] && r[0].result }))
    .catch((e) => sendResponse({ ok: false, error: String(e && e.message || e) }));
  return true;
});

// Figma motion export: sample GSAP/ScrollTrigger animations that touch the picked element (page JS world).
function dsxMotionCollect() {
  const root = document.querySelector("[data-dsx-root]");
  const out = { items: [], notes: [], libs: [] };
  if (!root) return out;
  const g = window.gsap, ST = window.ScrollTrigger;
  if (!g) { out.notes.push("No GSAP found on this page, so only CSS motion could exist (not exported)."); return out; }
  out.libs.push("gsap " + (g.version || ""));
  const pathOf = (el) => {
    const chain = []; let n = el;
    while (n && n !== root) { chain.unshift(n); n = n.parentElement; }
    if (n !== root) return null;
    let p = ":scope";
    for (const c of chain) p += " > " + c.tagName.toLowerCase() + ":nth-child(" + (Array.prototype.indexOf.call(c.parentElement.children, c) + 1) + ")";
    return p;
  };
  const anims = [];
  const seen = new Set();
  const add = (a, scrub, label) => { if (a && !seen.has(a)) { seen.add(a); anims.push({ a, scrub, label }); } };
  if (ST) ST.getAll().forEach((t) => add(t.animation, !!t.vars.scrub, t.vars.trigger && t.vars.trigger.id || ""));
  try { g.globalTimeline.getChildren(false, true, true).forEach((c) => { if (!c.scrollTrigger && !(c.parent && c.parent !== g.globalTimeline)) add(c, false, "free"); }); } catch (e) {}
  const N = 24;
  const simplify = (pts, eps) => {
    if (pts.length < 3) return pts;
    const keep = [pts[0], pts[pts.length - 1]];
    const rec = (a, b) => {
      let worst = -1, wi = -1;
      for (let i = a + 1; i < b; i++) {
        const t = (pts[i][0] - pts[a][0]) / (pts[b][0] - pts[a][0] || 1);
        const lin = pts[a][1] + t * (pts[b][1] - pts[a][1]);
        const e = Math.abs(pts[i][1] - lin);
        if (e > worst) { worst = e; wi = i; }
      }
      if (worst > eps) { keep.push(pts[wi]); rec(a, wi); rec(wi, b); }
    };
    rec(0, pts.length - 1);
    return keep.sort((x, y) => x[0] - y[0]);
  };
  const used = new Map();
  for (const { a, scrub, label } of anims) {
    let kids = [a];
    try { if (a.getChildren) kids = a.getChildren(true, true, false); } catch (e) {}
    const els = [];
    for (const k of kids) { let ts = []; try { ts = k.targets ? k.targets() : []; } catch (e) {} for (const t of ts) if (t && t.nodeType === 1 && root.contains(t) && !els.includes(t)) els.push(t); }
    if (!els.length) continue;
    const dur = a.duration();
    if (!(dur > 0)) continue;
    const totalMs = scrub ? 2000 : Math.round(dur * 1000);
    const p0 = a.progress();
    const samp = els.map(() => []);
    try {
      for (let i = 0; i <= N; i++) {
        a.progress(i / N, true);
        els.forEach((el, j) => {
          const gp = (p) => +g.getProperty(el, p) || 0;
          const cs = getComputedStyle(el);
          samp[j].push({ t: Math.round(totalMs * i / N), tx: gp("x"), ty: gp("y"), rot: gp("rotation"), sx: g.getProperty(el, "scaleX"), sy: g.getProperty(el, "scaleY"), op: parseFloat(cs.opacity), vis: cs.visibility });
        });
      }
    } finally { try { a.progress(p0, true); } catch (e) {} }
    els.forEach((el, j) => {
      const path = pathOf(el); if (!path) return;
      const props = {};
      for (const key of ["tx", "ty", "rot", "sx", "sy", "op"]) {
        const vals = samp[j].map((s) => s[key]);
        const min = Math.min(...vals), max = Math.max(...vals);
        if (!(max - min > (key === "op" || key === "sx" || key === "sy" ? 0.002 : 0.05))) continue;
        const uk = path + "|" + key;
        if (used.has(uk)) { out.notes.push("Two animations drive " + key + " on the same element (" + (el.className && el.className.baseVal === undefined ? String(el.className).split(" ")[0] : el.tagName) + "); only the first was exported."); continue; }
        used.set(uk, 1);
        props[key] = simplify(samp[j].map((s) => [s.t, +s[key].toFixed(4)]), key === "op" ? 0.01 : key === "sx" || key === "sy" ? 0.005 : 0.4);
      }
      const origin = getComputedStyle(el).transformOrigin;
      const cls = el.className && el.className.baseVal === undefined ? String(el.className).split(" ").slice(0, 2).join(".") : el.tagName.toLowerCase();
      const unsupported = [];
      try { const vv = (k) => k.vars || {}; for (const k of kids) { const v = vv(k); for (const n of Object.keys(v)) if (/textShadow|filter|clip|backgroundColor|color|boxShadow|width|height|^--|^attr$|strokeDash|borderRadius|^css$/i.test(n) && !unsupported.includes(n)) { const tt = k.targets ? k.targets() : []; if (tt.includes(el)) unsupported.push(n); } } } catch (e) {}
      if (Object.keys(props).length || unsupported.length) out.items.push({ path, cls, scrub, label, totalMs, origin, props, unsupported, w: el.getBoundingClientRect().width, h: el.getBoundingClientRect().height });
    });
  }
  return out;
}
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.type !== "dsx-motion-collect" || !sender.tab) return;
  chrome.scripting.executeScript({ target: { tabId: sender.tab.id }, world: "MAIN", func: dsxMotionCollect })
    .then((r) => sendResponse({ ok: true, data: r && r[0] && r[0].result })).catch((e) => sendResponse({ ok: false, error: String(e && e.message || e) }));
  return true;
});
