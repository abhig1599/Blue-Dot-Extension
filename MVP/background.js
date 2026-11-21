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
        const G = w.gsap, root = G.globalTimeline;
        const topOf = (a) => { let x = a; while (x.parent && x.parent !== root) x = x.parent; return x; };
        const tls = new Map(); let ti = 0;
        /* describe a ScrollTrigger and mark its trigger element so the page script can name it */
        const stInfo = (s) => { if (!s) return null; const v = s.vars || {}; let trig = null; try { const te = s.trigger || (typeof v.trigger === "string" ? document.querySelector(v.trigger) : v.trigger); if (te && te.nodeType === 1) { te.setAttribute("data-dsx-trig", ""); trig = true; } } catch (e) {} return safe({ start: typeof v.start === "string" ? v.start : undefined, end: typeof v.end === "string" ? v.end : undefined, scrub: v.scrub, pin: !!v.pin, toggleActions: v.toggleActions, once: v.once, markers: false, hasTrigger: !!trig }, 0); };
        let node = el, depth = 0;
        while (node && depth < 4) {
          const live = G.getTweensOf(node), recd = (w.__dsxRecorded || []).flatMap((x) => (x.getChildren ? x.getChildren(true, true, false) : [x])).filter((t) => { try { return t.targets && t.targets().includes(node) && !live.includes(t); } catch (e) { return false; } });
          for (const t of [...live, ...recd].slice(0, 8)) {
            let targets = []; try { targets = t.targets().filter((n) => n && n.nodeType === 1); } catch (e) {}
            const tag = "data-dsx-t" + ti; targets.forEach((n) => n.setAttribute(tag, ""));
            const par = t.parent && t.parent !== root ? t.parent : null, top = topOf(t);
            let tlId = null;
            if (par) { if (!tls.has(top)) tls.set(top, { id: tls.size, duration: top.duration(), repeat: top.repeat(), yoyo: top.yoyo(), repeatDelay: top.repeatDelay(), delay: top.delay(), st: stInfo(top.scrollTrigger), children: (top.getChildren ? top.getChildren(true, true, false).length : 0) }); tlId = tls.get(top).id; }
            const v = safe(t.vars, 0) || {}; delete v.parent; delete v.scrollTrigger;
            let rt = {}; try {
              /* playable = plays now, already played, scrub-driven, or scheduled under running ancestors.
                 a tween parked under a paused or finished timeline (pre-registered hover/drag states) never plays at rest */
              let scheduled = !t.paused(), stInChain = false, x = t.parent;
              while (x && x !== root) { if (x.scrollTrigger) stInChain = true; if (x.paused() || x.totalTime() >= x.duration() - 0.001) scheduled = false; x = x.parent; }
              if (t.scrollTrigger) stInChain = true;
              rt = { prog: +t.progress().toFixed(4), paused: !!t.paused(), active: !!t.isActive(), playable: !!(t.isActive() || t.progress() > 0 || stInChain || scheduled) };
            } catch (e) {}
            out.gsap.push({ on: depth === 0 ? "this element" : "ancestor " + depth, depth, duration: t.duration(), delay: t.delay(), vars: v, tag, count: targets.length, pos: par ? +t.startTime().toFixed(4) : 0, tl: tlId, st: par ? null : stInfo(t.scrollTrigger), rt });
            ti++;
          }
          node = node.parentElement; depth++;
        }
        out.timelines = [...tls.values()];
        /* sample the element frame by frame by driving its own GSAP animation: exact, however the site built it */
        const liveOwn = G.getTweensOf(el);
        /* remembered tweens count only if they are not live already (each tween once) */
        const own = liveOwn.concat((w.__dsxRecorded || []).flatMap((x) => (x.getChildren ? x.getChildren(true, true, false) : [x])).filter((t) => { try { return !liveOwn.includes(t) && t.targets && t.targets().includes(el); } catch (e) { return false; } }).filter((t, i, arr) => arr.indexOf(t) === i));
        if (own.length) {
          /* prefer a tween that actually plays: an idle interaction tween (never started, parked timeline) is not the element's design motion */
          const playable = (t) => { try { if (t.isActive() || t.progress() > 0) return true; if (t.scrollTrigger) return true; let x = t.parent; while (x && x !== root) { if (x.scrollTrigger) return true; if (x.paused() || x.totalTime() >= x.duration() - 0.001) return false; x = x.parent; } return !t.paused(); } catch (e) { return true; } };
          const ownPlayable = own.filter(playable);
          if (!ownPlayable.length) own.length = 0; else own.splice(0, own.length, ...ownPlayable);
        }
        if (own.length) {
          const A = topOf(own[0]), d = A.duration(), rd = A.repeatDelay ? A.repeatDelay() || 0 : 0, yo = A.yoyo ? A.yoyo() : false, rep = A.repeat ? A.repeat() : 0;
          const cyc = rep !== 0 ? (yo ? 2 * (d + rd) : d + rd) : d;
          if (d > 0 && cyc < 120) {
            const PROPS = ["transform", "opacity", "background-color", "color", "clip-path", "filter", "border-top-left-radius", "visibility", "width", "height", "letter-spacing"];
            const saved = A.totalTime(), wasPaused = A.paused(), N = Math.min(240, Math.max(60, Math.round(cyc * 40)));
            const frames = [];
            try {
              A.pause();
              for (let i = 0; i <= N; i++) { A.totalTime(cyc * i / N, true); const cs = getComputedStyle(el), v = {}; PROPS.forEach((p) => { v[p] = cs.getPropertyValue(p); }); frames.push({ t: cyc * 1000 * i / N, v }); }
            } finally { try { A.totalTime(saved, true); if (!wasPaused) A.resume(); } catch (e) {} }
            out.sample = { dur: cyc * 1000, delay: (A.delay ? A.delay() : 0) * 1000, repeat: rep, yoyo: yo, frames, st: stInfo(A.scrollTrigger), tweens: own.length, siblings: A.getChildren ? A.getChildren(true, true, false).length : 1 };
          }
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

// Figma motion export (page JS world).
// Finds every animation that moves the picked element or anything inside it (GSAP tweens, timelines, CSS and
// Web Animations), samples each one densely, pauses it on its most visible frame so the Figma layers can be
// captured there, and returns keyframes relative to that frame. dsxMotionRestore puts everything back.
function dsxMotionCollect() {
  const root = document.querySelector("[data-dsx-root]");
  const out = { items: [], notes: [], libs: [] };
  if (!root) return out;
  const codeMode = root.getAttribute("data-dsx-root") === "code"; /* code mode: absolute frames for CSS/JS, nothing is held */
  /* story mode (copy a section to Figma): scroll becomes time, as if someone scrolled through the section */
  const storyMode = root.getAttribute("data-dsx-root") === "figma-story";
  const PX_MS = 1; /* 1000 px of scrolling = 1 second in Figma */
  /* capture a section from a fixed scroll position: its top at the top of the window, so pinned content sits in place */
  const savedScroll = { x: scrollX, y: scrollY };
  const g = window.gsap;
  if (g) out.libs.push("gsap " + (g.version || ""));
  let alias = null; /* an animated parent whose motion is applied to the picked element (it moves with it) */
  const pathOf = (el) => {
    if (alias && el === alias) return ":scope";
    const chain = []; let n = el;
    while (n && n !== root) { chain.unshift(n); n = n.parentElement; }
    if (n !== root) return null;
    let p = ":scope";
    for (const c of chain) p += " > " + c.tagName.toLowerCase() + ":nth-child(" + (Array.prototype.indexOf.call(c.parentElement.children, c) + 1) + ")";
    return p;
  };
  const inRoot = (el) => el && el.nodeType === 1 && (el === root || root.contains(el) || (alias && el === alias));
  /* drivers: something we can move to any moment. GSAP: the top-level animation (or the tween itself when its
     parent is an endless or paused container). CSS/WAAPI: the Animation object. */
  const drivers = new Map(); // key -> { kind, set(ms), cycleMs, els:Set, restore(), scrub }
  const findDrivers = () => {
  if (g && g.globalTimeline) {
    const topOf = (a) => { let x = a; while (x.parent && x.parent !== g.globalTimeline) x = x.parent; return x; };
    let tweens = [];
    try { tweens = g.globalTimeline.getChildren(true, true, false); } catch (e) {}
    (window.__dsxRecorded || []).forEach((x) => { (x.getChildren ? x.getChildren(true, true, false) : [x]).forEach((t) => { if (!tweens.includes(t)) tweens.push(t); }); }); /* finished hover/scroll animations from the Recorder */
    for (const t of tweens) {
      let tg = []; try { tg = t.targets ? t.targets().filter(inRoot) : []; } catch (e) {}
      if (!tg.length) continue;
      /* skip animations parked under a paused or finished timeline: pre-registered hover/drag states never play at rest,
         and driving them would invert the design (hide what is shown, show what is hidden). ScrollTrigger-driven and
         already-played tweens stay. */
      try {
        let parked = t.paused(), scrubbed = !!t.scrollTrigger, x = t.parent;
        while (x && x !== g.globalTimeline) { if (x.scrollTrigger) scrubbed = true; if (x.paused() || x.totalTime() >= x.duration() - 0.001) parked = true; x = x.parent; }
        if (!scrubbed && parked && !t.isActive() && !(t.progress() > 0)) continue;
      } catch (e) {}
      let A = topOf(t);
      const cyc = (x) => { const d = x.duration(), rep = x.repeat ? x.repeat() : 0, rd = x.repeatDelay ? x.repeatDelay() || 0 : 0; return rep !== 0 ? (x.yoyo && x.yoyo() ? 2 * (d + rd) : d + rd) : d; };
      if (!(cyc(A) > 0) || cyc(A) > 600) A = t; // endless container: drive the tween on its own
      if (!(cyc(A) > 0) || cyc(A) > 600) continue;
      if (!drivers.has(A)) {
        const saved = A.totalTime(), wasPaused = A.paused(), st = A.scrollTrigger || (A.vars && A.vars.scrollTrigger);
        const stv = st && (st.vars || st);
        const stInst = A.scrollTrigger && typeof A.scrollTrigger.start === "number" ? A.scrollTrigger : null;
        drivers.set(A, { kind: "gsap", cycleMs: cyc(A) * 1000, els: new Set(), scrub: !!(stv && stv.scrub), loop: (A.repeat ? A.repeat() : 0) === -1, delayMs: (A.delay ? A.delay() : 0) * 1000,
          st: stv ? { start: typeof stv.start === "string" ? stv.start : undefined, end: typeof stv.end === "string" ? stv.end : undefined, scrub: stv.scrub } : null,
          stPx: stInst ? { start: stInst.start, end: stInst.end } : null,
          set: (ms) => { A.pause(); A.totalTime(ms / 1000, true); },
          restore: () => { try { A.totalTime(saved, true); if (!wasPaused) A.resume(); } catch (e) {} } });
      }
      tg.forEach((el) => drivers.get(A).els.add(el));
    }
  }
  let anims = [];
  try { anims = (alias || root).getAnimations({ subtree: !alias }); } catch (e) { try { anims = (alias || root).getAnimations(); } catch (e2) {} }
  ((window.__dsxRec && window.__dsxRec.css) || []).forEach((an) => { if (!anims.includes(an)) anims.push(an); });
  for (const an of anims) {
    const el = an.effect && an.effect.target; if (!inRoot(el)) continue;
    const tm = an.effect.getTiming(); const d = Number(tm.duration) || 0; if (!(d > 0)) continue;
    const per = (tm.direction === "alternate" || tm.direction === "alternate-reverse") ? 2 : 1;
    const cycleMs = d * per + (tm.delay > 0 && tm.delay < 2000 ? tm.delay : 0);
    if (cycleMs > 600000) continue;
    const ct = an.currentTime, ps = an.playState;
    drivers.set(an, { kind: "css", cycleMs, els: new Set([el]), loop: tm.iterations === Infinity, delayMs: 0, set: (ms) => { an.pause(); an.currentTime = ms; }, restore: () => { try { an.currentTime = ct; if (ps === "running") an.play(); } catch (e) {} } });
  }
  };
  findDrivers();
  /* nothing on the element or inside it: it may move because a parent is animated (a marquee track, a slider) */
  if (!drivers.size) {
    for (let a = root.parentElement, k = 0; a && a !== document.body && k < 4 && !drivers.size; a = a.parentElement, k++) {
      alias = a; findDrivers();
      if (drivers.size) { for (const [, D] of drivers) { D.els = new Set([...D.els].filter((x) => x === a)); } if (![...drivers.values()].some((D) => D.els.size)) { drivers.clear(); alias = null; } else out.notes.push("Moves with its parent " + a.tagName.toLowerCase() + (typeof a.className === "string" && a.className.trim() ? "." + a.className.trim().split(/\s+/)[0] : "") + "."); }
      else alias = null;
    }
  }
  if (!drivers.size) { out.notes.push("No animation found on this element, inside it or on its parents. Hover and scroll effects can be caught with Motion > Record the page."); return out; }

  /* story timing: when each animation starts and how long it lasts once scroll becomes time */
  let storyMs = 0;
  if (storyMode) {
    const secTop = root.getBoundingClientRect().top + scrollY, s0 = secTop - innerHeight, sEnd = secTop + root.offsetHeight;
    for (const [, D] of drivers) {
      if (D.stPx) { D.offset = Math.max(0, (D.stPx.start - s0) * PX_MS); D.span = D.scrub ? Math.max(300, (D.stPx.end - D.stPx.start) * PX_MS) : D.cycleMs; }
      else { D.offset = 0; D.span = D.cycleMs; }
      if (!D.loop) storyMs = Math.max(storyMs, D.offset + D.span);
    }
    storyMs = Math.min(60000, Math.max(storyMs, Math.min(20000, (sEnd - s0) * PX_MS * 0.5), ...[...drivers.values()].map((D) => D.loop ? D.cycleMs : 0)));
    out.story = { ms: Math.round(storyMs), pxPerSecond: 1000 / PX_MS };
  }
  /* move a track to its place on the section timeline: scrubbed ones stretch to their scroll distance, loops repeat */
  const toStory = (pts, D) => {
    if (!storyMode) return pts;
    let res = pts.map(([t, v]) => [D.offset + t * (D.span / (D.cycleMs || 1)), v]);
    if (D.loop && D.span > 0) { const one = res.slice(); for (let k = 1; D.offset + k * D.span < storyMs && res.length < 2000; k++) one.forEach(([t, v], i) => { if (i > 0 || k === 0) res.push([t + k * D.span, v]); }); }
    if (res.length && res[0][0] > 0) res.unshift([0, res[0][1]]); /* hold the first value until it starts */
    return res.filter(([t]) => t <= storyMs + 1);
  };
  /* read what the element looks like right now: translation, scale, rotation and opacity */
  const probeBox = document.createElement("div"); probeBox.style.cssText = "position:absolute;left:-99999px;top:0;visibility:hidden;pointer-events:none"; document.documentElement.appendChild(probeBox);
  const read = (el) => {
    const cs = getComputedStyle(el); let m = cs.transform; let tx = 0, ty = 0, sx = 1, sy = 1, rot = 0;
    if ((!m || m === "none") && el.style.transform && el.style.transform !== "none") { /* not rendered or inline: read GSAP's inline transform on a stand-in box of the same size */
      probeBox.style.width = (el.offsetWidth || el.getBoundingClientRect().width || 0) + "px"; probeBox.style.height = (el.offsetHeight || el.getBoundingClientRect().height || 0) + "px";
      probeBox.style.transform = el.style.transform; m = getComputedStyle(probeBox).transform; }
    if (m && m !== "none") { const M = new DOMMatrixReadOnly(m); tx = M.e; ty = M.f; sx = Math.hypot(M.a, M.b); rot = sx > 1e-6 ? Math.atan2(M.b, M.a) * 180 / Math.PI : 0; sy = sx > 1e-6 ? (M.a * M.d - M.b * M.c) / sx : Math.hypot(M.c, M.d); }
    const vis = cs.display === "none" || cs.visibility === "hidden" ? 0 : 1;
    return { tx, ty, sx, sy, rot, op: parseFloat(cs.opacity), vis };
  };
  const hold = [];
  for (const [, D] of drivers) {
    const els = [...D.els].filter((el) => pathOf(el) != null);
    if (!els.length) { D.restore(); continue; }
    /* dense enough for elastic and bounce curves; simplification keeps only the points that matter */
    const N = codeMode ? Math.max(60, Math.min(1200, Math.round(D.cycleMs / 1000 * 240))) : Math.max(40, Math.min(600, Math.round(D.cycleMs / 1000 * 120)));
    const frames = []; // per sample: array of states per element
    for (let i = 0; i <= N; i++) { D.set(D.cycleMs * i / N); frames.push(els.map(read)); }
    if (codeMode) {
      els.forEach((el, j) => {
        const r4 = (x) => +(+x).toFixed(4);
        let lastR = frames[0][j].rot;
        const fr = frames.map((f, i) => { const s = f[j]; let r = s.rot; while (r - lastR > 180) r -= 360; while (r - lastR < -180) r += 360; lastR = r; return { t: D.cycleMs * i / N, v: [s.tx, s.ty, r, s.sx, s.sy, s.op, s.vis] }; });
        const TOLS = [0.15, 0.15, 0.1, 0.001, 0.001, 0.003, 0];
        const changes = TOLS.map((tol, q) => Math.max(...fr.map((x) => x.v[q])) - Math.min(...fr.map((x) => x.v[q])) > tol);
        if (!changes.some(Boolean)) return;
        const ok = (a, b) => { for (let k = a + 1; k < b; k++) { const u = (fr[k].t - fr[a].t) / (fr[b].t - fr[a].t || 1); for (let q = 0; q < 7; q++) { if (q === 6) { if (fr[k].v[6] !== fr[a].v[6]) return false; continue; } if (Math.abs(fr[a].v[q] + u * (fr[b].v[q] - fr[a].v[q]) - fr[k].v[q]) > TOLS[q] + 1e-9) return false; } } return true; };
        const keep = [0]; let i = 0; while (i < fr.length - 1) { let k = i + 2; while (k < fr.length && ok(i, k)) k++; i = k - 1; keep.push(i); }
        const useT = changes.slice(0, 5).some(Boolean), useO = changes[5], useV = changes[6];
        const kfs = [];
        keep.forEach((n, idx) => {
          const v = fr[n].v, props = {};
          if (useT) props.transform = `translate(${r4(v[0])}px, ${r4(v[1])}px) rotate(${r4(v[2])}deg) scale(${r4(v[3])}, ${r4(v[4])})`;
          if (useO) props.opacity = String(r4(v[5]));
          if (useV) props.visibility = v[6] ? "visible" : "hidden";
          kfs.push({ offset: +(fr[n].t / D.cycleMs).toFixed(5), props });
          /* visibility is a step: hold the old value until the exact frame it changes */
          if (useV && idx < keep.length - 1) { const nx = fr[keep[idx + 1]]; if (nx.v[6] !== v[6] && keep[idx + 1] - n > 1) { const pre = fr[keep[idx + 1] - 1]; const p2 = Object.assign({}, props); kfs.push({ offset: +(pre.t / D.cycleMs).toFixed(5), props: p2 }); } }
        });
        const cls = typeof el.className === "string" && el.className.trim() ? "." + el.className.trim().split(/\s+/).slice(0, 2).join(".") : "";
        out.items.push({ path: pathOf(el), cls: el.tagName.toLowerCase() + cls, totalMs: Math.round(D.cycleMs), delayMs: Math.round(D.delayMs || 0), loop: !!D.loop, scrub: !!D.scrub, st: D.st || null, kind: D.kind, kfs });
      });
      D.restore();
      continue;
    }
    /* the most visible frame: big, upright and opaque. The Figma layers are captured there. */
    let best = 0, bestScore = -1e9;
    frames.forEach((f, i) => { const sc = f.reduce((a, s) => a + (s.vis ? Math.min(Math.abs(s.sx), 1) + Math.min(Math.abs(s.sy), 1) + s.op * 0.6 + 2 : 0) - Math.min(Math.abs(s.rot), 180) / 90, 0); /* hidden elements are not converted, so they count for nothing */ if (sc > bestScore + 1e-6) { bestScore = sc; best = i; } });
    D.set(D.cycleMs * best / N); D.bestMs = D.cycleMs * best / N; hold.push(D);
    els.forEach((el, j) => {
      const B = frames[best][j], tr = { tx: [], ty: [], sx: [], sy: [], rot: [], op: [] };
      let lastR = B.rot;
      frames.forEach((f, i) => {
        const s = f[j], t = Math.round(D.cycleMs * i / N);
        let r = s.rot; while (r - lastR > 180) r -= 360; while (r - lastR < -180) r += 360; lastR = r; // no 359 -> 0 jumps
        tr.tx.push([t, s.tx - B.tx]); tr.ty.push([t, s.ty - B.ty]);
        tr.sx.push([t, B.sx ? s.sx / B.sx : s.sx]); tr.sy.push([t, B.sy ? s.sy / B.sy : s.sy]);
        tr.rot.push([t, r - B.rot]); tr.op.push([t, s.vis ? s.op : 0]); /* display:none / visibility:hidden steps become opacity steps */
      });
      const TOL = { tx: 0.1, ty: 0.1, sx: 0.001, sy: 0.001, rot: 0.1, op: 0.002 };
      const simplify = (pts, eps) => { /* keep the fewest points that stay within eps of every sample */
        const keep = [0]; let i = 0;
        while (i < pts.length - 1) { let k = i + 2; for (; k < pts.length; k++) { let ok = true; for (let q = i + 1; q < k; q++) { const u = (pts[q][0] - pts[i][0]) / (pts[k][0] - pts[i][0] || 1); if (Math.abs(pts[i][1] + u * (pts[k][1] - pts[i][1]) - pts[q][1]) > eps) { ok = false; break; } } if (!ok) break; } i = k - 1; keep.push(i); }
        return keep.map((n) => [pts[n][0], +pts[n][1].toFixed(4)]);
      };
      const props = {};
      for (const k of Object.keys(tr)) { const v = tr[k].map((x) => x[1]); if (Math.max(...v) - Math.min(...v) > TOL[k]) props[k] = toStory(simplify(tr[k], TOL[k]), D); }
      if (!Object.keys(props).length) return;
      const cls = typeof el.className === "string" && el.className.trim() ? "." + el.className.trim().split(/\s+/).slice(0, 2).join(".") : "";
      out.items.push({ path: pathOf(el), cls: el.tagName.toLowerCase() + cls, totalMs: Math.round(storyMode ? storyMs : D.cycleMs), startMs: storyMode ? Math.round(D.offset) : 0, scrub: !!D.scrub, loop: !!D.loop, kind: D.kind, props,
        w: el.getBoundingClientRect().width, h: el.getBoundingClientRect().height, origin: getComputedStyle(el).transformOrigin });
    });
  }
  probeBox.remove();
  if (codeMode) return out;
  if (storyMode) {
    /* simulate scrolling in Figma: the copy sits in a viewport-sized frame, the section slides up as the page would
       scroll, and pinned parts move the opposite way while pinned, so they stay put on screen */
    const secTop = root.getBoundingClientRect().top + scrollY, s0 = secTop - innerHeight;
    out.story.viewport = { w: innerWidth, h: innerHeight };
    out.story.s0 = s0;
    /* ScrollTrigger re-syncs scrubbed animations to the scroll position while the layers are converted.
       Scroll to the exact position where its progress equals the capture frame, so both agree (and pins sit right). */
    const sd = hold.find((D) => D.scrub && D.stPx);
    const target = sd ? sd.stPx.start + (sd.bestMs / (sd.cycleMs || 1)) * (sd.stPx.end - sd.stPx.start) : root.getBoundingClientRect().top + scrollY;
    window.scrollTo(savedScroll.x, Math.max(0, Math.round(target)));
    try { if (window.ScrollTrigger) window.ScrollTrigger.update(); } catch (e) {}
    const cap = scrollY, T = storyMs, stepN = 120, scrollAt = (t) => s0 + t / PX_MS;
    out.story.rootY = Math.round(root.getBoundingClientRect().top); /* where the section sits in the window at capture */
    out.story.rootX = Math.round(root.getBoundingClientRect().left);
    const ts = []; for (let i = 0; i <= stepN; i++) ts.push(T * i / stepN);
    out.items.push({ path: ":frame", cls: "scroll", totalMs: Math.round(T), props: { ty: ts.map((t) => [t, +(cap - scrollAt(t)).toFixed(2)]) } });
    /* pinned elements: while pinned they move down with the scroll, relative to the section */
    try {
      const ST = window.ScrollTrigger;
      (ST ? ST.getAll() : []).forEach((t) => {
        const pe = t.pin; if (!pe || pe.nodeType !== 1 || !(pe === root || root.contains(pe))) return;
        const L = t.end - t.start, off = (y) => Math.max(0, Math.min(L, y - t.start));
        const path = pathOf(pe); if (path == null) return;
        const track = ts.map((tt) => [tt, +(off(scrollAt(tt)) - off(cap)).toFixed(2)]);
        const it = out.items.find((x) => x.path === path);
        if (it) { /* add to the element's own movement */
          const own = it.props.ty || [[0, 0], [T, 0]];
          const at = (pts, x) => { if (x <= pts[0][0]) return pts[0][1]; for (let k = 1; k < pts.length; k++) if (x <= pts[k][0]) { const u = (x - pts[k - 1][0]) / (pts[k][0] - pts[k - 1][0] || 1); return pts[k - 1][1] + u * (pts[k][1] - pts[k - 1][1]); } return pts[pts.length - 1][1]; };
          const times = [...new Set([...own.map((q) => q[0]), ...track.map((q) => q[0])])].sort((a, b) => a - b);
          it.props.ty = times.map((x) => [x, +(at(own, x) + at(track, x)).toFixed(2)]);
          if (!it.props.tx) it.props.tx = [[0, 0], [T, 0]];
        } else out.items.push({ path, cls: "pinned", totalMs: Math.round(T), props: { tx: [[0, 0], [T, 0]], ty: track } });
        out.notes.push("Pinned while scrolling: " + (pe.className && typeof pe.className === "string" ? pe.className.split(" ")[0] : pe.tagName.toLowerCase()) + ".");
      });
    } catch (e) {}
  }
  /* while the layers are converted nothing may move the paused frames: switch every ScrollTrigger off, keeping pins
     where they are (disable(false)), and switch them back on in dsxMotionRestore */
  const offST = [];
  try { const ST = window.ScrollTrigger; if (ST && ST.getAll) ST.getAll().forEach((t) => { if (t.enabled !== false && t.isActive !== undefined) { t.disable(false); offST.push(t); } }); } catch (e) {}
  window.__dsxMotionST = offST;
  hold.forEach((D) => { if (D.bestMs != null) D.set(D.bestMs); }); /* put every animation back on its capture frame */
  window.__dsxMotionHold = hold; // kept on the capture frame until dsxMotionRestore
  window.__dsxMotionScroll = storyMode ? savedScroll : null;
  return out;
}
function dsxMotionRestore() {
  (window.__dsxMotionST || []).forEach((t) => { try { t.enable(false); } catch (e) {} }); window.__dsxMotionST = null;
  const h = window.__dsxMotionHold || []; h.forEach((D) => D.restore()); window.__dsxMotionHold = null;
  const sc = window.__dsxMotionScroll; if (sc) { window.scrollTo(sc.x, sc.y); try { window.ScrollTrigger && window.ScrollTrigger.update(); } catch (e) {} window.__dsxMotionScroll = null; }
  return h.length;
}
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || (msg.type !== "dsx-motion-collect" && msg.type !== "dsx-motion-restore") || !sender.tab) return;
  chrome.scripting.executeScript({ target: { tabId: sender.tab.id }, world: "MAIN", func: msg.type === "dsx-motion-collect" ? dsxMotionCollect : dsxMotionRestore })
    .then((r) => sendResponse({ ok: true, data: r && r[0] && r[0].result })).catch((e) => sendResponse({ ok: false, error: String(e && e.message || e) }));
  return true;
});

// Motion Recorder (page JS world). GSAP removes tweens once they finish, so hover, click and scroll-in
// animations cannot be read afterwards. While recording, every new GSAP tween and every CSS animation that
// starts is kept, with the event that triggered it, so it can be inspected, exported or copied to Figma later.
function dsxRecStart() {
  const w = window, g = w.gsap;
  if (w.__dsxRec && w.__dsxRec.on) return { ok: true, already: true, gsap: !!g };
  const R = w.__dsxRec = w.__dsxRec || { on: false, tweens: [], css: [], last: "load", lastAt: 0 };
  w.__dsxRecorded = R.tweens;
  R.on = true; R.t0 = performance.now();
  const mark = (e) => { R.last = e.type.replace(/^pointer/, "").replace(/^mouse/, "") ; R.lastAt = performance.now(); };
  R.evs = ["pointerover", "pointerdown", "click", "scroll", "wheel", "keydown", "focusin"];
  R.evs.forEach((t) => w.addEventListener(t, mark, { capture: true, passive: true }));
  R.mark = mark;
  const trig = () => { const age = performance.now() - R.lastAt; return age < 400 ? ({ over: "hover", down: "click", click: "click", scroll: "scroll", wheel: "scroll", keydown: "key", focusin: "focus" }[R.last] || R.last) : "on its own"; };
  const keep = (a) => { try { if (!a || R.tweens.includes(a)) return; a.__dsxTrig = trig(); a.__dsxAt = Math.round(performance.now() - R.t0); R.tweens.push(a); if (R.tweens.length > 600) R.tweens.shift(); } catch (e) {} };
  const hookGsap = () => {
    const gg = w.gsap;
    if (!gg || gg.__dsxHooked) return;
    gg.__dsxHooked = true;
    ["to", "from", "fromTo"].forEach((k) => { const o = gg[k]; gg[k] = function () { const r = o.apply(this, arguments); if (w.__dsxRec && w.__dsxRec.on) keep(r); return r; }; });
    const otl = gg.timeline; gg.timeline = function () { const tl = otl.apply(this, arguments); if (w.__dsxRec && w.__dsxRec.on) keep(tl); return tl; };
  };
  hookGsap();
  /* GSAP can load after recording starts: keep checking and hook it when it appears */
  if (!w.gsap) { clearInterval(R.gsapPoll); R.gsapPoll = w.setInterval(() => { if (!w.__dsxRec || !w.__dsxRec.on || w.gsap) { clearInterval(R.gsapPoll); R.gsapPoll = 0; } hookGsap(); }, 1000); }
  /* animations that already exist (waiting for a scroll, paused, running) are kept too, and listed once they play */
  try { if (g) g.globalTimeline.getChildren(false, true, true).forEach((t) => { if (R.tweens.includes(t)) return; const d = t.duration ? t.duration() : 0; if (!(d > 0) || d > 600) return; t.__dsxT0 = t.totalTime(); t.__dsxPre = true; keep(t); t.__dsxTrig = null; }); } catch (e) {}
  R.onAnim = (e) => { try { const el = e.target; const an = el.getAnimations().find((x) => (x.animationName || x.transitionProperty) === (e.animationName || e.propertyName)); if (an && !R.css.includes(an)) { an.__dsxTrig = trig(); an.__dsxAt = Math.round(performance.now() - R.t0); R.css.push(an); } } catch (err) {} };
  document.addEventListener("animationstart", R.onAnim, true);
  document.addEventListener("transitionstart", R.onAnim, true);
  return { ok: true, gsap: !!g };
}
function dsxRecStop() {
  const R = window.__dsxRec; if (!R) return { ok: true };
  R.on = false; (R.evs || []).forEach((t) => window.removeEventListener(t, R.mark, { capture: true }));
  clearInterval(R.gsapPoll); R.gsapPoll = 0;
  document.removeEventListener("animationstart", R.onAnim, true);
  document.removeEventListener("transitionstart", R.onAnim, true);
  return { ok: true };
}
/* one row per animated element: what moved, how long, what triggered it. Elements are marked data-dsx-rec. */
function dsxRecList() {
  const R = window.__dsxRec; if (!R) return { rows: [], on: false };
  document.querySelectorAll("[data-dsx-rec]").forEach((n) => n.removeAttribute("data-dsx-rec"));
  const rows = new Map(); let id = 0;
  const desc = (e) => e.tagName.toLowerCase() + (typeof e.className === "string" && e.className.trim() ? "." + e.className.trim().split(/\s+/).slice(0, 2).join(".") : "");
  const SKIP = /^(on|callback|parent|overwrite|lazy|immediateRender|duration|delay|ease|stagger|repeat|yoyo|paused|scrollTrigger|startAt|runBackwards|data|id|repeatDelay|yoyoEase|inherit|keyframes)/;
  const add = (el, props, dur, trigger, at, kind, count) => {
    if (!el || el.nodeType !== 1 || !el.isConnected || el.closest("#dsx-host")) return;
    /* staggered groups (letters, list items) are reported on their shared parent, which is what you pick */
    let key = el; if (count > 1 && el.parentElement) key = el.parentElement;
    if (!rows.has(key)) { const n = ++id; key.setAttribute("data-dsx-rec", String(n)); rows.set(key, { id: n, el: desc(key), props: new Set(), dur: 0, triggers: new Set(), at, kinds: new Set(), count: 0, group: count > 1 }); }
    const r = rows.get(key); props.forEach((p) => r.props.add(p)); r.dur = Math.max(r.dur, dur); r.triggers.add(trigger); r.kinds.add(kind); r.count++; r.at = Math.min(r.at, at);
  };
  for (const a of R.tweens) {
    /* existing animations only count once they actually played during the recording */
    if (a.__dsxPre) { let moved = false; try { moved = (a.isActive && a.isActive()) || Math.abs(a.totalTime() - a.__dsxT0) > 1e-3; } catch (e) {} if (!moved) continue; if (!a.__dsxTrig) a.__dsxTrig = "scroll"; }
    const kids = a.getChildren ? a.getChildren(true, true, false) : [a];
    for (const t of kids) {
      let tg = []; try { tg = t.targets ? t.targets().filter((n) => n && n.nodeType === 1) : []; } catch (e) {}
      const props = Object.keys(t.vars || {}).filter((k) => !SKIP.test(k));
      if (!tg.length || !props.length) continue;
      add(tg[0], props, a.duration ? a.duration() : 0, a.__dsxTrig || "on its own", a.__dsxAt || 0, "GSAP", tg.length);
    }
  }
  for (const an of R.css) { const el = an.effect && an.effect.target; add(el, [an.animationName || an.transitionProperty || "css"], (an.effect.getTiming().duration || 0) / 1000, an.__dsxTrig || "on its own", an.__dsxAt || 0, "CSS", 1); }
  /* letters and list items animated one by one: fold siblings with the same animation into one row on their parent
     (repeat up the tree, so letters inside words inside a link become one row on the link) */
  for (let pass = 0; pass < 5; pass++) {
    /* an element that is its parent's only child is reported on the parent (letter wrappers, masks) */
    for (const [el, r] of [...rows]) { const p = el.parentElement; if (!p || p === document.body || p.children.length !== 1 || rows.has(p)) continue; el.removeAttribute("data-dsx-rec"); rows.delete(el); p.setAttribute("data-dsx-rec", String(r.id)); r.el = desc(p); rows.set(p, r); }
    const byParent = new Map();
    for (const [el, r] of rows) { const p = el.parentElement; if (!p || p === document.body) continue; const k = r.props.size ? [...r.props].sort().join(",") : ""; const key = p; if (!byParent.has(key)) byParent.set(key, []); byParent.get(key).push([el, r, k]); }
    let merged = false;
    for (const [p, list] of byParent) {
      if (list.length < 2) continue;
      const sig = list[0][2]; if (!list.every((x) => x[2] === sig)) continue;
      const first = list[0][1];
      list.forEach(([el]) => { el.removeAttribute("data-dsx-rec"); rows.delete(el); });
      if (rows.has(p)) { const r = rows.get(p); list.forEach(([, x]) => { x.props.forEach((q) => r.props.add(q)); x.triggers.forEach((q) => r.triggers.add(q)); r.count += x.count; }); r.group = true; continue; }
      const n = ++id; p.setAttribute("data-dsx-rec", String(n));
      const r = { id: n, el: desc(p), props: new Set(first.props), dur: Math.max(...list.map(([, x]) => x.dur)), triggers: new Set(list.flatMap(([, x]) => [...x.triggers])), at: Math.min(...list.map(([, x]) => x.at)), kinds: new Set(list.flatMap(([, x]) => [...x.kinds])), count: list.reduce((a, [, x]) => a + x.count, 0), group: true };
      rows.set(p, r); merged = true;
    }
    if (!merged) break;
  }
  return { on: !!R.on, kept: R.tweens.length + R.css.length, rows: [...rows.values()].map((r) => ({ id: r.id, el: r.el, props: [...r.props].slice(0, 6), dur: +r.dur.toFixed(2), triggers: [...r.triggers], at: r.at, kinds: [...r.kinds], count: r.count, group: r.group })).sort((x, y) => x.at - y.at) };
}
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const F = { "dsx-rec-start": dsxRecStart, "dsx-rec-stop": dsxRecStop, "dsx-rec-list": dsxRecList };
  if (!msg || !F[msg.type] || !sender.tab) return;
  chrome.scripting.executeScript({ target: { tabId: sender.tab.id }, world: "MAIN", func: F[msg.type] })
    .then((r) => sendResponse({ ok: true, data: r && r[0] && r[0].result })).catch((e) => sendResponse({ ok: false, error: String(e && e.message || e) }));
  return true;
});

// Flow check: remember which element to mark after navigating to another page.
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !sender.tab) return;
  if (msg.type === "dsx-pending-set") {
    chrome.storage.session.set({ ["dsxp" + sender.tab.id]: msg.pending }).then(() => sendResponse({ ok: true }));
    return true;
  }
  if (msg.type === "dsx-pending-get") {
    const k = "dsxp" + sender.tab.id;
    chrome.storage.session.get(k).then((o) => { const p = o[k]; if (p && p.url && sender.tab.url && sender.tab.url.split("#")[0] === p.url.split("#")[0]) { chrome.storage.session.remove(k); sendResponse({ pending: p }); } else sendResponse({}); });
    return true;
  }
});
chrome.tabs.onUpdated.addListener(async (tabId, info, tab) => {
  if (info.status !== "complete") return;
  const k = "dsxp" + tabId;
  const o = await chrome.storage.session.get(k); const p = o[k];
  if (!p || !tab.url || tab.url.split("#")[0] !== p.url.split("#")[0]) return;
  try { await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] }); }
  catch (e) { chrome.action.setBadgeText({ tabId, text: "!" }); chrome.action.setBadgeBackgroundColor({ tabId, color: "#f24822" }); }
});

// Motion gallery: an extension page that plays every saved animation as a preview card.
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.type !== "dsx-open-gallery") return;
  chrome.tabs.create({ url: chrome.runtime.getURL("gallery.html") }).then(() => sendResponse({ ok: true })).catch((e) => sendResponse({ ok: false, error: String(e && e.message || e) }));
  return true;
});

// Images for Figma copy. With the optional "all sites" permission, the extension can download images that the
// page itself is not allowed to read (CDNs without CORS), so they stay real images instead of placeholders.
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !sender.tab) return;
  if (msg.type === "dsx-fetch-image") {
    (async () => {
      try {
        const origin = new URL(msg.src).origin + "/*";
        if (!(await chrome.permissions.contains({ origins: [origin] }))) return sendResponse({ ok: false, reason: "no-permission" });
        const r = await fetch(msg.src, { credentials: "omit" }); if (!r.ok) return sendResponse({ ok: false, reason: "http " + r.status });
        const b = await r.arrayBuffer(); if (b.byteLength > 12 * 1024 * 1024) return sendResponse({ ok: false, reason: "too large" });
        let bin = ""; const u = new Uint8Array(b); for (let i = 0; i < u.length; i += 0x8000) bin += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000));
        sendResponse({ ok: true, mime: r.headers.get("content-type") || "image/png", b64: btoa(bin) });
      } catch (e) { sendResponse({ ok: false, reason: String(e && e.message || e) }); }
    })();
    return true;
  }
  if (msg.type === "dsx-open-permission") {
    chrome.tabs.create({ url: chrome.runtime.getURL("permission.html") }).then(() => sendResponse({ ok: true })).catch(() => sendResponse({ ok: false }));
    return true;
  }
});
