(() => {
  if (window.__dsx) { window.__dsx.toggle(); return; }

  /* ---------- state ---------- */
  const HOST_ID = "dsx-host";
  let uid = 0;
  const overrides = new Map();   // elId -> {prop: value}
  const rootVars = new Map();    // --name -> value
  const log = new Map();         // key -> {label, from, to, kind}
  const textEdits = new Map();   // elId -> {el, orig, cur}
  let showOrig = false;
  const cache = {};              // mode -> scan result
  let busyN = 0; const busy = (on) => { busyN = Math.max(0, busyN + (on ? 1 : -1)); host.classList.toggle("busy", busyN > 0); };
  const withBusy = async (fn) => { busy(true); try { return await fn(); } finally { setTimeout(() => busy(false), 350); } };
  let mode = null, picking = false, selected = null, finishOpen = false, figmaArmed = false, motionArmed = false, codeArmed = false, sectionArmed = false;

  /* every listener on document/window and every observer is tracked, so closing removes it all */
  const lifeLs = [], lifeObs = [];
  const onL = (t, n, f, o) => { t.addEventListener(n, f, o); lifeLs.push([t, n, f, o]); };
  const obsL = (o) => { lifeObs.push(o); return o; };

  /* ---------- helpers ---------- */
  const isUI = (el) => el.id === HOST_ID || (el.closest && el.closest("#" + HOST_ID));
  const toHex = (c) => {
    const m = c && c.match(/rgba?\(([^)]+)\)/);
    if (!m) return null;
    const p = m[1].split(/[,\s/]+/).filter(Boolean).map(Number);
    if (p.length >= 4 && p[3] === 0) return null;
    return "#" + p.slice(0, 3).map((v) => Math.round(v).toString(16).padStart(2, "0")).join("");
  };
  const sat = (hex) => {
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.substr(i, 2), 16) / 255);
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
    return mx === 0 ? 0 : (mx - mn) / mx;
  };
  const pretty = (v) => v.replace(/^--/, "").replace(/^(color|colour|clr)[-_]/, "").split(/[-_]/).map((w) => w[0] ? w[0].toUpperCase() + w.slice(1) : w).join(" ");
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const elId = (el) => { if (!el.hasAttribute("data-dsx")) el.setAttribute("data-dsx", ++uid); return el.getAttribute("data-dsx"); };
  const selectorOf = (el) => {
    let s = el.tagName.toLowerCase();
    if (el.id) s += "#" + el.id;
    else if (el.classList.length) s += "." + [...el.classList].slice(0, 2).join(".");
    return s;
  };
  const allEls = () => [...document.body.querySelectorAll("*")].filter((e) => !isUI(e) && !["SCRIPT", "STYLE", "NOSCRIPT", "LINK", "META"].includes(e.tagName)).slice(0, 6000);

  /* CSS variable map: hex -> [names] */
  let varMap = null;
  const buildVarMap = () => {
    if (varMap) return varMap;
    varMap = new Map();
    const names = new Map();
    const walk = (rules) => {
      for (const r of rules) {
        if (r.style) for (const n of r.style) if (n.startsWith("--") && !names.has(n)) names.set(n, r.style.getPropertyValue(n));
        if (r.cssRules) try { walk(r.cssRules); } catch (e) {}
      }
    };
    for (const sh of document.styleSheets) { try { walk(sh.cssRules); } catch (e) {} }
    const colorish = (v) => { v = String(v || "").trim(); if (!v) return false; if (/^-?[\d.]+(px|rem|em|ch|ex|%|vh|vw|vmin|vmax|s|ms|deg|rad|turn|fr|dppx|x)?$/i.test(v)) return false; if (/^\d/.test(v)) return false; return /^(#|rgb|hsl|hwb|okl|oklab|lab|lch|color\(|light-dark\(|var\(--|[a-zA-Z]+$)/i.test(v); };
    for (const [n, v] of names) { if (!colorish(v)) names.delete(n); }
    const probe = document.createElement("span");
    probe.style.display = "none";
    document.body.appendChild(probe);
    for (const n of names.keys()) {
      probe.style.color = "";
      probe.style.color = `var(${n})`;
      const hex = toHex(getComputedStyle(probe).color);
      if (probe.style.color && hex) {
        if (!varMap.has(hex)) varMap.set(hex, []);
        varMap.get(hex).push(n);
      }
    }
    probe.remove();
    return varMap;
  };

  /* ---------- override stylesheet + change log ---------- */
  const sheet = document.createElement("style");
  sheet.id = "dsx-overrides";
  document.documentElement.appendChild(sheet);
  let scheduleIssues = null;
  const ignored = new Set();
  const render = () => {
    if (showOrig) setCompare(false);
    let css = "";
    if (rootVars.size) css += ":root{" + [...rootVars].map(([k, v]) => `${k}:${v} !important`).join(";") + "}\n";
    for (const [id, props] of overrides) css += `[data-dsx="${id}"]{` + Object.entries(props).map(([p, v]) => `${p}:${v} !important`).join(";") + "}\n";
    sheet.textContent = css;
    if (scheduleIssues) scheduleIssues();
  };
  const setProp = (el, prop, val) => {
    const id = elId(el);
    if (!overrides.has(id)) overrides.set(id, {});
    overrides.get(id)[prop] = val;
  };
  const record = (key, label, from, to, kind) => {
    const e = log.get(key);
    const f = e ? e.from : from;
    if (f === to) log.delete(key); else log.set(key, { label, from: f, to, kind });
    updateBadge();
  };
  const revertAll = () => {
    for (const t of textEdits.values()) { t.el.removeAttribute("contenteditable"); t.el.textContent = t.orig; }
    textEdits.clear(); showOrig = false; sheet.media = ""; host.classList.remove("orig"); cmpEl.classList.add("gone");
    overrides.clear(); rootVars.clear(); log.clear(); ignored.clear(); render();
    document.querySelectorAll("[data-dsx]").forEach((e) => e.removeAttribute("data-dsx"));
    uid = 0;
    for (const k in cache) delete cache[k]; // element ids were reset
    updateBadge(); openMode(mode); if (selected) showElement(selected);
  };

  /* ---------- scans ---------- */
  const COLOR_PROPS = [["color", "text"], ["background-color", "bg"], ["border-top-color", "border"], ["border-right-color", "border"], ["border-bottom-color", "border"], ["border-left-color", "border"]];
  const scanColors = () => {
    const vm = buildVarMap();
    const map = new Map();
    for (const el of allEls()) {
      const cs = getComputedStyle(el);
      for (const [prop, use] of COLOR_PROPS) {
        if (use === "border" && (parseFloat(cs.getPropertyValue(prop.replace("color", "width"))) === 0 || cs.getPropertyValue(prop.replace("color", "style")) === "none")) continue;
        const hex = toHex(cs.getPropertyValue(prop));
        if (!hex) continue;
        if (!map.has(hex)) map.set(hex, { hex, els: [], uses: { text: 0, bg: 0, border: 0 }, accent: false });
        const s = map.get(hex);
        s.els.push({ el, prop }); s.uses[use]++;
        if ((el.tagName === "A" || el.tagName === "BUTTON" || el.getAttribute("role") === "button") && use !== "border") s.accent = true;
      }
    }
    const list = [...map.values()].sort((a, b) => b.els.length - a.els.length).slice(0, 40);
    const counters = {};
    for (const s of list) {
      const vars = vm.get(s.hex) || [];
      const dom = Object.entries(s.uses).sort((a, b) => b[1] - a[1])[0][0];
      let base = sat(s.hex) > 0.4 && s.accent ? "Accent" : dom === "text" ? "Text" : dom === "bg" ? "Surface" : "Border";
      counters[base] = (counters[base] || 0) + 1;
      s.vars = vars;
      s.name = vars.length ? pretty(vars[0]) : base + " " + counters[base];
      const parts = [];
      if (s.uses.text) parts.push(`text x${s.uses.text}`);
      if (s.uses.bg) parts.push(`background x${s.uses.bg}`);
      if (s.uses.border) parts.push(`border x${s.uses.border}`);
      s.role = parts.join(" / ");
    }
    return list;
  };
  const scanText = () => {
    const map = new Map();
    for (const el of allEls()) {
      if (![...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim())) continue;
      const cs = getComputedStyle(el);
      const g = { family: cs.fontFamily, size: cs.fontSize, weight: cs.fontWeight, lh: cs.lineHeight, ls: cs.letterSpacing };
      const key = Object.values(g).join("|");
      if (!map.has(key)) map.set(key, { key, ...g, els: [], tags: {} });
      const s = map.get(key);
      s.els.push(el); s.tags[el.tagName.toLowerCase()] = (s.tags[el.tagName.toLowerCase()] || 0) + 1;
    }
    const list = [...map.values()].sort((a, b) => parseFloat(b.size) - parseFloat(a.size) || b.els.length - a.els.length).slice(0, 30);
    list.forEach((s) => {
      const t = Object.entries(s.tags).sort((a, b) => b[1] - a[1])[0][0];
      s.name = /^h[1-6]$/.test(t) ? "Heading " + t.slice(1) : t === "a" ? "Link" : t === "button" ? "Button label" : t === "label" ? "Label" : parseFloat(s.size) <= 13 ? "Small / caption" : "Body";
    });
    return list;
  };
  const SPACE_PROPS = ["padding-top", "padding-right", "padding-bottom", "padding-left", "margin-top", "margin-right", "margin-bottom", "margin-left", "row-gap", "column-gap"];
  const scanSpacing = () => {
    const map = new Map();
    for (const el of allEls()) {
      const cs = getComputedStyle(el);
      for (const p of SPACE_PROPS) {
        const v = parseFloat(cs.getPropertyValue(p));
        if (!(v > 0)) continue;
        const k = Math.round(v * 10) / 10;
        if (!map.has(k)) map.set(k, { value: k, els: [], kinds: { padding: 0, margin: 0, gap: 0 } });
        const s = map.get(k);
        s.els.push({ el, prop: p }); s.kinds[p.split("-")[0]]++;
      }
    }
    return [...map.values()].sort((a, b) => b.els.length - a.els.length).slice(0, 24).sort((a, b) => a.value - b.value);
  };

  /* ---------- contrast + lint core ---------- */
  const parseRGBA = (c) => {
    const m = c && c.match(/rgba?\(([^)]+)\)/);
    if (!m) return null;
    const p = m[1].split(/[,\s/]+/).filter(Boolean).map(Number);
    return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
  };
  const blend = (f, b) => ({ r: f.r * f.a + b.r * (1 - f.a), g: f.g * f.a + b.g * (1 - f.a), b: f.b * f.a + b.b * (1 - f.a), a: 1 });
  const lum = (c) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b); };
  const ratioOf = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
  const effBg = (el) => {
    const layers = [];
    for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
      const cs = getComputedStyle(n);
      if (cs.backgroundImage !== "none") return null; // image or gradient: cannot judge
      const c = parseRGBA(cs.backgroundColor);
      if (c && c.a > 0) { layers.push(c); if (c.a >= 1) break; }
    }
    let base = { r: 255, g: 255, b: 255, a: 1 };
    for (let i = layers.length - 1; i >= 0; i--) base = blend(layers[i], base);
    return base;
  };
  const hasOwnText = (el) => [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
  const isVisible = (el) => {
    const cs = getComputedStyle(el), r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && cs.visibility !== "hidden" && cs.display !== "none" && parseFloat(cs.opacity) > 0.05;
  };
  const textContrast = (el) => {
    const cs = getComputedStyle(el), bg = effBg(el), fg = parseRGBA(cs.color);
    if (!bg || !fg) return null;
    const fs = parseFloat(cs.fontSize), large = fs >= 24 || (fs >= 18.66 && parseInt(cs.fontWeight, 10) >= 700);
    const f = blend(fg, bg);
    return { ratio: ratioOf(f, bg), need: large ? 3 : 4.5, large };
  };
  const isControl = (el) => el.tagName === "BUTTON" || el.getAttribute("role") === "button" || (el.tagName === "INPUT" && /^(submit|button)$/.test(el.type)) || (el.tagName === "A" && el.className && /btn|button|cta/i.test(String(el.className)));
  let bodySize = null;
  const getBodySize = () => {
    if (bodySize) return bodySize;
    const ps = [...document.querySelectorAll("p,li")].filter((e) => !isUI(e) && hasOwnText(e)).slice(0, 40).map((e) => parseFloat(getComputedStyle(e).fontSize)).sort((a, b) => a - b);
    return (bodySize = ps.length ? ps[Math.floor(ps.length / 2)] : 16);
  };
  const rgb2hsl = (c) => { const r = c.r / 255, g = c.g / 255, b = c.b / 255, mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2; let h = 0, s2 = 0; if (mx !== mn) { const d = mx - mn; s2 = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn); h = mx === r ? (g - b) / d + (g < b ? 6 : 0) : mx === g ? (b - r) / d + 2 : (r - g) / d + 4; h /= 6; } return { h, s: s2, l }; };
  const hsl2rgb = (o) => { const f = (p, q, t) => { if (t < 0) t += 1; if (t > 1) t -= 1; return t < 1 / 6 ? p + (q - p) * 6 * t : t < 1 / 2 ? q : t < 2 / 3 ? p + (q - p) * (2 / 3 - t) * 6 : p; }; if (!o.s) return { r: o.l * 255, g: o.l * 255, b: o.l * 255, a: 1 }; const q = o.l < 0.5 ? o.l * (1 + o.s) : o.l + o.s - o.l * o.s, p2 = 2 * o.l - q; return { r: f(p2, q, o.h + 1 / 3) * 255, g: f(p2, q, o.h) * 255, b: f(p2, q, o.h - 1 / 3) * 255, a: 1 }; };
  /* nearest same-hue colour that passes: keeps hue and saturation, moves lightness the least */
  const nearPass = (base, other, need) => {
    const o = rgb2hsl(base); let best = null;
    for (let d = 0; d <= 1.0001; d += 0.004) for (const sg of [-1, 1]) {
      const l = o.l + sg * d; if (l < 0 || l > 1) continue;
      const c = hsl2rgb({ h: o.h, s: o.s, l }), hx = hx2(c), cc = { r: parseInt(hx.slice(1, 3), 16), g: parseInt(hx.slice(3, 5), 16), b: parseInt(hx.slice(5, 7), 16), a: 1 };
      if (ratioOf(cc, other) >= need + 0.03) { const dist = Math.hypot(cc.r - base.r, cc.g - base.g, cc.b - base.b); if (!best || dist < best.dist) best = { hex: hx, ratio: ratioOf(cc, other), dist }; }
    }
    return best;
  };
  const smartFix = (el) => {
    const cs = getComputedStyle(el), bg = effBg(el), fg0 = parseRGBA(cs.color), t = textContrast(el);
    if (!bg || !fg0 || !t) return null;
    const fg = blend(fg0, bg), need = t.need, cands = [];
    const tf = nearPass(fg, bg, need); if (tf) cands.push({ side: "text", prop: "color", from: hx2(fg), to: tf.hex, ratio: tf.ratio, dist: tf.dist });
    const ob = parseRGBA(cs.backgroundColor);
    if (ob && ob.a >= 0.95) { const bf = nearPass(ob, fg, need); if (bf) cands.push({ side: "background", prop: "background-color", from: hx2(ob), to: bf.hex, ratio: bf.ratio, dist: bf.dist }); }
    if (!cands.length) return null;
    cands.sort((a, b) => a.dist - b.dist);
    return { ...cands[0], before: t.ratio, need, fg: hx2(fg), bgHex: hx2(bg) };
  };
  const lintEl = (el) => {
    const out = [], cs = getComputedStyle(el);
    if (hasOwnText(el)) {
      const t = textContrast(el);
      if (t && t.ratio < t.need) out.push({ sev: "error", key: "contrast", ratio: t.ratio, msg: `Contrast ${t.ratio.toFixed(1)}:1, needs ${t.need}:1 for ${t.large ? "large " : "body "}text (WCAG 1.4.3)` });
      const fs = parseFloat(cs.fontSize);
      if (fs < 12) out.push({ sev: "warn", key: "small", msg: `Text is ${fs}px, below the 12px minimum for comfortable reading` });
      const lh = parseFloat(cs.lineHeight) / fs;
      if (!isNaN(lh) && el.textContent.trim().length > 80 && lh < 1.3) out.push({ sev: "warn", key: "lh", msg: `Line height ${lh.toFixed(2)} is tight for paragraph text (1.5 recommended)` });
      if (/^H[1-6]$/.test(el.tagName) && fs <= getBodySize()) out.push({ sev: "warn", key: "hier", msg: `Heading is ${fs}px, no larger than body text (${getBodySize()}px): hierarchy breaks` });
    }
    if (isControl(el)) {
      const bg = parseRGBA(cs.backgroundColor), par = el.parentElement && effBg(el.parentElement);
      const bw = parseFloat(cs.borderTopWidth) > 0 && cs.borderTopStyle !== "none";
      if (bg && bg.a > 0.5 && par && !bw) {
        const r = ratioOf(blend(bg, par), par);
        if (r < 3) out.push({ sev: "warn", key: "ui", ratio: r, msg: `Control blends into its surroundings (${r.toFixed(1)}:1, needs 3:1 for UI components, WCAG 1.4.11)` });
      }
    }
    return out;
  };
  const lintMany = (els) => {
    const m = new Map();
    for (const el of [...new Set(els)].slice(0, 150)) {
      for (const i of lintEl(el)) {
        const e = m.get(i.key);
        if (!e) m.set(i.key, { ...i, count: 1, els: [el] });
        else { e.count++; e.els.push(el); if (i.ratio !== undefined && i.ratio < e.ratio) { e.ratio = i.ratio; e.msg = i.msg; } }
      }
    }
    const outl = [...m.values()].sort((a, b) => (a.sev === "error" ? 0 : 1) - (b.sev === "error" ? 0 : 1)); outl.src = els; return outl;
  };
  const sameColourPeers = (fx, el0) => {
    const out = [];
    for (const e of allEls()) {
      if (e === el0 || isUI(e) || !hasOwnText(e) || !isVisible(e)) continue;
      const t = textContrast(e); if (!t || t.ratio >= t.need) continue;
      const f = smartFix(e); if (f && f.side === fx.side && f.from === fx.from && f.bgHex === fx.bgHex && f.fg === fx.fg) out.push({ e, f });
      if (out.length > 300) break;
    }
    return out;
  };
  const doContrastFix = (list) => {
    const done = [];
    for (const { el, f } of list) {
      const id = elId(el), prev = (overrides.get(id) || {})[f.prop], key = "fx:" + wk(el) + ":" + f.prop;
      setProp(el, f.prop, f.to);
      record(key, `${selectorOf(el)} ${f.side} colour (contrast fix ${f.before.toFixed(1)} to ${f.ratio.toFixed(1)}:1)`, f.from, f.to, "colour");
      done.push({ el, f, prev, key });
    }
    render(); return done;
  };
  const undoContrastFix = (done) => { for (const { el, f, prev, key } of done) { const o = overrides.get(elId(el)); if (o) { if (prev === undefined) delete o[f.prop]; else o[f.prop] = prev; } record(key, "", f.from, f.from, "colour"); } render(); };
  const renderLint = (node, issues) => {
    if (!node) return;
    const src = issues.src;
    node.innerHTML = issues.length
      ? issues.map((i) => {
          let extra = "";
          if (i.key === "contrast" && i.els && i.els.length) { const f = smartFix(i.els[0]); if (f) extra = `<div class="fnrow"><button class="fixnow" type="button" data-fn="1" title="Change the ${f.side} from ${f.from} to ${f.to}">Fix now</button><span class="fnsub">${f.side} ${f.from} \u2192 ${f.to} \u00b7 ${f.ratio.toFixed(1)}:1</span></div>`; }
          return `<div class="lt ${i.sev === "error" ? "err" : "warn"}">${i.sev === "error" ? "\u25cf" : "\u25b2"} ${esc(i.msg)}${i.count > 1 ? " \u00b7 " + i.count + " elements" : ""}</div>${extra}`;
        }).join("")
      : `<div class="lt ok">\u2713 No contrast or hierarchy issues</div>`;
    const b = node.querySelector("[data-fn]"); if (!b) return;
    const ci = issues.find((i) => i.key === "contrast");
    b.addEventListener("click", (ev) => {
      ev.stopPropagation();
      const list = ci.els.map((el) => ({ el, f: smartFix(el) })).filter((x) => x.f);
      const done = doContrastFix(list), first = list[0].f;
      node.getRootNode().querySelectorAll('[data-p="color"],[data-p="background-color"]').forEach((inp) => { const m1 = list.find((x) => x.f.prop === inp.dataset.p); if (m1 && inp.value !== undefined) { try { inp.value = m1.f.to; } catch (e) {} } });
      const peers = sameColourPeers(first, list[0].el);
      node.innerHTML = `<div class="lt ok">\u2713 Fixed: ${first.side} ${first.from} \u2192 ${first.to} \u00b7 ${first.before.toFixed(1)}:1 to ${first.ratio.toFixed(1)}:1</div><div class="fnrow"><button class="fixnow ghost" type="button" data-un="1">Undo</button>${peers.length ? `<button class="fixnow" type="button" data-all="1">Apply to ${peers.length} more</button><span class="fnsub">same colours</span>` : ""}</div>`;
      let all = null;
      node.querySelector("[data-un]").addEventListener("click", (e2) => { e2.stopPropagation(); undoContrastFix(all ? done.concat(all) : done); if (src) renderLint(node, lintMany(src)); });
      const ab = node.querySelector("[data-all]");
      if (ab) ab.addEventListener("click", (e2) => { e2.stopPropagation(); all = doContrastFix(peers.map((p) => ({ el: p.e, f: p.f }))); ab.textContent = `Applied to ${peers.length} more places`; ab.disabled = true; });
    });
  };

  /* ---------- design review audit (automatable subset) ---------- */
  const runAudit = () => {
    bodySize = null;
    const F = [];
    const add = (group, sev, title, reason, items) => F.push({ group, sev, title, reason, items: (items || []).slice(0, 12), total: (items || []).length });
    const els = allEls().filter(isVisible);
    const textEls = els.filter(hasOwnText);
    const name = (el) => (el.getAttribute("aria-label") || el.getAttribute("title") || el.textContent || "").trim();
    const A = "Accessibility", U = "UX heuristics", V = "Visual quality";

    // contrast
    const bad = [];
    for (const el of textEls.slice(0, 2500)) { const t = textContrast(el); if (t && t.ratio < t.need) bad.push({ el, t }); }
    bad.sort((a, b) => a.t.ratio - b.t.ratio);
    bad.length ? add(A, "error", "Text contrast below AA", `${bad.length} text element${bad.length > 1 ? "s" : ""} fail 4.5:1 (3:1 for large text). Worst is ${bad[0].t.ratio.toFixed(1)}:1. WCAG 1.4.3.`, bad.map((b) => ({ el: b.el, note: `${b.t.ratio.toFixed(1)}:1, needs ${b.t.need}:1` })))
      : add(A, "pass", "Text contrast", "Every text element with a plain background passes AA. Text over images or gradients is not checked.");
    // alt
    const noAlt = [...document.images].filter((i) => !isUI(i) && !i.hasAttribute("alt") && i.getAttribute("role") !== "presentation" && isVisible(i));
    noAlt.length ? add(A, "error", "Images missing alt text", `${noAlt.length} image${noAlt.length > 1 ? "s have" : " has"} no alt attribute. Use alt="" for decorative images. WCAG 1.1.1.`, noAlt.map((el) => ({ el, note: (el.getAttribute("src") || "").slice(-40) })))
      : add(A, "pass", "Image alt text", "All images have an alt attribute.");
    // labels
    const ctrls = [...document.querySelectorAll("input,select,textarea")].filter((e) => !isUI(e) && !/^(hidden|submit|button|reset|image)$/.test(e.type) && isVisible(e));
    const unl = ctrls.filter((c) => {
      if (c.getAttribute("aria-label") || c.getAttribute("aria-labelledby") || c.title) return false;
      if (c.id && document.querySelector(`label[for="${CSS.escape(c.id)}"]`)) return false;
      return !c.closest("label");
    });
    unl.length ? add(A, "error", "Form fields without labels", `${unl.length} field${unl.length > 1 ? "s have" : " has"} no label or accessible name. A placeholder is not a label. WCAG 1.3.1, 3.3.2.`, unl.map((el) => ({ el, note: el.placeholder ? `placeholder "${el.placeholder}" only` : "no label" })))
      : add(A, "pass", "Form labels", ctrls.length ? "All visible form fields have a label." : "No form fields on this page.");
    // names
    const inter = [...document.querySelectorAll("a[href],button,[role=button]")].filter((e) => !isUI(e) && isVisible(e));
    const noName = inter.filter((e) => !name(e) && !(e.querySelector("img[alt]:not([alt=''])")) && !e.getAttribute("aria-labelledby"));
    noName.length ? add(A, "error", "Links or buttons without a name", `${noName.length} control${noName.length > 1 ? "s have" : " has"} no text, aria-label or alt text, so screen readers announce nothing useful. WCAG 4.1.2.`, noName.map((el) => ({ el, note: "no accessible name" })))
      : add(A, "pass", "Control names", "Every link and button has an accessible name.");
    // focus
    const focusBad = [];
    const walk = (rules) => { for (const r of rules) { if (r.selectorText && /:focus/.test(r.selectorText) && r.style) { const o = r.style.outline, os = r.style.outlineStyle, ow = r.style.outlineWidth; const off = o === "none" || o === "0" || os === "none" || ow === "0px" || /^0(px)?\b/.test(o || "x"); const alt = r.style.boxShadow || r.style.borderColor || r.style.border || r.style.background || r.style.backgroundColor || r.style.textDecoration; if (off && !alt) focusBad.push({ note: r.selectorText.slice(0, 60) }); } if (r.cssRules) try { walk(r.cssRules); } catch (e) {} } };
    for (const sh of document.styleSheets) { try { walk(sh.cssRules); } catch (e) {} }
    focusBad.length ? add(A, "warning", "Focus outline removed", `${focusBad.length} rule${focusBad.length > 1 ? "s" : ""} remove the focus outline without a replacement style, so keyboard users lose their place. WCAG 2.4.7, 2.4.11.`, focusBad)
      : add(A, "pass", "Visible keyboard focus", "No stylesheet rules strip the focus outline. Real focus order still needs a manual keyboard pass.");
    const tab = [...document.querySelectorAll("[tabindex]")].filter((e) => !isUI(e) && parseInt(e.getAttribute("tabindex"), 10) > 0);
    if (tab.length) add(A, "warning", "Positive tabindex", `${tab.length} element${tab.length > 1 ? "s use" : " uses"} tabindex above 0, which overrides the natural focus order. WCAG 2.4.3.`, tab.map((el) => ({ el, note: "tabindex=" + el.getAttribute("tabindex") })));
    // target size
    const small = inter.filter((e) => { if (e.tagName === "A" && e.closest("p,li,span,td") && getComputedStyle(e).display === "inline") return false; const r = e.getBoundingClientRect(); return r.width < 24 || r.height < 24; });
    small.length ? add(A, "warning", "Small touch targets", `${small.length} control${small.length > 1 ? "s are" : " is"} smaller than 24x24 CSS px. WCAG 2.5.8 (new in 2.2).`, small.map((el) => ({ el, note: Math.round(el.getBoundingClientRect().width) + "x" + Math.round(el.getBoundingClientRect().height) + "px" })))
      : add(A, "pass", "Target size", "Standalone controls are at least 24x24 px.");
    // page level
    const pg = [];
    if (!document.documentElement.lang) pg.push({ note: "<html> has no lang attribute (WCAG 3.1.1)" });
    if (!document.title.trim()) pg.push({ note: "Page has no <title> (WCAG 2.4.2)" });
    const vp = document.querySelector('meta[name=viewport]');
    if (vp && /user-scalable\s*=\s*(no|0)|maximum-scale\s*=\s*1(\.0)?\b/.test(vp.content)) pg.push({ note: "Viewport blocks pinch zoom (WCAG 1.4.4)" });
    pg.length ? add(A, "error", "Page-level basics", `${pg.length} basic issue${pg.length > 1 ? "s" : ""}.`, pg) : add(A, "pass", "Page-level basics", "Language, title and zoom are fine.");

    // UX: hierarchy
    const hs = [...document.querySelectorAll("h1,h2,h3,h4,h5,h6")].filter((e) => !isUI(e) && isVisible(e));
    const hp = [];
    const byLvl = {};
    hs.forEach((h) => { const l = +h.tagName[1]; (byLvl[l] = byLvl[l] || []).push(parseFloat(getComputedStyle(h).fontSize)); });
    const lv = Object.keys(byLvl).map(Number).sort();
    const avg = (a) => a.reduce((x, y) => x + y, 0) / a.length;
    for (let i = 0; i < lv.length - 1; i++) if (avg(byLvl[lv[i]]) < avg(byLvl[lv[i + 1]]) - 0.5) hp.push({ note: `h${lv[i]} (${Math.round(avg(byLvl[lv[i]]))}px) is smaller than h${lv[i + 1]} (${Math.round(avg(byLvl[lv[i + 1]]))}px)` });
    hs.forEach((h) => { if (parseFloat(getComputedStyle(h).fontSize) <= getBodySize()) hp.push({ el: h, note: "heading no larger than body text" }); });
    hp.length ? add(U, "warning", "Visual hierarchy breaks", "Headings should step down in size and stay larger than body text. Aesthetic Match and Hierarchy, NN/g.", hp)
      : add(U, "pass", "Heading hierarchy", hs.length ? "Heading sizes step down in order and stay above body size." : "No headings found.");
    const h1 = hs.filter((h) => h.tagName === "H1").length, skips = [];
    let prev = 0; hs.forEach((h) => { const l = +h.tagName[1]; if (prev && l > prev + 1) skips.push({ el: h, note: `jumps from h${prev} to h${l}` }); prev = l; });
    const hsIssues = [...(h1 === 0 ? [{ note: "No h1 on the page" }] : h1 > 1 ? [{ note: `${h1} h1 elements` }] : []), ...skips];
    hsIssues.length ? add(U, "warning", "Heading structure", "A single h1 and no skipped levels help scanning and screen-reader navigation. WCAG 1.3.1, 2.4.6.", hsIssues) : add(U, "pass", "Heading structure", "One h1, no skipped levels.");
    // consistency
    const btns = els.filter(isControl);
    const sigs = new Map();
    btns.forEach((b) => { const cs = getComputedStyle(b), k = [cs.backgroundColor, cs.borderRadius, cs.fontSize, cs.color].join("|"); if (!sigs.has(k)) sigs.set(k, b); });
    sigs.size > 4 ? add(U, "warning", "Many button styles", `${sigs.size} different button styles across ${btns.length} buttons. Consistency and standards, NN/g.`, [...sigs.values()].map((el) => ({ el, note: "style variant" })))
      : add(U, "pass", "Button consistency", btns.length ? `${sigs.size} button style${sigs.size > 1 ? "s" : ""} in use.` : "No button-styled controls found.");
    const fams = new Map();
    textEls.forEach((e) => { const f = getComputedStyle(e).fontFamily.split(",")[0].replace(/["']/g, "").trim(); fams.set(f, (fams.get(f) || 0) + 1); });
    fams.size > 3 ? add(U, "warning", "Too many font families", `${fams.size} families in use: ${[...fams.keys()].slice(0, 5).join(", ")}. Two or three is usually enough.`, []) : add(U, "pass", "Font families", `${fams.size} font famil${fams.size === 1 ? "y" : "ies"} in use.`);
    const lnk = [...document.querySelectorAll("p a[href],li a[href]")].filter((a) => !isUI(a) && isVisible(a)).filter((a) => {
      const cs = getComputedStyle(a); if (cs.textDecorationLine.includes("underline") || cs.fontWeight >= 600) return false;
      const lc = parseRGBA(cs.color), pc = parseRGBA(getComputedStyle(a.parentElement).color);
      return lc && pc && ratioOf(lc, pc) < 3;
    });
    lnk.length ? add(U, "warning", "Links hard to tell from text", `${lnk.length} inline link${lnk.length > 1 ? "s differ" : " differs"} from surrounding text by under 3:1 and have no underline. WCAG 1.4.1.`, lnk.map((el) => ({ el, note: "no underline, similar colour" })))
      : add(U, "pass", "Link affordance", "Inline links are underlined or clearly distinct.");
    // control, error prevention
    const ux = [];
    document.querySelectorAll("a[href]").forEach((a) => { if (!isUI(a) && /^(#|javascript:)/.test(a.getAttribute("href")) && a.getAttribute("href").length <= 11 && !a.getAttribute("role") && isVisible(a)) ux.push({ el: a, note: "link goes nowhere (" + a.getAttribute("href") + ")" }); });
    document.querySelectorAll("form").forEach((f) => { if (!isUI(f) && !f.querySelector("button:not([type=button]),input[type=submit]")) ux.push({ el: f, note: "form without a submit button" }); });
    ctrls.forEach((c) => { if (c.tagName === "INPUT" && c.type === "text" && /e-?mail/i.test(c.name + c.id)) ux.push({ el: c, note: "email field uses type=text (no validation or mobile keyboard)" }); if (c.type === "password" && !c.autocomplete) ux.push({ el: c, note: "password field has no autocomplete hint" }); });
    document.querySelectorAll('[role=dialog],[aria-modal=true],dialog[open]').forEach((d) => { if (!isUI(d) && isVisible(d) && !d.querySelector('[aria-label*=close i],[class*=close i],button')) ux.push({ el: d, note: "dialog with no close control" }); });
    ux.length ? add(U, "warning", "User control and error prevention", "Dead links, incomplete forms and trapped dialogs make errors harder to avoid or undo. NN/g heuristics 3 and 5.", ux)
      : add(U, "pass", "User control and error prevention", "No dead links, incomplete forms or trapped dialogs found.");

    // Visual
    const ovf = document.documentElement.scrollWidth > document.documentElement.clientWidth + 1;
    const ovEls = els.filter((e) => e.getBoundingClientRect().right > window.innerWidth + 1 && getComputedStyle(e).position !== "fixed").slice(0, 12);
    ovf ? add(V, "error", "Horizontal scroll", `Page is ${document.documentElement.scrollWidth}px wide in a ${document.documentElement.clientWidth}px viewport. WCAG 1.4.10 reflow.`, ovEls.map((el) => ({ el, note: "extends past right edge" })))
      : add(V, "pass", "Horizontal overflow", "No horizontal scroll at this viewport. Resize the window to test other widths.");
    if (!vp) add(V, "warning", "No viewport meta tag", "Mobile browsers will render the desktop layout, scaled down.", []);
    const tiny = textEls.filter((e) => parseFloat(getComputedStyle(e).fontSize) < 12);
    tiny.length ? add(V, "warning", "Very small text", `${tiny.length} element${tiny.length > 1 ? "s use" : " uses"} text under 12px.`, tiny.map((el) => ({ el, note: getComputedStyle(el).fontSize })))
      : add(V, "pass", "Text size", "No text under 12px.");
    const paras = textEls.filter((e) => e.textContent.trim().length > 80 && /^(P|LI|DIV|SPAN|BLOCKQUOTE)$/.test(e.tagName));
    const tight = paras.filter((e) => { const cs = getComputedStyle(e), r = parseFloat(cs.lineHeight) / parseFloat(cs.fontSize); return !isNaN(r) && r < 1.3; });
    const wide = paras.filter((e) => { const cs = getComputedStyle(e); return e.getBoundingClientRect().width / (parseFloat(cs.fontSize) * 0.5) > 95; });
    const rd = [...tight.map((el) => ({ el, note: "line height " + (parseFloat(getComputedStyle(el).lineHeight) / parseFloat(getComputedStyle(el).fontSize)).toFixed(2) })), ...wide.map((el) => ({ el, note: "line is about " + Math.round(el.getBoundingClientRect().width / (parseFloat(getComputedStyle(el).fontSize) * 0.5)) + " characters wide" }))];
    rd.length ? add(V, "warning", "Paragraph readability", `${tight.length} with tight line height (under 1.3), ${wide.length} with a very long line length (over about 95 characters).`, rd) : add(V, "pass", "Paragraph readability", "Line height and line length look comfortable.");
    const sizes = new Set(textEls.map((e) => getComputedStyle(e).fontSize));
    sizes.size > 12 ? add(V, "warning", "Type scale is sprawling", `${sizes.size} different font sizes. A scale of 6 to 8 sizes is easier to keep consistent.`, []) : add(V, "pass", "Type scale", `${sizes.size} font size${sizes.size === 1 ? "" : "s"} in use.`);
    const sp = scanSpacing(), tot = sp.reduce((a, s) => a + s.els.length, 0), off = sp.filter((s) => Math.round(s.value) % 4 !== 0 && Math.round(s.value) % 4 !== 0);
    const offN = off.reduce((a, s) => a + s.els.length, 0);
    tot && offN / tot > 0.35 ? add(V, "warning", "Spacing off a 4px grid", `${Math.round(offN / tot * 100)}% of spacing values are not multiples of 4px: ${off.slice(0, 6).map((s) => s.value + "px").join(", ")}.`, [])
      : add(V, "pass", "Spacing rhythm", "Most spacing values sit on a 4px grid.");
    return F;
  };

  /* ---------- UI shell (shadow DOM) ---------- */
  const host = document.createElement("div");
  host.id = HOST_ID;
  host.style.cssText = "all:initial;position:fixed;inset:0;z-index:2147483647;pointer-events:none;";
  const root = host.attachShadow({ mode: "open" });
  document.documentElement.appendChild(host);
  const ic = (d) => `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
  const hi = (b) => `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">${b}</svg>`;
  const ICONS = {
    compare: hi("<g fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.5\"><path d=\"M21.544 11.045c.304.426.456.64.456.955c0 .316-.152.529-.456.955C20.178 14.871 16.689 19 12 19c-4.69 0-8.178-4.13-9.544-6.045C2.152 12.529 2 12.315 2 12c0-.316.152-.529.456-.955C3.822 9.129 7.311 5 12 5c4.69 0 8.178 4.13 9.544 6.045Z\"/><path d=\"M15 12a3 3 0 1 0-6 0a3 3 0 0 0 6 0Z\"/></g>"),
    gallery: hi("<path fill=\"none\" stroke=\"currentColor\" stroke-linecap=\"round\" stroke-linejoin=\"round\" stroke-width=\"1.5\" d=\"M4 17.98V9.709c0-3.634 0-5.45 1.172-6.58S8.229 2 12 2s5.657 0 6.828 1.129C20 4.257 20 6.074 20 9.708v8.273c0 2.306 0 3.459-.773 3.871c-1.497.8-4.304-1.867-5.637-2.67c-.773-.465-1.16-.698-1.59-.698s-.817.233-1.59.698c-1.333.803-4.14 3.47-5.637 2.67C4 21.44 4 20.287 4 17.981\"/>"),
    effects: hi("<g fill=\"none\" stroke=\"currentColor\" stroke-linecap=\"round\" stroke-linejoin=\"round\" stroke-width=\"1.5\"><path d=\"m8.643 3.146l-1.705.788C4.313 5.147 3 5.754 3 6.75s1.313 1.603 3.938 2.816l1.705.788c1.652.764 2.478 1.146 3.357 1.146s1.705-.382 3.357-1.146l1.705-.788C19.687 8.353 21 7.746 21 6.75s-1.313-1.603-3.938-2.816l-1.705-.788C13.705 2.382 12.879 2 12 2s-1.705.382-3.357 1.146\"/><path d=\"M20.788 11.097c.141.199.212.406.212.634c0 .982-1.313 1.58-3.938 2.776l-1.705.777c-1.652.753-2.478 1.13-3.357 1.13s-1.705-.377-3.357-1.13l-1.705-.777C4.313 13.311 3 12.713 3 11.731c0-.228.07-.435.212-.634\"/><path d=\"M20.377 16.266c.415.331.623.661.623 1.052c0 .981-1.313 1.58-3.938 2.776l-1.705.777C13.705 21.624 12.879 22 12 22s-1.705-.376-3.357-1.13l-1.705-.776C4.313 18.898 3 18.299 3 17.318c0-.391.208-.72.623-1.052\"/></g>"),
    colour: hi("<g fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.5\"><path d=\"M22 12c0-5.523-4.477-10-10-10S2 6.477 2 12s4.477 10 10 10c.842 0 2 .116 2-1c0-.609-.317-1.079-.631-1.546c-.46-.683-.917-1.359-.369-2.454c.667-1.333 1.778-1.333 3.482-1.333c.851 0 1.851 0 3.018-.167c2.101-.3 2.5-1.592 2.5-3.5Z\"/><circle cx=\"9.5\" cy=\"8.5\" r=\"1.5\"/><circle cx=\"16.5\" cy=\"9.5\" r=\"1.5\"/><path stroke-linecap=\"round\" stroke-linejoin=\"round\" d=\"M7.125 15H7m.25 0a.25.25 0 1 1-.5 0a.25.25 0 0 1 .5 0\"/></g>"),
    text: hi("<path fill=\"none\" stroke=\"currentColor\" stroke-linecap=\"round\" stroke-linejoin=\"round\" stroke-width=\"1.5\" d=\"m14 19l-2.893-8.252C9.763 6.916 9.092 5 8 5s-1.763 1.916-3.107 5.748L2 19m2.5-7h7m10.47 1.94v4.5m0-4.5c.046-.824.048-1.45-.05-1.963c-.234-1.206-1.494-1.933-2.714-2.081c-1.168-.142-2.104.159-3.052 1.54m5.815 2.503h-2.843c-.437 0-.878.021-1.299.138c-2.573.716-2.384 4.323.196 4.768c.287.05.58.07.87.058c.677-.03 1.302-.358 1.84-.773c.627-.486 1.236-1.165 1.236-2.19z\"/>"),
    space: hi("<path fill=\"none\" stroke=\"currentColor\" stroke-linecap=\"round\" stroke-linejoin=\"round\" stroke-width=\"1.5\" d=\"M19 2v20M5 2v20M5 7.5v8.997c0 .465 0 .697.038.89A2 2 0 0 0 6.61 18.96c.193.038.425.038.89.038s.697 0 .89-.038a2 2 0 0 0 1.572-1.572c.038-.193.038-.425.038-.89V7.5c0-.465 0-.697-.038-.89A2 2 0 0 0 8.39 5.038C8.197 5 7.965 5 7.5 5s-.697 0-.89.038A2 2 0 0 0 5.038 6.61C5 6.803 5 7.035 5 7.5m9 3v2.997c0 .465 0 .697.038.89a2 2 0 0 0 1.572 1.572c.193.038.425.038.89.038s.697 0 .89-.038a2 2 0 0 0 1.572-1.572c.038-.193.038-.425.038-.89V10.5c0-.465 0-.697-.038-.89a2 2 0 0 0-1.572-1.572C17.197 8 16.965 8 16.5 8s-.697 0-.89.038a2 2 0 0 0-1.572 1.572c-.038.193-.038.425-.038.89\"/>"),
    pick: hi("<g fill=\"none\"><path stroke=\"currentColor\" stroke-linecap=\"round\" stroke-linejoin=\"round\" stroke-width=\"1.5\" d=\"M12.003 19.406L9.885 13.32h0c-.797-2.289-1.195-3.433-.596-4.032c.598-.598 1.744-.2 4.034.596l6.078 2.113c1.27.441 1.906.662 2.043 1.09a.9.9 0 0 1 .038.365c-.045.447-.62.794-1.772 1.49c-.739.445-1.108.668-1.206 1.004a.9.9 0 0 0-.035.294c.015.35.321.654.933 1.261l2.01 1.998h0c.3.299.451.448.52.616c.09.219.09.464 0 .683c-.068.168-.218.318-.518.618h0c-.3.299-.449.448-.616.517a.9.9 0 0 1-.683 0c-.167-.069-.317-.218-.616-.517h0L17.48 19.4h0c-.601-.601-.902-.902-1.247-.92a.9.9 0 0 0-.31.038c-.33.1-.55.465-.989 1.193h0c-.686 1.138-1.03 1.708-1.47 1.758a.9.9 0 0 1-.385-.04c-.421-.14-.64-.768-1.077-2.023\"/><path fill=\"currentColor\" d=\"M10.858 7.083a.75.75 0 0 0 1.284-.774zm-4.549 5.06a.75.75 0 1 0 .774-1.285zM5.75 8.5A2.75 2.75 0 0 1 8.5 5.75v-1.5A4.25 4.25 0 0 0 4.25 8.5zM8.5 5.75c1 0 1.875.533 2.358 1.333l1.284-.774A4.25 4.25 0 0 0 8.5 4.25zm-1.417 5.108A2.75 2.75 0 0 1 5.75 8.5h-1.5c0 1.547.827 2.9 2.06 3.642z\"/><path fill=\"currentColor\" d=\"M14.252 8.135a.75.75 0 0 0 1.496-.095zm-6.21 7.614a.75.75 0 0 0 .094-1.498zM2.75 8.506A5.757 5.757 0 0 1 8.507 2.75v-1.5A7.257 7.257 0 0 0 1.25 8.507zM8.507 2.75a5.757 5.757 0 0 1 5.745 5.385l1.496-.095a7.257 7.257 0 0 0-7.241-6.79zm-.37 11.502A5.757 5.757 0 0 1 2.75 8.506h-1.5c0 3.851 3 7.001 6.791 7.242z\"/></g>"),
    review: hi("<g fill=\"none\" stroke=\"currentColor\" stroke-linecap=\"round\" stroke-linejoin=\"round\" stroke-width=\"1.5\"><path d=\"M18.709 3.495C16.817 2.554 14.5 2 12 2s-4.816.554-6.709 1.495c-.928.462-1.392.693-1.841 1.419S3 6.342 3 7.748v3.49c0 5.683 4.542 8.842 7.173 10.196c.734.377 1.1.566 1.827.566s1.093-.189 1.827-.566C16.457 20.08 21 16.92 21 11.237V7.748c0-1.406 0-2.108-.45-2.834s-.913-.957-1.841-1.419\"/><path d=\"M15 11a3 3 0 1 1-6 0a3 3 0 0 1 6 0\"/></g>"),
    flow: hi("<g fill=\"none\" stroke=\"currentColor\" stroke-linecap=\"round\" stroke-linejoin=\"round\" stroke-width=\"1.5\"><circle cx=\"18\" cy=\"5\" r=\"3\"/><circle cx=\"6\" cy=\"19\" r=\"3\"/><path d=\"M12 5H8.5a3.5 3.5 0 1 0 0 7h7a3.5 3.5 0 1 1 0 7H12\"/></g>"),
    revert: hi("<g fill=\"none\" stroke=\"currentColor\" stroke-linecap=\"round\" stroke-linejoin=\"round\" stroke-width=\"1.5\"><path d=\"M12 21A9 9 0 1 0 4.204 7.5\"/><path d=\"M3 3v1.278c0 2.192 0 3.288.707 3.887c.708.6 1.789.42 3.95.059L9 8\"/></g>"),
    finish: hi("<path fill=\"none\" stroke=\"currentColor\" stroke-linecap=\"round\" stroke-linejoin=\"round\" stroke-width=\"1.5\" d=\"m5 14l3.5 3.5L19 6.5\"/>"),
    theme: hi("<g fill=\"none\" stroke=\"currentColor\" stroke-linecap=\"round\" stroke-width=\"1.5\"><circle cx=\"12\" cy=\"12\" r=\"10\" stroke-linejoin=\"round\"/><path stroke-linejoin=\"round\" d=\"M12 22V2\"/><path d=\"M12 7h8.5M12 17h8.5M12 12h10\"/></g>"),
    shot: hi("<g fill=\"none\" stroke=\"currentColor\" stroke-linecap=\"round\" stroke-width=\"1.5\"><path stroke-linejoin=\"round\" d=\"M12.697 3.5h-1.394c-.715 0-1.072 0-1.392.112a2 2 0 0 0-.545.292c-.271.204-.47.501-.866 1.096h0c-.203.305-.502.753-.621.879a2 2 0 0 1-1.106.591c-.17.03-.353.03-.72.03c-.98 0-1.47 0-1.87.113a3 3 0 0 0-2.07 2.07C2 9.083 2 9.573 2 10.553V14.5c0 2.828 0 4.243.879 5.121S5.172 20.5 8 20.5h8c2.829 0 4.243 0 5.122-.879C22 18.743 22 17.328 22 14.5v-3.946c0-.98 0-1.47-.113-1.871a3 3 0 0 0-2.07-2.07c-.4-.113-.89-.113-1.87-.113c-.366 0-.55 0-.72-.03a2 2 0 0 1-1.105-.591c-.12-.126-.419-.574-.622-.879c-.396-.595-.594-.892-.865-1.096a2 2 0 0 0-.545-.292c-.32-.112-.678-.112-1.393-.112\"/><path stroke-linejoin=\"round\" d=\"M16 13a4 4 0 1 1-8 0a4 4 0 0 1 8 0\"/><path d=\"M19.125 9.5H19m.25 0a.25.25 0 1 1-.5 0a.25.25 0 0 1 .5 0Z\"/></g>"),
    figma: hi("<g fill=\"none\" stroke=\"currentColor\" stroke-linejoin=\"round\" stroke-width=\"1.5\"><circle cx=\"15\" cy=\"12\" r=\"3\"/><path d=\"M9 21a3 3 0 0 0 3-3v-3H9a3 3 0 1 0 0 6Z\"/><path stroke-linecap=\"round\" d=\"M12 9v6H9a3 3 0 1 1 0-6zm0-6v6H9a3 3 0 0 1 0-6zm0 0v6h3a3 3 0 1 0 0-6z\"/></g>"),
    merge: hi("<g fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.5\"><path d=\"M7 20a2 2 0 1 0 0-4a2 2 0 0 0 0 4ZM7 8a2 2 0 1 0 0-4a2 2 0 0 0 0 4Zm10 6a2 2 0 1 0 0-4a2 2 0 0 0 0 4Z\"/><path stroke-linecap=\"round\" stroke-linejoin=\"round\" d=\"M7.021 8.28v7.127m7.39-3.402H10.02c-1.097 0-3.157-.88-3-3.225\"/></g>"),
    motion: hi("<g fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.5\"><circle cx=\"12\" cy=\"12\" r=\"10\"/><path stroke-linejoin=\"round\" d=\"M15.945 12.395c-.176.627-1.012 1.07-2.682 1.955c-1.615.856-2.422 1.285-3.073 1.113a1.66 1.66 0 0 1-.712-.393C9 14.62 9 13.746 9 12s0-2.62.478-3.07c.198-.186.443-.321.712-.392c.65-.173 1.458.256 3.073 1.112c1.67.886 2.506 1.329 2.682 1.955c.073.259.073.531 0 .79Z\"/></g>"),
    play: hi("<path fill=\"currentColor\" d=\"M8 5.5v13a1 1 0 0 0 1.5.86l10.4-6.5a1 1 0 0 0 0-1.72L9.5 4.64A1 1 0 0 0 8 5.5Z\"/>"),
    pause: hi("<path fill=\"currentColor\" d=\"M7 5h3v14H7zM14 5h3v14h-3z\"/>"),
    close: hi("<path fill=\"none\" stroke=\"currentColor\" stroke-linecap=\"round\" stroke-linejoin=\"round\" stroke-width=\"1.5\" d=\"M18 6L6 18m12 0L6 6\"/>")
  };
  const PLAY_I = ICONS.play, PAUSE_I = ICONS.pause;
  root.innerHTML = `
  <style>
    /* ==========================================================
       Blue Dot UI: one design system (v3.0)
       Tokens first, then components. No version layers, no !important
       except where a rule must beat inline styles from the JS.
       ========================================================== */
    :host{all:initial;
      --font:-apple-system,BlinkMacSystemFont,"SF Pro Text",Inter,"Segoe UI",system-ui,sans-serif;
      --mono:ui-monospace,"SF Mono","JetBrains Mono",Menlo,Consolas,monospace;
      /* surfaces: one ramp, darkest = bar */
      --s0:#141416; --s1:#1c1c1f; --s2:#26262a; --s3:#303035; --s4:#3a3a40;
      --line:rgba(255,255,255,.07); --line2:rgba(255,255,255,.12); --line3:rgba(255,255,255,.2);
      /* text: all pass WCAG AA on --s1 and --s2 */
      --fg:#f4f4f5; --fg2:#c2c2c8; --fg3:#9a9aa3;
      /* accent: white text on --acc is 4.8:1 */
      --acc:#0b6bef; --acc-h:#2a7ff3; --acc-t:#79b8ff; --acc-bg:rgba(11,107,239,.18);
      --red:#ff6b5f; --red-bg:rgba(255,107,95,.14); --amb:#ffc54d; --amb-bg:rgba(255,197,77,.14); --grn:#4ad37f; --grn-bg:rgba(74,211,127,.14);
      --r-sm:6px; --r:8px; --r-lg:12px; --r-xl:14px;
      --shadow:0 16px 48px rgba(0,0,0,.45),0 0 0 1px var(--line2);
      --ease:cubic-bezier(.22,1,.36,1); --spring:cubic-bezier(.34,1.3,.64,1);
      --bar:var(--s0);
    }
    *{box-sizing:border-box;font-family:var(--font);-webkit-font-smoothing:antialiased}
    .mono,.hex,.k2,.vn,code,kbd{font-family:var(--mono)}
    button{font-family:var(--font)}
    .gone{display:none!important}
    :focus-visible{outline:2px solid var(--acc-t);outline-offset:2px}

    /* ---------- toolbar ---------- */
    .bar{position:fixed;left:50%;bottom:18px;transform:translateX(-50%);display:flex;align-items:center;gap:6px;width:fit-content;max-width:min(1240px,calc(100vw - 16px));padding:5px;background:var(--s0);border-radius:var(--r-xl);box-shadow:0 12px 36px rgba(0,0,0,.4),0 0 0 1px var(--line2),inset 0 1px 0 rgba(255,255,255,.04);pointer-events:auto;color:var(--fg);overflow:hidden;user-select:none;transition:left .5s var(--ease),max-width .5s var(--ease),box-shadow .3s}
    .bar.collapsed{max-width:48px}
    .bar.dragging{cursor:grabbing;box-shadow:0 16px 44px rgba(0,0,0,.55),0 0 0 1.5px var(--acc)}
    .bar.nofx,.bar.nofx *{transition:none!important}
    .tools{flex:none;display:flex;align-items:center;gap:2px;transition:opacity .3s .1s,transform .45s var(--spring),filter .3s}
    .bar.collapsed .tools{opacity:0;transform:scale(.9);filter:blur(4px);pointer-events:none;transition-delay:0s}
    .grp{display:flex;align-items:center;gap:2px}
    .sep{width:1px;height:20px;background:var(--line2);margin:0 5px;flex:none}

    .btn{all:unset;box-sizing:border-box;position:relative;display:inline-flex;align-items:center;justify-content:center;height:34px;min-width:34px;padding:0 8px;border-radius:var(--r);cursor:pointer;color:var(--fg2);font:500 12.5px var(--font);white-space:nowrap;transition:background .15s,color .15s,padding .4s var(--ease)}
    .btn svg{display:block;flex:none}
    .btn:hover{background:var(--s2);color:var(--fg)}
    .btn:active{background:var(--s3)}
    .btn:focus-visible{outline:2px solid var(--acc-t);outline-offset:1px}
    .btn.on{background:var(--acc);color:#fff}
    .btn.on:hover{background:var(--acc-h)}
    .btn.dis{opacity:.35;cursor:default}
    .btn.dis:hover{background:none;color:var(--fg2)}
    /* icon-only so buttons never move under the cursor; the tooltip and panel title name the tool */
    .btn>span:not(.badge){display:inline-block;overflow:hidden;vertical-align:middle;max-width:0;opacity:0;margin-left:0;transition:max-width .42s var(--ease),opacity .2s,margin .42s var(--ease)}

    .btn.brand{width:36px;height:36px;min-width:36px;padding:0;border-radius:10px;background:var(--s2);cursor:grab;flex:none}
    .btn.brand:hover{background:var(--s3)}
    .pdot{display:block;width:20px;height:18px;flex:none}
    .pdot svg{display:block;width:100%;height:100%}
    .dsxdot{fill:#FFEF82;transition:fill .5s}
    :host(.busy) .dsxdot{fill:#3d9bff;animation:dsxPulse 1s ease-in-out infinite}
    @keyframes dsxPulse{50%{opacity:.45}}
    .btn.pclose{display:none!important}

    /* finish: quiet until there is something to finish */
    .btn[data-m=finish].has{background:var(--acc-bg);color:var(--acc-t);padding:0 10px}
    .btn[data-m=finish].has>span:not(.badge){max-width:150px;opacity:1;margin-left:6px}
    .btn[data-m=finish].has:hover{background:rgba(11,107,239,.28)}
    .btn[data-m=finish].on,.btn[data-m=finish].has.on{background:var(--acc);color:#fff}
    .bar.tight .btn[data-m=finish]>span:not(.badge){max-width:0;opacity:0;margin-left:0}
    .badge{display:none;min-width:18px;height:18px;margin-left:6px;padding:0 5px;border-radius:9px;background:var(--acc);color:#fff;font:700 11px/18px var(--font);font-variant-numeric:tabular-nums;text-align:center}
    .badge.show{display:inline-block}
    .btn.on .badge{background:#fff;color:var(--acc)}
    .btn[data-m=revert]:not(.dis):hover{color:var(--red);background:var(--red-bg)}
    .btn[data-m=close]:hover{color:var(--fg);background:var(--s3)}
    .btn[data-m=issues]{padding:0 4px;min-width:30px}
    .ibadge{font-style:normal;min-width:20px;height:20px;border-radius:10px;background:#e5484d;color:#fff;font:700 11px/20px var(--font);text-align:center;padding:0 6px;animation:ipop .35s var(--spring)}
    @keyframes ipop{from{transform:scale(.4)}to{transform:none}}

    /* tooltip */
    #tip{position:fixed;pointer-events:none;z-index:9;display:flex;gap:8px;align-items:center;max-width:280px;padding:6px 8px 6px 10px;border-radius:var(--r);background:var(--s3);color:var(--fg);font:500 12px var(--font);white-space:nowrap;box-shadow:0 8px 20px rgba(0,0,0,.4),0 0 0 1px var(--line2);opacity:0;transform:translateY(4px);transition:opacity .12s,transform .18s var(--ease)}
    #tip.show{opacity:1;transform:none}
    #tip kbd{font:600 11px var(--mono);color:var(--fg2);background:rgba(255,255,255,.1);border-radius:4px;padding:1px 5px}

    /* ---------- panels ---------- */
    .panel{position:fixed;right:12px;top:12px;bottom:78px;width:340px;display:flex;flex-direction:column;overflow:auto;overscroll-behavior:contain;touch-action:pan-y;scrollbar-width:thin;scrollbar-color:var(--s4) transparent;background:var(--s1);color:var(--fg);border-radius:var(--r-xl);box-shadow:var(--shadow);pointer-events:auto;font:12.5px/1.45 var(--font);visibility:hidden;opacity:0;transform:translateX(16px) scale(.98);transform-origin:right center;transition:opacity .25s,transform .45s var(--spring),visibility 0s linear .45s}
    .panel>*{flex:none}
    .panel.show{visibility:visible;opacity:1;transform:none;transition:opacity .3s,transform .5s var(--spring),visibility 0s}
    :host(.away) .panel.show{visibility:hidden;opacity:0;transform:translateX(16px) scale(.98);transition:opacity .2s,transform .4s,visibility 0s linear .4s}
    #rp{width:320px;bottom:auto;max-height:calc(100vh - 92px);transform-origin:right top}
    :host(.lpopen) #rp{right:calc(var(--lpw,340px) + 24px)}
    #lp.peek{transform:translateX(calc(100% + 24px))!important;box-shadow:none;opacity:0}
    .panel.moving{transition:none!important;cursor:grabbing}
    .panel.moving .ph{cursor:grabbing}
    .panel.moving::after{content:"";position:absolute;inset:0}
    .panel.dragging{cursor:grabbing;user-select:none}
    .panel.swapin>*{animation:dsxIn .3s var(--ease) both}
    @keyframes dsxIn{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}
    @keyframes dsxPop{from{opacity:0;transform:scale(.6)}to{opacity:1;transform:none}}
    .panel::-webkit-scrollbar{width:10px}
    .panel::-webkit-scrollbar-thumb{background:var(--s4);border-radius:10px;border:3px solid var(--s1)}
    .panel::-webkit-scrollbar-track{background:transparent}
    #peek{all:unset;box-sizing:border-box;position:fixed;right:0;top:50%;transform:translateY(-50%);writing-mode:vertical-rl;padding:12px 8px;border-radius:var(--r) 0 0 var(--r);background:var(--acc);color:#fff;font:600 12px var(--font);cursor:pointer;pointer-events:auto;box-shadow:0 6px 20px rgba(0,0,0,.4)}

    /* header: title, count, close. A small grip shows it can be dragged. */
    .ph{position:sticky;top:0;z-index:3;display:flex;align-items:center;gap:10px;padding:18px 14px 12px 16px;background:var(--s1);border-bottom:1px solid var(--line);cursor:grab;user-select:none}
    .ph::before{content:"";position:absolute;top:6px;left:50%;width:28px;height:4px;margin-left:-14px;border-radius:2px;background:var(--line3);transition:background .15s}
    .ph:hover::before{background:var(--fg3)}
    .ph b{flex:none;min-width:0;max-width:60%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font:600 14px/1.2 var(--font);color:var(--fg);letter-spacing:-.01em}
    .ph>span,.ph .scan{margin-left:auto;display:flex;align-items:center;gap:4px;min-width:0;white-space:nowrap;font:400 12px var(--font);color:var(--fg3)}
    .ph .pcx{all:unset;flex:none;width:24px;height:24px;border-radius:50%;display:grid;place-items:center;cursor:pointer;color:var(--fg2);background:var(--s2);transition:background .15s,color .15s,transform .15s var(--spring)}
    .ph .pcx:hover{background:var(--s3);color:var(--fg)}
    .ph .pcx:active{transform:scale(.9)}
    .ph .pcx svg{width:12px;height:12px}
    .ph .pcx:focus-visible,.ibtn:focus-visible{outline:2px solid var(--acc-t);outline-offset:1px}
    .ibtn{all:unset;display:inline-grid;place-items:center;width:24px;height:24px;border-radius:var(--r-sm);cursor:pointer;color:var(--fg3)}
    .ibtn:hover{background:var(--s2);color:var(--fg)}

    .foot{position:sticky;bottom:0;z-index:4;margin-top:auto;display:flex;gap:8px;padding:12px 16px 14px;background:var(--s1);border-top:1px solid var(--line)}
    .foot2{padding:14px 16px;font-size:12px;line-height:1.5;color:var(--fg3)}
    .foot2 a{color:var(--acc-t)}

    /* section label and empty state */
    .sec{display:flex;align-items:baseline;gap:6px;padding:16px 16px 6px;font:600 11px var(--font);letter-spacing:.06em;text-transform:uppercase;color:var(--fg3)}
    .sec span{font-weight:400;text-transform:none;letter-spacing:0}
    .empty{padding:28px 20px;text-align:center;color:var(--fg3);font-size:12.5px;line-height:1.5}
    .note{margin:12px 12px 4px;padding:10px 12px;border-radius:var(--r);background:var(--s2);font:400 12px/1.5 var(--font);color:var(--fg2)}
    .dtl{display:none;padding:10px 16px;font-size:12px;line-height:1.5;color:var(--fg2);background:var(--s2);border-bottom:1px solid var(--line)}
    .dtl.show{display:block}

    /* list rows */
    .row,.srow,.irow{display:flex;align-items:center;gap:12px;min-height:44px;padding:8px 16px;border-bottom:1px solid var(--line);transition:background .12s}
    .row:hover,.srow:hover{background:rgba(255,255,255,.03)}
    .meta{flex:1;min-width:0}
    .nm{color:var(--fg);font:500 13px/1.35 var(--font);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;letter-spacing:-.005em}
    .sub{color:var(--fg3);font:400 11.5px/1.4 var(--font);margin-top:1px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .hex{font-size:11.5px;color:var(--fg2);letter-spacing:.01em;font-variant-numeric:tabular-nums}
    .chg{color:var(--acc-t)}
    .sw{position:relative;width:32px;height:32px;border-radius:var(--r);flex:none;box-shadow:inset 0 0 0 1px var(--line3);cursor:pointer;overflow:hidden;transition:transform .15s var(--spring)}
    .sw:hover{transform:scale(1.06)}
    .sw input{position:absolute;inset:-8px;width:48px;height:48px;opacity:0;cursor:pointer}
    .dot{width:14px;height:14px;border-radius:4px;box-shadow:inset 0 0 0 1px var(--line3);flex:none}
    .dotp{display:inline-block;width:11px;height:11px;border-radius:50%;margin-right:5px;vertical-align:-1px;box-shadow:inset 0 0 0 1px var(--line3)}
    .bars{flex:none;width:80px;height:4px;background:var(--s3);border-radius:4px;overflow:hidden}
    .bars i{display:block;height:100%;background:var(--acc-t);border-radius:4px;transition:width .4s}
    .sp{display:flex;align-items:center;gap:8px}
    .sp .inp{width:64px}

    /* inputs */
    .inp{all:unset;box-sizing:border-box;display:block;width:100%;height:30px;padding:0 10px;border-radius:var(--r-sm);background:var(--s2);color:var(--fg);font:400 12.5px var(--font);font-variant-numeric:tabular-nums;box-shadow:inset 0 0 0 1px var(--line);transition:box-shadow .15s,background .15s}
    .inp:hover{background:var(--s3)}
    .inp:focus{box-shadow:inset 0 0 0 1.5px var(--acc);background:var(--s2)}
    select.inp{line-height:30px;padding:0 26px 0 10px;cursor:pointer;background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6'%3E%3Cpath d='M1 1l4 4 4-4' fill='none' stroke='%239a9aa3' stroke-width='1.5' stroke-linecap='round'/%3E%3C/svg%3E");background-repeat:no-repeat;background-position:right 10px center}
    .panel textarea{background:var(--s2);color:var(--fg);border:0;border-radius:var(--r-sm);box-shadow:inset 0 0 0 1px var(--line)}
    .lbl{font:500 11.5px var(--font);color:var(--fg3);margin-bottom:4px}
    .grid{display:grid;grid-template-columns:1fr 1fr;gap:8px}

    /* type cards */
    .tcard{padding:14px 16px;border-bottom:1px solid var(--line)}
    .tprev{color:var(--fg);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin:6px 0 12px;max-width:100%}
    .tcard .lint{margin-top:10px}
    .tcard .lint:empty{display:none}

    /* element panel */
    .esec{padding:14px 16px 16px;border-top:1px solid var(--line)}
    #rp .esec:first-of-type{border-top:0}
    .esec .eh{display:flex;align-items:center;justify-content:space-between;margin:0 0 10px}
    .esec h4{margin:0;font:600 12px var(--font);letter-spacing:.04em;text-transform:uppercase;color:var(--fg3)}
    .fgrid{display:grid;grid-template-columns:1fr 1fr;gap:6px}
    .fld{display:flex;align-items:center;gap:8px;height:30px;min-width:0;padding:0 10px;border-radius:var(--r-sm);background:var(--s2);box-shadow:inset 0 0 0 1px var(--line);cursor:text;transition:background .15s,box-shadow .15s}
    .fld.wide{grid-column:1/-1}
    .fld:hover{background:var(--s3)}
    .fld:focus-within{background:var(--s2);box-shadow:inset 0 0 0 1.5px var(--acc)}
    .fld .fk{flex:none;min-width:34px;color:var(--fg3);font:400 11.5px var(--font)}
    .fld .inp{all:unset;box-sizing:border-box;flex:1;min-width:0;color:var(--fg);font:400 12.5px var(--font);font-variant-numeric:tabular-nums;text-overflow:ellipsis}
    .erow{display:flex;align-items:center;gap:8px;padding:6px 16px}
    .erow .k{width:84px;flex:none;color:var(--fg3);font-size:12px}
    .erow .v{flex:1;min-width:0}
    .vn{font-size:11px;color:var(--acc-t);margin-top:4px;word-break:break-all}
    .cw{display:flex;align-items:center;gap:8px}
    .cw .sw{width:20px;height:20px;border-radius:5px}
    .cw .sw input{width:36px;height:36px}
    .crow{display:flex;align-items:center;gap:8px;min-height:30px;margin-bottom:4px}
    .crow .cw{flex:1;min-width:0;height:30px;padding:0 8px;border-radius:var(--r-sm);background:var(--s2);box-shadow:inset 0 0 0 1px var(--line)}
    .crow .ck{width:44px;flex:none;color:var(--fg3);font:11.5px var(--font);text-align:right}
    .crow .vn{flex:1;min-width:0;margin:0;color:var(--fg3);text-align:right;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}

    /* buttons inside panels */
    .pbtn{all:unset;box-sizing:border-box;flex:1;display:inline-flex;align-items:center;justify-content:center;gap:6px;height:34px;padding:0 14px;border-radius:var(--r);background:var(--acc);color:#fff;font:600 12.5px var(--font);text-align:center;white-space:nowrap;cursor:pointer;transition:background .15s,transform .1s}
    .pbtn:hover{background:var(--acc-h)}
    .pbtn:active{transform:scale(.98)}
    .pbtn:focus-visible{outline:2px solid var(--acc-t);outline-offset:2px}
    .pbtn.sec2,.pbtn[style*="3a3a3c"],#etxrow .pbtn{background:var(--s2)!important;color:var(--fg)!important;box-shadow:inset 0 0 0 1px var(--line2)}
    .pbtn.sec2:hover,#etxrow .pbtn:hover{background:var(--s3)!important}
    .pbtn.danger{background:transparent;color:var(--red);box-shadow:inset 0 0 0 1px rgba(255,107,95,.35)}
    .pbtn.danger:hover{background:var(--red-bg)}
    .pbtn[disabled]{opacity:.4;cursor:default;pointer-events:none}
    #etxrow .pbtn{width:100%}
    .mini{all:unset;box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;gap:6px;height:28px;padding:0 10px;border-radius:var(--r-sm);background:var(--s2);color:var(--fg);box-shadow:inset 0 0 0 1px var(--line2);font:500 12px var(--font);cursor:pointer;white-space:nowrap;transition:background .15s,color .15s}
    .mini:hover{background:var(--s3)}
    .mini:focus-visible{outline:2px solid var(--acc-t);outline-offset:1px}
    .mini.pri{background:var(--acc);color:#fff;box-shadow:none}
    .mini.pri:hover{background:var(--acc-h)}
    .mini.ico{width:28px;padding:0;flex:none;border-radius:var(--r-sm)}
    .mini.ico svg{width:16px;height:16px}
    .mini.ico.del:hover{color:var(--red);background:var(--red-bg)}
    .fixnow{all:unset;box-sizing:border-box;display:inline-flex;align-items:center;min-height:26px;max-width:100%;padding:0 12px;border-radius:var(--r-sm);background:var(--acc);color:#fff;font:600 12px var(--font);white-space:nowrap;cursor:pointer}
    .fixnow:hover{background:var(--acc-h)}
    .fixnow.ghost{background:var(--s3);color:var(--fg)}
    .fixnow[disabled]{opacity:.55;cursor:default}
    .fnsub{font:400 11.5px var(--font);color:var(--fg3)}
    .savebox{display:flex;gap:8px;padding:12px 16px}
    .savebox .inp{flex:1}
    .savebox .pbtn{flex:none;padding:0 14px}

    /* chips and tabs */
    .chips{display:flex;flex-wrap:wrap;gap:6px;padding:10px 16px 12px;border-bottom:1px solid var(--line)}
    .chip{all:unset;box-sizing:border-box;display:inline-flex;align-items:center;gap:6px;height:28px;padding:0 10px;border-radius:var(--r);background:var(--s2);color:var(--fg2);font:500 12px var(--font);cursor:pointer;transition:background .15s,color .15s}
    .chip b{font-weight:700;color:var(--fg);font-variant-numeric:tabular-nums}
    .chip:hover{background:var(--s3);color:var(--fg)}
    .chip.on{background:var(--acc);color:#fff}
    .chip.on b,.chip.on .shp{color:#fff!important}
    .chip:focus-visible{outline:2px solid var(--acc-t);outline-offset:1px}
    .shp{flex:none;display:inline-grid;place-items:center;width:16px;font:700 13px/1 var(--font)}
    .shp.err{color:var(--red)}.shp.warn{color:var(--amb)}.shp.ok{color:var(--grn)}
    .tag{flex:none;padding:1px 6px;border-radius:4px;background:var(--s3);color:var(--fg2);font:600 11px var(--font)}
    .tag.mono{font-family:var(--mono);font-weight:500}
    code{font-size:11.5px;color:var(--fg);background:rgba(255,255,255,.07);padding:1px 4px;border-radius:4px}

    /* lint messages under rows */
    .lt{padding:0 16px 8px 60px;font:400 11.5px/1.45 var(--font);color:var(--red)}
    .lt.warn{color:var(--amb)}.lt.ok{color:var(--grn)}
    .fnrow{display:flex;flex-wrap:wrap;align-items:center;gap:8px;padding:2px 16px 10px 60px}
    #elint{padding:10px 16px 2px}
    #elint .lt,#elint .fnrow,.tcard .lint .lt,.tcard .lint .fnrow{padding-left:0}
    .d{display:inline-block;flex:none;width:8px;height:8px;margin-right:6px;border-radius:50%;background:var(--red)}
    .d.warn{background:var(--amb)}.d.ok{background:var(--grn)}

    /* review findings and flow results */
    .gw .gh,.gh{display:flex;justify-content:space-between;align-items:baseline;padding:18px 16px 6px;font:600 11px var(--font);letter-spacing:.06em;text-transform:uppercase;color:var(--fg3)}
    .gw .gh span,.gh span{display:flex;align-items:center;gap:2px;font:400 11.5px var(--font);letter-spacing:0;text-transform:none;color:var(--fg3)}
    .fnd{border-bottom:1px solid var(--line)}
    .fnd summary{position:relative;display:flex;gap:10px;align-items:flex-start;padding:10px 16px;cursor:pointer;list-style:none;transition:background .12s}
    .fnd summary::-webkit-details-marker{display:none}
    .fnd summary:hover{background:rgba(255,255,255,.03)}
    .fnd[data-flat] summary{cursor:default}
    .fnd[data-flat] summary:hover{background:none}
    .fnd .wrap,.fl .wrap{white-space:normal;line-height:1.45}
    .fl,.irow{position:relative;display:flex;gap:10px;align-items:flex-start;padding:10px 16px;border-bottom:1px solid var(--line)}
    .fl .shp,.irow .shp,.fnd summary .shp{margin-top:2px}
    .fl.go,.irow{cursor:pointer}
    .fl:hover,.irow:hover{background:rgba(255,255,255,.04)}
    .fl .sub,.irow .sub{margin-top:2px;line-height:1.4;white-space:normal}
    .irow .meta .nm{white-space:normal}
    .fl .k2{max-width:none}
    .ttl{display:flex;align-items:center;gap:8px;min-width:0}
    .it{display:flex;justify-content:space-between;gap:10px;padding:6px 16px 6px 42px;font-size:12px}
    .it.go{cursor:pointer}
    .it.go:hover{background:rgba(255,255,255,.05)}
    .it.go:hover .k2{color:var(--acc-t)}
    .it .k2,.fl .k2{font-size:11.5px;color:var(--fg);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:170px}
    .it .sub{margin:0;text-align:right;white-space:normal}
    .racts{display:none;position:absolute;right:10px;top:6px;padding:2px;border-radius:var(--r);background:var(--s3);box-shadow:0 4px 12px rgba(0,0,0,.4),0 0 0 1px var(--line2)}
    .fl:hover .racts,.irow:hover .racts,.fl:focus-within .racts,.irow:focus-within .racts{display:flex}
    .racts button{all:unset;box-sizing:border-box;height:22px;line-height:22px;padding:0 8px;border-radius:var(--r-sm);color:var(--fg);font:600 11.5px var(--font);cursor:pointer}
    .racts button:hover{background:var(--acc);color:#fff}
    .racts button:focus-visible{outline:2px solid var(--acc-t)}
    .pg{border-bottom:1px solid var(--line)}
    .pg>summary{position:sticky;top:0;z-index:1;display:flex;align-items:center;gap:8px;padding:11px 16px;background:var(--s1);cursor:pointer;list-style:none}
    .pg>summary::-webkit-details-marker{display:none}
    .pg>summary:hover{background:var(--s2)}
    .pg>summary code{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;background:none;padding:0;font-size:12px;color:var(--fg)}
    .pg>summary .pc{font-size:12px;color:var(--fg3);white-space:nowrap}
    .pg .chev{flex:none;color:var(--fg3);transition:transform .2s}
    .pg:not([open]) .chev{transform:rotate(-90deg)}

    /* change summary */
    .ch{padding:12px 16px;border-bottom:1px solid var(--line)}
    .ch .t{color:var(--fg);font-weight:500;margin-bottom:6px}
    .arrow{display:flex;align-items:center;gap:8px;font:11.5px var(--mono);color:var(--fg3)}

    /* near-duplicates */
    .dups{border-bottom:1px solid var(--line);background:var(--amb-bg)}
    .dups>summary{display:flex;align-items:center;gap:8px;padding:11px 16px;cursor:pointer;list-style:none;font:600 12.5px var(--font);color:var(--fg)}
    .dups>summary::-webkit-details-marker{display:none}
    .dups>summary b{margin-left:auto;min-width:22px;text-align:center;padding:0 7px;border-radius:9px;background:rgba(0,0,0,.25);font-size:11.5px}
    .dnote{padding:0 16px 8px;font-size:12px;line-height:1.45;color:var(--fg2)}
    .drow{display:flex;align-items:center;gap:10px;padding:8px 16px;border-top:1px solid var(--line)}
    .drow .nm{white-space:normal;font-size:12.5px}
    .tabs{padding:10px 16px}
    .fxp{flex:none;width:34px;height:34px;background:#fff;border:1px solid #bbb}
    .fxz{flex:none;width:34px;height:34px;display:grid;place-items:center;border-radius:var(--r);background:var(--s2);font:700 13px var(--mono);color:var(--fg2)}

    /* gallery / sessions */
    .gcmp{position:relative;margin:0 16px;border-radius:var(--r);overflow:hidden;box-shadow:0 0 0 1px var(--line2)}
    .gcmp img{display:block;width:100%}
    .gclip{position:absolute;inset:0}
    .ghandle{position:absolute;top:0;bottom:0;width:2px;background:var(--acc);transform:translateX(-1px)}
    .gtag{position:absolute;top:8px;padding:3px 8px;border-radius:999px;background:rgba(0,0,0,.65);color:#fff;font:600 10.5px var(--font)}
    .gtag.l{left:8px}.gtag.r{right:8px}
    .gth{width:56px;height:40px;object-fit:cover;object-position:top;border-radius:var(--r-sm);flex:none;box-shadow:0 0 0 1px var(--line2)}

    /* motion */
    .mprev{padding:12px 16px 4px}
    .mstage{position:relative;height:170px;border-radius:var(--r);overflow:hidden;background-color:var(--s0);background-image:linear-gradient(45deg,#1b1b1e 25%,transparent 25%,transparent 75%,#1b1b1e 75%),linear-gradient(45deg,#1b1b1e 25%,transparent 25%,transparent 75%,#1b1b1e 75%);background-size:16px 16px;background-position:0 0,8px 8px;box-shadow:inset 0 0 0 1px var(--line)}
    .mwrap{position:absolute;transform-origin:top left}
    .mbar{display:flex;align-items:center;gap:6px;margin-top:8px}
    .mhint{flex:1;min-width:0;color:var(--fg3);font:12px var(--font)}
    .mnote{margin:6px 0 8px;color:var(--fg3);font:11.5px/1.45 var(--font)}
    .mchips{display:flex;flex-wrap:wrap;gap:6px}
    .mchip{padding:4px 9px;border-radius:var(--r-sm);background:var(--s2);color:var(--fg);box-shadow:inset 0 0 0 1px var(--line);font:600 11.5px var(--font)}
    .mchip i{font-style:normal;font-weight:500;color:var(--fg3)}
    .mnone{color:var(--fg3);font:12px var(--font)}
    .mi{display:flex;flex-direction:column;gap:2px;padding:8px 0;border-top:1px solid var(--line)}
    .mi:first-of-type{border-top:0}
    .mi b{color:var(--fg);font:600 12.5px var(--font)}
    .mi span{color:var(--fg3);font:11.5px var(--mono);word-break:break-word}
    .mwatch{display:flex;align-items:center;gap:10px;margin-top:10px}
    .mwatch .pbtn{flex:none}
    .mtabs{display:flex;flex-wrap:wrap;gap:4px;margin-bottom:8px}
    .mtab{all:unset;box-sizing:border-box;height:26px;padding:0 10px;border-radius:var(--r-sm);background:var(--s2);color:var(--fg2);font:600 12px var(--font);cursor:pointer}
    .mtab:hover{background:var(--s3);color:var(--fg)}
    .mtab.on{background:var(--acc);color:#fff}
    .mtab:focus-visible{outline:2px solid var(--acc-t)}
    .mcode{margin:0;max-height:260px;overflow:auto;padding:10px 12px;border-radius:var(--r);background:var(--s0);box-shadow:inset 0 0 0 1px var(--line);color:var(--fg);font:11.5px/1.55 var(--mono);white-space:pre;user-select:text;cursor:text}
    .mlink{color:var(--acc-t);text-decoration:none;font-weight:600}
    .mlink:hover{text-decoration:underline}
    .mcmd{display:block;padding:6px 8px;border-radius:var(--r-sm);background:var(--s0);color:var(--fg);font:11.5px var(--mono);white-space:pre-wrap;word-break:break-all}

    /* popup menu (screenshot, Figma) */
    .fmenu{position:fixed;z-index:2147483646;display:flex;flex-direction:column;gap:2px;min-width:200px;padding:5px;border-radius:var(--r-lg);background:var(--s2);box-shadow:0 12px 32px rgba(0,0,0,.45),0 0 0 1px var(--line2);pointer-events:auto;animation:fmup .16s var(--ease)}
    .fmenu button{all:unset;box-sizing:border-box;display:flex;align-items:center;gap:10px;height:34px;padding:0 10px;border-radius:var(--r-sm);color:var(--fg);font:500 12.5px var(--font);white-space:nowrap;cursor:pointer}
    .fmenu button svg{flex:none;color:var(--fg2)}
    .fmenu button:hover,.fmenu button:focus-visible{background:var(--acc);color:#fff;outline:none}
    .fmenu button:hover svg,.fmenu button:focus-visible svg{color:#fff}
    @keyframes fmup{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}

    /* ---------- on-page overlays ---------- */
    #hl{position:fixed;pointer-events:none;display:none;border:1.5px solid var(--acc-t);background:rgba(61,155,255,.12);border-radius:3px;transition:all .08s}
    #hlt{position:fixed;pointer-events:none;display:none;padding:3px 7px;border-radius:var(--r-sm);background:var(--acc);color:#fff;font:500 11px var(--mono)}
    #mk{position:fixed;inset:0;pointer-events:none}
    :host(.away) #mk,:host(.orig) #mk{display:none}
    .mk{position:fixed;pointer-events:none;border-radius:2px}
    .mk.err{background:rgba(229,72,77,.08)}.mk.warn{background:rgba(255,178,36,.08)}
    .mk.act{outline:1.5px dashed #e5484d;outline-offset:1px}.mk.warn.act{outline-color:#f5a524}
    .sq{position:fixed;height:5px;pointer-events:auto;cursor:pointer;background-repeat:repeat-x;background-position:0 0;outline:none}
    .sq.err{background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='6' height='5'%3E%3Cpath d='M0 4L1.5 1L4.5 4L6 1' fill='none' stroke='%23e5484d' stroke-width='1.3'/%3E%3C/svg%3E")}
    .sq.warn{background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='6' height='5'%3E%3Cpath d='M0 4L1.5 1L4.5 4L6 1' fill='none' stroke='%23f5a524' stroke-width='1.3'/%3E%3C/svg%3E")}
    .sq:focus-visible{outline:2px solid #fff;box-shadow:0 0 0 4px #e5484d}

    /* issue popover */
    .pop{position:fixed;z-index:5;width:300px;padding:14px;border-radius:var(--r-lg);background:var(--s1);color:var(--fg);box-shadow:var(--shadow);font:12.5px/1.5 var(--font);pointer-events:auto;visibility:hidden;opacity:0;transform:translateY(-6px);transition:opacity .15s,transform .25s var(--spring),visibility 0s linear .25s}
    .pop.show{visibility:visible;opacity:1;transform:none;transition:opacity .15s,transform .25s var(--spring),visibility 0s}
    .pop .pt{display:flex;align-items:center;gap:8px;margin-bottom:6px}
    .pop .pt b{flex:1;font:600 13px var(--font)}
    .pop .tag{background:#e5484d;color:#fff;font:700 10.5px var(--font);letter-spacing:.02em}
    .pop .tag.warn{background:var(--amb);color:#1a1300}
    .pop p{margin:0 0 8px;color:var(--fg2)}
    .pop .fx{display:flex;align-items:center;gap:8px;margin-bottom:8px;padding:8px 10px;border-radius:var(--r);background:var(--s2)}
    .pop .fx i{flex:none;width:16px;height:16px;border-radius:4px;box-shadow:inset 0 0 0 1px var(--line3)}
    .pop .fx span{font:11.5px var(--mono)}
    .pop .el{margin-bottom:10px;font:11px var(--mono);color:var(--fg3);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .pop .note{margin:0 0 8px;padding:0;background:none;font-size:11.5px;color:var(--fg2)}
    .pop .acts{display:flex;flex-wrap:wrap;gap:6px}
    .pb{all:unset;box-sizing:border-box;display:inline-flex;align-items:center;height:30px;padding:0 12px;border-radius:var(--r-sm);background:var(--acc);color:#fff;font:600 12px var(--font);cursor:pointer;transition:background .15s}
    .pb:hover{background:var(--acc-h)}
    .pb.b2{background:var(--s3);color:var(--fg)}
    .pb.b2:hover{background:var(--s4)}
    .pb.gh2{background:transparent;color:var(--fg2);box-shadow:inset 0 0 0 1px var(--line2)}
    .pb.gh2:hover{background:var(--s2);color:var(--fg)}
    .pb:focus-visible{outline:2px solid var(--acc-t);outline-offset:1px}

    /* compare banner and toast */
    #cmp{all:unset;box-sizing:border-box;position:fixed;left:50%;bottom:76px;transform:translateX(-50%);max-width:calc(100vw - 32px);padding:9px 16px;border-radius:999px;background:var(--acc);color:#fff;font:600 12.5px var(--font);text-align:center;cursor:pointer;pointer-events:auto;box-shadow:0 8px 24px rgba(0,0,0,.35)}
    #cmp:focus-visible{outline:2px solid #fff;outline-offset:2px}
    #toast{position:fixed;left:50%;bottom:76px;display:flex;align-items:center;gap:12px;max-width:calc(100vw - 32px);padding:9px 10px 9px 16px;border-radius:var(--r-lg);background:var(--s2);color:var(--fg);font:500 12.5px var(--font);box-shadow:0 10px 28px rgba(0,0,0,.45),0 0 0 1px var(--line2);opacity:0;transform:translate(-50%,8px);pointer-events:none;transition:opacity .2s,transform .25s var(--ease)}
    #toast.show{opacity:1;transform:translate(-50%,0);pointer-events:auto}
    #toast:not(:has(button)){padding-right:16px}
    #toast button{all:unset;flex:none;height:26px;padding:0 10px;border-radius:var(--r-sm);background:var(--s4);color:var(--fg);font:600 12px var(--font);cursor:pointer}
    #toast button:hover{background:var(--acc);color:#fff}
    #toast button:focus-visible{outline:2px solid var(--acc-t)}

    /* motion panel v3 */
    .mstyle{padding:14px 16px 0}
    .mstyle .mbadge{display:inline-flex;align-items:center;height:24px;padding:0 10px;border-radius:999px;background:var(--acc-bg);color:var(--acc-t);font:600 12px var(--font)}
    .mstyle p{margin:6px 0 0;color:var(--fg2);font:12.5px/1.5 var(--font)}
    .mstyle p::first-letter{text-transform:uppercase}
    .mempty{position:absolute;inset:0;display:grid;place-items:center;color:var(--fg3);font:500 12px var(--font)}
    .mbar .mini.ico svg{width:14px;height:14px}
    .mwatchbox{display:flex;align-items:center;gap:10px;margin:4px 0 6px;padding:10px;border-radius:var(--r);background:var(--s2)}
    .mwatchbox .pbtn{flex:none;height:30px;padding:0 12px}
    .mwatchbox .pbtn svg{width:15px;height:15px}
    .mwatchbox .mhint{font-size:11.5px;line-height:1.4}
    .mwatchbox.hot{background:var(--acc-bg);box-shadow:inset 0 0 0 1px rgba(11,107,239,.45)}
    .mwatchbox.live .mhint{color:var(--fg)}
    .mwatchbox.live .pbtn{background:var(--red-bg)!important;color:var(--red)!important;box-shadow:inset 0 0 0 1px rgba(255,107,95,.4)}
    .mlibs>summary{display:flex;align-items:center;gap:8px;cursor:pointer;list-style:none}
    .mlibs>summary::-webkit-details-marker{display:none}
    .mlibs>summary h4{flex:1;margin:0}
    .mlibs>summary::after{content:"";width:7px;height:7px;border-right:1.5px solid var(--fg3);border-bottom:1.5px solid var(--fg3);transform:rotate(-45deg);transition:transform .2s;margin-right:4px}
    .mlibs[open]>summary::after{transform:rotate(45deg)}
    .mlibs[open]>summary{margin-bottom:8px}
    .foot .pbtn svg{width:16px;height:16px}
    .mini[disabled]{opacity:.4;pointer-events:none}
    .mguide ol{margin:0;padding:0;list-style:none;counter-reset:g}
    .mguide li{position:relative;padding:0 0 12px 30px;color:var(--fg2);font:12.5px/1.55 var(--font);counter-increment:g}
    .mguide li::before{content:counter(g);position:absolute;left:0;top:0;width:20px;height:20px;border-radius:50%;display:grid;place-items:center;background:var(--acc-bg);color:var(--acc-t);font:700 11px/1 var(--font)}
    .mguide li:last-child{padding-bottom:0}
    .mguide code{font-size:11.5px}
    .mguide b{color:var(--fg)}
    .gcmd{display:flex;align-items:center;gap:6px;margin:6px 0 4px}
    .gcmd code{flex:1;padding:5px 8px;border-radius:var(--r-sm);background:var(--s0);box-shadow:inset 0 0 0 1px var(--line)}
    .gsnip{margin:6px 0 2px;padding:8px 10px;border-radius:var(--r-sm);background:var(--s0);box-shadow:inset 0 0 0 1px var(--line);color:var(--fg);font:11px/1.5 var(--mono);white-space:pre;overflow:auto}
    /* Motion Recorder */
    .pro{flex:none;padding:1px 6px;border-radius:4px;background:linear-gradient(135deg,#3d9bff,#a259ff);color:#fff;font:700 9.5px var(--font);letter-spacing:.06em}
    .recbar{display:flex;align-items:center;gap:10px;margin:12px 12px 6px;padding:10px 10px 10px 12px;border-radius:var(--r);background:var(--s2)}
    .recbar .rectxt{flex:1;color:var(--fg2);font-size:12px;line-height:1.4}
    .recdot{width:10px;height:10px;border-radius:50%;background:var(--fg3);flex:none}
    .recbar.live{background:rgba(229,72,77,.12);box-shadow:inset 0 0 0 1px rgba(229,72,77,.35)}
    .recbar.live .recdot{background:#e5484d;animation:dsxPulse 1s ease-in-out infinite}
    .recbar.live .rectxt{color:var(--fg)}
    .recrow{display:flex;align-items:center;gap:10px;padding:9px 12px 9px 16px;border-bottom:1px solid var(--line)}
    .recrow:hover{background:rgba(255,255,255,.04)}
    .recrow .rtrig{flex:none;font:600 10.5px var(--font);color:var(--acc-t);background:var(--acc-bg);padding:2px 7px;border-radius:999px}
    .recrow .ra{display:flex;gap:4px;flex:none}
    /* Figma / screenshot menu headings and two-line items */
    .fmenu .fmh{padding:8px 10px 4px;font:600 10.5px var(--font);letter-spacing:.06em;text-transform:uppercase;color:var(--fg3)}
    .fmenu .fmh:not(:first-child){margin-top:4px;border-top:1px solid var(--line);padding-top:10px}
    .fmenu button:has(small){height:auto;padding:7px 10px}
    .fmenu button>span{display:flex;flex-direction:column;flex:1;min-width:0}
    .fmenu button b{font:500 12.5px var(--font)}
    .fmenu button small{font:400 11.5px var(--font);color:var(--fg3)}
    .fmenu button:hover small,.fmenu button:focus-visible small{color:rgba(255,255,255,.82)}
    .fmenu button>span.pro{flex:none;display:inline-block;flex-direction:row;margin-left:6px}
    .fmenu button kbd{font:500 10.5px var(--mono);color:var(--fg3);background:var(--s3);border-radius:4px;padding:1px 5px}
    .fmenu button:hover kbd,.fmenu button:focus-visible kbd{background:rgba(255,255,255,.18);color:#fff}
    /* toast while working */
    #toast.work::before{content:"";flex:none;width:14px;height:14px;border-radius:50%;border:2px solid var(--line3);border-top-color:var(--acc-t);animation:dsxSpin .7s linear infinite}
    @keyframes dsxSpin{to{transform:rotate(360deg)}}
    /* QA fixes */
    #selbox{position:fixed;pointer-events:none;display:none;border:2px solid var(--acc-t);border-radius:4px;box-shadow:0 0 0 4px rgba(61,155,255,.18)}
    .ph .ptxt{font-weight:400;color:var(--fg3)}
    .cnote{margin:10px 16px 0}
    .findbar{position:fixed;left:50%;bottom:76px;transform:translateX(-50%);z-index:2147483647;display:flex;align-items:center;gap:4px;padding:5px 5px 5px 14px;border-radius:var(--r-lg);background:var(--s2);color:var(--fg);font:500 12.5px var(--font);box-shadow:0 10px 28px rgba(0,0,0,.45),0 0 0 1px var(--line2);pointer-events:auto;animation:fmup .16s var(--ease)}
    .findbar .fl0{max-width:160px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--fg2);font-family:var(--mono);font-size:11.5px}
    .findbar .fc{min-width:64px;text-align:center;font-variant-numeric:tabular-nums;font-weight:600}
    .findbar button{all:unset;box-sizing:border-box;width:28px;height:28px;border-radius:var(--r-sm);display:inline-grid;place-items:center;cursor:pointer;background:var(--s3);color:var(--fg);font:600 15px var(--font)}
    .findbar button:hover{background:var(--acc);color:#fff}
    .findbar .fx{background:transparent;color:var(--fg3)}
    :host(.finding) #toast{bottom:126px}
    .aachip{all:unset;box-sizing:border-box;display:inline-flex;align-items:center;gap:6px;height:26px;margin:0 0 8px 52px;padding:0 12px;border-radius:999px;background:var(--acc-bg);color:var(--acc-t);font:600 12px var(--font);cursor:pointer;white-space:nowrap;animation:fmup .16s var(--ease)}
    .aachip:hover{background:rgba(11,107,239,.3)}
    .aachip.off{background:var(--s2);color:var(--fg3);cursor:default}
    .flownote{max-width:340px;padding:12px 14px;border-radius:var(--r-lg);background:var(--s1);color:var(--fg);font:12.5px/1.5 var(--font);border-left:4px solid #e5484d;box-shadow:var(--shadow);pointer-events:auto}
    .flownote .fnt{font-weight:600;color:var(--red);margin-bottom:2px}
    .flownote.warn .fnt{color:var(--amb)}
    .flownote .fnr{color:var(--fg2)}
    .flownote .fnh{margin-top:4px;color:var(--fg3);word-break:break-all}
    .flownote .fxs{margin-top:10px;padding:10px;border-radius:var(--r);background:var(--s2)}
    .flownote .fxk{font-size:11px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;color:var(--fg3);margin-bottom:3px}
    .flownote .fxb{display:flex;gap:8px;margin-top:8px}
    .flownote .fnx{margin-top:10px}
    .flownote kbd{font:600 10.5px var(--mono);color:var(--fg3);margin-left:4px}
    .findable{position:relative}
    .row:hover .findable .nm::after{content:"Find";margin-left:8px;padding:1px 6px;border-radius:4px;background:var(--acc-bg);color:var(--acc-t);font:600 10.5px var(--font);vertical-align:1px}
    /* small windows: tighter buttons so Close and Issues never fall off the bar */
    .bar.compact .tools{gap:0}
    .bar.compact .btn:not(.brand){min-width:30px;padding:0 6px}
    .bar.compact .sep{margin:0 2px}
    .bar.tight .btn:not(.brand){min-width:28px;width:28px;padding:0}
    .bar.tight .btn svg{width:16px;height:16px}
    .bar.tight .grp{gap:0}
    .bar.tight .sep{margin:0 1px}
    .bar.tight .btn.brand{width:32px;height:32px;min-width:32px}
    .bar .tools{min-width:0;flex:0 1 auto;overflow-x:auto;scrollbar-width:none}
    .bar .tools::-webkit-scrollbar{display:none}
    .btn.bclose{flex:none}
    .bar.collapsed .bclose,.bar.collapsed>.sep{opacity:0;pointer-events:none}
    /* Figma-style property panel (Select element) */
    .fgrid4{display:grid;grid-template-columns:repeat(4,1fr);gap:4px}
    .fgrid4 .fld{padding:0 5px;gap:3px}
    .fgrid4 .fld .fk{min-width:0;width:10px;text-align:center;font-size:10px;flex:none}
    .fgrid4 .inp{font-size:11px}
    .fk2{font:11.5px var(--font);color:var(--fg3);margin:0 0 6px}
    .fselect{all:unset;box-sizing:border-box;flex:1;min-width:0;color:var(--fg);font:11.5px var(--font);cursor:pointer;text-overflow:ellipsis;white-space:nowrap;overflow:hidden;padding-right:12px;background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6'%3E%3Cpath d='M1 1l4 4 4-4' fill='none' stroke='%239a9aa3' stroke-width='1.5' stroke-linecap='round'/%3E%3C/svg%3E");background-repeat:no-repeat;background-position:right 0 center}
    .fselect option{background:var(--s2);color:var(--fg)}
    .seg{display:flex;gap:5px}
    .sbtn{all:unset;box-sizing:border-box;flex:1;height:28px;border-radius:var(--r-sm);background:var(--s2);box-shadow:inset 0 0 0 1px var(--line);display:inline-flex;align-items:center;justify-content:center;cursor:pointer;color:var(--fg3)}
    .sbtn:hover{background:var(--s3);color:var(--fg)}
    .sbtn.on{background:var(--acc);color:#fff;box-shadow:none}
    .sbtn:focus-visible{outline:2px solid var(--acc-t)}
    .hexin{all:unset;box-sizing:border-box;flex:1;min-width:0;color:var(--fg);font:12px var(--mono)}
    .pct{all:unset;box-sizing:border-box;width:36px;flex:none;color:var(--fg3);font:11px var(--mono);text-align:right}
    .crow .ck2{width:38px;flex:none;color:var(--fg3);font:11.5px var(--font);text-align:left}
    .vrow{margin:0 0 6px 46px}
    .vn2{font:10.5px var(--mono);color:var(--acc-t);word-break:break-all}
    .fgrid.wsel2{grid-template-columns:1fr 1.3fr}
    .fk svg{width:14px;height:14px;display:block}
    .fk.ico{min-width:16px;width:16px;display:flex;align-items:center;justify-content:center}
    .gprev{margin-top:8px;padding:12px 14px;border-radius:var(--r);background:var(--s2);color:var(--fg);font-size:18px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .footrow{display:flex;gap:6px;margin-top:8px}
    .footrow .pbtn{height:30px;font-size:12px}
    .fhdr{display:flex;flex-direction:column;gap:2px;margin-bottom:10px}
    .fhdr .ft{font:600 13px var(--font);color:var(--fg);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .fhdr .fs{font:11.5px var(--font);color:var(--fg3)}
    /* narrow windows: the icon bar wraps onto two rows and panels dock above it */
    :host(.narrow) .bar{flex-wrap:wrap;justify-content:center;row-gap:2px;padding:4px 6px;width:calc(100vw - 16px);max-width:calc(100vw - 16px)}
    :host(.narrow) .bar .tools{flex-wrap:wrap;justify-content:center;max-width:100%;overflow:visible;row-gap:2px}
    :host(.narrow) .bar .btn:not(.brand){height:30px;min-width:30px;padding:0 6px}
    :host(.narrow) .bar .btn>span:not(.badge){display:none}
    :host(.narrow) .grp{gap:0}
    :host(.narrow) #lp,:host(.narrow) #rp{left:8px!important;right:8px!important;width:auto!important;max-width:none;top:12px;bottom:calc(var(--barh,60px) + 30px);height:auto;max-height:none}
    :host(.narrow.lpopen) #rp{right:8px!important}
    :host(.narrow.lpopen) .bar:not(.moved){left:50%}
    /* small screens: the bar hides labels earlier */
    @media (max-width:1100px){.btn[data-m=finish].has>span:not(.badge){max-width:0;opacity:0;margin-left:0}}
    @media (prefers-reduced-motion:reduce){*{transition-duration:.01s!important;animation-duration:.01s!important}}
  </style>
  <div class="bar collapsed" id="bar" role="toolbar" aria-label="Blue Dot">
    <button class="btn brand" data-m="notch" data-tip="Click to collapse. Drag to move. Right-click to reset position." aria-label="Collapse or expand. Drag to move."><i class="pdot"><svg width="100%" height="100%" viewBox="0 0 313 282" fill="none" xmlns="http://www.w3.org/2000/svg"> <path d="M147.563 0.155904C166.822 -1.06346 180.108 4.81879 192.46 19.6024C182.771 27.8644 175.562 35.954 169.65 47.4227C159.347 67.4963 157.424 90.8374 164.31 112.325C171.282 133.86 186.559 151.728 206.752 161.96C228.545 172.989 251.081 173.589 273.988 166.01L289.416 193.768C299.633 212.179 308.197 226.051 300.208 247.84C295.608 260.439 286.207 270.71 274.056 276.406C258.793 283.393 244.727 281.218 229.486 275.724C220.66 272.54 213.358 267.063 205.128 262.707C198.907 259.412 192.643 256.802 186.07 254.323C161.5 245.946 133.997 243.283 110.632 256.971C106.947 259.131 100.895 263.354 97.2414 265.895C83.7591 275.267 73.2628 278.936 57.1452 281.251C43.5368 283.206 30.775 280.388 19.7407 271.907C9.04968 263.738 2.07242 251.631 0.366111 238.287C-0.660982 229.975 0.481823 221.537 3.68314 213.796C5.48684 209.444 8.63569 204.165 11.0086 199.96L22.3052 179.961L59.2195 114.467L94.4825 51.8631L104.731 33.6371C107.684 28.3913 110.582 22.8612 114.317 18.1559C122.704 7.58885 134.281 1.69115 147.563 0.155904Z" fill="#d9d9d9"/> <path d="M242.1 18.504C279.561 16.8958 311.218 45.9775 312.789 83.437C314.363 120.895 285.25 152.527 247.789 154.061C210.378 155.596 178.8 126.533 177.233 89.1244C175.662 51.7164 204.696 20.1097 242.1 18.504Z" class="dsxdot" fill="#FFEF82"/> </svg> </i></button>
    <button class="btn pclose gone" data-m="pclose" id="pclose" data-tip="Close panel" aria-label="Close panel">${ICONS.close}</button>
    <div class="tools">
    <div class="grp" data-g="Inspect and edit">
    <button class="btn" data-m="colours" data-tip="Colours" aria-label="Colours">${ICONS.colour}<span>Colours</span></button>
    <button class="btn" data-m="text" data-tip="Text" aria-label="Text">${ICONS.text}<span>Text</span></button>
    <button class="btn" data-m="spacing" data-tip="Spacing" aria-label="Spacing">${ICONS.space}<span>Spacing</span></button>
    <button class="btn" data-m="effects" data-tip="Radius, shadow, z-index" aria-label="Effects">${ICONS.effects}<span>Effects</span></button>
    <button class="btn" data-m="pick" data-tip="Select element" aria-label="Select element">${ICONS.pick}<span>Select element</span></button>
    </div>
    <div class="sep"></div>
    <div class="grp" data-g="Check">
    <button class="btn" data-m="review" data-tip="Design review" aria-label="Design review">${ICONS.review}<span>Review</span></button>
    <button class="btn" data-m="flow" data-tip="Flow check" aria-label="Flow check">${ICONS.flow}<span>Flow check</span></button>
    </div>
    <div class="sep"></div>
    <div class="grp" data-g="Capture">
    <button class="btn" data-m="compare" data-tip="Before / after: show the original" aria-label="Before and after">${ICONS.compare}<span>Compare</span></button>
    <button class="btn" data-m="shot" data-tip="Screenshot: screen, visible area or full page (copies to clipboard)" aria-label="Full-page screenshot">${ICONS.shot}<span>Screenshot</span></button>
    <button class="btn" data-m="motion" data-tip="Motion: read an element's animation, preview it and copy the code" aria-label="Motion inspector">${ICONS.motion}<span>Motion</span></button>
    <button class="btn" data-m="sessions" data-tip="Save and reopen your edits (sessions)" aria-label="Sessions">${ICONS.gallery}<span>Sessions</span></button>
    <button class="btn" data-m="figma" data-tip="Copy to Figma as editable layers, or copy as code" aria-label="Copy an element for Figma">${ICONS.figma}<span>Figma</span></button>
    </div>
    <div class="sep"></div>
    <div class="grp" data-g="Finish">
    <button class="btn" data-m="revert" data-tip="Revert all edits (you can undo)" aria-label="Revert all edits">${ICONS.revert}<span>Revert</span></button>
    <button class="btn" data-m="finish" data-tip="Finish: list of changes for the developer" aria-label="Finish: change summary">${ICONS.finish}<span>Finish</span><span class="badge" id="badge">0</span></button>
    </div>
    <button class="btn gone" data-m="issues" id="ibtn" data-tip="Issues caused by your edits" aria-label="Issues caused by your edits"><i class="ibadge" id="ibadge">0</i></button>
    </div>
    <div class="sep"></div>
    <button class="btn bclose" data-m="close" data-tip="Close Blue Dot" aria-label="Close Blue Dot">${ICONS.close}</button>
  </div>
  <div id="mk"></div>
  <div class="panel" id="lp"></div>
  <div class="panel" id="rp"></div>
  <div id="tip" role="tooltip"></div><div class="pop" id="pop" role="dialog" aria-label="Issue details"></div>
  <div id="hl"></div><div id="hlt"></div><button id="peek" class="gone" aria-label="Show panel">Show panel</button><button id="cmp" class="gone">Showing the original. Press Alt+B or click to go back to your edits.</button><div id="toast" role="status"></div>`;
  const $ = (s) => root.querySelector(s);
  const lp = $("#lp"), rp = $("#rp"), hl = $("#hl"), hlt = $("#hlt");
  const updateBadge = () => { const rv = $("#bar [data-m=revert]"); if (rv) { rv.classList.toggle("dis", log.size === 0); rv.setAttribute("aria-disabled", log.size === 0 ? "true" : "false"); } const b = $("#badge"); b.textContent = log.size; b.classList.toggle("show", log.size > 0); const fb = $("#bar [data-m=finish]"); if (fb) fb.classList.toggle("has", log.size > 0); if (finishOpen) showFinish(); };


  /* ---------- live issues: badge, inline markers, popover ---------- */
  const mk = $("#mk"), pop = $("#pop"), ibtn = $("#ibtn"), ibadge = $("#ibadge");
  const wid = new WeakMap(); let wn = 0;
  const wk = (el) => { if (!wid.has(el)) wid.set(el, ++wn); return wid.get(el); };
  const hx2 = (c) => "#" + [c.r, c.g, c.b].map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0")).join("");
  let issues = [], activeKey = null, showIgnored = false;
  const candidates = () => {
    let base = [];
    const keep = (e) => !isUI(e) && !/^(SCRIPT|STYLE|NOSCRIPT|HEAD|META|LINK)$/.test(e.tagName) && (hasOwnText(e) || isControl(e));
    if (rootVars.size) base = [...document.body.querySelectorAll("*")].filter(keep);
    else for (const id of overrides.keys()) { const el = document.querySelector(`[data-dsx="${id}"]`); if (el) base.push(el, ...[...el.querySelectorAll("*")].filter(keep)); }
    return [...new Set(base)].filter((e) => keep(e) && isVisible(e)).slice(0, 500);
  };
  const fixColour = (el) => {
    const cs = getComputedStyle(el), bg = effBg(el), fg0 = parseRGBA(cs.color);
    if (!bg || !fg0) return null;
    const fg = blend(fg0, bg), need = textContrast(el).need;
    const tgt = lum(bg) > 0.4 ? { r: 0, g: 0, b: 0 } : { r: 255, g: 255, b: 255 };
    for (let t = 0; t <= 1.0001; t += 0.02) {
      const c = { r: fg.r + (tgt.r - fg.r) * t, g: fg.g + (tgt.g - fg.g) * t, b: fg.b + (tgt.b - fg.b) * t, a: 1 };
      const r = ratioOf(c, bg);
      if (r >= need + 0.05) return { hex: hx2(c), ratio: r, from: hx2(fg) };
    }
    return null;
  };
  const describe = (i) => {
    const el = i.el, cs = getComputedStyle(el), fs = parseFloat(cs.fontSize);
    if (i.key === "contrast") {
      const t = textContrast(el), f = smartFix(el);
      return { title: "Hard to read", why: `This text is ${i.ratio.toFixed(1)}:1 against its background. WCAG AA needs ${t ? t.need : 4.5}:1, so low-vision users and anyone in bright light will struggle to read it.`, fix: f && { prop: f.prop, val: f.to, from: f.from, label: `Change ${f.side} ${f.from} to ${f.to} (${f.ratio.toFixed(1)}:1)`, swatch: f.to, kind: "colour", name: f.side + " colour" } };
    }
    if (i.key === "small") return { title: "Text too small", why: `This text is ${fs}px. Under 12px is hard to read on most screens.`, fix: { prop: "font-size", val: "14px", from: fs + "px", label: "Set size to 14px", kind: "text", name: "font size" } };
    if (i.key === "lh") { const lh = parseFloat(cs.lineHeight) / fs; return { title: "Lines too tight", why: `Line height is ${lh.toFixed(2)}. Paragraphs read best around 1.5, tight lines make it easy to lose your place.`, fix: { prop: "line-height", val: "1.5", from: lh.toFixed(2), label: "Set line height to 1.5", kind: "text", name: "line height" } }; }
    if (i.key === "hier") { const n = Math.ceil(getBodySize() * 1.5); return { title: "Heading does not stand out", why: `This heading is ${fs}px, no bigger than body text (${getBodySize()}px). Without a size step the page loses its hierarchy.`, fix: { prop: "font-size", val: n + "px", from: fs + "px", label: `Set size to ${n}px`, kind: "text", name: "font size" } }; }
    return { title: "Control blends in", why: `${i.msg}. People may not see it is clickable.`, fix: null };
  };
  const computeIssues = () => {
    if (!overrides.size && !rootVars.size) return [];
    const els = candidates();
    sheet.disabled = true;
    const base = new Map();
    for (const el of els) { const ks = lintEl(el).map((i) => i.key); if (ks.length) base.set(el, new Set(ks)); }
    sheet.disabled = false;
    const out = [];
    for (const el of els) for (const i of lintEl(el)) {
      if (base.has(el) && base.get(el).has(i.key)) continue;
      out.push({ ...i, el, id: wk(el) + ":" + i.key });
    }
    out.sort((a, b) => (a.sev === "error" ? 0 : 1) - (b.sev === "error" ? 0 : 1));
    return out;
  };
  const open_ = () => issues.filter((i) => !ignored.has(i.id));
  const placePop = () => {
    const i = issues.find((x) => x.id === activeKey);
    if (!i || !document.contains(i.el)) { closePop(); return; }
    const r = i.el.getBoundingClientRect(), h = pop.offsetHeight || 200;
    let top = r.bottom + 10, left = Math.min(Math.max(8, r.left), innerWidth - 298);
    if (top + h > innerHeight - 8) { const up = r.top - h - 10; top = up >= 64 ? up : Math.max(64, innerHeight - h - 8); }
    pop.style.left = left + "px"; pop.style.top = top + "px";
  };
  const closePop = () => { activeKey = null; pop.classList.remove("show"); mk.querySelectorAll(".mk.act").forEach((n) => n.classList.remove("act")); };
  const nearestOverride = (el) => { for (let n = el; n && n.nodeType === 1; n = n.parentElement) { const id = n.getAttribute("data-dsx"); if (id && overrides.has(id)) return n; } return null; };
  const afterEdit = () => { for (const k in cache) delete cache[k]; render(); if (mode && mode !== "issues") openMode(mode); if (selected) showElement(selected); };
  const openPop = (id) => {
    const i = issues.find((x) => x.id === id); if (!i) return;
    activeKey = id;
    const d = describe(i), ov = nearestOverride(i.el);
    pop.innerHTML = `<div class="pt"><i class="d ${i.sev === "error" ? "err" : "warn"}"></i><b>${esc(d.title)}</b><span class="tag ${i.sev === "error" ? "" : "warn"}">${i.sev === "error" ? "ERROR" : "WARNING"}</span></div>
      <p>${esc(d.why)}</p>
      ${d.fix ? `<div class="fx">${d.fix.swatch ? `<i style="background:${esc(d.fix.swatch)}"></i>` : ""}<span>${esc(d.fix.label)}</span></div>` : ""}
      <div class="el">${esc(selectorOf(i.el))}</div>
      ${!ov && rootVars.size ? `<div class="note">Caused by a site variable change. Use Revert in the bar to undo it.</div>` : ""}
      <div class="acts">${d.fix ? `<button class="pb" data-a="fix">Fix now</button>` : ""}${ov ? `<button class="pb b2" data-a="rev">Revert this change</button>` : ""}<button class="pb gh2" data-a="ign">Ignore</button></div>`;
    pop.querySelectorAll("[data-a]").forEach((b) => b.addEventListener("click", () => {
      const a = b.dataset.a, el = i.el;
      if (a === "ign") { ignored.add(id); closePop(); refreshIssues(); return; }
      if (a === "fix") { setProp(el, d.fix.prop, d.fix.val); record("fx:" + wk(el) + ":" + d.fix.prop, `${selectorOf(el)} ${d.fix.name} (fix)`, d.fix.from, d.fix.val, d.fix.kind); }
      if (a === "rev") { const n = ov; overrides.delete(n.getAttribute("data-dsx")); n.removeAttribute("data-dsx"); record("rv:" + wk(n), `Reverted ${selectorOf(n)}`, "edited", "original", "text"); }
      closePop(); afterEdit();
    }));
    pop.classList.add("show"); placePop();
    mk.querySelectorAll(".mk").forEach((n) => n.classList.toggle("act", n.dataset.id === id));
  };
  const drawMarkers = () => {
    mk.innerHTML = "";
    const stack = new Map(); let n = 0;
    for (const i of open_()) {
      if (n >= 150) break;
      const r = i.el.getBoundingClientRect();
      if (r.width < 2 || r.height < 2 || r.bottom < 0 || r.top > innerHeight || r.right < 0 || r.left > innerWidth) continue;
      n++;
      const c = i.sev === "error" ? "err" : "warn", k = stack.get(i.el) || 0; stack.set(i.el, k + 1);
      const b = document.createElement("div"); b.className = "mk " + c + (i.id === activeKey ? " act" : ""); b.dataset.id = i.id;
      Object.assign(b.style, { left: r.left + "px", top: r.top + "px", width: r.width + "px", height: r.height + "px" });
      const q = document.createElement("div"); q.className = "sq " + c; q.tabIndex = 0; q.setAttribute("role", "button"); q.setAttribute("aria-label", "Design issue: " + describe(i).title);
      Object.assign(q.style, { left: r.left + "px", top: (r.bottom - 3 + k * 6) + "px", width: Math.max(12, r.width) + "px" });
      q.addEventListener("mouseenter", () => { if (activeKey !== i.id) openPop(i.id); });
      q.addEventListener("click", (e) => { e.stopPropagation(); if (activeKey === i.id) closePop(); else openPop(i.id); });
      q.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openPop(i.id); } });
      mk.append(b, q);
    }
  };
  const jumpTo = (i) => { i.el.scrollIntoView({ block: "center", behavior: "smooth" }); setTimeout(() => { nudge(i.el); drawMarkers(); openPop(i.id); }, 450); };
  const issuesPanel = () => {
    const L = open_(), ig = issues.filter((i) => ignored.has(i.id));
    let html = `<div class="ph"><b>Edit issues</b><span class="scan">${L.length} open</span></div>`;
    html += L.length ? L.map((i, x) => { const d = describe(i), cls = i.sev === "error" ? "err" : "warn"; return `<div class="irow" data-x="${x}"><span class="shp ${cls}" aria-label="${i.sev === "error" ? "Error" : "Warning"}">${i.sev === "error" ? SHAPE.error : SHAPE.warn}</span><div class="meta"><div class="ttl"><span class="nm">${esc(d.title)}</span><span class="tag mono">${esc(selectorOf(i.el))}</span></div><div class="sub wrap">${esc(i.msg)}</div></div><div class="racts"><button data-a="loc">Locate</button><button data-a="cp">Copy</button><button data-a="ig">Ignore</button></div></div>`; }).join("") : `<div class="empty">No issues from your edits.</div>`;
    if (ig.length) html += `<div class="foot2">${ig.length} ignored. <a href="#" id="unign" style="color:inherit">Restore</a></div>`;
    lp.innerHTML = html;
    lp.querySelectorAll(".irow").forEach((r) => r.addEventListener("click", (e) => {
      const i = L[+r.dataset.x], a = e.target.closest("button[data-a]");
      if (a && a.dataset.a === "cp") { e.stopPropagation(); navigator.clipboard.writeText(`${describe(i).title} (${selectorOf(i.el)}): ${i.msg}`).then(() => { a.textContent = "Copied"; setTimeout(() => { a.textContent = "Copy"; }, 1200); }).catch(() => {}); return; }
      if (a && a.dataset.a === "ig") { e.stopPropagation(); ignored.add(i.id); refreshIssues(); return; }
      jumpTo(i);
    }));
    const u = lp.querySelector("#unign"); if (u) u.addEventListener("click", (e) => { e.preventDefault(); ignored.clear(); refreshIssues(); });
  };
  const refreshIssues = () => {
    issues = computeIssues();
    if (activeKey && !issues.some((x) => x.id === activeKey && !ignored.has(x.id))) closePop();
    const n = open_().length;
    ibtn.classList.toggle("gone", n === 0);
    ibadge.textContent = n > 99 ? "99+" : n;
    ibtn.setAttribute("aria-label", n + " issue" + (n === 1 ? "" : "s") + " caused by your edits");
    drawMarkers();
    if (activeKey) placePop();
    if (mode === "issues") { if (n) issuesPanel(); else openMode(null); }
  };
  let t_ = null;
  scheduleIssues = () => { clearTimeout(t_); t_ = setTimeout(refreshIssues, 220); };
  let raf_ = 0;
  const reflow = () => { if (raf_) return; raf_ = requestAnimationFrame(() => { raf_ = 0; if (issues.length) { drawMarkers(); if (activeKey) placePop(); } }); };
  onL(window, "scroll", reflow, true); onL(window, "resize", reflow);
  onL(document, "mousedown", (e) => { const p = e.composedPath(); if (activeKey && !p.includes(pop) && !p.some((n) => n.classList && n.classList.contains("sq"))) closePop(); }, true);
  onL(document, "keydown", (e) => { if (e.key === "Escape" && activeKey) closePop(); }, true);

  /* ---------- left panel renderers ---------- */
  const setActive = () => {
    root.querySelectorAll(".bar .btn[data-m]").forEach((b) => b.classList.toggle("on", b.dataset.m === mode || (b.dataset.m === "pick" && picking && !figmaArmed && !codeArmed && !motionArmed) || (b.dataset.m === "finish" && finishOpen) || (b.dataset.m === "compare" && showOrig) || (b.dataset.m === "figma" && (figmaArmed || codeArmed || figMenuOpen === "figma")) || (b.dataset.m === "shot" && figMenuOpen === "shot") || (b.dataset.m === "motion" && motionArmed)));
    const pc = $("#pclose"), act = mode && mode !== "pick" ? root.querySelector(`.bar .btn[data-m=${mode}]`) : picking ? root.querySelector(`.bar .btn[data-m=pick]`) : finishOpen ? root.querySelector(`.bar .btn[data-m=finish]`) : null;
    if (pc && act) { act.after(pc); pc.classList.remove("gone"); } else if (pc) pc.classList.add("gone");
  };

  const colourPanel = () => {
    const list = cache.colours || (cache.colours = scanColors());
    lp.innerHTML = `<div class="ph"><b>Colours</b><span>${list.length} found</span></div>` + list.map((s, i) => `
      <div class="row"><label class="sw" style="background:${s.cur || s.hex}"><input type="color" data-i="${i}" value="${s.cur || s.hex}"></label>
      <div class="meta"><div class="nm">${esc(s.name)}</div><div class="sub">${s.vars.length ? esc(s.vars[0]) + " \u00b7 " : ""}${esc(s.role)}</div></div>
      <div class="hex ${s.cur ? "chg" : ""}">${s.cur || s.hex}</div></div><div data-l="${i}"></div>`).join("") || `<div class="empty">No colours found.</div>`;
    { const cl = colourDups(list); const L = (c) => `Used ${uses(c)}`; L.main = (c) => c.canon.cur || c.canon.hex;
      addDups(cl, L, (c) => [...c.members, c.canon].map((m) => `<span class="dotp" style="background:${m.cur || m.hex}"></span>${m.cur || m.hex}`).join(" \u00b7 "), "These colours look almost identical. Merge them into the most used one.", (c) => mergeColours(list, c)); }
    lp.querySelectorAll(".row .meta").forEach((m) => { const r = m.closest(".row"), inp = r && r.querySelector("input[type=color]"); if (!inp) return; m.style.cursor = "pointer"; m.classList.add("findable"); m.title = "Show where this colour is used"; m.addEventListener("click", () => { const sw = list[inp.dataset.i]; startFind(sw.els.map((x) => x.el), sw.cur || sw.hex); }); });
    lp.querySelectorAll('input[type=color]').forEach((inp) => inp.addEventListener("input", () => {
      const s = list[inp.dataset.i], to = inp.value;
      s.cur = to;
      for (const { el, prop } of s.els) setProp(el, prop, to);
      for (const v of s.vars) rootVars.set(v, to);
      render();
      record("g:c:" + s.hex, `${s.name} (all uses)`, s.hex, to, "colour");
      const tg = []; for (const { el, prop } of s.els) { tg.push(el); if (prop === "background-color") tg.push(...[...el.children].slice(0, 8)); }
      renderLint(lp.querySelector(`[data-l="${inp.dataset.i}"]`), lintMany(tg));
      const row = inp.closest(".row");
      row.querySelector(".sw").style.background = to;
      const hx = row.querySelector(".hex"); hx.textContent = to; hx.classList.add("chg");
    }));
  };

  const textPanel = () => {
    const list = cache.text || (cache.text = scanText());
    const fam = (f) => f.split(",")[0].replace(/["']/g, "").trim();
    lp.innerHTML = `<div class="ph"><b>Type scale</b><span>${list.length} styles</span></div>` + list.map((s, i) => `
      <div class="tcard" data-i="${i}">
        <div style="display:flex;justify-content:space-between"><span class="nm">${esc(s.name)}</span><span class="sub">${s.els.length} element${s.els.length === 1 ? "" : "s"}</span></div>
        <div class="tprev" style="font-family:${esc(s.family)};font-size:${Math.min(parseFloat(s.size), 30)}px;font-weight:${s.weight};letter-spacing:${s.ls}">${esc(fam(s.family))} Aa</div>
        <div class="grid">
          <div><div class="lbl">Family</div><input class="inp" data-p="font-family" value="${esc(fam(s.family))}"></div>
          <div><div class="lbl">Weight</div><select class="inp" data-p="font-weight">${[100,200,300,400,500,600,700,800,900].map((w) => `<option ${String(w) === s.weight ? "selected" : ""}>${w}</option>`).join("")}</select></div>
          <div><div class="lbl">Size</div><input class="inp" data-p="font-size" value="${s.size}"></div>
          <div><div class="lbl">Line height</div><input class="inp" data-p="line-height" value="${s.lh}"></div>
          <div><div class="lbl">Tracking</div><input class="inp" data-p="letter-spacing" value="${s.ls}"></div>
        </div><div class="lint"></div></div>`).join("") || `<div class="empty">No text found.</div>`;
    { const cl = textDups(list); const L = (c) => `Used ${uses(c)}`; L.main = (c) => c.canon.size;
      addDups(cl, L, (c) => [...c.members, c.canon].map((m) => m.size).join(" \u00b7 ") + " " + esc(c.canon.family.split(",")[0].replace(/["']/g, "")) + " " + c.canon.weight, "Sizes within 1px of each other, same family and weight. Merge them into the most used size.", (c) => mergeText(list, c)); }
    lp.querySelectorAll(".tcard").forEach((card) => { const hd = card.firstElementChild; if (!hd) return; hd.style.cursor = "pointer"; hd.title = "Show where this text style is used"; hd.addEventListener("click", () => { const t = list[card.dataset.i]; startFind(t.els.map((x) => (x && x.el) || x), t.name); }); });
    lp.querySelectorAll(".tcard").forEach((card) => {
      const s = list[card.dataset.i];
      card.querySelectorAll("[data-p]").forEach((inp) => {
        const apply = () => {
          const p = inp.dataset.p;
          let v = inp.value.trim();
          if (!v) return;
          if (/^-?[\d.]+$/.test(v) && p !== "font-weight") v += "px";
          if (p === "font-family" && /\s/.test(v) && !/["',]/.test(v)) v = `"${v}"`;
          const orig = { "font-family": s.family, "font-weight": s.weight, "font-size": s.size, "line-height": s.lh, "letter-spacing": s.ls }[p];
          for (const el of s.els) setProp(el, p, v);
          render();
          renderLint(card.querySelector(".lint"), lintMany(s.els));
          record(`g:t:${s.key}:${p}`, `${s.name} ${p.replace("font-", "").replace("-", " ")}`, orig.split(",")[0].replace(/["']/g, ""), v.split(",")[0].replace(/["']/g, ""), "text");
        };
        inp.addEventListener(inp.tagName === "SELECT" ? "change" : "change", apply);
        inp.addEventListener("keydown", (e) => {
          if (e.key === "Enter") { inp.blur(); return; }
          if (inp.tagName === "SELECT" || (e.key !== "ArrowUp" && e.key !== "ArrowDown")) return;
          const m = inp.value.match(/^(-?[\d.]+)(.*)$/); if (!m) return;
          e.preventDefault();
          const d = (e.shiftKey ? 10 : 1) * (e.key === "ArrowUp" ? 1 : -1);
          inp.value = Math.round((parseFloat(m[1]) + d) * 100) / 100 + m[2];
          apply();
        });
      });
    });
  };

  const spacingPanel = () => {
    const list = cache.spacing || (cache.spacing = scanSpacing());
    const max = Math.max(...list.map((s) => s.els.length), 1);
    lp.innerHTML = `<div class="ph"><b>Spacing</b><span>${list.length} values</span></div>` + list.map((s, i) => {
      const k = Object.entries(s.kinds).filter((x) => x[1]).map((x) => `${x[0]} x${x[1]}`).join(" / ");
      return `<div class="row"><div class="sp"><input class="inp" data-i="${i}" value="${s.value}"><span class="sub">px</span></div>
      <div class="meta"><div class="sub">${k}</div><div class="bars" style="margin-top:6px;width:100%"><i style="width:${Math.max(4, s.els.length / max * 100)}%"></i></div></div></div>`;
    }).join("") || `<div class="empty">No spacing found.</div>`;
    { const cl = spaceDups(list); const L = (c) => `Used ${uses(c)}`; L.main = (c) => c.canon.value + "px";
      addDups(cl, L, (c) => [...c.members, c.canon].map((m) => m.value + "px").join(" \u00b7 "), "Spacing values a pixel or so apart. Merge them into the most used one.", (c) => mergeSpace(list, c)); }
    lp.querySelectorAll(".row .meta").forEach((m) => { const inp = m.closest(".row").querySelector(".sp .inp"); if (!inp) return; m.style.cursor = "pointer"; m.classList.add("findable"); m.title = "Show where this spacing is used"; m.addEventListener("click", () => { const sp = list[inp.dataset.i]; startFind(sp.els.map((x) => x.el), sp.value + "px"); }); });
    lp.querySelectorAll(".sp .inp").forEach((inp) => {
      const s = list[inp.dataset.i];
      inp.addEventListener("change", () => {
        const v = parseFloat(inp.value);
        if (isNaN(v) || v < 0) return;
        for (const { el, prop } of s.els) setProp(el, prop, v + "px");
        render();
        record("g:s:" + s.value, `Spacing ${s.value}px (all uses)`, s.value + "px", v + "px", "space");
      });
      inp.addEventListener("keydown", (e) => {
        if (e.key === "Enter") { inp.blur(); return; }
        if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
        const cur = parseFloat(inp.value); if (isNaN(cur)) return;
        e.preventDefault();
        inp.value = String(Math.max(0, cur + (e.shiftKey ? 10 : 1) * (e.key === "ArrowUp" ? 1 : -1)));
        inp.dispatchEvent(new Event("change", { bubbles: true }));
      });
    });
  };

  /* ---------- review panel ---------- */
  const flash = (el) => {
    el.scrollIntoView({ block: "center", behavior: "smooth" });
    setTimeout(() => {
      nudge(el);
      const r = el.getBoundingClientRect();
      Object.assign(hl.style, { display: "block", left: r.left + "px", top: r.top + "px", width: r.width + "px", height: r.height + "px", borderColor: "#f24822", background: "rgba(242,72,34,.14)" });
      setTimeout(() => { hl.style.display = "none"; hl.style.borderColor = ""; hl.style.background = ""; }, 2600);
    }, 350);
  };
  const reviewPanel = () => {
    const F = runAudit();
    const groups = ["Accessibility", "UX heuristics", "Visual quality"];
    const cnt = (g, s) => F.filter((f) => f.group === g && (s === "warning" ? f.sev === "warning" : f.sev === s)).length;
    const issues = F.filter((f) => f.sev !== "pass").length;
    const note = "Automated subset of WCAG 2.2 AA, NN/g heuristics and basic visual checks. Not a full compliance audit: keyboard order, screen-reader behaviour and content quality still need a manual pass.";
    const tot = (sv) => F.filter((f) => f.sev === sv).length;
    let html = `<div class="ph"><b>Design review</b><span class="scan">${issues} to look at <button class="ibtn" data-tip="${esc(note)}" aria-label="About this review">${infoSvg}</button></span></div>`;
    html += `<div class="chips" id="chips"><button class="chip" data-f="error"><span class="shp err">${SHAPE.error}</span><b>${tot("error")}</b> Errors</button><button class="chip" data-f="warning"><span class="shp warn">${SHAPE.warn}</span><b>${tot("warning")}</b> Warnings</button><button class="chip" data-f="pass"><span class="shp ok">${SHAPE.pass}</span><b>${tot("pass")}</b> Pass</button><button class="chip on" data-f="all">All</button></div>`;
    groups.forEach((g) => {
      const e = cnt(g, "error"), w = cnt(g, "warning"), p = cnt(g, "pass");
      html += `<div class="gw"><div class="sec gh">${g}<span>${[e ? e + " error" + (e > 1 ? "s" : "") : "", w ? w + " warning" + (w > 1 ? "s" : "") : "", p ? p + " pass" : ""].filter(Boolean).join(" \u00b7 ")}</span></div>`;
      F.filter((f) => f.group === g).sort((a, b) => ({ error: 0, warning: 1, pass: 2 }[a.sev] - { error: 0, warning: 1, pass: 2 }[b.sev])).forEach((f) => {
        const idx = F.indexOf(f);
        const cls = f.sev === "error" ? "err" : f.sev === "warning" ? "warn" : "ok";
        html += `<details class="fnd" data-sev="${f.sev}" ${f.items.length ? "" : "data-flat"}><summary><span class="shp ${cls}">${SHAPE[f.sev === "warning" ? "warn" : f.sev]}</span><div class="meta"><div class="nm">${esc(f.title)}${f.total ? ` <span class="sub">(${f.total})</span>` : ""}</div><div class="sub wrap">${esc(f.reason)}</div></div></summary>` +
          f.items.map((it, ii) => `<div class="it ${it.el ? "go" : ""}" data-f="${idx}" data-i="${ii}"><span class="k2">${it.el ? esc(selectorOf(it.el)) : ""}</span><span class="sub">${esc(it.note || "")}</span></div>`).join("") +
          (f.total > f.items.length ? `<div class="it"><span class="sub">and ${f.total - f.items.length} more</span></div>` : "") + `</details>`;
      });
      html += `</div>`;
    });
    html += `<div class="foot"><button class="pbtn" id="rerun">Run review again</button></div>`;
    lp.innerHTML = html;
    let rf = "all";
    lp.querySelectorAll(".chip").forEach((c) => c.addEventListener("click", () => {
      rf = rf === c.dataset.f && rf !== "all" ? "all" : c.dataset.f;
      lp.querySelectorAll(".chip").forEach((x) => x.classList.toggle("on", x.dataset.f === rf));
      lp.querySelectorAll(".fnd").forEach((n) => { n.style.display = rf === "all" || n.dataset.sev === rf ? "" : "none"; });
      lp.querySelectorAll(".gw").forEach((g) => { g.style.display = [...g.querySelectorAll(".fnd")].some((n) => n.style.display !== "none") ? "" : "none"; });
    }));
    lp.querySelectorAll(".it.go").forEach((n) => n.addEventListener("click", () => { const fd = F[n.dataset.f], it = fd.items[n.dataset.i]; if (!it || !it.el) return; const err = fd.sev === "error"; markEl(it.el, { sev: fd.sev, col: err ? null : "#ffb020", head: (err ? "Error" : "Warning") + " \u00b7 " + fd.title, reason: it.note || fd.reason, label: labelOf(it.el), fix: fixFor(fd, it) }); }));
    $("#rerun").onclick = () => { lp.innerHTML = `<div class="empty">Reviewing\u2026</div>`; setTimeout(reviewPanel, 20); };
  };

  /* ---------- flow check (static crawl, GET only) ---------- */
  let flowRun = 0, flowAbort = null, lastFlowReport = "";
  const FLOW = { maxPages: 60, maxDepth: 3, concurrency: 6, timeoutMs: 8000 };
  const UNSAFE = /(log-?out|sign-?out|sign-?off|delete|remove|unsubscribe|cancel|checkout|purchase|\bbuy\b|\/pay|payment|order|confirm|reset|activate|unlink|revoke|disconnect|deactivate)/i;
  const FILE_EXT = /\.(pdf|zip|gz|png|jpe?g|gif|webp|svg|ico|mp4|mp3|mov|woff2?|ttf|csv|xlsx?|docx?|pptx?|dmg|exe|apk)(\?|$)/i;
  const route = (u) => { try { const x = new URL(u); return x.pathname + x.search; } catch (e) { return u; } };
  const CAP = (x) => x ? x[0].toUpperCase() + x.slice(1) : x;
  const TAGN = { a: "Link", button: "Button", form: "Form", input: "Field", select: "Field", textarea: "Field", img: "Image", page: "Page" };
  const parseLabel = (l) => { const m = /^([a-z0-9]+)(?: "(.*)"|#(.+))?$/i.exec(l) || []; const tag = (m[1] || "").toLowerCase(), text = m[2] || m[3] || ""; return text ? { title: text, tag: TAGN[tag] || tag } : { title: TAGN[tag] || CAP(l), tag: "" }; };
  const shortReason = (r) => r.replace(/No detectable action: no link, form, or handler attribute.*$/i, "No link, form or handler.").replace(/Link goes nowhere \(href="#"\) and has no detectable action/i, 'Goes nowhere (href="#"), no other action.').replace(/Dead end: no links to other pages.*$/i, "Dead end: no links to other pages.").replace(/Orphan: listed in sitemap.xml but no crawled page links to it/i, "Orphan: in sitemap.xml, but nothing links to it.");
  const codeify = (h) => h.replace(/(^|[\s(])((?:\/[\w\-.~%]+)+\/?|#[\w-]+|sitemap\.xml)/g, "$1<code>$2</code>");
  const SHAPE = { error: "\u2715", warn: "\u25b3", pass: "\u2713" };
  const infoSvg = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/></svg>';
  const labelOf = (el) => {
    const t = (el.getAttribute("aria-label") || el.textContent || el.value || el.getAttribute("title") || el.getAttribute("alt") || "").replace(/\s+/g, " ").trim().slice(0, 32);
    return `${el.tagName.toLowerCase()}${t ? ` "${t}"` : el.id ? "#" + el.id : ""}`;
  };
  const HANDLER_ATTR = /^(on|@|v-on|x-on|hx-|ng-click|data-|aria-controls|aria-expanded|aria-haspopup|popovertarget|formaction|href|form$|command)/i;
  const hasWiring = (el) => [...el.attributes].some((a) => HANDLER_ATTR.test(a.name));
  /* review: suggested fixes (page only, undoable) */
  const hex2 = (c) => "#" + [c.r, c.g, c.b].map((v) => Math.round(v).toString(16).padStart(2, "0")).join("");
  const ADVICE = {
    "Images missing alt text": "Add a short alt describing what the image shows. Use alt=\"\" if it is purely decorative.",
    "Form fields without labels": "Add a visible <label for=...> next to the field. A placeholder is not a label.",
    "Links or buttons without a name": "Add visible text or an aria-label that says where it goes or what it does.",
    "Focus outline removed": "Remove outline:none, or replace it with a clear :focus-visible style (2px outline, 3:1 contrast).",
    "Positive tabindex": "Remove tabindex above 0 and reorder the HTML so the natural order is right.",
    "Page-level basics": "Add <html lang=\"en\">, a unique <title>, and remove maximum-scale=1 / user-scalable=no from the viewport meta.",
    "Visual hierarchy breaks": "Make each heading level larger than the one below it and larger than body text.",
    "Heading structure": "Use one h1 and do not skip levels (h2 then h3).",
    "Many button styles": "Reduce to a primary, secondary and tertiary style and reuse them.",
    "Too many font families": "Limit the site to two or three font families.",
    "User control and error prevention": "Give links a real destination, forms a submit button, and dialogs a close button."
  };
  const fixFor = (f, it) => {
    const el = it && it.el; const t = f.title;
    const advice = ADVICE[t] ? { desc: ADVICE[t] } : null;
    if (!el) return advice;
    const propFix = (props, desc, label, from, to, kind) => { const id = () => elId(el); return { desc, apply() { Object.entries(props).forEach(([k, v]) => setProp(el, k, v)); if (label) record("fix:" + t + ":" + id(), label, from, to, kind); render(); return "Applied: " + desc; }, undo() { const o = overrides.get(id()); if (o) Object.keys(props).forEach((k) => delete o[k]); log.delete("fix:" + t + ":" + id()); updateBadge(); render(); } }; };
    const attrFix = (name, val, desc) => { const had = el.hasAttribute(name), old = el.getAttribute(name); return { desc, apply() { el.setAttribute(name, val); return "Applied: " + desc; }, undo() { if (had) el.setAttribute(name, old); else el.removeAttribute(name); } }; };
    if (t === "Text contrast below AA") {
      const cs = getComputedStyle(el), bg = effBg(el), fg = parseRGBA(cs.color); if (!bg || !fg) return advice;
      const need = textContrast(el).need + 0.15, base = blend(fg, bg), lumBg = (0.2126 * bg.r + 0.7152 * bg.g + 0.0722 * bg.b);
      const target = lumBg > 140 ? { r: 0, g: 0, b: 0 } : { r: 255, g: 255, b: 255 };
      let best = null;
      for (let k = 0; k <= 100; k++) { const x = k / 100, c = { r: base.r + (target.r - base.r) * x, g: base.g + (target.g - base.g) * x, b: base.b + (target.b - base.b) * x, a: 1 }; if (ratioOf(c, bg) >= need) { best = c; break; } }
      if (!best) return advice || { desc: "No colour of this hue reaches the required contrast on this background. Change the background instead." };
      const from = toHex(cs.color) || hex2(base), to = hex2(best);
      return propFix({ color: to }, `Change text colour ${from} to ${to} (${ratioOf(best, bg).toFixed(1)}:1, needs ${(need - 0.15).toFixed(1)}:1). Same hue, only darker or lighter.`, labelOf(el) + " text colour", from, to, "colour");
    }
    if (t === "Small touch targets") { const d = getComputedStyle(el).display; const p = { "min-width": "24px", "min-height": "24px" }; if (d === "inline") p.display = "inline-block"; return propFix(p, "Give it a minimum size of 24 x 24 px so it is easy to hit (WCAG 2.5.8).", labelOf(el) + " size", Math.round(el.getBoundingClientRect().width) + "x" + Math.round(el.getBoundingClientRect().height) + "px", "min 24x24px", "spacing"); }
    if (t === "Links hard to tell from text") return propFix({ "text-decoration": "underline" }, "Underline the link so it is not told apart by colour alone (WCAG 1.4.1).", labelOf(el) + " underline", "none", "underline", "text");
    if (t === "Images missing alt text") { const nm = ((el.getAttribute("src") || "").split("?")[0].split("/").pop() || "").replace(/\.[a-z0-9]+$/i, "").replace(/[-_]+/g, " ").trim(); const a = nm && !/^\d+$/.test(nm) ? nm : ""; return attrFix("alt", a, a ? `Add alt="${a}" (taken from the file name, so check it says what the image shows).` : 'Mark it as decorative with alt="" (use this only if it adds no information).'); }
    if (t === "Form fields without labels") { const a = el.placeholder || el.name || el.id; return a ? attrFix("aria-label", a, `Add aria-label="${a}" as a quick fix. A visible label is still better.`) : advice; }
    if (t === "Positive tabindex") return attrFix("tabindex", "0", "Set tabindex to 0 so it follows the natural focus order.");
    if (t === "User control and error prevention" && el.tagName === "INPUT" && /e-?mail/i.test(el.name + el.id) && el.type === "text") return attrFix("type", "email", 'Change the field to type="email" for validation and the right mobile keyboard.');
    return advice;
  };
  /* flow: locate and mark the exact element */
  const cssPath = (el) => { const parts = []; let n = el; while (n && n.nodeType === 1 && n !== n.ownerDocument.documentElement) { let i = 1, sib = n; while ((sib = sib.previousElementSibling)) if (sib.tagName === n.tagName) i++; parts.unshift(n.tagName.toLowerCase() + ":nth-of-type(" + i + ")"); n = n.parentElement; } return "html>" + parts.join(">"); };
  const locOf = (el) => ({ sel: cssPath(el), tag: el.tagName, href: el.getAttribute && el.getAttribute("href"), text: (el.textContent || "").trim().replace(/\s+/g, " ").slice(0, 80) });
  const findLoc = (loc) => {
    if (!loc) return null;
    try { const e = document.querySelector(loc.sel); if (e && e.tagName === loc.tag && (!loc.href || e.getAttribute("href") === loc.href)) return e; } catch (e) {}
    const c = [...document.querySelectorAll(loc.tag.toLowerCase())].filter((e) => !isUI(e));
    return c.find((e) => (!loc.href || e.getAttribute("href") === loc.href) && (!loc.text || (e.textContent || "").trim().replace(/\s+/g, " ").slice(0, 80) === loc.text)) || (loc.href ? c.find((e) => e.getAttribute("href") === loc.href) : null) || null;
  };
  let flowMark = null;
  const clearMark = () => { if (flowMark) { flowMark.stop = true; flowMark.box.remove(); flowMark.note.remove(); flowMark = null; } };
  const markEl = (el, f) => {
    clearMark();
    const sevCol = f.col || "#f24822";
    const box = document.createElement("div"); box.style.cssText = "position:fixed;z-index:2147483646;pointer-events:none;border:3px solid " + sevCol + ";border-radius:4px;box-shadow:0 0 0 4px rgba(242,72,34,.22),0 0 24px rgba(242,72,34,.45);box-sizing:border-box;transition:opacity .2s";
    const note = document.createElement("div"); note.className = "flownote";
    note.style.cssText = "position:fixed;z-index:2147483647;border-left-color:" + sevCol; note.classList.toggle("warn", !!f.col);
    const tgt = f.href ? `<div class="fnh">href: <code>${esc(f.href)}</code></div>` : "";
    const head = f.head || ((f.sev === "error" ? "Broken" : "Check") + " \u00b7 " + (f.label || "element"));
    const BTN = "";
    const fixHtml = f.fix ? (f.fix.apply ? `<div class="fxs"><div class="fxk">Suggested fix</div><div class="fxd">${esc(f.fix.desc)}</div><div class="fxb"><button class="pb fxa">Apply fix</button><button class="pb b2 fxu" style="display:none">Undo</button></div></div>` : `<div class="fxs"><div class="fxk">How to fix</div><div>${esc(f.fix.desc)}</div></div>`) : "";
    note.innerHTML = `<div class="fnt">${esc(head)}</div><div class="fnr">${esc(f.reason)}</div>${tgt}${fixHtml}<div class="fnx"><button class="pb gh2 fxx">Dismiss <kbd>Esc</kbd></button></div>`;
    const xa = note.querySelector(".fxa"), xu = note.querySelector(".fxu");
    if (xa) {
      xa.addEventListener("click", (e) => { e.stopPropagation(); try { const d = f.fix.apply(); note.querySelector(".fxd").textContent = d || "Applied"; note.querySelector(".fxs > div").textContent = "Applied on this page only (not saved to the site)"; xa.style.display = "none"; xu.style.display = "inline-flex"; } catch (err) { say("Could not apply: " + (err && err.message || err)); } });
      xu.addEventListener("click", (e) => { e.stopPropagation(); try { f.fix.undo(); note.querySelector(".fxd").textContent = f.fix.desc; note.querySelector(".fxs > div").textContent = "Suggested fix"; xu.style.display = "none"; xa.style.display = "inline-flex"; } catch (err) {} });
    }
    note.querySelector(".fxx").addEventListener("click", (e) => { e.stopPropagation(); clearMark(); });
    root.appendChild(box); root.appendChild(note);
    const st = { box, note, stop: false }; flowMark = st;
    el.scrollIntoView({ block: "center", behavior: "auto" });
    setTimeout(() => nudge(el), 60);
    const place = () => {
      if (st.stop) return;
      const r = el.getBoundingClientRect(), pad = 3;
      Object.assign(box.style, { left: r.left - pad + "px", top: r.top - pad + "px", width: r.width + pad * 2 + "px", height: r.height + pad * 2 + "px" });
      const nh = note.offsetHeight || 80; let ty = r.bottom + 12; if (ty + nh > innerHeight - 70) ty = Math.max(8, r.top - nh - 12);
      note.style.left = Math.max(8, Math.min(r.left, innerWidth - note.offsetWidth - 8)) + "px"; note.style.top = ty + "px";
      requestAnimationFrame(place);
    };
    place();
  };
  onL(document, "keydown", (e) => { if (e.key === "Escape" && flowMark) clearMark(); }, true);
  const goTo = (f) => {
    if (!f.loc) return;
    const here = route(location.href).replace(/\/index\.(html?|php)$/, "/"), there = f.page.replace(/\/index\.(html?|php)$/, "/");
    if (here === there) { const el = f.el || findLoc(f.loc); if (el) markEl(el, f); else say("Could not find that element on the page any more."); return; }
    const pend = { url: location.origin + f.page, loc: f.loc, sev: f.sev, label: f.label, reason: f.reason, href: f.href || (f.loc && f.loc.href) || null };
    say("Opening " + f.page + " to show it\u2026");
    chrome.runtime.sendMessage({ type: "dsx-pending-set", pending: pend }, () => { location.href = pend.url; });
  };
  setTimeout(() => {
    try { chrome.runtime.sendMessage({ type: "dsx-pending-get" }, (res) => { const p = res && res.pending; if (!p) return; const tryMark = (n) => { const el = findLoc(p.loc); if (el) markEl(el, p); else if (n < 12) setTimeout(() => tryMark(n + 1), 250); else say("Could not find the element on " + p.url); }; tryMark(0); }); } catch (e) {}
  }, 500);

  const analyzeDoc = (doc, live, pageUrl) => {
    const out = [], R = route(pageUrl);
    const q = (s) => [...doc.querySelectorAll(s)].filter((e) => !live || !isUI(e));
    const add = (sev, el, reason, extra) => out.push({ page: R, sev, label: el ? labelOf(el) : "page", reason, el: live ? el : null, loc: el ? locOf(el) : null, href: el && el.getAttribute ? el.getAttribute("href") : null, ...extra });
    const ids = new Set([...doc.querySelectorAll("[id]")].map((e) => e.id).concat([...doc.querySelectorAll("a[name]")].map((e) => e.getAttribute("name"))));
    q("a[href]").forEach((a) => {
      const h = a.getAttribute("href").trim();
      if (h === "" || h === "#" || /^javascript:\s*(void\(0\)|;|)\s*;?$/i.test(h)) {
        if (!hasWiring(a) || (a.attributes.length && ![...a.attributes].some((x) => /^(on|@|v-on|x-on|hx-|ng-click|data-|aria-controls|aria-expanded|aria-haspopup|role)/i.test(x.name))))
          add("warn", a, `Link goes nowhere (href="${h}") and has no detectable action`);
      } else if (h[0] === "#" && h.length > 1) {
        const id = decodeURIComponent(h.slice(1));
        if (id !== "top" && !ids.has(id)) add("error", a, `Points to #${id}, which does not exist on this page`);
      }
    });
    q('button,[role=button],input[type=button]').forEach((b) => {
      if (b.disabled || b.getAttribute("aria-disabled") === "true") return;
      if (b.tagName === "BUTTON" && b.closest("form") && (b.type === "submit" || !b.getAttribute("type"))) return;
      if (b.tagName === "BUTTON" && b.closest("a[href]")) return;
      if (hasWiring(b)) return;
      add("warn", b, "No detectable action: no link, form, or handler attribute (may be wired by JavaScript the scan cannot see)");
    });
    q("form").forEach((f) => {
      const act = (f.getAttribute("action") || "").trim();
      if (!f.querySelector('button:not([type=button]):not([type=reset]),input[type=submit],input[type=image]') && !hasWiring(f)) add("warn", f, "Form has no submit button");
      if (/^javascript:|^#$/i.test(act)) add("warn", f, `Form action is "${act}", so submitting does nothing useful`);
    });
    return out;
  };
  const fetchPage = async (url, signal, head) => {
    const ac = new AbortController(); const to = setTimeout(() => ac.abort(), FLOW.timeoutMs);
    signal.addEventListener("abort", () => ac.abort(), { once: true });
    try {
      const res = await fetch(url, { method: head ? "HEAD" : "GET", credentials: "same-origin", redirect: "follow", signal: ac.signal, headers: { Accept: "text/html,*/*" } });
      const ct = res.headers.get("content-type") || "";
      let html = null;
      if (!head && res.ok && /html/i.test(ct)) html = await res.text();
      else if (!head) res.body && res.body.cancel && res.body.cancel();
      return { status: res.status, final: res.url, redirected: res.redirected, html, ct };
    } catch (e) {
      return { status: 0, err: ac.signal.aborted ? "timed out or stopped" : "redirect loop or network error" };
    } finally { clearTimeout(to); }
  };
  const flowPanel = () => withBusy(() => flowPanel0());
  const flowPanel0 = async () => {
    const run = ++flowRun;
    if (flowAbort) flowAbort.abort();
    const ctl = (flowAbort = new AbortController());
    const origin = location.origin, startU = new URL(location.href); startU.hash = ""; startU.pathname = startU.pathname.replace(/\/index\.(html?|php)$/, "/");
    const pages = new Map(), seen = new Set([startU.href]), queue = [{ url: startU.href, depth: 0 }];
    const refs = [];       // {from,text,target,hash,el}
    let accessSkipped = 0; const findings = [], skipped = new Set(); let external = 0, capped = 0, fetched = 0, active = 0;
    const draw = (done) => {
      if (run !== flowRun) return;
      lp.innerHTML = `<div class="ph"><b>Flow check</b><span>${done ? "done" : "scanning\u2026"}</span></div><div class="empty" style="padding-bottom:6px">Scanned ${fetched} page${fetched === 1 ? "" : "s"} \u00b7 ${queue.length + active} queued</div><div style="margin:6px 14px 16px" class="bars"><i style="width:${Math.min(100, fetched / Math.max(1, fetched + queue.length + active) * 100)}%"></i></div><div class="foot"><button class="pbtn sec2" id="fstop">Stop</button></div>`;
      const b = $("#fstop"); if (b) b.onclick = () => { ctl.abort(); };
    };
    const norm = (href, base) => { try { const u = new URL(href, base); if (!/^https?:$/.test(u.protocol)) return null; return u; } catch (e) { return null; } };
    const handle = async (job) => {
      const live = job.url === startU.href;
      let doc, pageUrl = job.url, info = { status: 200 };
      if (live) { doc = document; }
      else {
        info = await fetchPage(job.url, ctl.signal, FILE_EXT.test(job.url));
        pageUrl = info.final || job.url;
        if (info.html) doc = new DOMParser().parseFromString(info.html, "text/html");
      }
      fetched++;
      const p = { url: job.url, final: pageUrl, status: info.status, err: info.err, doc, live, redirected: info.redirected, links: 0 };
      pages.set(job.url, p);
      if (doc && (info.status === 200 || live)) {
        findings.push(...analyzeDoc(doc, live, pageUrl));
        const anchors = [...doc.querySelectorAll("a[href]")].filter((a) => !live || !isUI(a));
        for (const a of anchors) {
          const raw = a.getAttribute("href").trim();
          if (!raw || raw[0] === "#" || /^(mailto:|tel:|sms:|javascript:|data:)/i.test(raw)) continue;
          const u = norm(raw, pageUrl); if (!u) continue;
          if (u.origin !== origin) { external++; continue; }
          const hash = u.hash.slice(1); u.hash = ""; u.pathname = u.pathname.replace(/\/index\.(html?|php)$/, "/");
          p.links++;
          const text = labelOf(a);
          if (UNSAFE.test(u.pathname + u.search) || /^(post|delete|put)$/i.test(a.getAttribute("data-method") || "")) { skipped.add(route(u.href)); continue; }
          refs.push({ from: route(pageUrl), text, target: u.href, hash, el: live ? a : null, loc: locOf(a), href: raw });
          if (!seen.has(u.href)) {
            if (seen.size >= FLOW.maxPages) { capped++; continue; }
            if (job.depth + 1 > FLOW.maxDepth) { capped++; continue; }
            seen.add(u.href); queue.push({ url: u.href, depth: job.depth + 1 });
          }
        }
      }
    };
    draw(false);
    const worker = async () => {
      while (!ctl.signal.aborted) {
        const job = queue.shift();
        if (!job) { if (active === 0) return; await new Promise((r) => setTimeout(r, 40)); continue; }
        active++; try { await handle(job); } finally { active--; }
        if (fetched % 2 === 0) draw(false);
      }
    };
    await Promise.all(Array.from({ length: FLOW.concurrency }, worker));
    if (run !== flowRun) return;
    const stopped = ctl.signal.aborted;

    // broken targets and missing anchors on other pages
    const reported = new Set();
    for (const r of refs) {
      const t = pages.get(r.target);
      if (!t) continue;
      const key = r.from + "|" + r.target + "|" + r.text;
      if (t.err || t.status >= 400) {
        // access problems are not flow breakage: skip sign-in walls, forbidden, rate limits, timeouts, network errors
        if (t.err || [401, 403, 407, 429].includes(t.status)) { accessSkipped++; continue; }
        if (reported.has(key)) continue; reported.add(key);
        findings.push({ page: r.from, sev: "error", label: r.text, href: r.href, loc: r.loc, reason: `Link to ${route(r.target)} returns ${t.status}`, el: r.el });
      } else if (t.redirected && /\/(log-?in|sign-?in|auth)\b/i.test(route(t.final))) {
        accessSkipped++; continue;
      } else if (r.hash && t.doc && t.status === 200) {
        const id = decodeURIComponent(r.hash);
        if (!t.doc.getElementById(id) && !t.doc.querySelector(`a[name="${CSS.escape(id)}"]`) && !reported.has(key + "#")) { reported.add(key + "#"); findings.push({ page: r.from, sev: "error", label: r.text, href: r.href, loc: r.loc, reason: `${route(r.target)} has no element with id "${id}"`, el: r.el }); }
      }
    }
    // dead ends
    for (const p of pages.values()) if (p.doc && p.status === 200 && p.links === 0 && !p.live && !p.doc.querySelector("form")) findings.push({ page: route(p.final), sev: "warn", label: "page", reason: "Dead end: no links to other pages, so the user cannot continue", el: null });
    // orphans via sitemap
    let orphanNote = "";
    try {
      const sm = await fetchPage(origin + "/sitemap.xml", ctl.signal, false);
      if (sm.status === 200) {
        const txt = await (await fetch(origin + "/sitemap.xml", { credentials: "same-origin" })).text();
        const locs = [...txt.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)].map((m) => norm(m[1], origin)).filter((u) => u && u.origin === origin).slice(0, 80);
        const linked = new Set([...refs.map((r) => route(r.target)), route(startU.href)]);
        if (capped === 0 && !stopped) locs.forEach((u) => { u.hash = ""; if (!linked.has(route(u.href))) findings.push({ page: route(u.href), sev: "warn", label: "page", reason: "Orphan: listed in sitemap.xml but no crawled page links to it", el: null }); });
        else orphanNote = "Orphan check skipped because the crawl hit its limit.";
      }
    } catch (e) {}

    // render
    const byPage = new Map();
    findings.forEach((f) => { if (!byPage.has(f.page)) byPage.set(f.page, []); byPage.get(f.page).push(f); });
    const gone = new Set();
    const cnt = (sev) => findings.filter((f) => f.sev === sev && !gone.has(f)).length;
    const pageList = [...byPage.entries()].sort((a, b) => b[1].filter((f) => f.sev === "error").length - a[1].filter((f) => f.sev === "error").length || b[1].length - a[1].length);
    const reportText = () => pageList.map(([r, fs]) => [r, fs.filter((f) => !gone.has(f))]).filter(([, fs]) => fs.length).map(([r, fs]) => r + "\n" + fs.map((f) => `  ${f.sev === "error" ? "[BROKEN]" : "[CHECK]"} ${f.label}: ${f.reason}`).join("\n")).join("\n\n");
    const sum = `${fetched} page${fetched === 1 ? "" : "s"}${skipped.size ? ` \u00b7 ${skipped.size} skipped` : ""}${external ? ` \u00b7 ${external} external` : ""}${capped ? ` \u00b7 ${capped} not followed` : ""}`;
    const detail = `${stopped ? "Stopped early. " : ""}Scanned ${fetched} page${fetched === 1 ? "" : "s"} and ${refs.length} internal links.${capped ? ` ${capped} links beyond the limit (${FLOW.maxPages} pages, depth ${FLOW.maxDepth}) were not followed.` : ""}${skipped.size ? ` ${skipped.size} risky URL${skipped.size > 1 ? "s" : ""} skipped (logout, delete, checkout and similar).` : ""}${external ? ` ${external} external links were not checked.` : ""} ${orphanNote} Static analysis only: GET requests, nothing is clicked or submitted. JavaScript-built content, app routes and pages behind sign-in may be missed.`;
    let html = `<div class="ph"><b>Flow check</b><span class="scan">${esc(sum)} <button class="ibtn" id="finfo" data-tip="Scan details" aria-label="Scan details">${infoSvg}</button></span></div>`;
    html += `<div class="dtl" id="fdtl">${esc(detail)}</div>`;
    html += `<div class="chips" id="chips"><button class="chip" data-f="error"><span class="shp err">${SHAPE.error}</span><b id="ce">${cnt("error")}</b> Broken</button><button class="chip" data-f="warn" data-tip="Check: no link, form or handler found in the page source. It may still work if JavaScript wires it up, which this scan cannot see."><span class="shp warn">${SHAPE.warn}</span><b id="cw">${cnt("warn")}</b> Check</button><button class="chip on" data-f="all">All</button></div>`;
    if (!findings.length) html += `<div class="empty">No flow breakpoints found in the pages scanned.</div>`;
    pageList.forEach(([r, fs]) => {
      fs.sort((a, b) => (a.sev === "error" ? 0 : 1) - (b.sev === "error" ? 0 : 1));
      html += `<details class="pg" open><summary><svg class="chev" width="10" height="10" viewBox="0 0 10 10"><path d="M2 3.5l3 3 3-3" fill="none" stroke="currentColor" stroke-width="1.5"/></svg><code>${esc(r)}</code><span class="pc"></span></summary>`;
      fs.slice(0, 40).forEach((f) => {
        const L = parseLabel(f.label), idx = findings.indexOf(f);
        html += `<div class="fl ${f.loc ? "go" : ""}" data-sev="${f.sev}" data-i="${idx}"><span class="shp ${f.sev === "error" ? "err" : "warn"}" aria-label="${f.sev === "error" ? "Broken" : "Check"}">${f.sev === "error" ? SHAPE.error : SHAPE.warn}</span><div class="meta"><div class="ttl"><span class="nm">${esc(L.title)}</span>${L.tag ? `<span class="tag">${esc(L.tag)}</span>` : ""}</div><div class="sub wrap">${codeify(esc(shortReason(f.reason)))}</div></div><div class="racts">${f.el ? `<button data-a="loc">Locate</button>` : ""}<button data-a="cp">Copy</button><button data-a="ig">Ignore</button></div></div>`;
      });
      if (fs.length > 40) html += `<div class="it"><span class="sub">and ${fs.length - 40} more on this page</span></div>`;
      html += `</details>`;
    });
    html += `<div class="foot"><button class="pbtn sec2" id="frerun">Scan again</button><button class="pbtn" id="fcopy">Copy report</button></div>`;
    lp.innerHTML = html;
    let filt = "all";
    const refresh = () => {
      lp.querySelectorAll(".fl").forEach((n) => { const f = findings[n.dataset.i]; n.style.display = gone.has(f) || (filt !== "all" && n.dataset.sev !== filt) ? "none" : ""; });
      lp.querySelectorAll(".pg").forEach((g) => {
        const rows = [...g.querySelectorAll(".fl")], vis = rows.filter((n) => n.style.display !== "none");
        const e = rows.filter((n) => !gone.has(findings[n.dataset.i]) && n.dataset.sev === "error").length, w = rows.filter((n) => !gone.has(findings[n.dataset.i]) && n.dataset.sev === "warn").length;
        g.querySelector(".pc").textContent = [e ? e + " broken" : "", w ? w + " check" : ""].filter(Boolean).join(" \u00b7 ");
        g.style.display = vis.length ? "" : "none";
      });
      $("#ce").textContent = cnt("error"); $("#cw").textContent = cnt("warn");
      $("#chips").querySelectorAll(".chip").forEach((c) => c.classList.toggle("on", c.dataset.f === filt));
      const hdr = lp.querySelector(".ph .scan"); void hdr;
    };
    lp.querySelectorAll(".chip").forEach((c) => c.addEventListener("click", () => { filt = filt === c.dataset.f && filt !== "all" ? "all" : c.dataset.f; refresh(); }));
    $("#finfo").onclick = () => $("#fdtl").classList.toggle("show");
    lp.querySelectorAll(".fl").forEach((n) => {
      const f = findings[n.dataset.i];
      n.addEventListener("click", (e) => {
        const a = e.target.closest("button[data-a]");
        if (a) {
          e.stopPropagation();
          if (a.dataset.a === "loc") goTo(f);
          if (a.dataset.a === "cp") navigator.clipboard.writeText(`${f.label}: ${f.reason}`).then(() => { a.textContent = "Copied"; setTimeout(() => { a.textContent = "Copy"; }, 1200); }).catch(() => {});
          if (a.dataset.a === "ig") { gone.add(f); refresh(); }
          return;
        }
        goTo(f);
      });
    });
    refresh();
    $("#frerun").onclick = () => flowPanel();
    $("#fcopy").onclick = () => navigator.clipboard.writeText(reportText()).then(() => { $("#fcopy").textContent = "Copied"; }).catch(() => { $("#fcopy").textContent = "Copy failed"; });
  };

  /* ---------- toast, before/after, live text edit, saved sessions ---------- */
  const toast = $("#toast"), cmpEl = $("#cmp");
  const say = (msg, act, opt) => {
    toast.textContent = msg; toast.classList.toggle("work", !!(opt && opt.work));
    if (act) { const b = document.createElement("button"); b.type = "button"; b.textContent = act.label; b.onclick = () => { toast.classList.remove("show"); act.fn(); }; toast.appendChild(b); }
    toast.classList.add("show"); clearTimeout(say.t); if (!(opt && opt.work)) say.t = setTimeout(() => toast.classList.remove("show"), act ? 8000 : Math.min(9000, 3200 + msg.length * 25));
  };
  /* revert with an undo window instead of a silent, permanent wipe */
  const revertWithUndo = () => {
    if (!log.size && !textEdits.size) { say("Nothing to revert yet."); return; }
    const snap = snapshot(), n = log.size;
    revertAll();
    say(`Reverted ${n} change${n === 1 ? "" : "s"}.`, { label: "Undo", fn: () => { restore(snap); say("Changes restored."); } });
  };
  const setCompare = (on) => {
    showOrig = on; sheet.media = on ? "not all" : "";
    for (const t of textEdits.values()) t.el.textContent = on ? t.orig : t.cur;
    host.classList.toggle("orig", on); cmpEl.classList.toggle("gone", !on); setActive();
  };
  const toggleCompare = () => {
    if (!showOrig && !(overrides.size || rootVars.size || textEdits.size)) { say("Nothing to compare yet. Make an edit first."); return; }
    setCompare(!showOrig);
  };
  cmpEl.addEventListener("click", () => setCompare(false));

  const shortTx = (t) => { t = t.replace(/\s+/g, " ").trim(); return t.length > 36 ? t.slice(0, 35) + "\u2026" : t; };
  const editable = (el) => el && el.children.length === 0 && el.textContent.trim().length > 0 && !/^(INPUT|TEXTAREA|SELECT|IMG|VIDEO|CANVAS)$/i.test(el.tagName);
  const startTextEdit = (el) => {
    if (!editable(el)) { say("Pick the innermost element that holds the text. This one has other elements inside it."); return; }
    if (showOrig) setCompare(false);
    setPicking(false);
    const id = elId(el), prev = textEdits.get(id), orig = prev ? prev.orig : el.textContent;
    el.contentEditable = "plaintext-only"; el.spellcheck = false;
    el.style.outline = "2px solid #0d99ff"; el.style.outlineOffset = "2px";
    el.focus();
    const sel = getSelection(); sel.selectAllChildren(el); sel.collapseToEnd();
    const noNav = (e) => e.preventDefault();
    const done = (cancel) => {
      el.removeEventListener("blur", onBlur); el.removeEventListener("keydown", onKey, true); el.removeEventListener("click", noNav, true);
      el.removeAttribute("contenteditable"); el.style.outline = ""; el.style.outlineOffset = "";
      if (!el.getAttribute("style")) el.removeAttribute("style");
      if (cancel) el.textContent = prev ? prev.cur : orig;
      const cur = el.textContent;
      if (cur !== orig) { textEdits.set(id, { el, orig, cur }); record("tx:" + id, `Copy: "${shortTx(orig)}"`, orig, cur, "copy"); }
      else { textEdits.delete(id); log.delete("tx:" + id); updateBadge(); }
      if (scheduleIssues) scheduleIssues();
    };
    const onBlur = () => done(false);
    const onKey = (e) => { e.stopPropagation(); if (e.key === "Enter") { e.preventDefault(); el.blur(); } else if (e.key === "Escape") { e.preventDefault(); el.removeEventListener("blur", onBlur); done(true); el.blur(); } };
    el.addEventListener("blur", onBlur); el.addEventListener("keydown", onKey, true); el.addEventListener("click", noNav, true);
  };

  const pathOf = (el) => {
    const parts = [];
    for (let n = el; n && n.nodeType === 1 && n !== document.documentElement; n = n.parentElement) {
      if (n.id && document.querySelectorAll("#" + CSS.escape(n.id)).length === 1) { parts.unshift("#" + CSS.escape(n.id)); break; }
      const sib = [...n.parentElement.children].filter((c) => c.tagName === n.tagName);
      parts.unshift(n.tagName.toLowerCase() + ":nth-of-type(" + (sib.indexOf(n) + 1) + ")");
    }
    return parts.join(" > ");
  };
  const snapshot = () => ({
    v: 1,
    ov: [...overrides].map(([id, props]) => { const el = document.querySelector(`[data-dsx="${id}"]`); return el ? [pathOf(el), props] : null; }).filter(Boolean),
    rv: [...rootVars], lg: [...log],
    tx: [...textEdits.values()].map((t) => [pathOf(t.el), t.orig, t.cur])
  });
  const restore = (d) => {
    revertAll();
    let miss = 0; const q = (p) => { try { return document.querySelector(p); } catch (e) { return null; } };
    for (const [path, props] of d.ov) { const el = q(path); if (!el) { miss++; continue; } for (const p in props) setProp(el, p, props[p]); }
    for (const [k, v] of d.rv) rootVars.set(k, v);
    for (const [path, orig, cur] of d.tx) { const el = q(path); if (!el) { miss++; continue; } el.textContent = cur; textEdits.set(elId(el), { el, orig, cur }); }
    for (const [k, v] of d.lg) log.set(k, v);
    render(); updateBadge();
    return miss;
  };
  /* sessions: save the current edits under a name and reopen them later (opt-in, stored in this browser) */
  const SESS_KEY = "dsx:sessions";
  const loadSess = () => new Promise((r) => { try { chrome.storage.local.get(SESS_KEY, (o) => r((o && o[SESS_KEY]) || [])); } catch (e) { r([]); } });
  const putSess = (list) => new Promise((r) => { try { chrome.storage.local.set({ [SESS_KEY]: list }, r); } catch (e) { r(); } });
  const sessionsPanel = async () => {
    const all = await loadSess(), here = location.origin;
    const mine = all.filter((x) => x.origin === here).sort((a, b) => b.t - a.t);
    const when = (t) => new Date(t).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
    const n = log.size;
    lp.innerHTML = `<div class="ph"><b>Sessions</b><span class="scan">${mine.length} saved for this site</span></div>
      <div class="note">A session is a named copy of your current edits (colours, text, spacing, copy changes). Save it to pick the work up later or show a client. Nothing is saved unless you press Save. Sessions stay in this browser until you delete them.</div>
      <div class="savebox"><input class="inp" id="sname" placeholder="Session name" maxlength="60" value="${esc(location.hostname + " " + new Date().toLocaleDateString([], { month: "short", day: "numeric" }))}"><button class="pbtn" id="ssave" ${n ? "" : "disabled"}>Save</button></div>
      <div class="sub" style="padding:0 16px 10px">${n ? n + " change" + (n > 1 ? "s" : "") + " ready to save." : "Make an edit first, then save it as a session."}</div>` +
      (mine.length ? `<div class="sec gh">Saved sessions<span>${mine.length}</span></div>` + mine.map((x) => `<div class="srow" data-id="${esc(x.id)}"><div class="meta"><div class="nm">${esc(x.name)}</div><div class="sub">${x.count} change${x.count === 1 ? "" : "s"} \u00b7 ${esc(x.path)} \u00b7 ${when(x.t)}</div></div><button class="pbtn sec2" data-a="open" style="flex:none;width:auto;min-width:0;padding:0 12px">Open</button><button class="pbtn sec2" data-a="del" style="flex:none;width:auto;min-width:0;padding:0 10px" aria-label="Delete session">\u2715</button></div>`).join("") : `<div class="empty">No saved sessions for this site yet.</div>`);
    const sv = $("#ssave");
    if (sv) sv.onclick = async () => {
      const name = ($("#sname").value || "").trim() || "Session";
      const list = await loadSess();
      list.push({ id: "s" + Date.now().toString(36), name, origin: here, path: location.pathname, t: Date.now(), count: log.size, data: snapshot() });
      await putSess(list.slice(-60)); say("Session saved: " + name); sessionsPanel();
    };
    lp.querySelectorAll(".srow").forEach((r) => r.addEventListener("click", async (e) => {
      const b = e.target.closest("button[data-a]"); if (!b) return;
      const list = await loadSess(), x = list.find((i) => i.id === r.dataset.id); if (!x) return;
      if (b.dataset.a === "del") { await putSess(list.filter((i) => i.id !== x.id)); say("Session deleted"); return sessionsPanel(); }
      const miss = restore(x.data); say(miss ? `Opened "${x.name}". ${miss} edit${miss > 1 ? "s" : ""} could not find ${miss > 1 ? "their elements" : "its element"} on this page.` : `Opened "${x.name}".`); sessionsPanel();
    }));
  };
  /* v2.4: before/after screenshot gallery (replaces saved sessions) */
  const storeOk = () => { try { return !!(chrome && chrome.storage && chrome.storage.local); } catch (e) { return false; } };
  const SHOTS_KEY = "dsx:shots", SHOT_CAP = 30;
  const loadShots = () => new Promise((r) => { try { chrome.storage.local.get(SHOTS_KEY, (o) => r((o && o[SHOTS_KEY]) || [])); } catch (e) { r([]); } });
  const blobToUrl = (blob) => new Promise((r) => { const fr = new FileReader(); fr.onload = () => r(fr.result); fr.readAsDataURL(blob); });
  const saveShot = async (blob, label) => {
    if (!storeOk()) throw new Error("storage is not available on this page");
    const list = await loadShots(), data = await blobToUrl(blob);
    list.unshift({ id: Date.now().toString(36), label, page: location.origin + location.pathname, host: location.hostname, at: Date.now(), data });
    await new Promise((r) => { try { chrome.storage.local.set({ [SHOTS_KEY]: list.slice(0, SHOT_CAP) }, r); } catch (e) { r(); } });
  };
  const dlUrl = (u, name) => { const a = document.createElement("a"); a.href = u; a.download = name; document.documentElement.appendChild(a); a.click(); a.remove(); };
  const IC_DL = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4v11M7.5 11 12 15.5 16.5 11M5 19.5h14"/></svg>';
  const IC_TRASH = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16M9.5 7V5h5v2M6.5 7l.8 12h9.4l.8-12M10 11v5M14 11v5"/></svg>';
  const galleryPanel = async () => {
    const list = await loadShots(), here = location.origin + location.pathname;
    const bef = list.find((x) => x.label === "before" && x.page === here), aft = list.find((x) => x.label === "after" && x.page === here);
    const when = (t) => new Date(t).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
    lp.innerHTML = `<div class="ph"><b>Before and after</b><span class="scan">${list.length} saved</span></div>
      <div class="note">Capture the whole page before you change anything, then again after. Open this panel in a meeting to show both. Images stay on this computer, inside the extension, until you delete them. Nothing is uploaded.</div>
      <div class="savebox"><button class="pbtn" id="gb">Capture before</button><button class="pbtn" id="ga">Capture after</button></div>` +
      (bef && aft ? `<div class="sec gh">Compare this page<span>drag to reveal</span></div>
        <div class="gcmp" id="gcmp"><img src="${aft.data}" alt="After"><div class="gclip" id="gclip"><img src="${bef.data}" alt="Before"></div><div class="ghandle" id="ghandle"></div><span class="gtag l">Before</span><span class="gtag r">After</span></div>
        <input type="range" id="grange" min="0" max="100" value="50" aria-label="Before and after slider" style="margin:6px 16px 4px;width:calc(100% - 32px)">` :
       `<div class="sub" style="padding:4px 16px 12px">${bef || aft ? "Capture the " + (bef ? "after" : "before") + " image to see the two side by side." : "No captures for this page yet. Start with the before image, make your edits, then capture the after image."}</div>`) +
      (list.length ? `<div class="sec gh">All captures<span>${list.length}</span></div>` + list.map((x) => `<div class="srow" data-id="${esc(x.id)}"><img class="gth" src="${x.data}" alt=""><div class="meta"><div class="nm">${x.label === "before" ? "Before" : "After"}</div><div class="sub">${esc(x.host)} \u00b7 ${when(x.at)}</div></div><button class="mini ico" data-a="dl" title="Download PNG" aria-label="Download image">${IC_DL}</button><button class="mini ico del" data-a="del" title="Delete" aria-label="Delete image">${IC_TRASH}</button></div>`).join("") + `<div class="foot"><button class="pbtn" id="gdel" style="background:#3a3a3c">Delete all</button></div>` : "");
    const cap = (label) => async () => { lp.classList.remove("show"); await fullShot(label); lp.classList.add("show"); galleryPanel(); };
    $("#gb").onclick = cap("before"); $("#ga").onclick = cap("after");
    const gd = $("#gdel"); if (gd) gd.onclick = () => { chrome.storage.local.remove(SHOTS_KEY, () => { say("All captures deleted"); galleryPanel(); }); };
    const gr = $("#grange"); if (gr) { const set = (v) => { $("#gclip").style.clipPath = `inset(0 ${100 - v}% 0 0)`; $("#ghandle").style.left = v + "%"; }; gr.oninput = () => set(+gr.value); set(50); }
    lp.querySelectorAll(".srow .mini").forEach((bt) => bt.addEventListener("click", async () => {
      const id = bt.closest(".srow").dataset.id, x = list.find((i) => i.id === id); if (!x) return;
      if (bt.dataset.a === "dl") return dlUrl(x.data, `blue-dot-${x.host}-${x.label}.png`);
      chrome.storage.local.set({ [SHOTS_KEY]: list.filter((i) => i.id !== id) }, () => galleryPanel());
    }));
  };

  /* ---------- near-duplicates (colours, type sizes, spacing, radius, shadow, z-index) ---------- */
  /* group values around the most-used one. Every member must be near the main value itself, so 10, 11, 12, 13, 14 never chain into one group */
  const clusterOf = (items, near) => {
    const order = [...items].sort((a, b) => b.els.length - a.els.length), used = new Set(), out = [];
    for (const c of order) {
      if (used.has(c)) continue;
      const members = order.filter((x) => x !== c && !used.has(x) && near(c, x));
      if (members.length) { used.add(c); members.forEach((x) => used.add(x)); out.push({ canon: c, members }); }
    }
    return out;
  };
  const rgbOf = (h) => [1, 3, 5].map((i) => parseInt(h.substr(i, 2), 16));
  const cDist = (a, b) => { const x = rgbOf(a), y = rgbOf(b); return Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2]); };
  const dupHtml = (cl, label, fmt, note) => cl.length ? `<details class="dups" open><summary><span class="shp warn">\u25b3</span>Near-duplicates<b>${cl.length}</b></summary><div class="dnote">${esc(note)}</div>` + cl.map((c, i) => `<div class="drow"><div class="meta"><div class="nm">${fmt(c)}</div><div class="sub">${esc(label(c))}</div></div><button class="mini pri ico" data-merge="${i}" data-tip="Merge: change every use of the similar values to ${esc(label.main ? label.main(c) : "the main one")}. You can undo it with Revert." aria-label="Merge similar values">${ICONS.merge}</button></div>`).join("") + `</details>` : "";
  const wireDups = (cl, merge) => lp.querySelectorAll("[data-merge]").forEach((b) => b.addEventListener("click", () => merge(cl[+b.dataset.merge])));
  const addDups = (cl, label, fmt, note, merge, anchor) => { const h = lp.querySelector(anchor || ".ph"); if (!h || !cl.length) return; h.insertAdjacentHTML("afterend", dupHtml(cl, label, fmt, note)); wireDups(cl, merge); };
  const dropMembers = (list, c) => { for (const m of c.members) { c.canon.els.push(...m.els); const i = list.indexOf(m); if (i >= 0) list.splice(i, 1); } };
  const uses = (c) => c.members.map((m) => m.els.length + "\u00d7").join(", ") + " vs " + c.canon.els.length + "\u00d7";

  const colourDups = (list) => {
    const eff = (s) => s.cur || s.hex;
    return clusterOf(list, (a, b) => { const d = cDist(eff(a), eff(b)); return d > 0 && d <= 9; });
  };
  const mergeColours = (list, c) => {
    const to = c.canon.cur || c.canon.hex;
    for (const m of c.members) {
      for (const { el, prop } of m.els) setProp(el, prop, to);
      for (const v of m.vars) { rootVars.set(v, to); c.canon.vars.push(v); }
      record("g:c:" + m.hex, `${m.name} (merged into ${c.canon.name})`, m.cur || m.hex, to, "colour");
    }
    dropMembers(list, c); render(); colourPanel();
  };
  const sizeNum = (s) => parseFloat(s.size);
  const textDups = (list) => clusterOf(list, (a, b) => a.weight === b.weight && a.family.split(",")[0] === b.family.split(",")[0] && sizeNum(a) !== sizeNum(b) && Math.abs(sizeNum(a) - sizeNum(b)) <= 1);
  const mergeText = (list, c) => {
    for (const m of c.members) {
      for (const el of m.els) setProp(el, "font-size", c.canon.size);
      record(`g:t:${m.key}:font-size`, `${m.name} size (merged into ${c.canon.name})`, m.size, c.canon.size, "text");
    }
    dropMembers(list, c); render(); textPanel();
  };
  const spaceDups = (list) => clusterOf(list, (a, b) => a.value !== b.value && Math.min(a.value, b.value) >= 6 && Math.abs(a.value - b.value) <= Math.max(1, Math.max(a.value, b.value) * 0.06));
  const mergeSpace = (list, c) => {
    for (const m of c.members) { for (const { el, prop } of m.els) setProp(el, prop, c.canon.value + "px"); record("g:s:" + m.value, `Spacing ${m.value}px (merged into ${c.canon.value}px)`, m.value + "px", c.canon.value + "px", "space"); }
    dropMembers(list, c); render(); spacingPanel();
  };

  /* ---------- Effects: radius, shadow, z-index ---------- */
  let fxTab = "radius";
  const RPROPS = ["border-top-left-radius", "border-top-right-radius", "border-bottom-right-radius", "border-bottom-left-radius"];
  const scanRadius = () => {
    const map = new Map();
    for (const el of allEls()) {
      const cs = getComputedStyle(el);
      for (const p of RPROPS) {
        const v = cs.getPropertyValue(p).split(" ")[0];
        if (!v || parseFloat(v) === 0) continue;
        const k = v.endsWith("%") ? v : (Math.round(parseFloat(v) * 10) / 10) + "px";
        if (!map.has(k)) map.set(k, { key: k, num: k.endsWith("%") ? null : parseFloat(k), els: [] });
        map.get(k).els.push({ el, prop: p });
      }
    }
    return [...map.values()].sort((a, b) => b.els.length - a.els.length).slice(0, 16).sort((a, b) => (a.num === null) - (b.num === null) || a.num - b.num);
  };
  const shadowNums = (v) => { const col = (v.match(/rgba?\([^)]*\)/) || [""])[0], a = col ? (col.match(/[\d.]+/g) || []).map(Number) : [], alpha = a.length > 3 ? a[3] : 1; const rest = v.replace(col, ""), n = (rest.match(/-?[\d.]+px/g) || []).map(parseFloat); return { alpha, n, inset: /inset/.test(v), layers: v.split(/,(?![^(]*\))/).length }; };
  const scanShadow = () => {
    const map = new Map();
    for (const el of allEls()) {
      const v = getComputedStyle(el).boxShadow;
      if (!v || v === "none") continue;
      if (!map.has(v)) map.set(v, { key: v, num: shadowNums(v), els: [] });
      map.get(v).els.push({ el, prop: "box-shadow" });
    }
    return [...map.values()].sort((a, b) => b.els.length - a.els.length).slice(0, 14);
  };
  const shadowDups = (list) => clusterOf(list, (a, b) => { const x = a.num, y = b.num; return a.key !== b.key && x.layers === 1 && y.layers === 1 && x.inset === y.inset && x.n.length >= 3 && y.n.length >= 3 && [0, 1, 2].every((i) => Math.abs(x.n[i] - y.n[i]) <= 2) && Math.abs(x.alpha - y.alpha) <= 0.06; });
  const scanZ = () => {
    const map = new Map();
    for (const el of allEls()) {
      const cs = getComputedStyle(el), z = cs.zIndex;
      if (z === "auto" || cs.position === "static") continue;
      const n = parseInt(z, 10); if (isNaN(n)) continue;
      if (!map.has(n)) map.set(n, { key: String(n), num: n, els: [] });
      map.get(n).els.push({ el, prop: "z-index" });
    }
    return [...map.values()].sort((a, b) => b.num - a.num).slice(0, 20);
  };
  const zDups = (list) => clusterOf(list, (a, b) => a.num !== b.num && Math.min(a.num, b.num) >= 10 && Math.abs(a.num - b.num) <= 10);
  const FX = {
    radius: { scan: scanRadius, dups: (l) => clusterOf(l, (a, b) => a.num !== null && b.num !== null && a.num !== b.num && Math.abs(a.num - b.num) <= 1 && Math.max(a.num, b.num) >= 3), name: "Radius", unit: "px", rec: "radius" },
    shadow: { scan: scanShadow, dups: shadowDups, name: "Shadow", rec: "shadow" },
    z: { scan: scanZ, dups: zDups, name: "Z-index", rec: "z" }
  };
  const effectsPanel = () => {
    const F = FX[fxTab], cacheKey = "fx" + fxTab, list = cache[cacheKey] || (cache[cacheKey] = F.scan());
    const max = Math.max(...list.map((x) => x.els.length), 1);
    const tabs = `<div class="chips tabs" id="fxt">${[["radius", "Radius"], ["shadow", "Shadow"], ["z", "Z-index"]].map(([k, n]) => `<button class="chip ${k === fxTab ? "on" : ""}" data-t="${k}">${n}</button>`).join("")}</div>`;
    const rows = list.map((x, i) => {
      const prev = fxTab === "radius" ? `<span class="fxp" style="border-radius:${esc(x.key)}"></span>` : fxTab === "shadow" ? `<span class="fxp" style="box-shadow:${esc(x.key)}"></span>` : `<span class="fxz">z</span>`;
      const sub = fxTab === "z" ? (x.num >= 1000 ? "very high" : "") : "";
      return `<div class="row">${prev}<div class="meta" style="min-width:0"><input class="inp" data-i="${i}" value="${esc(x.key)}" aria-label="${F.name} value"><div class="bars" style="margin-top:6px;width:100%"><i style="width:${Math.max(4, x.els.length / max * 100)}%"></i></div><div class="sub">${x.els.length} use${x.els.length === 1 ? "" : "s"}${sub ? " \u00b7 " + sub : ""}</div></div></div>`;
    }).join("") || `<div class="empty">No ${F.name.toLowerCase()} values found on this page.</div>`;
    lp.innerHTML = `<div class="ph"><b>Effects</b><span class="scan">${list.length} ${F.name.toLowerCase()} value${list.length === 1 ? "" : "s"}</span></div>${tabs}${rows}`;
    $("#fxt").querySelectorAll(".chip").forEach((c) => c.addEventListener("click", () => { fxTab = c.dataset.t; effectsPanel(); }));
    lp.querySelectorAll(".inp[data-i]").forEach((inp) => {
      const x = list[inp.dataset.i];
      inp.addEventListener("change", () => {
        let v = inp.value.trim(); if (!v) { inp.value = x.key; return; }
        if (fxTab === "radius" && /^[\d.]+$/.test(v)) v += "px";
        if (fxTab === "z" && !/^-?\d+$/.test(v)) { inp.value = x.key; return; }
        const prop = x.els[0] ? x.els[0].prop : "z-index";
        if (!CSS.supports(prop, v)) { inp.value = x.key; return; }
        for (const { el, prop } of x.els) setProp(el, prop, v);
        render(); record("g:fx:" + fxTab + ":" + x.key, `${F.name} ${x.key.length > 24 ? x.key.slice(0, 22) + "\u2026" : x.key} (all uses)`, x.key, v, F.rec);
      });
      inp.addEventListener("keydown", (e) => { if (e.key === "Enter") inp.blur(); });
    });
    const cl = F.dups(list);
    const lab = (c) => `${c.members.map((m) => m.key.length > 28 ? m.key.slice(0, 26) + "\u2026" : m.key).join(", ")} \u2192 ${c.canon.key.length > 28 ? c.canon.key.slice(0, 26) + "\u2026" : c.canon.key}`;
    const L = (c) => `Used ${uses(c)}`; L.main = (c) => c.canon.key;
    addDups(cl, L, (c) => `<span class="mono" style="font-size:12px;word-break:break-all">${esc(lab(c))}</span>`, fxTab === "z" ? "Close z-index values can usually share one layer. Merging can change what sits on top, so check the page after." : "These look almost the same. Merge them into the most used one.", (c) => {
      for (const m of c.members) { for (const { el, prop } of m.els) setProp(el, prop, c.canon.key); record("g:fx:" + fxTab + ":" + m.key, `${F.name} ${m.key.length > 24 ? m.key.slice(0, 22) + "\u2026" : m.key} (merged)`, m.key, c.canon.key, F.rec); }
      dropMembers(list, c); render(); effectsPanel();
    }, "#fxt");
  };

  /* ---------- panel docking: nudge away from a located element ---------- */
  const peekBtn = $("#peek");
  let peekT = 0;
  const peek = (on) => {
    clearTimeout(peekT);
    lp.classList.toggle("peek", on); peekBtn.classList.toggle("gone", !on);
    if (on) peekT = setTimeout(() => peek(false), 6000);
  };
  peekBtn.addEventListener("click", () => peek(false));
  const nudge = (el) => {
    if (!lp.classList.contains("show")) return;
    const r = el.getBoundingClientRect(), p = lp.getBoundingClientRect();
    if (r.right > p.left - 8 && r.left < p.right && r.bottom > p.top && r.top < p.bottom) peek(true);
  };
  obsL(new MutationObserver(() => { host.classList.toggle("lpopen", lp.classList.contains("show")); host.style.setProperty("--lpw", lp.style.width || "340px"); if (!lp.classList.contains("show")) peek(false); })).observe(lp, { attributes: true, attributeFilter: ["class", "style"] });
  onL(document, "keydown", (e) => { if (e.key === "Escape" && lp.classList.contains("peek")) peek(false); }, true);

  const openMode = (m) => {
    if (mode === "record" && m !== "record") stopRecording(true);
    mode = m; setActive();
    if (!m || m === "pick") { if (!m) lp.classList.remove("show"); return; }
    lp.classList.add("show");
    lp.style.width = m === "review" || m === "flow" ? "380px" : "340px";
    if (m !== "flow" && flowAbort) flowAbort.abort();
    lp.innerHTML = `<div class="empty">Scanning\u2026</div>`;
    setTimeout(() => { lp.classList.remove("swapin"); void lp.offsetWidth; lp.classList.add("swapin"); const P = ({ colours: colourPanel, text: textPanel, spacing: spacingPanel, review: reviewPanel, flow: flowPanel, issues: issuesPanel, gallery: galleryPanel, sessions: sessionsPanel, effects: effectsPanel })[m]; if (P) P(); }, 20); /* modes without a panel (record) just leave the panel closed */
  };

  /* ---------- element picker ---------- */
  const EP = [
    ["Text colour", "color", "c"], ["Background", "background-color", "c"], ["Border colour", "border-top-color", "c"],
    ["Font", "font-family", "t"], ["Size", "font-size", "t"], ["Weight", "font-weight", "t"], ["Line height", "line-height", "t"], ["Tracking", "letter-spacing", "t"],
    ["Padding", "padding", "t"], ["Margin", "margin", "t"], ["Radius", "border-radius", "t"]
  ];
  const cssShort = (cs, p) => {
    if (p === "padding" || p === "margin") { const v = ["top", "right", "bottom", "left"].map((s) => cs.getPropertyValue(`${p}-${s}`)); return v.every((x) => x === v[0]) ? v[0] : v.join(" "); }
    return cs.getPropertyValue(p);
  };
  const WEIGHTS = [["100", "Thin"], ["200", "Extra light"], ["300", "Light"], ["400", "Regular"], ["500", "Medium"], ["600", "Semibold"], ["700", "Bold"], ["800", "Extra bold"], ["900", "Black"]];
  const rgbaOf = (c) => { const m = c && c.match(/rgba?\(([^)]+)\)/); if (!m) return null; const p = m[1].split(/[,\s/]+/).filter(Boolean).map(Number); if (p.length < 3 || isNaN(p[0])) return null; return { r: p[0], g: p[1], b: p[2], a: p.length >= 4 ? Math.round(p[3] * 100) / 100 : 1 }; };
  const hexA = (hex, a) => { if (!hex) return "transparent"; if (a >= 1) return hex; const r = parseInt(hex.substr(1, 2), 16), g = parseInt(hex.substr(3, 2), 16), b = parseInt(hex.substr(5, 2), 16); return `rgba(${r}, ${g}, ${b}, ${a})`; };
  const showElement = (el) => {
    selected = el; markSelected(el);
    const cs = getComputedStyle(el), vm = buildVarMap(), sel = selectorOf(el), id = elId(el);
    const FICONS = { "font-size": "M4 7V4h16v3M12 4v16m-4 0h8", "line-height": "M3 6h18M3 12h18M3 18h18", "letter-spacing": "M4 5v14M20 5v14M8.5 15l3.5-7 3.5 7m-5.7-2.5h4.4", "font-family": "M12 3l9 5-9 5-9-5 9-5zM3 13l9 5 9-5", "W": "M8 5h8M5 5v14m14-14v14M8 19h8", "H": "M5 8v8M5 5h14M5 19h14M19 8v8" };
    const FLABELS = { "font-size": "Font size", "line-height": "Line height", "letter-spacing": "Letter spacing", "font-family": "Font", "width": "Width", "height": "Height", "padding-top": "Padding top", "padding-right": "Padding right", "padding-bottom": "Padding bottom", "padding-left": "Padding left", "margin-top": "Margin top", "margin-right": "Margin right", "margin-bottom": "Margin bottom", "margin-left": "Margin left", "border-radius": "Corner radius", "opacity": "Opacity" };
    const fld = (label, prop, wide) => { const oval = cssShort(cs, prop).split(",")[0].replace(/["']/g, ""); let val = oval; if (/^-?[\d.]+px$/.test(val)) val = val.slice(0, -2); if (/^-?\d+\.\d{2,}$/.test(val)) val = String(Math.round(parseFloat(val) * 10) / 10); const ic2 = FICONS[prop] ? `<span class="fk ico" title="${FLABELS[prop] || label}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="${FICONS[prop]}"/></svg></span>` : `<span class="fk">${label}</span>`; return `<label class="fld${wide ? " wide" : ""}" title="${FLABELS[prop] || label}">${ic2}<input class="inp" data-p="${prop}" data-o="${esc(oval)}" value="${esc(val)}" spellcheck="false" aria-label="${FLABELS[prop] || label}"></label>`; };
    const wsel = () => { const cur = String(parseInt(cs.fontWeight) || 400); const known = WEIGHTS.some(([v]) => v === cur); return `<label class="fld" title="Weight"><span class="fk ico" title="Font weight"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M7 4h5a4 4 0 010 8H7zM7 12h6.5a4 4 0 010 8H7z"/></svg></span><select class="fselect" data-p="font-weight" data-o="${cur}" aria-label="Weight">${WEIGHTS.map(([v, n]) => `<option value="${v}"${v === cur ? " selected" : ""}>${n}</option>`).join("")}${known ? "" : `<option value="${cur}" selected>${cur}</option>`}</select></label>`; };
    const col = (label, prop) => {
      const noBorder = prop === "border-top-color" && (parseFloat(cs.borderTopWidth) === 0 || cs.borderTopStyle === "none");
      if (noBorder) return `<div class="crow"><span class="ck2">${label}</span><div class="cw"><span class="sw" style="background:transparent;cursor:default"></span><span class="hex">No border</span></div></div>`;
      const v0 = cssShort(cs, prop), rgb = rgbaOf(v0), hex = toHex(v0), a = rgb ? rgb.a : 1, vars = hex ? vm.get(hex) || [] : [];
      return `<div class="crow"><span class="ck2">${label}</span><div class="cw"><label class="sw" style="background:${hexA(hex, a)}"><input type="color" data-p="${prop}" data-o="${hex || ""}" data-a="${a}" value="${hex || "#ffffff"}" aria-label="${label}"></label><input class="hexin" data-hx="${prop}" value="${hex || "transparent"}" spellcheck="false" aria-label="${label} hex"><input class="pct" data-pct="${prop}" value="${Math.round(a * 100)}%" spellcheck="false" aria-label="${label} opacity"></div></div>${vars.length ? `<div class="vrow"><span class="vn2">${vars.map((v) => esc(v)).join(", ")}</span></div>` : ""}`;
    };
    const sec = (t, inner, extra) => `<section class="esec"><div class="eh"><h4>${t}</h4>${extra || ""}</div>${inner}</section>`;
    const ta = cs.textAlign === "start" ? "left" : cs.textAlign === "end" ? "right" : cs.textAlign;
    const ALIGNS = [["left", "M3 5h18M3 10h12M3 15h18M3 20h12"], ["center", "M3 5h18M6 10h12M3 15h18M6 20h12"], ["right", "M3 5h18M9 10h12M3 15h18M9 20h12"], ["justify", "M3 5h18M3 10h18M3 15h18M3 20h18"]];
    const alignRow = `<div class="seg" id="eal">${ALIGNS.map(([v, d]) => `<button type="button" class="sbtn${ta === v ? " on" : ""}" data-v="${v}" aria-label="Align ${v}"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><path d="${d}"/></svg></button>`).join("")}</div>`;
    const rows = sec("Layout", `<div class="fgrid">${fld("W", "width")}${fld("H", "height")}</div>`)
      + sec("Spacing", `<div class="fk2">Padding</div><div class="fgrid4">${fld("T", "padding-top")}${fld("R", "padding-right")}${fld("B", "padding-bottom")}${fld("L", "padding-left")}</div><div class="fk2" style="margin-top:8px">Margin</div><div class="fgrid4">${fld("T", "margin-top")}${fld("R", "margin-right")}${fld("B", "margin-bottom")}${fld("L", "margin-left")}</div>`)
      + sec("Typography", `<div class="fhdr"><span class="ft">${esc(cssShort(cs, "font-family").split(",")[0].replace(/["']/g, ""))}</span><span class="fs">${esc(el.tagName.toLowerCase())} \u00b7 ${/\b(72[01]|7[4-9]\d|[89]\d{2})\b/.test(cs.fontWeight) ? "Display" : parseFloat(cs.fontSize) >= 32 ? "Display" : parseFloat(cs.fontSize) >= 20 ? "Heading" : "Body"} \u00b7 ${Math.round(el.getBoundingClientRect().width)}px wide</span></div><div id="etxrow"></div><div class="fgrid wsel2">${fld("T", "font-size")}${wsel()}</div><div class="fgrid" style="margin-top:6px">${fld("LH", "line-height")}${fld("A", "letter-spacing")}</div><div style="margin-top:6px">${alignRow}</div><div class="gprev" style="font-family:${esc(cssShort(cs, "font-family"))};font-weight:${esc(cs.fontWeight)}">AaBbCcDdEeFfGgHh 0123456789</div><div class="footrow"><button class="pbtn sec2" id="ecss" type="button">Copy CSS</button></div>`)
      + sec("Colour", col("Text", "color") + col("Fill", "background-color") + col("Stroke", "border-top-color"))
      + sec("Appearance", `<div class="fgrid">${fld("Radius", "border-radius")}${fld("Opacity", "opacity")}</div>`)
      + sec("Motion", `<button class="pbtn sec2" id="emo" style="width:100%">Inspect motion on this element</button>`);
    const txt0 = (el.innerText || el.getAttribute("aria-label") || el.alt || "").trim().replace(/\s+/g, " ").slice(0, 28);
    rp.innerHTML = `<div class="ph"><b title="${esc(sel)}">${esc(sel)}${txt0 ? `<span class="ptxt"> \u00b7 ${esc(txt0)}${(el.innerText || "").trim().length > 28 ? "\u2026" : ""}</span>` : ""}</b><span>${Math.round(el.getBoundingClientRect().width)} \u00d7 ${Math.round(el.getBoundingClientRect().height)}</span></div><div id="elint"></div>${rows}<div style="height:10px"></div>`;
    rp.classList.add("show");
    rp.querySelector("#etxrow").innerHTML = `<button class="pbtn sec2" id="etx" ${editable(el) ? "" : 'data-tip="This element has other elements inside it. Pick the one that holds the text."'} style="width:100%;margin-bottom:8px;${editable(el) ? "" : "opacity:.5"}">Edit text on page</button>`;
    rp.querySelector("#etx").onclick = () => startTextEdit(el);
    rp.querySelector("#ecss").onclick = () => { const c2 = getComputedStyle(el); const css = `font-family: ${c2.fontFamily};\nfont-size: ${c2.fontSize};\nfont-weight: ${c2.fontWeight};\nline-height: ${c2.lineHeight};\nletter-spacing: ${c2.letterSpacing};\ncolor: ${c2.color};\ntext-align: ${c2.textAlign};`; navigator.clipboard.writeText(css).then(() => { rp.querySelector("#ecss").textContent = "Copied"; setTimeout(() => { const b = rp.querySelector("#ecss"); if (b) b.textContent = "Copy CSS"; }, 1200); }).catch(() => { rp.querySelector("#ecss").textContent = "Copy failed"; }); };
    rp.querySelector("#emo").onclick = () => { setPicking(false); showMotion(el); };
    const relint = () => renderLint(rp.querySelector("#elint"), lintMany([el, ...[...el.children].slice(0, 8)]));
    relint();
    const setColour = (cInp, to) => {
      const p = cInp.dataset.p, a = parseFloat(cInp.dataset.a);
      const val = hexA(to, isNaN(a) ? 1 : a);
      if (p === "border-top-color") ["top", "right", "bottom", "left"].forEach((s) => setProp(el, `border-${s}-color`, val)); else setProp(el, p, val);
      render();
      cInp.parentElement.style.background = val;
      const cw = cInp.closest(".cw"); if (cw) { const hx = cw.querySelector(".hexin"); if (hx && hx.value !== to) hx.value = to; }
      relint();
    };
    rp.querySelectorAll("input[data-p]").forEach((inp) => {
      const p = inp.dataset.p, o = inp.dataset.o, label = `${sel} ${p.replace("background-color", "background").replace("border-top-color", "border colour").replace(/-/g, " ")}`;
      const key = `e:${id}:${p}`;
      if (inp.type === "color") {
        inp.addEventListener("input", () => { const to = inp.value; setColour(inp, to); record(key, label, o || "transparent", to, "colour"); applyAllChip(inp, el, p, o, to); });
      } else {
        const applyVal = () => {
          let v = inp.value.trim(); if (!v) return;
          if (p === "opacity") { v = String(Math.min(1, Math.max(0, parseFloat(v) || 0))); inp.value = v; }
          else if (/^-?[\d.]+$/.test(v) && !/^(font-weight|font-family|line-height)$/.test(p)) v += "px";
          setProp(el, p, v); render(); relint(); record(key, label, o, v, "text");
        };
        inp.addEventListener("change", applyVal);
        inp.addEventListener("keydown", (e) => {
          if (e.key === "Enter") { inp.blur(); return; }
          if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
          const m = inp.value.match(/^(-?[\d.]+)(.*)$/); if (!m) return;
          e.preventDefault();
          const d = (e.shiftKey ? 10 : 1) * (e.key === "ArrowUp" ? 1 : -1);
          inp.value = Math.round((parseFloat(m[1]) + d) * 100) / 100 + m[2];
          applyVal();
        });
      }
    });
    rp.querySelectorAll("select[data-p]").forEach((inp) => {
      const p = inp.dataset.p, o = inp.dataset.o;
      inp.addEventListener("change", () => { setProp(el, p, inp.value); render(); relint(); record(`e:${id}:${p}`, `${sel} font weight`, o, inp.value, "text"); });
    });
    rp.querySelectorAll(".hexin").forEach((hx) => {
      const prop = hx.dataset.hx, cw = hx.closest(".cw"), cInp = cw.querySelector('input[type="color"]');
      hx.addEventListener("change", () => {
        let v = hx.value.trim().toLowerCase();
        if (/^[0-9a-f]{6}$/.test(v)) v = "#" + v;
        else if (/^#?[0-9a-f]{3}$/.test(v)) v = "#" + v.replace("#", "").split("").map((c) => c + c).join("");
        if (!/^#[0-9a-f]{6}$/.test(v)) { hx.value = toHex(cssShort(getComputedStyle(el), prop)) || "transparent"; return; }
        cInp.value = v; setColour(cInp, v); record(`e:${id}:${prop}`, `${sel} ${prop.replace("background-color", "background").replace("border-top-color", "border colour").replace(/-/g, " ")}`, cInp.dataset.o || "transparent", v, "colour"); applyAllChip(cInp, el, prop, cInp.dataset.o, v);
      });
      hx.addEventListener("keydown", (e) => { if (e.key === "Enter") hx.blur(); });
    });
    rp.querySelectorAll(".pct").forEach((pc) => {
      const cw = pc.closest(".cw"), cInp = cw.querySelector('input[type="color"]');
      const applyPct = () => {
        const a0 = parseFloat(pc.value.replace("%", "").trim());
        if (isNaN(a0)) { pc.value = Math.round((parseFloat(cInp.dataset.a) || 1) * 100) + "%"; return; }
        const a = Math.min(100, Math.max(0, a0)) / 100;
        cInp.dataset.a = a; pc.value = Math.round(a * 100) + "%";
        setColour(cInp, cInp.value);
      };
      pc.addEventListener("change", applyPct);
      pc.addEventListener("keydown", (e) => { if (e.key === "Enter") pc.blur(); });
    });
    const eal = rp.querySelector("#eal");
    if (eal) eal.querySelectorAll(".sbtn").forEach((b) => b.addEventListener("click", () => {
      eal.querySelectorAll(".sbtn").forEach((x) => x.classList.remove("on")); b.classList.add("on");
      setProp(el, "text-align", b.dataset.v); render(); relint(); record(`e:${id}:text-align`, `${sel} text align`, ta, b.dataset.v, "text");
    }));
  };
  const selBox = document.createElement("div"); selBox.id = "selbox"; root.appendChild(selBox);
  let selRaf = 0;
  const markSelected = (el) => {
    cancelAnimationFrame(selRaf);
    if (!el) { selBox.style.display = "none"; return; }
    const loop = () => { if (selected !== el || !el.isConnected) { selBox.style.display = "none"; return; } const r = el.getBoundingClientRect(); Object.assign(selBox.style, { display: "block", left: r.left - 2 + "px", top: r.top - 2 + "px", width: r.width + 4 + "px", height: r.height + 4 + "px" }); selRaf = requestAnimationFrame(loop); };
    loop();
  };
  const target = (e) => { const cp = e.composedPath(); if (cp.includes(host)) return null; const t = cp[0]; return t && t.nodeType === 1 && !isUI(t) && t !== document.documentElement && t !== document.body ? t : null; };
  /* hovered element, plus how far the user lifted it with the arrow keys */
  let hovBase = null, hovEl = null;
  const pickVerb = () => sectionArmed ? "Copy section with motion" : figmaArmed ? "Copy for Figma" : motionArmed ? "Inspect motion" : codeArmed ? "Copy as code" : "Inspect";
  /* the section an element belongs to: a <section>, <header>, <footer>, or the first wide block around it */
  const sectionOf = (el) => {
    let best = el;
    for (let n = el; n && n !== document.body && n !== document.documentElement; n = n.parentElement) {
      const r = n.getBoundingClientRect();
      if (/^(SECTION|HEADER|FOOTER|ARTICLE|ASIDE|NAV)$/.test(n.tagName) && r.width > innerWidth * 0.5) return n;
      if (r.width >= innerWidth * 0.7 && r.height >= 120) { best = n; if (n.parentElement && (n.parentElement === document.body || n.parentElement.tagName === "MAIN")) return n; }
    }
    return best;
  };
  const drawHover = () => {
    let t = hovEl;
    if (t && sectionArmed && t === hovBase) t = hovEl = sectionOf(hovBase);
    if (!t || !picking) { hl.style.display = hlt.style.display = "none"; return; }
    const r = t.getBoundingClientRect();
    Object.assign(hl.style, { display: "block", left: r.left + "px", top: r.top + "px", width: r.width + "px", height: r.height + "px" });
    hlt.textContent = `${pickVerb()} \u00b7 ${selectorOf(t)} \u00b7 ${Math.round(r.width)}\u00d7${Math.round(r.height)}`;
    hlt.style.display = "block";
    const above = r.top - 26 >= 0;
    Object.assign(hlt.style, { left: Math.max(4, Math.min(innerWidth - hlt.offsetWidth - 4, r.left)) + "px", top: (above ? r.top - 26 : Math.min(innerHeight - 26, r.bottom + 4)) + "px" });
  };
  const onMove = (e) => {
    if (!picking) return;
    const t = target(e);
    if (t !== hovBase) { hovBase = t; hovEl = t; }
    drawHover();
  };
  onL(document, "keydown", (e) => {
    if (!picking || !hovEl || (e.key !== "ArrowUp" && e.key !== "ArrowDown")) return;
    if (e.key === "ArrowUp") { const p = hovEl.parentElement; if (p && p !== document.body && p !== document.documentElement) hovEl = p; }
    else if (hovEl !== hovBase) { let n = hovBase; while (n && n.parentElement !== hovEl) n = n.parentElement; if (n) hovEl = n; }
    e.preventDefault(); e.stopPropagation(); drawHover();
  }, true);
  const onClick = (e) => {
    if (!picking) return;
    let t = target(e);
    if (!t) return;
    if (hovEl && hovEl !== t && hovEl.contains(t)) t = hovEl;  /* keep the parent the user lifted to */
    e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
    if (sectionArmed) { const a = hovEl && hovEl.contains(t) ? hovEl : sectionOf(t); setPicking(false); copyFigma(a, { story: true }); return; }
    if (figmaArmed) { const a = t; setPicking(false); copyFigma(a); return; }
    if (motionArmed) { const a = t; setPicking(false); showMotion(a); return; }
    if (codeArmed) { const a = t; setPicking(false); copyCode(a); return; }
    showElement(t);
  };
  const swallow = (e) => { if (picking && target(e)) { e.preventDefault(); e.stopPropagation(); } };
  onL(document, "mousemove", onMove, true);
  onL(document, "click", onClick, true);
  ["mousedown", "mouseup", "pointerdown", "pointerup", "submit"].forEach((n) => onL(document, n, swallow, true));
  const setPicking = (on) => {
    if (on !== picking) busy(on);
    if (!on && /picks the parent/.test(toast.textContent)) toast.classList.remove("show");
    picking = on;
    if (!on) { hovBase = hovEl = null; hl.style.display = hlt.style.display = "none"; rp.classList.remove("show"); selected = null; figmaArmed = false; sectionArmed = false; motionArmed = false; codeArmed = false; }
    document.documentElement.style.cursor = on ? "crosshair" : "";
    setActive();
  };

  /* ---------- finish ---------- */
  const summaryText = () => [...log.values()].map((c) => `${c.label}: ${c.from} -> ${c.to}`).join("\n");
  const showFinish = () => {
    finishOpen = true;
    const items = [...log.values()];
    rp.innerHTML = `<div class="ph"><b>Change summary</b><span>${items.length} change${items.length === 1 ? "" : "s"}</span></div>` +
      (items.map((c) => `<div class="ch"><div class="t">${esc(c.label)}</div><div class="arrow">${c.kind === "colour" && /^#/.test(c.from) ? `<span class="dot" style="background:${c.from}"></span>` : ""}<span>${esc(c.from)}</span><span>\u2192</span>${c.kind === "colour" ? `<span class="dot" style="background:${c.to}"></span>` : ""}<span style="color:var(--fg)">${esc(c.to)}</span></div></div>`).join("") || `<div class="empty">No changes yet.<br>Edit a colour, font or spacing value and it will be listed here.</div>`) +
      `<div class="foot"><button class="pbtn danger" id="rv"${items.length ? "" : " disabled"}>Revert all</button><button class="pbtn" id="cp"${items.length ? "" : " disabled"}>Copy list</button></div>`;
    rp.classList.add("show"); setActive();
    $("#cp").onclick = () => { navigator.clipboard.writeText(summaryText()).then(() => { $("#cp").textContent = "Copied"; setTimeout(() => { const c = $("#cp"); if (c) c.textContent = "Copy list"; }, 1800); }).catch(() => { $("#cp").textContent = "Copy failed"; }); };
    $("#rv").onclick = () => { finishOpen = false; rp.classList.remove("show"); revertWithUndo(); setActive(); };
  };


  /* ---------- v2.2: scrolling inside panels, screenshot, copy for Figma ---------- */
  const panelOf = (e) => { const cp = e.composedPath(); return cp.find((n) => n === lp || n === rp); };
  const onWheel = (e) => {
    const p = panelOf(e); if (!p) return;
    e.stopImmediatePropagation();
    if (p.scrollHeight <= p.clientHeight + 1) { e.preventDefault(); return; }
    e.preventDefault();
    const k = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? p.clientHeight : 1;
    p.scrollTop += e.deltaY * k;
  };
  onL(window, "wheel", onWheel, { capture: true, passive: false });
  let mv = null;
  root.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    const cp = e.composedPath(); const p = panelOf(e); if (!p) return;
    const ph = cp.find((n) => n.nodeType === 1 && n.classList && n.classList.contains("ph")); if (!ph) return;
    if (cp.some((n) => n.nodeType === 1 && /^(INPUT|TEXTAREA|SELECT|BUTTON|A)$/.test(n.tagName))) return;
    const r = p.getBoundingClientRect();
    mv = { p, dx: e.clientX - r.left, dy: e.clientY - r.top, w: r.width, id: e.pointerId };
    p.classList.add("moving"); e.stopImmediatePropagation(); e.preventDefault();
  }, true);
  onL(window, "pointermove", (e) => {
    if (!mv) return;
    const vw = innerWidth, vh = innerHeight;
    const x = Math.max(8, Math.min(vw - mv.w - 8, e.clientX - mv.dx));
    const y = Math.max(8, Math.min(vh - 80, e.clientY - mv.dy));
    const st = mv.p.style;
    st.left = x + "px"; st.top = y + "px"; st.right = "auto"; st.bottom = "auto"; st.maxHeight = "calc(100vh - " + (y + 8) + "px)"; st.height = "auto"; st.transform = "none";
    e.preventDefault();
  }, true);
  const endMove = () => { if (mv) { mv.p.classList.remove("moving"); mv = null; } };
  onL(window, "pointerup", endMove, true); onL(window, "pointercancel", endMove, true);
  let drag = null;
  root.addEventListener("pointerdown", (e) => {
    const p = panelOf(e); if (!p || e.button !== 0) return;
    if (e.composedPath().some((n) => n.nodeType === 1 && /^(INPUT|TEXTAREA|SELECT|BUTTON|A|LABEL|SUMMARY)$/.test(n.tagName) || (n.nodeType === 1 && (n.isContentEditable || n.classList && n.classList.contains("sw"))))) return;
    drag = { p, y: e.clientY, top: p.scrollTop, moved: false, id: e.pointerId };
  });
  onL(window, "pointermove", (e) => {
    if (!drag) return;
    const dy = e.clientY - drag.y;
    if (!drag.moved && Math.abs(dy) > 4) { drag.moved = true; drag.p.classList.add("dragging"); }
    if (drag.moved) { drag.p.scrollTop = drag.top - dy; e.preventDefault(); }
  }, true);
  const endDrag = () => { if (drag) { drag.p.classList.remove("dragging"); const was = drag.moved; drag = null; if (was) { const swallowClick = (ev) => { ev.stopPropagation(); ev.preventDefault(); }; root.addEventListener("click", swallowClick, { capture: true, once: true }); setTimeout(() => root.removeEventListener("click", swallowClick, true), 50); } } };
  onL(window, "pointerup", endDrag, true); onL(window, "pointercancel", endDrag, true);

  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const loadImg = (src) => new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = src; });
  const saveBlob = (blob, name) => { const u = URL.createObjectURL(blob); const a = document.createElement("a"); a.href = u; a.download = name; document.documentElement.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(u), 4000); };
  const outImage = async (blob, name, okMsg) => {
    try { window.focus(); await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]); say(okMsg + " copied to your clipboard. Paste it anywhere."); return true; }
    catch (e) { saveBlob(blob, name); say("Clipboard blocked, so " + okMsg.toLowerCase() + " was saved to your downloads."); return false; }
  };
  const shotVisible = async () => {
    if (!(window.chrome && chrome.runtime && chrome.runtime.sendMessage)) { say("Screenshot needs the extension. Reload the page and click the icon."); return; }
    const pv = host.style.visibility; host.style.visibility = "hidden"; await wait(180);
    try {
      const res = await withBusy(() => new Promise((r) => chrome.runtime.sendMessage({ type: "dsx-capture" }, r)));
      host.style.visibility = pv;
      if (!res || !res.ok) throw new Error((res && res.error) || "capture failed");
      const blob = await (await fetch(res.dataUrl)).blob();
      await outImage(blob, `blue-dot-${location.hostname || "page"}-visible.png`, "Visible area");
    } catch (err) { host.style.visibility = pv; say("Screenshot failed: " + (err && err.message ? err.message : err)); }
  };
  const shotScreen = async () => {
    if (!(navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia)) { say("This browser does not allow screen capture here."); return; }
    let stream;
    try { stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false, selfBrowserSurface: "include", surfaceSwitching: "exclude" }); }
    catch (err) { say(err && err.name === "NotAllowedError" ? "Screen capture was cancelled." : "Screen capture failed: " + (err && err.message || err)); return; }
    const pv = host.style.visibility;
    try {
      const v = document.createElement("video"); v.muted = true; v.srcObject = stream; await v.play();
      host.style.visibility = "hidden"; await wait(450);
      const c = document.createElement("canvas"); c.width = v.videoWidth; c.height = v.videoHeight; c.getContext("2d").drawImage(v, 0, 0);
      host.style.visibility = pv; stream.getTracks().forEach((t) => t.stop());
      const blob = await new Promise((r) => c.toBlob(r, "image/png"));
      await outImage(blob, `blue-dot-screen-${Date.now()}.png`, "Screen capture");
    } catch (err) { host.style.visibility = pv; stream.getTracks().forEach((t) => t.stop()); say("Screen capture failed: " + (err && err.message || err)); }
  };
  let shooting = false;
  const fullShot = async (label) => {
    if (shooting) return;
    if (!(window.chrome && chrome.runtime && chrome.runtime.sendMessage)) { say("Screenshot needs the extension. Reload the page and click the icon."); return; }
    shooting = true;
    const sx = scrollX, sy = scrollY, dpr = window.devicePixelRatio || 1;
    const docEl = document.documentElement, vh = innerHeight, vw = innerWidth;
    const total = Math.max(docEl.scrollHeight, document.body ? document.body.scrollHeight : 0, vh);
    const maxH = Math.floor(16000 / dpr);
    const H = Math.min(total, maxH);
    const prevVis = host.style.visibility; host.style.visibility = "hidden";
    const prevSB = docEl.style.scrollBehavior; docEl.style.scrollBehavior = "auto";
    const hidden = [];
    const sbStyle = document.createElement("style"); sbStyle.textContent = "html{scrollbar-width:none!important}html::-webkit-scrollbar,body::-webkit-scrollbar{display:none!important}"; document.documentElement.appendChild(sbStyle);
    try {
      const canvas = document.createElement("canvas"); canvas.width = Math.round(vw * dpr); canvas.height = Math.round(H * dpr);
      const ctx = canvas.getContext("2d");
      let y = 0, n = 0;
      const total_n = Math.ceil(H / vh);
      while (y < H) {
        scrollTo(0, y); await wait(n === 0 ? 350 : 650);
        const real = scrollY;
        if (n === 1) {
          document.querySelectorAll("body *").forEach((el) => { if (el === host) return; const pos = getComputedStyle(el).position; if (pos === "fixed" || pos === "sticky") { hidden.push([el, el.style.visibility]); el.style.visibility = "hidden"; } });
        }
        const res = await withBusy(() => new Promise((r) => chrome.runtime.sendMessage({ type: "dsx-capture" }, r)));
        if (!res || !res.ok) throw new Error((res && res.error) || "capture failed");
        const img = await loadImg(res.dataUrl);
        ctx.drawImage(img, 0, Math.round(real * dpr), canvas.width, Math.round(img.height * (canvas.width / img.width)));
        y = real + vh; n++;
        if (n > 60) break;
      }
      const blob = await new Promise((r) => canvas.toBlob(r, "image/png"));
      let copied = false; if (label) await saveShot(blob, label); else { try { window.focus(); await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]); copied = true; } catch (e) { saveBlob(blob, `blue-dot-${location.hostname || "page"}-full.png`); } }
      host.style.visibility = prevVis;
      say(total > maxH ? "Saved the first " + maxH + "px of the page (browser size limit)." : label ? (label === "before" ? "Before image saved." : "After image saved.") : (copied ? "Full-page screenshot copied to your clipboard. Paste it anywhere." : "Clipboard blocked, so the full-page screenshot was saved to your downloads."));
    } catch (err) {
      host.style.visibility = prevVis;
      say("Screenshot failed: " + (err && err.message ? err.message : err));
    } finally {
      hidden.forEach(([el, v]) => { el.style.visibility = v; }); sbStyle.remove();
      docEl.style.scrollBehavior = prevSB; scrollTo(sx, sy); host.style.visibility = prevVis; shooting = false;
    }
  };

  /* v2.4: close button in every panel header */
  const addClose = (panel) => {
    const ph = panel.querySelector(".ph"); if (!ph || ph.querySelector(".pcx")) return;
    const b = document.createElement("button"); b.className = "pcx"; b.setAttribute("aria-label", "Close panel"); b.setAttribute("title", "Close");
    b.innerHTML = '<svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M2.5 2.5l7 7M9.5 2.5l-7 7"/></svg>';
    b.addEventListener("click", (e) => { e.stopPropagation(); const x = root.querySelector('.bar .btn[data-m=pclose]'); if (x) x.click(); });
    ph.appendChild(b);
  };
  [lp, rp].forEach((pn) => { if (!pn) return; obsL(new MutationObserver(() => addClose(pn))).observe(pn, { childList: true, subtree: true }); addClose(pn); });

  const armSection = () => {
    if (mode) openMode(null); finishOpen = false; rp.classList.remove("show");
    figmaArmed = true; sectionArmed = true; setPicking(true); figmaArmed = true; sectionArmed = true; setActive();
    say("Click a section to copy it with all its animation. \u2191 picks a bigger part, Esc cancels.");
  };
  const armFigma = (on) => {
    if (on) { if (mode) openMode(null); finishOpen = false; rp.classList.remove("show"); if (mode) openMode(null); figmaArmed = true; setPicking(true); figmaArmed = true; setActive(); say("Click the element to copy for Figma. \u2191 picks the parent, Esc cancels."); }
    else { figmaArmed = false; setPicking(false); }
  };
  const fx = (n) => Math.round(n * 100) / 100;
  const xesc = (t) => String(t).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const rgba = (c) => { const m = String(c).match(/rgba?\(([^)]+)\)/); if (!m) return null; const v = m[1].split(/[ ,\/]+/).filter(Boolean).map(Number); const a = v.length > 3 ? v[3] : 1; if (a === 0) return null; return { fill: `rgb(${v[0]},${v[1]},${v[2]})`, op: a }; };
  const measureCtx = document.createElement("canvas").getContext("2d");
  const figmaSvg = (rootEl) => {
    const R = rootEl.getBoundingClientRect(), out = [], notes = new Set();
    const rx = (cs) => { const m = cs.borderTopLeftRadius.match(/[\d.]+/); const v = m ? parseFloat(m[0]) : 0; return cs.borderTopLeftRadius.includes("%") ? 0 : v; };
    const walk = (el) => {
      if (el.nodeType !== 1 || el === host) return;
      const cs = getComputedStyle(el);
      if (cs.display === "none" || cs.visibility === "hidden" || parseFloat(cs.opacity) === 0) return;
      const r = el.getBoundingClientRect();
      const x = fx(r.left - R.left), y = fx(r.top - R.top), w = fx(r.width), h = fx(r.height);
      const op = parseFloat(cs.opacity);
      out.push(`<g${op < 1 ? ` opacity="${fx(op)}"` : ""}>`);
      if (w > 0 && h > 0) {
        const bg = rgba(cs.backgroundColor), radius = rx(cs);
        if (cs.backgroundImage && cs.backgroundImage !== "none" && !/^url/.test(cs.backgroundImage)) notes.add("gradients");
        if (bg) out.push(`<rect x="${x}" y="${y}" width="${w}" height="${h}"${radius ? ` rx="${radius}"` : ""} fill="${bg.fill}"${bg.op < 1 ? ` fill-opacity="${fx(bg.op)}"` : ""}/>`);
        const bw = ["Top", "Right", "Bottom", "Left"].map((sd) => parseFloat(cs[`border${sd}Width`]) || 0);
        const bc = ["Top", "Right", "Bottom", "Left"].map((sd) => rgba(cs[`border${sd}Color`]));
        const sty = ["Top", "Right", "Bottom", "Left"].map((sd) => cs[`border${sd}Style`]);
        if (bw.every((v) => v === bw[0]) && bw[0] > 0 && bc[0] && sty[0] !== "none") {
          const k = bw[0] / 2;
          out.push(`<rect x="${fx(x + k)}" y="${fx(y + k)}" width="${fx(w - bw[0])}" height="${fx(h - bw[0])}"${radius ? ` rx="${Math.max(0, fx(radius - k))}"` : ""} fill="none" stroke="${bc[0].fill}" stroke-width="${bw[0]}"${bc[0].op < 1 ? ` stroke-opacity="${fx(bc[0].op)}"` : ""}${sty[0] === "dashed" ? ' stroke-dasharray="6 4"' : sty[0] === "dotted" ? ' stroke-dasharray="1 3"' : ""}/>`);
        } else {
          if (bw[0] > 0 && bc[0]) out.push(`<rect x="${x}" y="${y}" width="${w}" height="${bw[0]}" fill="${bc[0].fill}"/>`);
          if (bw[2] > 0 && bc[2]) out.push(`<rect x="${x}" y="${fx(y + h - bw[2])}" width="${w}" height="${bw[2]}" fill="${bc[2].fill}"/>`);
          if (bw[3] > 0 && bc[3]) out.push(`<rect x="${x}" y="${y}" width="${bw[3]}" height="${h}" fill="${bc[3].fill}"/>`);
          if (bw[1] > 0 && bc[1]) out.push(`<rect x="${fx(x + w - bw[1])}" y="${y}" width="${bw[1]}" height="${h}" fill="${bc[1].fill}"/>`);
        }
        if (cs.boxShadow && cs.boxShadow !== "none") notes.add("shadows");
        const tag = el.tagName;
        if (tag === "IMG" && el.complete && el.naturalWidth) {
          let href = el.currentSrc || el.src;
          try { const c = document.createElement("canvas"); c.width = el.naturalWidth; c.height = el.naturalHeight; c.getContext("2d").drawImage(el, 0, 0); href = c.toDataURL("image/png"); } catch (e) { notes.add("cross-site images (kept as grey boxes)"); href = ""; }
          if (href) out.push(`<image x="${x}" y="${y}" width="${w}" height="${h}" preserveAspectRatio="xMidYMid slice" href="${xesc(href)}"/>`);
          else out.push(`<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="#d9d9d9"/>`);
        } else if (tag === "svg") {
          try { const c = el.cloneNode(true); c.setAttribute("x", x); c.setAttribute("y", y); c.setAttribute("width", w); c.setAttribute("height", h); if (!c.getAttribute("xmlns")) c.setAttribute("xmlns", "http://www.w3.org/2000/svg"); c.querySelectorAll("*").forEach((n) => { if (n.getAttribute && (n.getAttribute("fill") === "currentColor")) n.setAttribute("fill", cs.color); if (n.getAttribute && n.getAttribute("stroke") === "currentColor") n.setAttribute("stroke", cs.color); }); if (c.getAttribute("fill") === "currentColor") c.setAttribute("fill", cs.color); out.push(new XMLSerializer().serializeToString(c)); } catch (e) {}
        } else if (tag === "CANVAS" || tag === "VIDEO" || tag === "IFRAME") { notes.add("canvas, video and iframes"); out.push(`<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="#d9d9d9"/>`); }
      }
      if (el.tagName !== "svg" && !/^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE)$/.test(el.tagName)) {
        for (const node of el.childNodes) {
          if (node.nodeType === 3) {
            const txt = node.textContent.replace(/\s+/g, " ");
            if (!txt.trim()) continue;
            const fs = parseFloat(cs.fontSize) || 14, fam = cs.fontFamily, wt = cs.fontWeight;
            const tt = cs.textTransform, ls = parseFloat(cs.letterSpacing) || 0;
            measureCtx.font = `${cs.fontStyle} ${wt} ${fs}px ${fam}`;
            const asc = measureCtx.measureText("Hg").fontBoundingBoxAscent || fs * 0.92;
            const rng = document.createRange(), lines = [];
            const raw = node.textContent;
            let i = 0;
            while (i < raw.length) {
              let j = i; while (j < raw.length && !/\s/.test(raw[j])) j++;
              if (j > i) { rng.setStart(node, i); rng.setEnd(node, j); const rc = rng.getClientRects()[0]; if (rc) { const word = tt === "uppercase" ? raw.slice(i, j).toUpperCase() : tt === "lowercase" ? raw.slice(i, j).toLowerCase() : tt === "capitalize" ? raw.slice(i, j).replace(/^./, (c) => c.toUpperCase()) : raw.slice(i, j); const last = lines[lines.length - 1]; if (last && Math.abs(last.top - rc.top) < 3) { last.t += " " + word; } else lines.push({ top: rc.top, left: rc.left, t: word }); } }
              i = j + 1;
            }
            const col = rgba(cs.color) || { fill: "#000", op: 1 };
            for (const L of lines) out.push(`<text x="${fx(L.left - R.left)}" y="${fx(L.top - R.top + asc)}" font-family="${xesc(fam.replace(/"/g, "'"))}" font-size="${fs}" font-weight="${wt}"${cs.fontStyle !== "normal" ? ` font-style="${cs.fontStyle}"` : ""}${ls ? ` letter-spacing="${ls}"` : ""} fill="${col.fill}"${col.op < 1 ? ` fill-opacity="${fx(col.op)}"` : ""} xml:space="preserve">${xesc(L.t)}</text>`);
          } else if (node.nodeType === 1) walk(node);
        }
      }
      out.push("</g>");
    };
    walk(rootEl);
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${fx(R.width)}" height="${fx(R.height)}" viewBox="0 0 ${fx(R.width)} ${fx(R.height)}">${out.join("")}</svg>`;
    return { svg, notes: [...notes] };
  };
  const ensureFigma = async () => {
    if (globalThis.__dsxFigma) return true;
    try { await new Promise((r) => chrome.runtime.sendMessage({ type: "dsx-load-figma" }, r)); } catch (e) {}
    return !!globalThis.__dsxFigma;
  };
  const copyFigma = (el, opt) => withBusy(() => copyFigma0(el, opt || {}));
  /* Images on another domain (CDNs) cannot be downloaded from the page, so the converter used to drop them,
     and their animation with them. Try a normal download, then crop the image from one screenshot of the tab,
     then fall back to a neutral placeholder so the layer and its motion always survive. */
  const figmaImageLoader = (root) => {
    let shot = null; const stats = { fetched: 0, cropped: 0, placeholder: 0 };
    const grab = () => shot || (shot = (async () => {
      const prev = host.style.visibility; host.style.visibility = "hidden";
      /* animation frames do not run in background tabs, so never wait on them alone */
      await Promise.race([new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))), new Promise((r) => setTimeout(r, 120))]);
      if (document.hidden) { host.style.visibility = prev; return null; } /* a background tab cannot be captured: use placeholders */
      try { const res = await new Promise((r) => { try { chrome.runtime.sendMessage({ type: "dsx-capture" }, r); } catch (e) { r(null); } }); return res && res.ok ? await loadImg(res.dataUrl) : null; }
      catch (e) { return null; } finally { host.style.visibility = prev; }
    })());
    const toBytes = async (canvas) => { const b = await new Promise((r) => canvas.toBlob(r, "image/png")); return { bytes: await b.arrayBuffer(), mimeType: "image/png" }; };
    const findImg = (src) => [...(root.querySelectorAll ? root.querySelectorAll("img") : []), ...(root.tagName === "IMG" ? [root] : [])].find((i) => i.currentSrc === src || i.src === src);
    const loader = async ({ src }) => {
      try { const r = await fetch(src, { credentials: "omit" }); if (r.ok) { const b = await r.blob(); if (b.size) { stats.fetched++; return { bytes: await b.arrayBuffer(), mimeType: b.type || "image/png" }; } } } catch (e) {}
      /* the extension itself can download it when the optional "images from other sites" permission is on */
      try {
        const x = await new Promise((r) => { const t = setTimeout(() => r(null), 8000); try { chrome.runtime.sendMessage({ type: "dsx-fetch-image", src }, (v) => { clearTimeout(t); r(v); }); } catch (e) { clearTimeout(t); r(null); } });
        if (x && x.ok) { const bin = atob(x.b64), u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); stats.fetched++; return { bytes: u.buffer, mimeType: x.mime }; }
        if (x && x.reason === "no-permission") stats.needsPermission = true;
      } catch (e) {}
      const img = findImg(src), rr = img && img.getBoundingClientRect();
      if (rr && rr.width > 2 && rr.height > 2 && rr.bottom > 0 && rr.right > 0 && rr.top < innerHeight && rr.left < innerWidth) {
        const sh = await grab();
        if (sh) {
          const k = sh.width / innerWidth, sx = Math.max(0, rr.left * k), sy = Math.max(0, rr.top * k), sw = Math.min(sh.width - sx, rr.width * k), shh = Math.min(sh.height - sy, rr.height * k);
          if (sw > 1 && shh > 1) { const c = document.createElement("canvas"); c.width = Math.round(sw); c.height = Math.round(shh); c.getContext("2d").drawImage(sh, sx, sy, sw, shh, 0, 0, c.width, c.height); stats.cropped++; return toBytes(c); }
        }
      }
      const w = Math.max(8, Math.min(1600, Math.round((img && img.naturalWidth) || (rr && rr.width) || 200))), h = Math.max(8, Math.min(1600, Math.round((img && img.naturalHeight) || (rr && rr.height) || 150)));
      const c = document.createElement("canvas"); c.width = w; c.height = h; const g = c.getContext("2d");
      g.fillStyle = "#e4e4e7"; g.fillRect(0, 0, w, h); g.strokeStyle = "#a1a1aa"; g.lineWidth = Math.max(1, Math.min(w, h) / 60);
      const u = Math.min(w, h) / 5; g.strokeRect(w / 2 - u, h / 2 - u * 0.75, u * 2, u * 1.5); g.beginPath(); g.moveTo(w / 2 - u, h / 2 + u * 0.5); g.lineTo(w / 2 - u * 0.2, h / 2 - u * 0.1); g.lineTo(w / 2 + u, h / 2 + u * 0.75); g.stroke();
      stats.placeholder++; return toBytes(c);
    };
    loader.stats = stats; return loader;
  };
  const PASTE = MAC_K();
  function MAC_K() { return /Mac|iPhone|iPad/.test(navigator.platform || "") ? "\u2318V" : "Ctrl+V"; }
  let lastFigma = null;
  const copyFigmaAgain = () => {
    if (!lastFigma) return;
    navigator.clipboard.write([new ClipboardItem({ "text/html": new Blob([lastFigma], { type: "text/html" }) })])
      .then(() => say(`Copied again. Press ${PASTE} on the Figma canvas.`)).catch(() => say("The browser blocked the clipboard. Click the page once, then try again."));
  };
  const copyFigma0 = async (el, opt = {}) => {
    const isPage = el === document.body || el === document.documentElement;
    const what = isPage ? "the page" : selectorOf(el);
    /* Chrome only allows clipboard writes shortly after a click. Converting can take longer than that,
       so the write starts now, inside the click, and its content is handed over when it is ready. */
    let give, fail;
    const htmlP = new Promise((a, b) => { give = a; fail = b; });
    let writeP = null;
    try { window.focus(); writeP = navigator.clipboard.write([new ClipboardItem({ "text/html": htmlP.then((h) => new Blob([h], { type: "text/html" })) })]); writeP.catch(() => {}); } catch (e) { writeP = null; }
    say(`Preparing ${isPage ? "the page" : "the element"} for Figma\u2026`, null, { work: true });
    let html = null, mo = null, m = null;
    try {
      if (!(await ensureFigma())) throw new Error("converter not loaded");
      const ask = (type, ms) => new Promise((res) => { const t = setTimeout(() => res(null), ms); try { chrome.runtime.sendMessage({ type }, (x) => { clearTimeout(t); res(x && x.ok ? x.data : null); }); } catch (e) { clearTimeout(t); res(null); } });
      /* 1. find the motion and pause every animation on its most visible frame */
      if (!isPage) { el.setAttribute("data-dsx-root", opt.story ? "figma-story" : "1"); m = await ask("dsx-motion-collect", 12000); el.removeAttribute("data-dsx-root"); }
      let result;
      /* a section with no background of its own sits on the page's background: give the copy what you actually see */
      const bg0 = el.style.backgroundColor, cs0 = getComputedStyle(el);
      let bgSet = false;
      if (opt.story && (!toHex(cs0.backgroundColor)) && cs0.backgroundImage === "none") {
        let a = el.parentElement, c = null; while (a && !c) { const ac = getComputedStyle(a); if (toHex(ac.backgroundColor)) c = ac.backgroundColor; a = a.parentElement; }
        el.style.backgroundColor = c || "rgb(255, 255, 255)"; bgSet = true;
      }
      try {
        /* 2. capture the layers on that frame */
        const r = el.getBoundingClientRect();
        const imgLoad = figmaImageLoader(el);
        /* sections with motion keep every layer exactly where the page draws it (no auto layout), so pinned and
           moving parts line up with their keyframes */
        const f = globalThis.__dsxFigma.createFigmaConverter({ trace: true, imageLoader: imgLoad, layout: opt.story ? "absolute" : "auto" });
        window.__dsxImgStats = imgLoad.stats;
        result = await f.convert({ element: el, width: Math.max(1, Math.round(r.width)), height: Math.max(1, Math.round(r.height)), name: isPage ? (document.title || location.hostname) : (el.id ? "#" + el.id : selectorOf(el)) });
      } finally { if (bgSet) el.style.backgroundColor = bg0; if (!isPage) await ask("dsx-motion-restore", 3000); /* 3. let the page play again - always: a timed-out or failed collect can still have held frames */ }
      html = result.toClipboardHtml();
      /* 4. write the keyframes onto the layers */
      try { if (m && m.items && m.items.length) { mo = globalThis.__dsxFigma.applyMotion(result, m); html = mo.html; } else if (m && m.notes) host.dataset.motionNote = m.notes.join(" "); }
      catch (e) { host.dataset.motionErr = String(e && e.message || e); }
    } catch (err) { host.dataset.figmaErr = String(err && err.message || err); html = null; }

    if (html) {
      lastFigma = html; window.__dsxLastFigmaHtml = html; window.__dsxLastMotion = mo; host.dataset.figmaLen = String(html.length);
      give(html);
      /* Chrome can leave a delayed clipboard write pending forever after a long conversion: wait 4 s at most */
      let ok = false;
      if (writeP) ok = await Promise.race([writeP.then(() => true, () => false), new Promise((r) => setTimeout(() => r(false), 4000))]);
      if (!ok && !document.hidden) { try { ok = await Promise.race([navigator.clipboard.write([new ClipboardItem({ "text/html": new Blob([html], { type: "text/html" }) })]).then(() => true, () => false), new Promise((r) => setTimeout(() => r(false), 3000))]); } catch (e) {} }
      const story = opt.story && m && m.story ? `, ${(m.story.ms / 1000).toFixed(1)}s timeline (scroll played as time)` : "";
      const anim = mo && mo.withMotion ? ` with ${mo.applied.length} animated layer${mo.applied.length === 1 ? "" : "s"}${story}` : opt.story ? " (no animation found in this section)" : "";
      const ph = window.__dsxImgStats && window.__dsxImgStats.placeholder;
      if (ok && ph && window.__dsxImgStats.needsPermission) say(`Copied ${what}${anim}. ${ph} image${ph === 1 ? " is" : "s are"} from another site and became placeholder${ph === 1 ? "" : "s"}.`, { label: "Allow images", fn: () => { try { chrome.runtime.sendMessage({ type: "dsx-open-permission" }); } catch (e) {} } });
      else if (ok) say(`Copied ${what} as Figma layers${anim}. Press ${PASTE} on the Figma canvas.`, { label: "Copy again", fn: copyFigmaAgain });
      else say(`${isPage ? "The page" : "The element"} is ready, but the browser blocked the clipboard.`, { label: "Copy now", fn: copyFigmaAgain });
      return;
    }
    fail(new Error("no layers"));
    let res;
    try { res = figmaSvg(el); } catch (err) { say("Could not read that element: " + err.message); return; }
    window.__dsxLastSvg = res.svg;
    const miss = res.notes.length ? ` Left out: ${res.notes.join(", ")}.` : "";
    try { await navigator.clipboard.writeText(res.svg); say(`Copied as SVG (editable layers were not available). Press ${PASTE} in Figma.${miss}`); }
    catch (err) { saveBlob(new Blob([res.svg], { type: "image/svg+xml" }), "blue-dot-element.svg"); say("The clipboard was blocked, so the SVG was saved to your downloads. Drag it into Figma." + miss); }
  };

  /* ---------- v2.3: Motion inspector ---------- */
  const kebab = (k) => k.replace(/[A-Z]/g, (m) => "-" + m.toLowerCase());
  const camelK = (k) => k.replace(/-([a-z])/g, (m, c) => c.toUpperCase());
  const probeMain = () => new Promise((res) => { let done = false; const fin = (v) => { if (!done) { done = true; res(v); } }; setTimeout(() => fin(null), 3500); try { chrome.runtime.sendMessage({ type: "dsx-probe" }, (r) => fin(r && r.ok ? r.data : null)); } catch (e) { fin(null); } });
  const findKeyframesRule = (name) => {
    for (const ss of document.styleSheets) {
      let rules; try { rules = ss.cssRules; } catch (e) { continue; }
      const walk = (rs) => { for (const r of rs) { if (r.type === 7 && r.name === name) return r; if (r.cssRules && r.type !== 7) { const x = walk(r.cssRules); if (x) return x; } } return null; };
      const x = walk(rules); if (x) return x;
    }
    return null;
  };
  const rulesToKfs = (rule) => [...rule.cssRules].map((kr) => {
    const offs = kr.keyText.split(",").map((t) => t.trim() === "from" ? 0 : t.trim() === "to" ? 1 : parseFloat(t) / 100);
    const props = {}; for (let i = 0; i < kr.style.length; i++) { const pn = kr.style[i]; props[pn] = kr.style.getPropertyValue(pn); }
    return offs.map((o) => ({ offset: o, props }));
  }).flat().sort((a, b) => a.offset - b.offset);
  const hoverRulesFor = (el) => {
    const out = [];
    const walk = (rs) => { for (const r of rs) { if (r.type === 1 && r.selectorText && r.selectorText.includes(":hover")) { for (const part of r.selectorText.split(",")) { if (!part.includes(":hover")) continue; try { if (el.matches(part.replace(/:hover/g, "").trim() || "*")) { const d = {}; for (let i = 0; i < r.style.length; i++) d[r.style[i]] = r.style.getPropertyValue(r.style[i]); out.push({ sel: part.trim(), decls: d }); } } catch (e) {} } } else if (r.cssRules && r.type !== 7) walk(r.cssRules); } };
    for (const ss of document.styleSheets) { let rules; try { rules = ss.cssRules; } catch (e) { continue; } walk(rules); }
    return out;
  };
  const timingOf = (t) => ({ duration: Math.round(Number(t.duration) || 0), delay: Math.round(t.delay || 0), easing: t.easing || "linear", iterations: t.iterations === Infinity ? "infinite" : t.iterations, direction: t.direction || "normal", fill: t.fill || "none" });
  const cleanKfs = (anim) => anim.effect.getKeyframes().map((k) => { const props = {}; let off = k.offset == null ? k.computedOffset : k.offset; for (const key of Object.keys(k)) { if (["offset", "computedOffset", "composite", "easing"].includes(key)) continue; props[kebab(key)] = String(k[key]); } return { offset: off, easing: k.easing && k.easing !== "linear" ? k.easing : undefined, props }; });
  const collectMotion = (el) => {
    const cs = getComputedStyle(el), m = { anims: [], hover: hoverRulesFor(el), trans: [], samples: null };
    for (const a of el.getAnimations()) {
      try {
        const type = typeof CSSAnimation !== "undefined" && a instanceof CSSAnimation ? "CSS animation" : typeof CSSTransition !== "undefined" && a instanceof CSSTransition ? "CSS transition" : "Web Animation";
        const name = a.animationName || a.transitionProperty || a.id || "effect";
        const rule = type === "CSS animation" ? findKeyframesRule(a.animationName) : null;
        m.anims.push({ type, name, timing: timingOf(a.effect.getTiming()), kfs: cleanKfs(a), ruleText: rule ? rule.cssText : null });
      } catch (e) {}
    }
    if (!m.anims.length && cs.animationName && cs.animationName !== "none") {
      cs.animationName.split(",").forEach((nm, i) => {
        nm = nm.trim(); const rule = findKeyframesRule(nm); if (!rule) return;
        const pick = (prop) => { const v = cs.getPropertyValue(prop).split(","); return (v[i] || v[0] || "").trim(); };
        const dur = pick("animation-duration"), del = pick("animation-delay");
        const ms = (t) => t.endsWith("ms") ? parseFloat(t) : parseFloat(t) * 1000;
        m.anims.push({ type: "CSS animation", name: nm, timing: { duration: Math.round(ms(dur)), delay: Math.round(ms(del)), easing: pick("animation-timing-function"), iterations: pick("animation-iteration-count") === "infinite" ? "infinite" : parseFloat(pick("animation-iteration-count")) || 1, direction: pick("animation-direction"), fill: pick("animation-fill-mode") }, kfs: rulesToKfs(rule), ruleText: rule.cssText, idle: true });
      });
    }
    const tp = cs.transitionProperty.split(",").map((x) => x.trim()), td = cs.transitionDuration.split(",").map((x) => x.trim()), tl = cs.transitionDelay.split(",").map((x) => x.trim()), te = cs.transitionTimingFunction.split(/,(?![^(]*\))/).map((x) => x.trim());
    const ms = (t) => t.endsWith("ms") ? parseFloat(t) : parseFloat(t) * 1000;
    tp.forEach((pr, i) => { const d = ms(td[i % td.length]); if (d > 0) m.trans.push({ prop: pr, duration: Math.round(d), delay: Math.round(ms(tl[i % tl.length])), easing: te[i % te.length] }); });
    return m;
  };
  /* auto-detect: synthetic effect from GSAP tween values, and a plain-language style name */
  const EASE = { none: "linear", linear: "linear", power1: ["cubic-bezier(.25,.46,.45,.94)", "cubic-bezier(.55,.085,.68,.53)", "cubic-bezier(.455,.03,.515,.955)"], power2: ["cubic-bezier(.215,.61,.355,1)", "cubic-bezier(.55,.055,.675,.19)", "cubic-bezier(.645,.045,.355,1)"], power3: ["cubic-bezier(.165,.84,.44,1)", "cubic-bezier(.895,.03,.685,.22)", "cubic-bezier(.77,0,.175,1)"], power4: ["cubic-bezier(.19,1,.22,1)", "cubic-bezier(.755,.05,.855,.06)", "cubic-bezier(.86,0,.07,1)"], expo: ["cubic-bezier(.16,1,.3,1)", "cubic-bezier(.7,0,.84,0)", "cubic-bezier(.87,0,.13,1)"], sine: ["cubic-bezier(.39,.575,.565,1)", "cubic-bezier(.47,0,.745,.715)", "cubic-bezier(.445,.05,.55,.95)"], circ: ["cubic-bezier(.075,.82,.165,1)", "cubic-bezier(.6,.04,.98,.335)", "cubic-bezier(.785,.135,.15,.86)"], back: ["cubic-bezier(.175,.885,.32,1.275)", "cubic-bezier(.6,-.28,.735,.045)", "cubic-bezier(.68,-.55,.265,1.55)"] };
  const gsapEase = (e) => { const s0 = String(e || "power1.out"), m = /^([a-z]+)(\d?)(?:\.(in|out|inOut))?/i.exec(s0); if (!m) return "ease"; const k = m[1].toLowerCase() === "power" ? "power" + (m[2] || 1) : m[1].toLowerCase(); const v = EASE[k]; if (typeof v === "string") return v; if (!v) return "ease-out"; const d = (m[3] || "out"); return v[d === "out" ? 0 : d === "in" ? 1 : 2]; };
  const gsapProps = (v) => {
    const o = {}, tr = [];
    const num = (x) => (typeof x === "number" ? x : parseFloat(x));
    if (v.x != null) tr.push(`translateX(${num(v.x)}px)`); if (v.xPercent != null) tr.push(`translateX(${num(v.xPercent)}%)`);
    if (v.y != null) tr.push(`translateY(${num(v.y)}px)`); if (v.yPercent != null) tr.push(`translateY(${num(v.yPercent)}%)`);
    if (v.scale != null) tr.push(`scale(${num(v.scale)})`); if (v.scaleX != null) tr.push(`scaleX(${num(v.scaleX)})`); if (v.scaleY != null) tr.push(`scaleY(${num(v.scaleY)})`);
    if (v.rotation != null) tr.push(`rotate(${num(v.rotation)}deg)`); if (v.rotate != null) tr.push(`rotate(${num(v.rotate)}deg)`);
    if (tr.length) o.transform = tr.join(" ");
    if (v.opacity != null) o.opacity = String(v.opacity); if (v.autoAlpha != null) o.opacity = String(v.autoAlpha);
    /* every other CSS property GSAP was given (backgroundColor, borderRadius, filter, clipPath, ...) */
    const SKIP = /^(x|y|z|xPercent|yPercent|rotation|rotate|rotationX|rotationY|rotateX|rotateY|scale|scaleX|scaleY|skewX|skewY|opacity|autoAlpha|duration|delay|ease|repeat|repeatDelay|yoyo|yoyoEase|stagger|overwrite|immediateRender|runBackwards|startAt|lazy|paused|reversed|id|data|callbackScope|inherit|keyframes|transformOrigin|svgOrigin|force3D|onStart|onUpdate|onComplete|onRepeat|onReverseComplete|scrollTrigger|parent|snap|modifiers|motionPath|text|scrambleText|morphSVG|drawSVG)$/;
    const PX = /^(width|height|top|left|right|bottom|margin|padding|border.*Width|borderRadius|fontSize|letterSpacing|gap|min.*|max.*)/;
    for (const k of Object.keys(v)) { const x = v[k]; if (SKIP.test(k) || (typeof x !== "string" && typeof x !== "number")) continue; o[k.replace(/[A-Z]/g, (c) => "-" + c.toLowerCase())] = typeof x === "number" && PX.test(k) ? x + "px" : String(x); }
    if (v.transformOrigin) o["transform-origin"] = String(v.transformOrigin);
    return o;
  };
  /* ---- exact GSAP easing: GSAP's own ease formulas, written out as a CSS linear() curve ---- */
  const gsapEaseFn = (e) => {
    const s0 = String(e == null ? "power1.out" : e).trim(), m = /^([a-z]+)(\d?)(?:\.(in|out|inOut))?(?:\(([^)]*)\))?$/i.exec(s0);
    if (!m) return null;
    let k = m[1].toLowerCase(); const dir = m[3] || "out", args = (m[4] || "").split(",").map((x) => parseFloat(x)).filter((x) => !isNaN(x));
    const alias = { quad: "power1", cubic: "power2", quart: "power3", quint: "power4", strong: "power4" };
    if (alias[k]) k = alias[k]; else if (k === "power") k = "power" + (m[2] || 1);
    if (k === "none" || k === "linear" || k === "power0") return (t) => t;
    const io = (out) => dir === "out" ? out : dir === "in" ? (t) => 1 - out(1 - t) : (t) => t < 0.5 ? (1 - out(1 - 2 * t)) / 2 : 0.5 + out(2 * t - 1) / 2;
    const pw = /^power([1-4])$/.exec(k);
    if (pw) { const n = +pw[1] + 1; return io((t) => 1 - Math.pow(1 - t, n)); }
    if (k === "sine") return io((t) => Math.sin(t * Math.PI / 2));
    if (k === "expo") return io((t) => t === 1 ? 1 : 1 - Math.pow(2, -10 * t));
    if (k === "circ") return io((t) => Math.sqrt(1 - (t - 1) * (t - 1)));
    if (k === "back") { const o = args.length ? args[0] : 1.70158; return io((t) => { const u = t - 1; return u * u * ((o + 1) * u + o) + 1; }); }
    if (k === "elastic") { const amp = args.length ? args[0] : 1, per0 = args.length > 1 ? args[1] : (dir === "inOut" ? 0.45 : 0.3); const p1 = amp >= 1 ? amp : 1, per = per0 / (amp < 1 ? amp : 1), p3 = per / (2 * Math.PI) * (Math.asin(1 / p1) || 0), w = 2 * Math.PI / per; return io((t) => t === 1 ? 1 : p1 * Math.pow(2, -10 * t) * Math.sin((t - p3) * w) + 1); }
    if (k === "bounce") { const n1 = 7.5625, d1 = 2.75; return io((t) => t < 1 / d1 ? n1 * t * t : t < 2 / d1 ? n1 * (t -= 1.5 / d1) * t + 0.75 : t < 2.5 / d1 ? n1 * (t -= 2.25 / d1) * t + 0.9375 : n1 * (t -= 2.625 / d1) * t + 0.984375); }
    return null;
  };
  /* sample the ease densely, then keep only the points needed to stay within 0.001 of the real curve */
  const fnToCss = (f) => {
    if (!f) return null;
    const N = 600, P = []; for (let i = 0; i <= N; i++) P.push([i / N, f(i / N)]);
    if (P.every(([x, y]) => Math.abs(y - x) < 1e-4)) return "linear";
    const keep = new Set([0, N]);
    const rdp = (i, j) => { let w = -1, d = 0; for (let k = i + 1; k < j; k++) { const t = (P[k][0] - P[i][0]) / (P[j][0] - P[i][0]), e = Math.abs(P[k][1] - (P[i][1] + t * (P[j][1] - P[i][1]))); if (e > d) { d = e; w = k; } } if (d > 0.001) { keep.add(w); rdp(i, w); rdp(w, j); } };
    rdp(0, N);
    const idx = [...keep].sort((x, y) => x - y);
    return "linear(" + idx.map((k, n) => { const y = +P[k][1].toFixed(4); return n === 0 || n === idx.length - 1 ? String(y) : `${y} ${+(P[k][0] * 100).toFixed(2)}%`; }).join(", ") + ")";
  };
  const gsapEaseCss = (e) => { const s0 = String(e == null ? "power1.out" : e); const st = /^steps\((\d+)\)$/.exec(s0); if (st) return `steps(${st[1]})`; return fnToCss(gsapEaseFn(e)) || gsapEase(e); };
  const gsapEaseCssRev = (e) => { const f = gsapEaseFn(e); return f ? fnToCss((t) => 1 - f(1 - t)) : gsapEase(e); };

  /* the element's own values with GSAP's inline styles left out: that is where a GSAP tween starts or ends */
  const naturalStyle = (el, props) => {
    const c = el.cloneNode(false); c.removeAttribute("style"); c.removeAttribute("data-dsx-probe"); c.removeAttribute("data-dsx");
    c.style.cssText = "position:absolute!important;visibility:hidden!important;pointer-events:none!important;animation:none!important;transition:none!important";
    el.parentNode.insertBefore(c, el); const cs = getComputedStyle(c), o = {}; props.forEach((k) => { o[k] = cs.getPropertyValue(k); }); c.remove(); return o;
  };
  const TKEYS = ["x", "y", "xPercent", "yPercent", "rotation", "rotate", "scale", "scaleX", "scaleY"];
  /* GSAP keeps transforms as separate parts (x, y, rotation, scale) and composes them in this order */
  const decompose = (tf) => {
    const st = { x: 0, y: 0, xp: 0, yp: 0, r: 0, sx: 1, sy: 1 };
    const mm = /matrix\(([^)]+)\)/.exec(tf || ""); if (!mm) return st;
    const [a, b, c, d, e, f] = mm[1].split(",").map(parseFloat);
    st.x = e; st.y = f; st.sx = Math.hypot(a, b); st.r = Math.atan2(b, a) * 180 / Math.PI; st.sy = st.sx ? (a * d - b * c) / st.sx : 1; return st;
  };
  const applyT = (st, v) => {
    const o = Object.assign({}, st), n = (x) => (typeof x === "number" ? x : parseFloat(x));
    if (v.x != null) o.x = n(v.x); if (v.y != null) o.y = n(v.y); if (v.xPercent != null) o.xp = n(v.xPercent); if (v.yPercent != null) o.yp = n(v.yPercent);
    if (v.rotation != null) o.r = n(v.rotation); if (v.rotate != null) o.r = n(v.rotate);
    if (v.scale != null) { o.sx = n(v.scale); o.sy = n(v.scale); } if (v.scaleX != null) o.sx = n(v.scaleX); if (v.scaleY != null) o.sy = n(v.scaleY);
    return o;
  };
  const r4 = (x) => +(+x).toFixed(4);
  const tStr = (o, pct) => `translate(${r4(o.x)}px, ${r4(o.y)}px)${pct ? ` translate(${r4(o.xp)}%, ${r4(o.yp)}%)` : ""} rotate(${r4(o.r)}deg) scale(${r4(o.sx)}, ${r4(o.sy)})`;

  /* frames sampled from the live GSAP timeline -> the fewest keyframes that still match every frame */
  const sampledGsap = (probe) => {
    const S = probe && probe.sample; if (!S || !S.frames || S.frames.length < 3) return null;
    const F = S.frames, keys = Object.keys(F[0].v).filter((k) => F.some((f) => f.v[k] !== F[0].v[k]));
    if (!keys.length) return null;
    const nums = (x) => (String(x).match(/-?[\d.]+(?:e-?\d+)?/g) || []).map(Number);
    const tol = (k) => k === "transform" ? 0.15 : k === "opacity" ? 0.004 : /color/.test(k) ? 1.2 : 0.3;
    const ok = (i, j) => { /* does a straight line from frame i to j stay close to every frame in between? */
      for (let m = i + 1; m < j; m++) {
        const u = (F[m].t - F[i].t) / (F[j].t - F[i].t);
        for (const k of keys) {
          if (k === "visibility") { if (F[m].v[k] !== F[i].v[k]) return false; continue; }
          const a = nums(F[i].v[k]), b = nums(F[j].v[k]), c = nums(F[m].v[k]);
          if (a.length !== b.length || a.length !== c.length) { if (F[m].v[k] !== F[i].v[k] && F[m].v[k] !== F[j].v[k]) return false; continue; }
          for (let q = 0; q < a.length; q++) { const e = Math.abs(a[q] + (b[q] - a[q]) * u - c[q]); if (e > (k === "transform" && q < 4 ? 0.002 : tol(k))) return false; }
        }
      }
      return true;
    };
    const keep = [0]; let i = 0;
    while (i < F.length - 1) { let j = i + 2; while (j < F.length && ok(i, j)) j++; i = j - 1; keep.push(i); }
    const dur = S.dur;
    /* matrices with scale 0 cannot be interpolated by CSS (it jumps), so write each frame as translate/rotate/scale parts */
    let lastR = 0;
    const tParts = (tf) => { if (!tf || tf === "none") return "translate(0px, 0px) rotate(0deg) scale(1, 1)"; const mm = /matrix\(([^)]+)\)/.exec(tf); if (!mm) return tf; const [a, b, c, d, e, f] = mm[1].split(",").map(parseFloat); const sx = Math.hypot(a, b); const r = sx > 1e-6 ? Math.atan2(b, a) * 180 / Math.PI : lastR; lastR = r; const sy = sx > 1e-6 ? (a * d - b * c) / sx : Math.hypot(c, d); return `translate(${r4(e)}px, ${r4(f)}px) rotate(${r4(r)}deg) scale(${r4(sx)}, ${r4(sy)})`; };
    const kfs = keep.map((n) => { const props = {}; keys.forEach((k) => { props[k === "border-top-left-radius" ? "border-radius" : k] = k === "transform" ? tParts(F[n].v[k]) : F[n].v[k]; }); return { offset: +(F[n].t / dur).toFixed(5), props }; });
    const rep0 = S.repeat;
    return { kind: "gsap-timeline", label: `GSAP timeline, read frame by frame (${kfs.length} keyframes, exact)`, kfs, timing: { duration: Math.round(dur), delay: Math.round(S.delay || 0), easing: "linear", iterations: rep0 === -1 ? "infinite" : rep0 === 0 ? 1 : S.yoyo ? (rep0 + 1) / 2 : rep0 + 1, direction: "normal", fill: "both" }, trigger: S.st ? (S.st.scrub ? "scroll (scrubbed)" : "scroll into view") : "GSAP timeline", scroll: S.st || null, gsap: { v: {}, repeat: rep0 } };
  };
  /* the selector that matches exactly the elements a GSAP tween animates (marked by the probe) */
  const groupSel = (attr, el) => {
    let list = []; try { list = [...document.querySelectorAll("[" + attr + "]")]; } catch (e) {}
    if (!list.length) return el ? selName(el) : "";
    if (list.length === 1) return selName(list[0]);
    const same = (q) => { try { const m = document.querySelectorAll(q); return m.length === list.length && list.every((x) => [...m].includes(x)); } catch (e) { return false; } };
    for (const c of list[0].classList) if (list.every((x) => x.classList.contains(c)) && same("." + CSS.escape(c))) return "." + CSS.escape(c);
    const par = list[0].parentElement;
    if (par && list.every((x) => x.parentElement === par)) {
      const ps = selName(par), c = [...list[0].classList].find((k) => list.every((x) => x.classList.contains(k)));
      const q = noRuntime(ps + " > " + (c ? "." + CSS.escape(c) : list[0].tagName.toLowerCase())); if (same(q)) return q;
      const q2 = noRuntime(selName(par.classList.contains("pin-spacer") ? par.parentElement : par) + " " + (c ? "." + CSS.escape(c) : list[0].tagName.toLowerCase())); if (same(q2)) return q2;
    }
    const anc = list.reduce((a, x) => { while (a && !a.contains(x)) a = a.parentElement; return a; }, list[0].parentElement);
    const c2 = [...list[0].classList].find((k) => list.every((x) => x.classList.contains(k)));
    if (anc && c2) { const q = selName(anc) + " ." + CSS.escape(c2); if (same(q)) return q; }
    return list.map((x) => selName(x)).join(", ");
  };
  const gsapEffect = (probe, el) => {
    const list = (probe && probe.gsap) || []; if (!list.length) return null;
    const has = (g) => { const v = g.vars || {}; return Object.keys(gsapProps(v)).length || TKEYS.some((k) => v[k] != null); };
    const pick = list.find((g) => g.on === "this element" && has(g)) || list.find(has);
    if (!pick) return null;
    const v = pick.vars || {}, back = !!v.runBackwards, sa = v.startAt || null;
    const other = gsapProps(v); delete other.transform;
    const usesT = TKEYS.some((k) => v[k] != null || (sa && sa[k] != null)), pct = ["xPercent", "yPercent"].some((k) => v[k] != null || (sa && sa[k] != null));
    const natP = naturalStyle(el, [...Object.keys(other), "transform"]);
    const natT = decompose(natP.transform);
    const tween = {}, rest = {};
    Object.keys(other).forEach((k) => { tween[k] = other[k]; rest[k] = natP[k] || (k === "opacity" ? "1" : ""); });
    if (usesT) { tween.transform = tStr(applyT(natT, v), pct); rest.transform = tStr(natT, pct); }
    let A, Z;
    if (sa) { const sp = gsapProps(sa); delete sp.transform; A = Object.assign({}, rest, sp); if (usesT) A.transform = tStr(applyT(natT, sa), pct); Z = tween; }
    else if (back) { A = tween; Z = rest; } else { A = rest; Z = tween; }
    const dur = Math.max(1, Math.round((pick.duration != null ? pick.duration : v.duration != null ? v.duration : 0.5) * 1000));
    const rep = v.repeat != null ? +v.repeat : 0, rd = Math.max(0, Math.round((+v.repeatDelay || 0) * 1000)), yoyo = !!v.yoyo;
    const ez = gsapEaseCss(v.ease), ezR = gsapEaseCssRev(v.ease);
    const stg = typeof v.stagger === "number" ? v.stagger : v.stagger && typeof v.stagger.each === "number" ? v.stagger.each : 0;
    let kfs, timing;
    const iters = (n) => rep === -1 ? "infinite" : n;
    if (rd && rep !== 0) {
      /* GSAP waits repeatDelay between loops; CSS has no such setting, so the wait is written into the keyframes */
      if (yoyo) { const T = 2 * (dur + rd); kfs = [{ offset: 0, easing: ez, props: A }, { offset: dur / T, props: Z }, { offset: (dur + rd) / T, easing: ezR, props: Z }, { offset: (2 * dur + rd) / T, props: A }, { offset: 1, props: A }]; timing = { duration: T, iterations: iters((rep + 1) / 2) }; }
      else { const T = dur + rd; kfs = [{ offset: 0, easing: ez, props: A }, { offset: dur / T, props: Z }, { offset: 1, props: Z }]; timing = { duration: T, iterations: iters(rep + 1) }; }
      Object.assign(timing, { delay: Math.round((pick.delay || 0) * 1000), easing: "linear", direction: "normal", fill: "both" });
    } else {
      kfs = [{ offset: 0, props: A }, { offset: 1, props: Z }];
      timing = { duration: dur, delay: Math.round((pick.delay || 0) * 1000), easing: ez, iterations: iters(rep + 1), direction: yoyo ? "alternate" : "normal", fill: "both" };
    }
    return { kind: "gsap", label: "GSAP tween, converted exactly (values, easing curve, repeat and delay)", kfs, timing, segEase: !!(rd && rep !== 0), stagger: stg ? Math.round(stg * 1000) : 0, trigger: "GSAP tween on " + pick.on, gsap: { v, back, ease: v.ease, stagger: !!v.stagger, repeat: rep } };
  };
  const detectStyle = (m, eff, probe) => {
    if (eff && eff.kind === "group") {
      const it = eff.items, visOnly = it.filter((x) => x.kfs.some((k) => k.props.visibility) && !x.kfs.some((k) => k.props.transform || k.props.opacity)).length;
      const starts = it.map((x) => { const k = x.kfs.findIndex((f, i) => i > 0 && JSON.stringify(f.props) !== JSON.stringify(x.kfs[0].props)); return k > 0 ? x.kfs[k - 1].offset : 0; });
      const staggered = it.length > 2 && new Set(starts.map((v) => v.toFixed(3))).size > it.length / 2;
      /* what changes most across the elements: movement, scale, rotation, fade */
      const ch = { x: 0, y: 0, s: 0, r: 0, o: 0 }, mag = { x: 0, y: 0 };
      it.forEach((x) => { const tf = x.kfs.map((k) => k.props.transform || "").filter(Boolean), nums = tf.map((t) => (t.match(/-?[\d.]+/g) || []).map(Number));
        if (nums.length > 1) { const rng = (q) => Math.max(...nums.map((n) => n[q] || 0)) - Math.min(...nums.map((n) => n[q] || 0)); mag.x += rng(0); mag.y += rng(1); if (rng(0) > 1) ch.x++; if (rng(1) > 1) ch.y++; if (rng(2) > 1) ch.r++; if (rng(3) > 0.02) ch.s++; }
        if (x.kfs.some((k) => k.props.opacity != null && +k.props.opacity < 0.95)) ch.o++; });
      const most = (k) => ch[k] > it.length / 2;
      const textish = it.filter((x) => /^span|^div\.char|char|word|line/.test(x.cls)).length > it.length / 2;
      const unit = textish ? (it.length > 30 ? "letter" : it.length > 6 ? "word" : "line") : "item";
      let name = visOnly > it.length / 2 ? "Typewriter"
        : most("r") && most("s") ? (textish ? "Letter scramble" : "Scatter")
        : most("x") && mag.x > mag.y * 2 ? (most("s") ? `Sliding, scaling ${unit}s` : `Slide-in ${unit}s`)
        : most("y") && most("o") ? `Fade-up ${unit} reveal`
        : most("y") ? `Slide-up ${unit} reveal`
        : most("x") ? `Slide-in ${unit}s`
        : most("s") ? `Pop-in ${unit}s`
        : most("o") ? `Fade-in ${unit}s` : "Component animation";
      if (staggered && !/reveal|Typewriter|scramble/.test(name)) name = "Staggered " + name.charAt(0).toLowerCase() + name.slice(1);
      const desc = `${it.length} elements animate together${staggered ? ", one after another" : ""}. ${Math.round(it[0].totalMs)}ms${it[0].loop ? ", loops" : ""}${it.some((x) => x.scrub) ? ", follows the scrollbar" : ""}.`;
      return { name, desc };
    }
    const st = (probe && probe.st) || [], scrub = st.some((x) => x.scrub), trig = st.length ? (scrub ? "follows the scrollbar" : "plays when scrolled into view") : "";
    const len = (x) => { const mm = /(-?[\d.]+)/.exec(x || ""); return mm ? parseFloat(mm[1]) : 0; };
    const dur = (t) => Math.round(t.duration) + "ms";
    if (eff && eff.kfs && eff.kfs.length > 1) {
      const a = eff.kfs[0].props, t = eff.timing;
      /* compare with the frame furthest from the start: loops and yoyos end where they started */
      const dist = (p) => { let d = 0; for (const k of new Set([...Object.keys(a), ...Object.keys(p)])) { const x = (String(a[k] || "").match(/-?[\d.]+/g) || []).map(Number), y = (String(p[k] || "").match(/-?[\d.]+/g) || []).map(Number); for (let q = 0; q < Math.max(x.length, y.length); q++) d += Math.abs((x[q] || 0) - (y[q] || 0)); if (String(a[k]) !== String(p[k]) && !x.length) d += 1; } return d; };
      const z = eff.kfs.reduce((best, k) => dist(k.props) > dist(best.props) ? k : best, eff.kfs[eff.kfs.length - 1]).props;
      const pr = (p) => (p || {});
      const tfA = String(pr(a).transform || "none"), tfZ = String(pr(z).transform || "none");
      const grab = (tf, re) => { const mm = re.exec(tf); return mm ? parseFloat(mm[1]) : 0; };
      /* understands translateX/Y(), translate(x, y), translate(%), scale(), rotate() and matrix() */
      const parseT = (tf) => {
        const o = { x: 0, y: 0, s: 1, r: 0 }, mx = /matrix\(([^)]+)\)/.exec(tf);
        if (mx) { const [a1, b1, , , e1, f1] = mx[1].split(",").map(parseFloat); o.x = e1; o.y = f1; o.s = Math.hypot(a1, b1); o.r = Math.atan2(b1, a1) * 180 / Math.PI; return o; }
        const tp = /translate\((-?[\d.]+)px,\s*(-?[\d.]+)px\)/.exec(tf); if (tp) { o.x += +tp[1]; o.y += +tp[2]; }
        const pc = /translate\((-?[\d.]+)%,\s*(-?[\d.]+)%\)/.exec(tf); if (pc) { o.x += +pc[1] * (r0.w || 100) / 100; o.y += +pc[2] * (r0.h || 100) / 100; }
        o.x += grab(tf, /translateX\((-?[\d.]+)/); o.y += grab(tf, /translateY\((-?[\d.]+)/);
        const sc = /scale\((-?[\d.]+)/.exec(tf); if (sc) o.s = +sc[1];
        o.r = grab(tf, /rotate\((-?[\d.]+)/); return o;
      };
      const r0 = eff.box || {}, TA = parseT(tfA), TZ = parseT(tfZ);
      const ay = TA.y, zy = TZ.y, ax = TA.x, zx = TZ.x, as = TA.s, zs = TZ.s, ar = TA.r, zr = TZ.r;
      const oa = pr(a).opacity != null ? parseFloat(pr(a).opacity) : null, oz = pr(z).opacity != null ? parseFloat(pr(z).opacity) : null;
      const fadeIn = oa != null && oz != null && oz > oa, fadeOut = oa != null && oz != null && oz < oa, dy = zy - ay, dx = zx - ax;
      let name = "", what = [];
      if (t.iterations === "infinite" && Math.abs(dx) > 40 && !fadeIn && !fadeOut && (t.easing === "linear" || eff.kind === "gsap-timeline") && Math.abs(zr - ar) < 0.5 && Math.abs(zs - as) < 0.001) { name = "Marquee / ticker"; what.push("loops sideways at constant speed"); }
      else if (eff.kind === "hover" || (eff.anim && /transition/i.test(eff.anim.type || ""))) { name = Math.abs(dy) > 0 ? "Hover lift" : zs !== as ? "Hover scale" : "Hover transition"; what.push("moves up " + Math.abs(Math.round(dy)) + "px on hover/state change"); if (!dy) what[0] = "changes on hover/state change"; }
      else {
        if (fadeIn) what.push("fades in"); if (fadeOut) what.push("fades out");
        if (Math.abs(dy) >= 1) what.push((dy < 0 ? "moves up " : "moves down ") + Math.abs(Math.round(dy)) + "px"); if (Math.abs(dx) >= 1) what.push((dx < 0 ? "moves left " : "moves right ") + Math.abs(Math.round(dx)) + "px");
        if (zs !== as) what.push("scales " + as + " to " + zs); if (Math.abs(zr - ar) > 0.5) what.push("rotates " + Math.round(zr - ar) + "°");
        const colour = ["background-color", "color", "fill", "border-color"].some((k) => pr(a)[k] != null && pr(a)[k] !== pr(z)[k]), shape = pr(a)["border-radius"] != null && pr(a)["border-radius"] !== pr(z)["border-radius"];
        if (colour) what.push("changes colour"); if (shape) what.push("changes corner radius");
        const mv = Math.abs(dy) >= 1 && Math.abs(dx) < 1 ? (dy > 0 ? "up" : "down") : Math.abs(dx) >= 1 && Math.abs(dy) < 1 ? (dx > 0 ? "left" : "right") : "";
        if (scrub && !fadeIn && !fadeOut && Math.abs(dy) > 60 && zs === as) name = "Parallax";
        else if (fadeIn && Math.abs(dy) >= 1) name = "Fade " + (dy < 0 ? "up" : "down");
        else if (fadeIn && Math.abs(dx) >= 1) name = "Fade in from the " + (dx > 0 ? "left" : "right");
        else if (fadeIn && zs !== as) name = zs > as ? "Zoom in" : "Fade in + shrink";
        else if (fadeIn) name = "Fade in";
        else if (fadeOut) name = "Fade out";
        else if ([Math.abs(dx) >= 1 || Math.abs(dy) >= 1, Math.abs(zs - as) > 0.001, Math.abs(zr - ar) > 0.5].filter(Boolean).length >= 2) name = [Math.abs(dx) >= 1 || Math.abs(dy) >= 1 ? "Slide" : "", Math.abs(zr - ar) > 0.5 ? (Math.abs(zr - ar) >= 90 ? "spin" : "tilt") : "", Math.abs(zs - as) > 0.001 ? (zs > as ? "grow" : "shrink") : ""].filter(Boolean).join(" + ").replace(/^./, (c) => c.toUpperCase());
        else if (Math.abs(dx) >= 1 && Math.abs(dy) < 1) name = "Slide " + (dx < 0 ? "in from the right" : "in from the left");
        else if (Math.abs(dy) >= 1) name = "Slide " + (dy < 0 ? "up" : "down");
        else if (zs !== as) name = zs > as ? "Scale up" : "Scale down";
        else if (Math.abs(zr - ar) > 0.5) name = Math.abs(zr - ar) >= 90 ? "Spin" : "Tilt";
        else if (colour && shape) name = "Colour and shape morph";
        else if (colour) name = "Colour shift";
        else if (shape) name = "Shape morph";
        else name = "Property change";
        if (eff.gsap && eff.gsap.stagger) name = "Staggered " + name.charAt(0).toLowerCase() + name.slice(1);
        if (scrub && name !== "Parallax") name = "Scroll-scrubbed " + name.charAt(0).toLowerCase() + name.slice(1);
      }
      const desc = (what.length ? what.join(" and ") : "changes") + ". " + (eff.gsap && eff.gsap.v && eff.gsap.v.duration != null ? Math.round(eff.gsap.v.duration * 1000) + "ms" : dur(t)) + (eff.gsap && eff.gsap.ease ? ", " + String(eff.gsap.ease) : eff.dispEase && eff.dispEase !== "linear" ? ", " + eff.dispEase : /^linear\(/.test(t.easing || "") ? ", custom easing" : t.easing && t.easing !== "linear" ? ", " + t.easing : ", linear") + (eff.gsap && eff.gsap.v && eff.gsap.v.repeatDelay ? ", " + Math.round(eff.gsap.v.repeatDelay * 1000) + "ms pause between loops" : "") + (t.delay ? ", " + Math.round(t.delay) + "ms delay" : "") + (trig ? ". " + trig.charAt(0).toUpperCase() + trig.slice(1) + "." : eff.kind === "hover" ? "." : ". " + (eff.trigger ? eff.trigger.charAt(0).toUpperCase() + eff.trigger.slice(1) : "") + ".");
      return { name, desc: desc.replace(/\.\./g, ".") };
    }
    if (m.trans.length) { const x = m.trans[0]; return { name: "CSS transition", desc: `Animates ${m.trans.map((q) => q.prop).slice(0, 3).join(", ")} over ${x.duration}ms (${x.easing}) when its state changes (hover, focus, class change). No from/to values found yet, so no preview.` }; }
    if (st.length) return { name: scrub ? "Scroll-scrubbed motion" : "Scroll-triggered motion", desc: "A ScrollTrigger drives something on or around this element, but no readable from/to values were found. Watch for 8 s and scroll to capture them." };
    return null;
  };
  const groupEffect = (probe) => {
    const G = probe && probe.group, items = (G && G.items) || [];
    if (!items.length || (items.length === 1 && items[0].path === ":scope")) return null;
    const first = items.find((i) => i.path === ":scope") || items[0];
    const kids = items.filter((i) => i.path !== ":scope").length;
    return { kind: "group", label: `Component motion: ${items.length} animated element${items.length === 1 ? "" : "s"}, read frame by frame (exact)`, items, kids,
      kfs: first.kfs, timing: { duration: first.totalMs, delay: first.delayMs || 0, easing: "linear", iterations: first.loop ? "infinite" : 1, direction: "normal", fill: "both" },
      scroll: first.scrub ? (first.st || { scrub: true }) : null, trigger: first.scrub ? "scroll (scrubbed)" : "component" };
  };
  const primaryEffect = (m, el, probe) => {
    const ge0 = groupEffect(probe); if (ge0) return ge0;
    if (m.samples && m.samples.kfs.length > 1 && !m.anims.some((a) => a.kfs.length > 1 && !a.idle)) return { kind: "sampled", label: "Sampled while you watched (approximate)", kfs: m.samples.kfs, timing: m.samples.timing, trigger: m.samples.trigger };
    const a = m.anims.find((x) => x.kfs.length > 1 && x.type !== "CSS transition") || m.anims.find((x) => x.kfs.length > 1);
    const hoverEff = () => {
      const cs = getComputedStyle(el), decl = Object.assign({}, ...m.hover.map((h) => h.decls));
      const base = {}; Object.keys(decl).forEach((k) => { base[k] = cs.getPropertyValue(k); });
      const t = m.trans[0];
      return { kind: "hover", label: "Hover transition", kfs: [{ offset: 0, props: base }, { offset: 1, props: decl }], timing: { duration: t.duration, delay: t.delay, easing: t.easing, iterations: "infinite", direction: "alternate", fill: "both" }, trigger: "hover" };
    };
    if (a && !(a.type === "CSS transition" && m.hover.length && m.trans.length)) {
      const kfEasings = [...new Set(a.kfs.map((k) => k.easing || "linear"))];
      const dispEase = a.timing.easing !== "linear" ? a.timing.easing : (kfEasings.length === 1 ? kfEasings[0] : "mixed easing");
      return { kind: "anim", label: a.type + ": " + a.name, kfs: a.kfs, timing: a.timing, dispEase, anim: a, trigger: a.idle ? "set on the element (runs when it renders)" : "running now" };
    }
    if (m.hover.length && m.trans.length) return hoverEff();
    if (m.samples && m.samples.kfs.length > 1) return { kind: "sampled", label: "Sampled while you watched (approximate)", kfs: m.samples.kfs, timing: m.samples.timing, trigger: m.samples.trigger };
    const S = probe && probe.sample, own = ((probe && probe.gsap) || []).filter((g) => g.depth === 0);
    const complex = S && (S.tweens > 1 || S.siblings > 1 || own.some((g) => g.tl != null) || (S.st && S.st.scrub));
    if (complex) { const sg = sampledGsap(probe); if (sg) return sg; }
    const ge = gsapEffect(probe, el); if (ge) { if (own[0] && own[0].st) { ge.scroll = own[0].st; ge.trigger = own[0].st.scrub ? "scroll (scrubbed)" : "scroll into view"; } return ge; }
    const sg = sampledGsap(probe); if (sg) return sg;
    return null;
  };
  const kfToWaapi = (kfs) => kfs.map((k) => { const o = { offset: k.offset }; if (k.easing) o.easing = k.easing; for (const [pn, v] of Object.entries(k.props)) o[camelK(pn)] = v; return o; });
  const waapiTiming = (t) => ({ duration: t.duration, delay: t.delay, easing: t.easing, iterations: t.iterations === "infinite" ? "Infinity" : t.iterations, direction: t.direction, fill: t.fill === "none" ? "both" : t.fill });
  const jsonIter = (o) => JSON.stringify(o, null, 2).replace(/"Infinity"/g, "Infinity");
  /* shortest selector that matches only this element, so pasted code animates only what was picked */
  /* wrappers that GSAP and others add at runtime: they will not be in the user's own HTML */
  const RUNTIME_CLS = /^(dsx|is-|has-|pin-spacer|gsap-|split-|lenis|swiper-slide-(active|next|prev)|aos-)/;
  const noRuntime = (q) => q.replace(/\s*>\s*\.pin-spacer\s*>\s*/g, " ").replace(/\.pin-spacer\s*>\s*/g, ""); /* "a > .pin-spacer > b" -> "a b": matches with or without the wrapper */
  const selName = (el) => noRuntime(selName0(el));
  const selName0 = (el) => {
    const one = (q) => { try { return document.querySelectorAll(q).length === 1; } catch (e) { return false; } };
    if (el.id && one("#" + CSS.escape(el.id))) return "#" + CSS.escape(el.id);
    const cls = [...el.classList].filter((c) => !RUNTIME_CLS.test(c)).map((c) => "." + CSS.escape(c));
    for (const c of cls) if (one(c)) return c;
    for (let i = 0; i < cls.length; i++) for (let j = i + 1; j < cls.length; j++) if (one(cls[i] + cls[j])) return cls[i] + cls[j];
    const parts = []; let n = el;
    while (n && n !== document.body && parts.length < 5) {
      if (n.classList.contains("pin-spacer")) { n = n.parentElement; continue; }
      const c = [...n.classList].filter((x) => !RUNTIME_CLS.test(x)).slice(0, 2).map((x) => "." + CSS.escape(x)).join("");
      const sib = n.parentElement ? [...n.parentElement.children].filter((x) => x.tagName === n.tagName) : [];
      parts.unshift((c || n.tagName.toLowerCase()) + (sib.length > 1 ? `:nth-of-type(${sib.indexOf(n) + 1})` : ""));
      const q = parts.join(" > "); if (one(q)) return q; n = n.parentElement;
    }
    return cls.join("") || el.tagName.toLowerCase();
  };
  /* ScrollTrigger start/end ("top bottom", "center 80%") -> CSS view-timeline "cover" percentages */
  const stRange = (st, el) => {
    const vh = innerHeight, eh = Math.max(1, (el.offsetHeight || el.getBoundingClientRect().height)), span = vh + eh;
    const pos = (w, size) => { w = String(w || "").trim(); if (w === "top" || w === "left") return 0; if (w === "center") return 0.5 * size; if (w === "bottom" || w === "right") return size; const pc = /^(-?[\d.]+)%$/.exec(w); if (pc) return +pc[1] / 100 * size; const px = /^(-?[\d.]+)(px)?$/.exec(w); if (px) return +px[1]; return null; };
    const one = (txt, dflt) => { const [a, b] = String(txt || dflt).split(/\s+/); const ea = pos(a, eh), vb = pos(b == null ? "bottom" : b, vh); if (ea == null || vb == null) return null; return +((((vh - vb) + ea) / span) * 100).toFixed(2); };
    const s0 = one(st.start, "top bottom"), e0 = one(st.end, "bottom top");
    return s0 == null || e0 == null ? { css: "cover 0% cover 100%", a: "cover 0%", b: "cover 100%", approx: true } : { css: `cover ${s0}% cover ${e0}%`, a: `cover ${s0}%`, b: `cover ${e0}%` };
  };
  const genCode = (m, eff, el, lib, probe) => {
    const sel = selName(el), out = { css: "", js: "", react: "", prompt: "" };
    if (eff && eff.kind === "group") {
      const trigEl = probe && probe.trigEl && probe.trigEl !== el && probe.trigEl.isConnected ? probe.trigEl : null, trigSel = trigEl ? probe.trigSel : "";
      const tlName = "--component-scroll";
      const kfText = (k) => `{ ${Object.entries(k.props).map(([pn, v]) => `${pn}: ${v};`).join(" ")} }`;
      const css = [], jsItems = [];
      let usesScrub = false, rg = null;
      eff.items.forEach((it, i) => {
        const childSel = it.path === ":scope" ? sel : sel + it.path.replace(/^:scope/, "");
        const nm = "motion-" + (i + 1);
        css.push(`@keyframes ${nm} {\n${it.kfs.map((k) => `  ${Math.round(k.offset * 100000) / 1000}% ${kfText(k)}`).join("\n")}\n}`);
        if (it.scrub) { usesScrub = true; rg = rg || stRange(it.st || {}, trigEl || el); css.push(`${childSel} {\n  animation: ${nm} linear both;\n  animation-timeline: ${trigSel ? tlName : "view()"};\n  animation-range: ${rg.css};\n}`); }
        else css.push(`${childSel} {\n  animation: ${nm} ${it.totalMs}ms linear ${it.delayMs || 0}ms ${it.loop ? "infinite" : 1} both;\n}`);
        jsItems.push({ path: it.path, keyframes: kfToWaapi(it.kfs), timing: it.scrub ? { duration: "auto", fill: "both" } : { duration: it.totalMs, delay: it.delayMs || 0, iterations: it.loop ? "Infinity" : 1, easing: "linear", fill: "both" }, scrub: !!it.scrub });
      });
      out.css = `/* ${eff.items.length} animated elements, each with its exact keyframes (read frame by frame from the page) */\n` + (usesScrub && trigSel ? `:root { timeline-scope: ${tlName}; }\n${trigSel} { view-timeline-name: ${tlName}; } /* the ScrollTrigger trigger */\n\n` : "") + css.join("\n\n");
      const itemsJs = JSON.stringify(jsItems, null, 2).replace(/"Infinity"/g, "Infinity");
      const run = (rootExpr) => `const root = ${rootExpr};\nITEMS.forEach(({ path, keyframes, timing, scrub }) => {\n  const el = path === ":scope" ? root : root.querySelector(path);\n  if (!el) return;\n  el.animate(keyframes, scrub ? { ...timing, timeline: new ViewTimeline({ subject: ${trigSel ? `document.querySelector("${trigSel}")` : "root"} }), rangeStart: "${rg ? rg.a : "cover 0%"}", rangeEnd: "${rg ? rg.b : "cover 100%"}" } : timing);\n});`;
      out.js = `// Animates "${sel}" and its ${eff.kids} animated children. No library needed.\nconst ITEMS = ${itemsJs};\n\n` + run(`document.querySelector("${sel}")`);
      out.react = `"use client";\nimport { useEffect, useRef } from "react";\n\n// Wrap the component markup (the element "${sel}" and its children) in <Motion>.\nconst ITEMS = ${itemsJs};\n\nexport default function Motion({ children }) {\n  const ref = useRef(null);\n  useEffect(() => {\n    if (!ref.current || !ref.current.firstElementChild) return;\n    const anims = [];\n    const root = ref.current.firstElementChild;\n    ITEMS.forEach(({ path, keyframes, timing, scrub }) => {\n      const el = path === ":scope" ? root : root.querySelector(path);\n      if (el) anims.push(el.animate(keyframes, scrub ? { ...timing, timeline: new ViewTimeline({ subject: root }), rangeStart: "${rg ? rg.a : "cover 0%"}", rangeEnd: "${rg ? rg.b : "cover 100%"}" } : timing));\n    });\n    return () => anims.forEach((a) => a.cancel());\n  }, []);\n  return <div ref={ref} style={{ display: "contents" }}>{children}</div>;\n}`;
    } else if (eff) {
      const t = eff.timing, nm = eff.anim ? eff.anim.name : "dsx-effect";
      const kfCss = eff.anim && eff.anim.ruleText ? eff.anim.ruleText : `@keyframes ${nm} {\n` + eff.kfs.map((k) => `  ${Math.round(k.offset * 100000) / 1000}% { ${Object.entries(k.props).map(([pn, v]) => `${pn}: ${v};`).join(" ")}${k.easing ? ` animation-timing-function: ${k.easing};` : ""} }`).join("\n") + "\n}";
      const stg = eff.stagger || 0, many = stg && document.querySelectorAll(sel).length > 1;
      const sc = eff.scroll || null, scrub = !!(sc && sc.scrub != null && sc.scrub !== false), onEnter = !!(sc && !scrub);
      const trigEl = probe && probe.trigEl && probe.trigEl !== el && probe.trigEl.isConnected ? probe.trigEl : null, trigSel = trigEl ? probe.trigSel : "";
      const rg = sc ? stRange(sc, trigEl || el) : null, tlName = "--" + (nm.replace(/[^\w-]/g, "") || "dsx") + "-scroll";
      const grp = ((probe && probe.gsap) || []).find((g) => g.depth === 0 && g.count > 1);
      if (eff.kind === "hover") {
        out.css = `${sel} {\n  transition: ${m.trans.map((x) => `${x.prop} ${x.duration}ms ${x.easing}${x.delay ? " " + x.delay + "ms" : ""}`).join(", ")};\n}\n` + m.hover.map((h) => `${h.sel} {\n${Object.entries(h.decls).map(([pn, v]) => `  ${pn}: ${v};`).join("\n")}\n}`).join("\n");
      } else {
        if (scrub) out.css = `${kfCss}\n\n/* Scrubbed: follows the scrollbar, like the original ScrollTrigger (scrub). Native CSS, Chrome 115+ */\n` + (trigSel ? `:root { timeline-scope: ${tlName}; }\n${trigSel} { view-timeline-name: ${tlName}; } /* the ScrollTrigger trigger */\n` : "") + `${sel} {\n  animation: ${nm} ${eff.segEase ? "linear" : t.easing} both;\n  animation-timeline: ${trigSel ? tlName : "view()"};\n  animation-range: ${rg.css};\n}` + (grp ? `\n/* This is one of ${grp.count} staggered elements. The GSAP tab animates the whole group. */` : "") + (rg.approx ? "\n/* start/end used pixel offsets, so the range is approximate */" : "");
        else out.css = `${kfCss}\n\n${onEnter ? sel + ".is-in" : sel} {\n  animation: ${nm} ${t.duration}ms ${eff.segEase ? "linear" : (t.easing === "linear" && eff.kind !== "sampled" && eff.kfs && eff.kfs[0] && eff.kfs[0].easing) || t.easing} ${many ? `calc(${t.delay}ms + var(--i, 0) * ${stg}ms)` : t.delay + "ms"} ${t.iterations} ${t.direction} ${t.fill === "none" ? "both" : t.fill};\n}` + (many ? `\n/* staggered by ${stg}ms: give each element its index, e.g. style="--i: 0", "--i: 1", ... */` : "") + (onEnter ? `\n${sel} { opacity: ${(eff.kfs[0].props.opacity != null ? eff.kfs[0].props.opacity : 1)}; } /* state before it plays */\n\n/* Plays when scrolled into view, like the original. Add this script once: */\n/*\nnew IntersectionObserver((es, io) => es.forEach((e) => { if (e.isIntersecting) { e.target.classList.add("is-in"); io.unobserve(e.target); } }), { threshold: 0.15 })\n  .observe(document.querySelector("${sel}"));\n*/` : "") + (eff.kind === "sampled" ? "\n/* keyframes were sampled from the running page, so easing is linear and values are approximate */" : "");
      }
      const kfJs = jsonIter(kfToWaapi(eff.kfs)), tmJs = jsonIter(waapiTiming(t));
      out.js = eff.kind === "hover" ? `// hover: use the CSS above. Equivalent with the Web Animations API:\nconst el = document.querySelector("${sel}");\nel.addEventListener("mouseenter", () => el.animate(${kfJs}, { ...${tmJs}, iterations: 1, fill: "forwards" }));\nel.addEventListener("mouseleave", () => el.animate(${kfJs}, { ...${tmJs}, iterations: 1, direction: "reverse", fill: "forwards" }));`
        : scrub ? `// Scrubbed by scroll, like the original ScrollTrigger. Chrome 115+\nconst el = document.querySelector("${sel}");\nel.animate(${kfJs}, {\n  ...${tmJs.replace(/\n/g, "\n  ")},\n  duration: "auto",\n  timeline: new ViewTimeline({ subject: ${trigSel ? `document.querySelector("${trigSel}")` : "el"} }),\n  rangeStart: "${rg.a}",\n  rangeEnd: "${rg.b}"\n});`
        : onEnter ? `// Plays when the element scrolls into view, like the original\nconst el = document.querySelector("${sel}");\nconst io = new IntersectionObserver(([e]) => {\n  if (!e.isIntersecting) return;\n  el.animate(${kfJs.replace(/\n/g, "\n  ")}, ${tmJs.replace(/\n/g, "\n  ")});\n  io.disconnect();\n}, { threshold: 0.15 });\nio.observe(el);`
        : many ? `const KEYFRAMES = ${kfJs};\nconst TIMING = ${tmJs};\ndocument.querySelectorAll("${sel}").forEach((el, i) => {\n  el.animate(KEYFRAMES, { ...TIMING, delay: TIMING.delay + i * ${stg} });\n});`
        : `const el = document.querySelector("${sel}");\nel.animate(${kfJs}, ${tmJs});`;
      const scrollish = eff.trigger && /scroll/.test(eff.trigger);
      out.react = `"use client";\nimport { useEffect, useRef } from "react";\n\nconst KEYFRAMES = ${kfJs};\nconst TIMING = ${tmJs};\n\nexport default function Effect({ children }) {\n  const ref = useRef(null);\n  useEffect(() => {\n    const el = ref.current;\n    if (!el) return;\n` + (scrub ? `    const a = el.animate(KEYFRAMES, { ...TIMING, duration: "auto", timeline: new ViewTimeline({ subject: el }), rangeStart: "${rg.a}", rangeEnd: "${rg.b}" });\n    return () => a.cancel();\n` : scrollish ? `    const io = new IntersectionObserver(([e]) => { if (e.isIntersecting) { el.animate(KEYFRAMES, TIMING); io.disconnect(); } }, { threshold: 0.2 });\n    io.observe(el);\n    return () => io.disconnect();\n` : eff.kind === "hover" ? `    const on = () => el.animate(KEYFRAMES, { ...TIMING, iterations: 1, fill: "forwards" });\n    const off = () => el.animate(KEYFRAMES, { ...TIMING, iterations: 1, direction: "reverse", fill: "forwards" });\n    el.addEventListener("mouseenter", on); el.addEventListener("mouseleave", off);\n    return () => { el.removeEventListener("mouseenter", on); el.removeEventListener("mouseleave", off); };\n` : `    const a = el.animate(KEYFRAMES, TIMING);\n    return () => a.cancel();\n`) + `  }, []);\n  return <div ref={ref}>{children}</div>;\n}`;
    }
    if (probe) {
      const parts = [];
      if (probe.gsap && probe.gsap.length) {
        const INTERNAL = ["runBackwards", "immediateRender", "startAt", "overwrite", "lazy", "callbackScope", "data", "id", "parent", "inherit", "keyframes", "scrollTrigger", "paused"];
        const clean = (g) => {
          const v = Object.assign({}, g.vars), from = !!v.runBackwards, sa = v.startAt;
          INTERNAL.forEach((k) => { if (!(k === "overwrite" && v[k] === true)) delete v[k]; });
          v.duration = +(+g.duration).toFixed(3); if (g.delay && g.tl == null) v.delay = +(+g.delay).toFixed(3); else delete v.delay;
          if (v.repeat === 0) delete v.repeat; if (v.repeatDelay === 0) delete v.repeatDelay; if (v.yoyo === false) delete v.yoyo;
          Object.keys(v).forEach((k) => { if (v[k] && typeof v[k] === "object" && k !== "stagger") delete v[k]; });
          return { v, from, sa };
        };
        const js = (o, ind) => JSON.stringify(o, null, 2).replace(/"([A-Za-z_$][\w$]*)":/g, "$1:").replace(/\n/g, "\n" + ind);
        const stObj = (st, trig) => { if (!st) return null; const o = { trigger: trig || sel }; if (st.start) o.start = st.start; if (st.end) o.end = st.end; if (st.scrub != null && st.scrub !== false) o.scrub = st.scrub; if (st.toggleActions) o.toggleActions = st.toggleActions.split(" ").length === 4 ? st.toggleActions : (st.toggleActions + " none none none").split(" ").slice(0, 4).join(" "); if (st.pin) o.pin = true; if (st.once) o.once = true; return o; };
        const call = (method, target, c, posArg, ind) => c.sa && !c.from ? `${method}("${target}", ${js(c.sa, ind)}, ${js(c.v, ind)}${posArg})` : `${method === "gsap" ? "gsap" : method}${method === "gsap" ? "." : "."}${c.from ? "from" : "to"}("${target}", ${js(c.v, ind)}${posArg})`.replace(/^gsap\.\./, "gsap.");
        const lines = [], usesST = probe.gsap.some((g) => g.st) || (probe.timelines || []).some((t) => t.st);
        lines.push(`// GSAP${usesST ? " + ScrollTrigger" : ""}, rebuilt from the page. Install: npm i gsap`);
        lines.push(`import gsap from "gsap";` + (usesST ? `\nimport { ScrollTrigger } from "gsap/ScrollTrigger";\ngsap.registerPlugin(ScrollTrigger);` : ""));
        const groups = new Map();
        probe.gsap.forEach((g) => { const k = g.tl == null ? "solo" + Math.random() : "tl" + g.tl; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(g); });
        for (const [k, gs] of groups) {
          const T0 = k.startsWith("tl") ? ((probe.timelines || [])[gs[0].tl] || {}) : null;
          const bare = T0 && !T0.repeat && !T0.yoyo && !T0.repeatDelay && !T0.delay && !T0.st && gs.length === 1 && gs[0].pos === 0;
          if (k.startsWith("solo") || bare) {
            const g = gs[0], c = clean(g), st = stObj(g.st, probe.trigSel);
            if (st) c.v.scrollTrigger = st;
            const tgt = g.sel || sel;
            lines.push(c.sa && !c.from ? `gsap.fromTo("${tgt}", ${js(c.sa, "")}, ${js(c.v, "")});` : `gsap.${c.from ? "from" : "to"}("${tgt}", ${js(c.v, "")});`);
          } else {
            const T = (probe.timelines || [])[gs[0].tl] || {}, tv = {};
            if (T.repeat) tv.repeat = T.repeat; if (T.yoyo) tv.yoyo = true; if (T.repeatDelay) tv.repeatDelay = T.repeatDelay; if (T.delay) tv.delay = T.delay;
            const st = stObj(T.st, probe.trigSel); if (st) tv.scrollTrigger = st;
            lines.push(`const tl = gsap.timeline(${Object.keys(tv).length ? js(tv, "") : ""});`);
            gs.sort((x, y) => x.pos - y.pos).forEach((g) => { const c = clean(g), tgt = g.sel || sel; lines.push(c.sa && !c.from ? `tl.fromTo("${tgt}", ${js(c.sa, "")}, ${js(c.v, "")}, ${g.pos});` : `tl.${c.from ? "from" : "to"}("${tgt}", ${js(c.v, "")}, ${g.pos});`); });
            if (T.children > gs.length) lines.push(`// The original timeline has ${T.children} tweens; only the ${gs.length} that move this element or its parents are shown.`);
          }
        }
        parts.push(lines.join("\n"));
      }
      if (probe.framer) parts.push(`// Framer Motion props read from the React element\n<motion.div\n  initial={${jsonIter(probe.framer.initial)}}\n  animate={${jsonIter(probe.framer.animate)}}${probe.framer.whileInView ? `\n  whileInView={${jsonIter(probe.framer.whileInView)}}` : ""}${probe.framer.whileHover ? `\n  whileHover={${jsonIter(probe.framer.whileHover)}}` : ""}\n  transition={${jsonIter(probe.framer.transition)}}\n/>`);
      const aos = [...el.attributes].filter((a) => a.name.startsWith("data-aos"));
      if (aos.length) parts.push(`// AOS (npm i aos; import "aos/dist/aos.css"; AOS.init())\n<div ${aos.map((a) => `${a.name}="${a.value}"`).join(" ")}>…</div>`);
      if (parts.length) out.lib = parts.join("\n\n");
    }
    const libs = lib.length ? lib.map((l) => l.name + (l.version ? " " + l.version : "")).join(", ") : "none detected";
    const r = el.getBoundingClientRect();
    out.prompt = [
      "Recreate this web effect in a React / Next.js project.",
      `Page: ${location.href}`,
      `Element: ${selectorOf(el)} (${el.tagName.toLowerCase()}, ${Math.round(r.width)} x ${Math.round(r.height)} px)${el.textContent.trim() ? `, text: "${el.textContent.trim().slice(0, 60)}"` : ""}`,
      `Animation libraries on the page: ${libs}`,
      eff ? `Effect: ${eff.label}. Trigger: ${eff.trigger || "unknown"}. Timing: ${eff.timing.duration}ms, delay ${eff.timing.delay}ms, easing ${eff.timing.easing}, repeat ${eff.timing.iterations}, direction ${eff.timing.direction}.` : "Effect: none found on this element yet.",
      eff ? "Keyframes (exact values read from the page):\n" + eff.kfs.map((k) => `  ${Math.round(k.offset * 1000) / 10}%: ${Object.entries(k.props).map(([pn, v]) => `${pn}: ${v}`).join("; ")}`).join("\n") : "",
      out.lib ? "Library code found:\n" + out.lib : "",
      eff && eff.kind === "sampled" ? "Note: keyframes were sampled from the live page, so easing is approximate (linear)." : "",
      "Limits: values were read from the live page. Original JS source and logic are not available.",
      "Reference image: see the attached file blue-dot-effect-ref.png (saved from the same element)."
    ].filter(Boolean).join("\n");
    return out;
  };
  const inlineClone = (src, budget) => {
    const c = src.cloneNode(false);
    if (src.nodeType === 1) {
      const cs = getComputedStyle(src); c.removeAttribute("id"); c.removeAttribute("class"); c.removeAttribute("data-dsx-probe");
      let t = ""; for (const pn of cs) { if (/^(animation|transition)/.test(pn)) continue; t += pn + ":" + cs.getPropertyValue(pn) + ";"; }
      c.style.cssText = t + "animation:none;transition:none;";
      budget.n++;
      for (const ch of src.childNodes) { if (budget.n > 140) break; if (ch.nodeType === 1 && /^(SCRIPT|STYLE|NOSCRIPT|IFRAME)$/.test(ch.tagName)) continue; c.appendChild(inlineClone(ch, budget)); }
    }
    return c;
  };
  let preview = null;
  const mountPreview = (stage, el, eff) => {
    if (preview) { preview.destroy(); preview = null; }
    stage.innerHTML = "";
    const r = el.getBoundingClientRect();
    const w = Math.max(8, Math.min(r.width, 2400)), h = Math.max(8, Math.min(r.height, 1600));
    const sw = stage.clientWidth || 320, sh = stage.clientHeight || 170;
    const sc = Math.min(1, (sw - 28) / w, (sh - 28) / h);
    const wrap = document.createElement("div"); wrap.className = "mwrap"; wrap.style.cssText = `width:${w}px;height:${h}px;left:${(sw - w * sc) / 2}px;top:${(sh - h * sc) / 2}px;transform:scale(${sc})`;
    const clone = inlineClone(el, { n: 0 });
    clone.style.cssText += `;position:absolute;left:0;top:0;margin:0;width:${w}px;height:${h}px;box-sizing:border-box;`;
    wrap.appendChild(clone); stage.appendChild(wrap);
    let anim = null;
    if (eff && eff.kind === "group") {
      const anims = [];
      eff.items.forEach((it) => {
        let node = clone; if (it.path !== ":scope") { try { node = clone.querySelector(it.path); } catch (e) { node = null; } }
        if (!node) return;
        const T = Math.max(60, it.totalMs);
        anims.push(node.animate(kfToWaapi(it.kfs), { duration: T, delay: Math.min(it.delayMs || 0, 800), iterations: Infinity, easing: "linear", fill: "both", endDelay: it.loop ? 0 : 700 }));
      });
      preview = { destroy: () => { anims.forEach((a) => { try { a.cancel(); } catch (e) {} }); stage.innerHTML = ""; }, toggle: () => { const p = anims[0] && anims[0].playState === "paused"; anims.forEach((a) => p ? a.play() : a.pause()); return !!p; }, restart: () => anims.forEach((a) => { a.cancel(); a.play(); }) };
      return preview;
    }
    if (eff) {
      const t = eff.timing;
      anim = clone.animate(kfToWaapi(eff.kfs), { duration: Math.max(60, t.duration), delay: Math.min(t.delay, 800), easing: t.easing, iterations: Infinity, direction: eff.kind === "hover" ? "alternate" : t.direction, fill: "both", endDelay: 700 });
    }
    preview = { destroy: () => { try { anim && anim.cancel(); } catch (e) {} stage.innerHTML = ""; }, toggle: () => { if (!anim) return false; if (anim.playState === "paused") { anim.play(); return true; } anim.pause(); return false; }, restart: () => { if (anim) { anim.cancel(); anim.play(); } } };
    return preview;
  };
  const SAMPLE_PROPS = ["opacity", "transform", "translate", "scale", "rotate", "filter", "clip-path", "color", "background-color", "width", "height", "border-radius", "box-shadow", "letter-spacing"];
  const watchMotion = (el, secs, done0, tick) => {
    busy(true); const done = (...a) => { setTimeout(() => busy(false), 350); return done0(...a); };
    const cs = getComputedStyle(el), snap = () => SAMPLE_PROPS.map((pn) => cs.getPropertyValue(pn));
    const t0 = performance.now(); let last = snap(); const first = last.slice(); const samples = [{ t: 0, v: last }];
    let hovered = 0, visibleAt = 0; const seen = new Map(); let firstChange = null;
    const onEnter = () => { hovered = performance.now() - t0; };
    el.addEventListener("mouseenter", onEnter);
    const io = obsL(new IntersectionObserver(([e]) => { if (e.isIntersecting && !visibleAt) visibleAt = performance.now() - t0; }, { threshold: 0.15 })); io.observe(el);
    let raf = 0, lastT = 0;
    const loop = (now) => {
      const t = now - t0;
      if (now - lastT > 30) {
        lastT = now;
        for (const a of el.getAnimations()) if (!seen.has(a)) { try { seen.set(a, { name: a.animationName || a.transitionProperty || "effect", kfs: cleanKfs(a), timing: timingOf(a.effect.getTiming()) }); } catch (e) {} }
        const v = snap();
        if (v.join("|") !== last.join("|")) { if (firstChange == null) firstChange = t; samples.push({ t, v }); last = v; }
      }
      if (tick) tick(Math.max(0, secs - t / 1000));
      if (t < secs * 1000) raf = requestAnimationFrame(loop); else finish();
    };
    const finish = () => {
      el.removeEventListener("mouseenter", onEnter); io.disconnect();
      let result = null;
      if (samples.length > 1) {
        const tStart = samples[0].t === 0 && firstChange != null ? Math.max(0, firstChange - 30) : 0, tEnd = samples[samples.length - 1].t;
        const span = Math.max(60, tEnd - tStart);
        let pick = samples.filter((x, i) => i === 0 || x.t >= tStart);
        if (pick.length > 12) pick = pick.filter((x, i) => i === 0 || i === pick.length - 1 || i % Math.ceil(pick.length / 10) === 0);
        const changed = SAMPLE_PROPS.map((pn, i) => pick.some((x) => x.v[i] !== first[i]) ? i : -1).filter((i) => i >= 0);
        const kfs = pick.map((x) => { const props = {}; changed.forEach((i) => { props[SAMPLE_PROPS[i]] = x.v[i]; }); return { offset: Math.max(0, Math.min(1, (x.t - tStart) / span)), props }; });
        if (kfs.length) kfs[0].offset = 0;
        const trig = hovered && firstChange != null && Math.abs(firstChange - hovered) < 250 ? "hover" : visibleAt && firstChange != null && Math.abs(firstChange - visibleAt) < 400 ? "scroll into view" : "on load or by script";
        result = { kfs, timing: { duration: Math.round(span), delay: 0, easing: "linear", iterations: 1, direction: "normal", fill: "both" }, trigger: trig };
      }
      done(result, [...seen.values()]);
    };
    raf = requestAnimationFrame(loop);
    return () => { cancelAnimationFrame(raf); el.removeEventListener("mouseenter", onEnter); io.disconnect(); };
  };
  const elementShot = async (el) => {
    el.scrollIntoView({ block: "center", inline: "center" }); await wait(450);
    const prev = host.style.visibility; host.style.visibility = "hidden"; await wait(120);
    try {
      const res = await withBusy(() => new Promise((r) => chrome.runtime.sendMessage({ type: "dsx-capture" }, r)));
      if (!res || !res.ok) throw new Error((res && res.error) || "capture failed");
      const img = await loadImg(res.dataUrl), k = img.width / innerWidth, r = el.getBoundingClientRect();
      const sx = Math.max(0, r.left * k), sy = Math.max(0, r.top * k), sw2 = Math.min(img.width - sx, r.width * k), sh2 = Math.min(img.height - sy, r.height * k);
      const c = document.createElement("canvas"); c.width = Math.max(1, Math.round(sw2)); c.height = Math.max(1, Math.round(sh2));
      c.getContext("2d").drawImage(img, sx, sy, sw2, sh2, 0, 0, c.width, c.height);
      const blob = await new Promise((rr) => c.toBlob(rr, "image/png"));
      saveBlob(blob, "blue-dot-effect-ref.png");
      return true;
    } finally { host.style.visibility = prev; }
  };
  const armMotion = (on) => {
    if (on) { finishOpen = false; rp.classList.remove("show"); if (mode) openMode(null); motionArmed = true; setPicking(true); motionArmed = true; setActive(); say("Click an animated element. \u2191 picks the parent, Esc cancels."); }
    else { motionArmed = false; setPicking(false); }
  };
  let motionTab = "css", motionStop = null;
  const LIBINFO = {
    "gsap": { pkg: "gsap", npm: "https://www.npmjs.com/package/gsap", docs: "https://gsap.com/docs/v3/", cmd: "npm install gsap" },
    "gsap scrolltrigger": { pkg: "gsap", npm: "https://www.npmjs.com/package/gsap", docs: "https://gsap.com/docs/v3/Plugins/ScrollTrigger/", cmd: "npm install gsap", note: 'import { ScrollTrigger } from "gsap/ScrollTrigger"; gsap.registerPlugin(ScrollTrigger);' },
    "lenis": { pkg: "lenis", npm: "https://www.npmjs.com/package/lenis", docs: "https://lenis.darkroom.engineering/", cmd: "npm install lenis" },
    "aos": { pkg: "aos", npm: "https://www.npmjs.com/package/aos", docs: "https://michalsnik.github.io/aos/", cmd: "npm install aos" },
    "locomotive scroll": { pkg: "locomotive-scroll", npm: "https://www.npmjs.com/package/locomotive-scroll", docs: "https://github.com/locomotivemtl/locomotive-scroll", cmd: "npm install locomotive-scroll" },
    "anime.js": { pkg: "animejs", npm: "https://www.npmjs.com/package/animejs", docs: "https://animejs.com/documentation/", cmd: "npm install animejs" },
    "lottie": { pkg: "lottie-web", npm: "https://www.npmjs.com/package/lottie-web", docs: "https://airbnb.io/lottie/", cmd: "npm install lottie-web" },
    "swiper": { pkg: "swiper", npm: "https://www.npmjs.com/package/swiper", docs: "https://swiperjs.com/get-started", cmd: "npm install swiper" },
    "three.js": { pkg: "three", npm: "https://www.npmjs.com/package/three", docs: "https://threejs.org/docs/", cmd: "npm install three" },
    "scrollreveal": { pkg: "scrollreveal", npm: "https://www.npmjs.com/package/scrollreveal", docs: "https://scrollrevealjs.org/", cmd: "npm install scrollreveal" },
    "wow.js": { pkg: "wow.js", npm: "https://www.npmjs.com/package/wow.js", docs: "https://wowjs.uk/", cmd: "npm install wow.js" },
    "framer motion": { pkg: "framer-motion", npm: "https://www.npmjs.com/package/framer-motion", docs: "https://motion.dev/docs", cmd: "npm install framer-motion" },
    "framer (published site)": { pkg: null, npm: null, docs: "https://www.framer.com/developers/", cmd: null }
  };
  const libRows = (libs) => libs.map((l) => { const i = LIBINFO[String(l.name).toLowerCase()]; const ver = l.version ? ` <i>${esc(l.version)}</i>` : "";
    if (!i) return `<div class="mi"><b>${esc(l.name)}${ver}</b><span>No install link on file for this one.</span></div>`;
    return `<div class="mi" style="flex-direction:column;align-items:stretch;gap:6px"><div style="display:flex;justify-content:space-between;gap:8px"><b>${esc(l.name)}${ver}</b><span>${i.npm ? `<a class="mlink" href="${i.npm}" target="_blank" rel="noopener noreferrer">npm</a> \u00b7 ` : ""}<a class="mlink" href="${i.docs}" target="_blank" rel="noopener noreferrer">docs</a></span></div>${i.cmd ? `<div style="display:flex;gap:6px;align-items:center"><code class="mcmd" style="flex:1">${esc(i.cmd)}</code><button class="mini" data-copy="${esc(i.cmd)}">Copy</button></div>` : ""}${i.note ? `<code class="mcmd">${esc(i.note)}</code>` : ""}</div>`; }).join("");
  const stWords = (x) => `Scroll-triggered${x.scrub ? " and scrubbed: the animation follows the scrollbar, forward and back" : ": plays when you scroll to it"}. Starts when "${x.start || "top bottom"}" reaches the viewport, ends at "${x.end || "bottom top"}".`;
  /* ---------- "How to apply it": steps that match the selected code tab ---------- */
  const guideFor = (tab, eff, el, code, probe) => {
    const sel = selName(el), scroll = eff && eff.scroll, scrub = !!(scroll && scroll.scrub != null && scroll.scrub !== false);
    const sels = [...new Set(((probe && probe.gsap) || []).map((g) => g.sel).filter(Boolean))];
    const usesST = /ScrollTrigger/.test(code.lib || "");
    const cmd = (c) => `<div class="gcmd"><code>${esc(c)}</code><button class="mini" data-copy="${esc(c)}">Copy</button></div>`;
    const name = (s0) => `<code>${esc(s0)}</code>`;
    const steps = [];
    if (tab === "css") {
      steps.push(`Copy the code and paste it into your stylesheet (for example <code>globals.css</code>).`);
      steps.push(`Give your element the selector ${name(sel)}, or rename ${name(sel)} in the code to your own class.`);
      if (scrub) steps.push(`It is tied to scrolling with <code>animation-timeline</code> (Chrome and Edge 115+, Safari 26+). Older browsers show the end state, which is a safe fallback.`);
      else if (scroll) steps.push(`It should start when it scrolls into view: add the small script from the comment at the bottom of the code once, before <code>&lt;/body&gt;</code>.`);
      if (/--i/.test(code.css || "")) steps.push(`For the stagger, give each element its index: <code>style="--i: 0"</code>, <code>"--i: 1"</code>, and so on.`);
      steps.push(`Reload the page. Users who turned on "reduce motion" should get a still version: wrap the rule in <code>@media (prefers-reduced-motion: no-preference) { … }</code>.`);
    } else if (tab === "js") {
      steps.push(`Make sure the element exists and matches ${name(sel)}.`);
      steps.push(`Paste the code in a script that runs after the page loads: <code>&lt;script defer src="motion.js"&gt;</code> or just before <code>&lt;/body&gt;</code>. No library needed: it uses the browser's Web Animations API.`);
      if (scrub) steps.push(`Scroll-scrubbing uses <code>ViewTimeline</code> (Chrome and Edge 115+). Elsewhere, wrap it in <code>if ("ViewTimeline" in window) { … }</code>.`);
    } else if (tab === "react") {
      steps.push(`Save the code as <code>Effect.jsx</code> in your components folder.`);
      steps.push(`Wrap the element you want to animate: <code>&lt;Effect&gt;&lt;YourCard /&gt;&lt;/Effect&gt;</code>.`);
      steps.push(`In Next.js App Router it already starts with <code>"use client"</code>, so it works inside server pages.`);
    } else if (tab === "lib") {
      steps.push(`Install GSAP:` + cmd("npm i gsap"));
      if (usesST) steps.push(`It uses ScrollTrigger, which comes with the same package. The code already imports and registers it.`);
      steps.push(`Your HTML needs elements that match ${sels.length ? sels.map(name).join(", ") : name(sel)}${probe && probe.trigSel && usesST ? `, and a section for the scroll trigger: ${name(probe.trigSel)}` : ""}. Rename the selectors in the code if your classes are different.`);
      steps.push(`<b>Plain HTML:</b> put the code in a module script after your content: <code>&lt;script type="module" src="motion.js"&gt;</code>.`);
      steps.push(`<b>React / Next.js:</b> install the hook${cmd("npm i @gsap/react")}then run the code inside it, so it is cleaned up for you:<pre class="gsnip">"use client";\nimport { useRef } from "react";\nimport { useGSAP } from "@gsap/react";\n\nconst ref = useRef(null);\nuseGSAP(() => {\n  // paste the gsap code here\n}, { scope: ref });\n\nreturn &lt;section ref={ref}&gt;…&lt;/section&gt;;</pre>`);
      if (usesST) steps.push(`If content above it loads late (images, fonts), call <code>ScrollTrigger.refresh()</code> once it has loaded so the start and end points are right.`);
    } else if (tab === "prompt") {
      steps.push(`Copy the prompt into your AI coding assistant.`);
      steps.push(`Attach the reference image (the camera button below saves it).`);
      steps.push(`Ask it to use the selectors and files of your project.`);
    }
    return steps.length ? `<section class="esec mguide"><div class="eh"><h4>How to apply it</h4></div><ol>${steps.map((x) => `<li>${x}</li>`).join("")}</ol></section>` : "";
  };

  /* ---------- motion gallery: keep an animation as a live preview card ---------- */
  const GAL_KEY = "dsx:gallery";
  const VIS = ["display", "position", "box-sizing", "width", "height", "min-width", "min-height", "max-width", "padding", "margin", "border", "border-radius", "background", "background-color", "background-image", "background-size", "background-position", "background-repeat", "color", "font", "font-family", "font-size", "font-weight", "font-style", "line-height", "letter-spacing", "text-align", "text-transform", "text-decoration", "white-space", "box-shadow", "flex-direction", "flex-wrap", "align-items", "justify-content", "gap", "grid-template-columns", "grid-template-rows", "object-fit", "overflow", "fill", "stroke", "filter", "list-style", "vertical-align", "top", "left", "right", "bottom", "z-index"];
  /* a light copy with only the visible styles, so many cards fit in storage */
  const slimClone = (src, budget, isRoot) => {
    const c = src.cloneNode(false);
    if (src.nodeType !== 1) return c;
    const cs = getComputedStyle(src);
    [...c.attributes].forEach((a) => { if (!/^(src|alt|viewBox|d|fill|stroke|width|height|xmlns|points|cx|cy|r|x|y|rx|ry|x1|x2|y1|y2|transform|stroke-width|stroke-linecap|stroke-linejoin|preserveAspectRatio)$/i.test(a.name)) c.removeAttribute(a.name); });
    if (c.tagName === "IMG" && src.currentSrc) c.setAttribute("src", src.currentSrc);
    let t = ""; for (const pn of VIS) { const v = cs.getPropertyValue(pn); if (v) t += pn + ":" + v + ";"; }
    if (isRoot) t += "position:relative;top:auto;left:auto;right:auto;bottom:auto;margin:0;";
    else { const tf = cs.transform; if (tf && tf !== "none") t += "transform:" + tf + ";"; if (cs.opacity !== "1") t += "opacity:" + cs.opacity + ";"; }
    c.setAttribute("style", t);
    budget.n++;
    for (const ch of src.childNodes) { if (budget.n > 160) break; if (ch.nodeType === 1 && /^(SCRIPT|STYLE|NOSCRIPT|IFRAME|VIDEO|CANVAS)$/.test(ch.tagName)) continue; if (ch.nodeType === 8) continue; c.appendChild(slimClone(ch, budget, false)); }
    return c;
  };
  const easeName = (e) => { const s0 = String(e || ""); const m = /^(linear|ease|ease-in|ease-out|ease-in-out|steps\(\d+\))$/.exec(s0); return m ? m[1] : /^cubic-bezier/.test(s0) ? "cubic-bezier" : /^linear\(/.test(s0) ? "custom curve" : s0.slice(0, 24); };
  const saveToGallery = async (el, eff, sty, code, probe) => {
    if (!eff) throw new Error("no animation to save yet");
    const r = el.getBoundingClientRect();
    const html = slimClone(el, { n: 0 }, true).outerHTML;
    if (html.length > 400000) throw new Error("this element is too large for a preview card");
    const g = eff.gsap ? eff.gsap.v : null;
    const tags = [];
    /* tag the animation's own source first; a library found on the page only labels the card when the effect actually came from it */
    if (eff.gsap) tags.push("GSAP");
    else if (eff.anim) tags.push(/transition/i.test(eff.anim.type) ? "CSS transition" : "CSS animation"); else if (eff.kind === "hover") tags.push("Hover"); else if (eff.kind === "sampled") tags.push("Sampled");
    else if (probe && probe.libs && probe.libs.length) tags.push(probe.libs[0].name);
    if (g && g.ease) tags.push(String(g.ease)); else if (eff.timing.easing) tags.push(easeName(eff.timing.easing));
    tags.push((eff.gsap ? Math.round(((g && g.duration) || eff.timing.duration / 1000) * 100) / 100 + "s" : (eff.timing.duration / 1000).toFixed(2).replace(/0$/, "") + "s"));
    if (eff.timing.iterations === "infinite") tags.push(eff.timing.direction === "alternate" || (g && g.yoyo) ? "loop · yoyo" : "loop");
    if (eff.stagger) tags.push("stagger");
    const item = {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      name: sty ? sty.name : eff.label, desc: sty ? sty.desc : "", kind: eff.kind, hover: eff.kind === "hover",
      kfs: kfToWaapi(eff.kfs), timing: waapiTiming(eff.timing), stagger: eff.stagger || 0,
      group: eff.kind === "group" ? eff.items.slice(0, 160).map((it) => ({ path: it.path, kfs: kfToWaapi(it.kfs), timing: { duration: it.totalMs, delay: it.delayMs || 0, iterations: it.loop ? "Infinity" : 1, easing: "linear" } })) : null,
      html, w: Math.round(r.width), h: Math.round(r.height),
      code: { css: code.css || "", js: code.js || "", react: code.react || "", gsap: code.lib || "", prompt: code.prompt || "" },
      tags, page: location.href, site: location.hostname, title: document.title, at: Date.now()
    };
    const list = (await store.get(GAL_KEY)) || [];
    list.unshift(item); await new Promise((res) => { try { chrome.storage.local.set({ [GAL_KEY]: list.slice(0, 200) }, res); } catch (e) { res(); } });
    return item;
  };
  const openGallery = () => { try { chrome.runtime.sendMessage({ type: "dsx-open-gallery" }); } catch (e) { say("Could not open the gallery."); } };

  const showMotion = async (el) => {
    if (motionStop) { motionStop(); motionStop = null; }
    mode = "motion"; motionArmed = false; setActive();
    lp.classList.add("show"); lp.style.width = "400px";
    lp.innerHTML = `<div class="empty">Reading motion\u2026</div>`;
    el.setAttribute("data-dsx-probe", "1");
    const probe = await probeMain();
    el.removeAttribute("data-dsx-probe");
    if (probe) {
      try {
        (probe.gsap || []).forEach((g) => { let a = el; for (let d = 0; d < (g.depth || 0) && a.parentElement; d++) a = a.parentElement; g.sel = g.tag ? groupSel(g.tag, a) : selName(a); });
        const tr = document.querySelectorAll("[data-dsx-trig]"); probe.trigSel = tr.length === 1 ? selName(tr[0]) : ""; probe.trigEl = tr.length === 1 ? tr[0] : null;
      } catch (e) {}
      document.querySelectorAll("[data-dsx-trig]").forEach((n) => n.removeAttribute("data-dsx-trig"));
      /* every animated element inside the picked one, sampled as exact keyframes */
      try {
        el.setAttribute("data-dsx-root", "code");
        probe.group = await new Promise((res) => { const t = setTimeout(() => res(null), 8000); try { chrome.runtime.sendMessage({ type: "dsx-motion-collect" }, (x) => { clearTimeout(t); res(x && x.ok ? x.data : null); }); } catch (e) { clearTimeout(t); res(null); } });
      } catch (e) {} finally { el.removeAttribute("data-dsx-root"); }
      for (let k = 0; k < 64; k++) document.querySelectorAll(`[data-dsx-t${k}]`).forEach((n) => n.removeAttribute(`data-dsx-t${k}`));
    }
    let m; try { m = collectMotion(el); } catch (err) { lp.innerHTML = `<div class="ph"><b>Motion</b></div><div class="empty">Could not read this element's motion: ${esc(err && err.message || err)}</div>`; return; }
    let watched = null;
    const render = () => {
      const eff = primaryEffect(m, el, probe), sty = detectStyle(m, eff, probe), code = genCode(m, eff, el, (probe && probe.libs) || [], probe);
      host.__last = { eff, sty, code, el }; /* read by automated tests */
      const libs = (probe && probe.libs) || [];
      const chips = libs.length ? libs.map((l) => `<span class="mchip">${esc(l.name)}${l.version ? " <i>" + esc(l.version) + "</i>" : ""}</span>`).join("") : `<span class="mnone">No animation library detected on this page.</span>`;
      const lst = [];
      m.anims.forEach((a) => { const kfEasings = [...new Set(a.kfs.map((k) => k.easing || "linear"))]; const ease = a.timing.easing !== "linear" ? a.timing.easing : (kfEasings.length === 1 ? kfEasings[0] : "mixed easing"); lst.push(`<div class="mi"><b>${esc(a.type)}: ${esc(a.name)}</b><span>${a.timing.duration}ms \u00b7 ${esc(ease)} \u00b7 delay ${a.timing.delay}ms \u00b7 ${esc(String(a.timing.iterations))}\u00d7</span></div>`); });
      m.trans.forEach((x) => lst.push(`<div class="mi"><b>Transition: ${esc(x.prop)}</b><span>${x.duration}ms \u00b7 ${esc(x.easing)}${x.delay ? " \u00b7 delay " + x.delay + "ms" : ""}</span></div>`));
      m.hover.forEach((h) => lst.push(`<div class="mi"><b>${esc(h.sel)}</b><span>${esc(Object.entries(h.decls).slice(0, 4).map(([a, b]) => a + ": " + b).join("; "))}</span></div>`));
      if (probe && probe.gsap) probe.gsap.forEach((g) => { const v = g.vars || {}, skip = /^(delay|duration|ease|overwrite|paused|stagger|scrollTrigger|onComplete|onStart|onUpdate|immediateRender|lazy|id|data|repeat|yoyo|repeatDelay|runBackwards|startAt|callbackScope)$/; const to = Object.entries(v).filter(([k, x]) => !skip.test(k) && (typeof x === "number" || typeof x === "string")).slice(0, 6).map(([k, x]) => k + " \u2192 " + x); lst.push(`<div class="mi"><b>GSAP tween (${esc(g.on)})</b><span>${to.length ? "Animates " + esc(to.join(", ")) + ". " : ""}${Math.round(g.duration * 1000)}ms${v.ease ? " \u00b7 ease " + esc(String(v.ease)) : ""}${v.delay ? " \u00b7 delay " + Math.round(v.delay * 1000) + "ms" : ""}${v.stagger ? " \u00b7 staggered across children" : ""}</span></div>`); });
      if (probe && probe.st) probe.st.forEach((x) => lst.push(`<div class="mi"><b>ScrollTrigger</b><span>${esc(stWords(x))}</span></div>`));
      if (probe && probe.framer) lst.push(`<div class="mi"><b>Framer Motion props</b><span>${esc(Object.keys(probe.framer).filter((k) => probe.framer[k] != null).join(", "))}</span></div>`);
      const tabs = [["css", "CSS"], ["js", "JavaScript"], ["react", "React"], ["lib", "Library"], ["prompt", "AI prompt"]].filter(([k]) => k !== "lib" || code.lib);
      if (!tabs.some(([k]) => k === motionTab)) motionTab = "css";
      const txt = code[motionTab] || "";
      const nothing = !eff && !m.anims.length && !m.trans.length && !m.hover.length;
      const note = eff ? (eff.kind === "sampled" ? "Replays the values captured while watching. Timing and easing are approximate." : "Replays the exact keyframes on a copy of the element. Scroll links and scripts are not reproduced.")
        : libs.length ? `Nothing is running right now. This page animates with ${esc(libs.map((l) => l.name).slice(0, 2).join(" and "))}, usually on scroll or hover.` : "Nothing is running on this element right now.";
      lp.innerHTML = `<div class="ph"><b>Motion</b><span class="mono" title="${esc(selectorOf(el))}">${esc(selectorOf(el))}</span></div>
        ${sty ? `<div class="mstyle"><span class="mbadge">${esc(sty.name)}</span><p>${esc(sty.desc)}</p></div>` : ""}
        <div class="mprev"><div class="mstage" id="mstage">${eff ? "" : `<div class="mempty">No preview yet</div>`}</div>
          <div class="mbar">${eff ? `<button class="mini ico" id="mplay" aria-label="Pause preview" data-tip="Pause or play">${PAUSE_I}</button><button class="mini ico" id="mrst" aria-label="Restart preview" data-tip="Restart">${ICONS.revert}</button>` : ""}<span class="mhint">${eff ? esc(eff.label) : ""}</span><button class="mini" id="mpick">Pick another</button></div>
          <div class="mnote">${note}</div>
          <div class="mwatchbox${nothing ? " hot" : ""}"><button class="pbtn ${nothing ? "" : "sec2"}" id="mwatch">${ICONS.motion}<span>Watch for 8 s</span></button><span class="mhint" id="mw">Then scroll or hover the element to capture its motion.</span></div>
        </div>
        <section class="esec"><div class="eh"><h4>On this element</h4></div>${lst.join("") || `<div class="mnone">No animation, transition or hover rule found.</div>`}</section>
        <section class="esec"><div class="eh"><h4>Code</h4><button class="mini pri" id="mcopy"${txt ? "" : " disabled"}>Copy ${esc((tabs.find(([k]) => k === motionTab) || [0, ""])[1])}</button></div><div class="mtabs" role="tablist">${tabs.map(([k, l]) => `<button class="mtab${k === motionTab ? " on" : ""}" role="tab" aria-selected="${k === motionTab}" data-mt="${k}">${l}</button>`).join("")}</div><pre class="mcode" id="mcode">${esc(txt || "Nothing to show yet. Use Watch to capture the motion first.")}</pre></section>
        ${txt ? guideFor(motionTab, eff, el, code, probe) : ""}
        <details class="esec mlibs"${libs.length ? "" : " data-empty"}><summary><h4>Libraries on this page</h4><span class="tag">${libs.length}</span></summary>${libs.length ? libRows(libs) : chips}</details>
        <div class="foot"><button class="mini ico" id="mref" aria-label="Save image" data-tip="Save a PNG of the element (handy for the AI prompt)">${ICONS.shot}</button><button class="pbtn sec2" id="mgal"${eff ? "" : " disabled"} data-tip="Keep this animation in your gallery: a live preview card with its code">${ICONS.gallery}<span>Add to gallery</span></button><button class="pbtn" id="mfig" data-tip="Figma layers with the animation as keyframes">${ICONS.figma}<span>Copy to Figma</span></button></div>`;
      const stage = lp.querySelector("#mstage");
      requestAnimationFrame(() => mountPreview(stage, el, eff));
      const mp = lp.querySelector("#mplay");
      if (mp) mp.onclick = () => { if (!preview) return; const playing = preview.toggle(); mp.innerHTML = playing ? PAUSE_I : PLAY_I; mp.setAttribute("aria-label", playing ? "Pause preview" : "Play preview"); };
      const mr = lp.querySelector("#mrst"); if (mr) mr.onclick = () => preview && preview.restart();
      lp.querySelector("#mpick").onclick = () => { if (motionStop) { motionStop(); motionStop = null; } armMotion(true); };
      lp.querySelectorAll("[data-mt]").forEach((b) => b.onclick = () => { motionTab = b.dataset.mt; render(); });
      lp.querySelectorAll("[data-copy]").forEach((b) => b.onclick = () => { navigator.clipboard.writeText(b.dataset.copy).then(() => { b.textContent = "Copied"; setTimeout(() => { b.textContent = "Copy"; }, 1400); }).catch(() => say("Clipboard was blocked.")); });
      lp.querySelectorAll("a.mlink").forEach((a) => a.addEventListener("click", (e) => e.stopPropagation()));
      lp.querySelector("#mcopy").onclick = (ev) => { const b = ev.currentTarget, was = b.textContent; navigator.clipboard.writeText(txt).then(() => { b.textContent = "Copied"; setTimeout(() => { b.textContent = was; }, 1500); }).catch(() => say("Clipboard was blocked.")); };
      lp.querySelector("#mfig").onclick = () => { copyFigma(el); };
      lp.querySelector("#mgal").onclick = async (ev) => { const b = ev.currentTarget; b.disabled = true; try { await saveToGallery(el, eff, sty, code, probe); b.innerHTML = `${ICONS.finish}<span>Saved</span>`; say("Added to your motion gallery.", { label: "Open gallery", fn: openGallery }); } catch (e) { b.disabled = false; say("Could not save: " + (e && e.message || e)); } };
      lp.querySelector("#mref").onclick = async (ev) => { const b = ev.currentTarget; b.disabled = true; try { await elementShot(el); say("Saved blue-dot-effect-ref.png to your downloads."); } catch (e) { say("Could not save the image: " + e.message); } b.disabled = false; };
      lp.querySelector("#mwatch").onclick = () => {
        const mw = lp.querySelector("#mw"), wb = lp.querySelector("#mwatch");
        if (motionStop) { motionStop(); motionStop = null; busy(false); wb.closest(".mwatchbox").classList.remove("live"); wb.innerHTML = `${ICONS.motion}<span>Watch for 8 s</span>`; mw.textContent = "Stopped. Nothing was captured."; return; }
        wb.innerHTML = `<span>Stop</span>`; wb.closest(".mwatchbox").classList.add("live");
        el.scrollIntoView({ block: "center", behavior: "smooth" });
        motionStop = watchMotion(el, 8, (res, seen) => {
          motionStop = null;
          if (res) m.samples = res;
          seen.forEach((a) => { if (a.kfs.length > 1 && !m.anims.some((x) => x.name === a.name)) m.anims.push({ type: "Web Animation", name: a.name, timing: a.timing, kfs: a.kfs, ruleText: null }); });
          render();
          say(res || seen.length ? "Watch done. Motion captured." : "Nothing changed on that element while watching.");
        }, (left) => { mw.textContent = `Watching\u2026 scroll or hover the element now (${Math.ceil(left)} s)`; });
      };
    };
    lp.classList.remove("swapin"); void lp.offsetWidth; lp.classList.add("swapin");
    render();
  };

  /* element colour: "Apply to all N" chip */
  const ALLP = [["color", "color"], ["background-color", "background-color"], ["border-top-color", "border"], ["fill", "fill"], ["stroke", "stroke"]];
  const setAllColour = (m, to) => { for (const { el, prop } of m) { if (prop === "border") ["top", "right", "bottom", "left"].forEach((sd) => setProp(el, `border-${sd}-color`, to)); else setProp(el, prop, to); } };
  const applyAllChip = (inp, el0, p0, orig, to) => {
    if (!orig || !/^#/.test(orig)) return;
    const host2 = inp.closest(".crow"); if (!host2) return;
    let chip = host2.nextElementSibling && host2.nextElementSibling.classList.contains("aachip") ? host2.nextElementSibling : null;
    if (!chip) {
      const found = [];
      for (const el of allEls()) {
        if (isUI(el)) continue; const cs = getComputedStyle(el);
        for (const [css, kind] of ALLP) {
          if (el === el0 && (kind === p0 || (kind === "border" && p0 === "border-top-color"))) continue;
          if (kind === "border" && (parseFloat(cs.borderTopWidth) === 0 || cs.borderTopStyle === "none")) continue;
          if ((kind === "fill" || kind === "stroke") && !(el instanceof SVGElement)) continue;
          if (toHex(cs.getPropertyValue(css)) === orig) found.push({ el, prop: kind === "border" ? "border" : kind });
        }
      }
      chip = document.createElement("button"); chip.className = "aachip"; chip.type = "button";

      chip._m = found; chip._on = false; host2.after(chip);
      chip.addEventListener("click", (e) => {
        e.stopPropagation();
        const cur = inp.value, key = "g:c:" + orig;
        if (!chip._on) { setAllColour(chip._m, cur); for (const v of (buildVarMap().get(orig) || [])) rootVars.set(v, cur); chip._on = true; render(); record(key, `${orig} (all ${chip._m.length + 1} uses)`, orig, cur, "colour"); }
        else { for (const { el, prop } of chip._m) { const o2 = overrides.get(elId(el)); if (!o2) continue; if (prop === "border") ["top", "right", "bottom", "left"].forEach((sd) => delete o2[`border-${sd}-color`]); else delete o2[prop]; } for (const v of (buildVarMap().get(orig) || [])) rootVars.delete(v); chip._on = false; log.delete(key); updateBadge(); render(); }
        chip.textContent = chip._on ? `Applied to ${chip._m.length + 1} places \u00b7 Undo` : `Apply to all ${chip._m.length + 1}`;
      });
    }
    if (!chip._m.length) { chip.textContent = "No other element uses this colour"; chip.classList.add("off"); chip.disabled = true; return; }
    if (chip._on) { setAllColour(chip._m, to); for (const v of (buildVarMap().get(orig) || [])) rootVars.set(v, to); render(); record("g:c:" + orig, `${orig} (all ${chip._m.length + 1} uses)`, orig, to, "colour"); }
    else chip.textContent = `Apply to all ${chip._m.length + 1}`;
  };
  /* ---------- Find-style usage navigation (3 of 12, prev/next) ---------- */
  let finder = null;
  const stopFind = () => { host.classList.remove("finding"); if (!finder) return; finder.stop = true; finder.bar.remove(); finder.boxes.forEach((b) => b.remove()); finder = null; };
  const startFind = (els, label) => {
    stopFind();
    const list = [...new Set(els)].filter((e) => e && e.isConnected && !isUI(e));
    if (!list.length) { say("Nothing on this page uses that."); return; }
    const bar = document.createElement("div"); bar.className = "findbar";
    const B = "";
    bar.innerHTML = `<span class="fl0">${esc(label)}</span><span class="fc">1 of ${list.length}</span><button class="fp" aria-label="Previous match" title="Previous (Shift+Enter)">\u2039</button><button class="fn" aria-label="Next match" title="Next (Enter)">\u203a</button><button class="fx" aria-label="Close find" title="Close (Esc)">\u2715</button>`; host.classList.add("finding");
    root.appendChild(bar);
    const mk = (cur) => { const b = document.createElement("div"); b.style.cssText = "position:fixed;z-index:2147483645;pointer-events:none;box-sizing:border-box;border-radius:3px;transition:opacity .15s;" + (cur ? "border:2px solid #3d9bff;box-shadow:0 0 0 4px rgba(61,155,255,.28);z-index:2147483646" : "border:1px dashed rgba(61,155,255,.75);background:rgba(61,155,255,.07)"); root.appendChild(b); return b; };
    const boxes = list.slice(0, 160).map(() => mk(false)), curBox = mk(true); boxes.push(curBox);
    const st = { bar, boxes, stop: false, i: 0, list }; finder = st;
    const place = () => {
      if (st.stop) return;
      list.slice(0, 160).forEach((el, k) => { const r = el.getBoundingClientRect(), b = boxes[k], on = r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth && r.width > 0; b.style.display = on && k !== st.i ? "block" : "none"; if (on) Object.assign(b.style, { left: r.left + "px", top: r.top + "px", width: r.width + "px", height: r.height + "px" }); });
      const r = list[st.i].getBoundingClientRect(); Object.assign(curBox.style, { display: "block", left: r.left - 2 + "px", top: r.top - 2 + "px", width: r.width + 4 + "px", height: r.height + 4 + "px" });
      requestAnimationFrame(place);
    };
    const go = (d) => { st.i = (st.i + d + list.length) % list.length; bar.querySelector(".fc").textContent = `${st.i + 1} of ${list.length}`; const el = list[st.i], r = el.getBoundingClientRect(); if (r.top < 80 || r.bottom > innerHeight - 110) el.scrollIntoView({ block: "center", behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" }); };
    bar.querySelector(".fp").onclick = () => go(-1); bar.querySelector(".fn").onclick = () => go(1); bar.querySelector(".fx").onclick = stopFind;
    st.go = go; place(); go(0);
  };
  onL(document, "keydown", (e) => {
    if (!finder) return;
    const t = e.composedPath()[0];
    if (e.key === "Escape") { stopFind(); return; }
    if (e.key === "Enter" && !(t && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) { e.preventDefault(); finder.go(e.shiftKey ? -1 : 1); }
  }, true);

  /* ---------- one tool at a time + Figma drop-up ---------- */
  let figMenuOpen = false, figMenu = null;  // figMenuOpen is false or the menu kind: figma | shot
  const closeFigMenu = () => { if (figMenu) { figMenu.remove(); figMenu = null; } if (figMenuOpen) { figMenuOpen = false; setActive(); } };
  const releaseTools = (keep) => {
    stopFind();
    if (keep !== "figma" && keep !== "shot") closeFigMenu(); else if (figMenuOpen && figMenuOpen !== keep) closeFigMenu();
    if (picking && keep !== "pick" && keep !== "motion" && keep !== "figma") setPicking(false);
    if (keep === "shot" && picking) setPicking(false);
    if (mode && mode !== keep) openMode(null);
    if (keep !== "figma" && (figmaArmed || codeArmed) && picking) setPicking(false);
  };
  /* Capture code: HTML + the CSS it needs to stay responsive, or a React component */
  const absUrl = (u) => { try { return new URL(u, location.href).href; } catch (e) { return u; } };
  const collectCode = (el) => {
    const nodes = [el, ...el.querySelectorAll("*")].slice(0, 400);
    const clone = el.cloneNode(true);
    clone.querySelectorAll("script,noscript,style,link,template").forEach((n) => n.remove());
    const assets = new Set(), fams = new Set(), kfs = new Set(), vars = new Set();
    const wipe = (n) => {
      const st0 = n.getAttribute && n.getAttribute("style");
      if (st0 && /translate:\s*none;\s*rotate:\s*none;\s*scale:\s*none/.test(st0)) {
        /* GSAP's signature: these values are a frozen animation frame, not the design */
        ["translate", "rotate", "scale", "transform", "opacity", "visibility", "will-change"].forEach((pn) => n.style.removeProperty(pn));
        if (!n.getAttribute("style").trim()) n.removeAttribute("style");
      }
      [...n.attributes].forEach((a) => { if (/^data-dsx/.test(a.name) || /^on/i.test(a.name)) n.removeAttribute(a.name); });
      ["src", "href", "poster", "data-src"].forEach((k) => { if (n.hasAttribute && n.hasAttribute(k)) { const v = n.getAttribute(k); if (v && !/^(#|javascript:|mailto:|tel:|data:)/i.test(v)) { const u = absUrl(v); n.setAttribute(k, u); if (k !== "href") assets.add(u); } } });
      if (n.hasAttribute && n.hasAttribute("srcset")) n.setAttribute("srcset", n.getAttribute("srcset").split(",").map((x) => { const [u, d] = x.trim().split(/\s+/); const a = absUrl(u); assets.add(a); return a + (d ? " " + d : ""); }).join(", "));
    };
    [clone, ...clone.querySelectorAll("*")].forEach(wipe);
    nodes.forEach((n) => { const cs = getComputedStyle(n); cs.fontFamily.split(",").forEach((f) => fams.add(f.replace(/["']/g, "").trim().toLowerCase())); if (cs.backgroundImage && /url\(/.test(cs.backgroundImage)) [...cs.backgroundImage.matchAll(/url\(["']?([^"')]+)["']?\)/g)].forEach((m) => assets.add(absUrl(m[1]))); if (cs.animationName && cs.animationName !== "none") cs.animationName.split(",").forEach((x) => kfs.add(x.trim())); });
    const out = [], fonts = [], keyframes = [], stats = { rules: 0, media: 0, container: 0 };
    const matches = (sel) => { if (!sel) return false; const clean = sel.replace(/::?(before|after|first-line|first-letter|placeholder|marker|selection|-[a-z-]+)/g, "").replace(/:(hover|focus|focus-visible|focus-within|active|visited)/g, ""); try { return nodes.some((n) => n.matches(clean || "*")) || nodes.some((n) => n.matches(sel)); } catch (e) { return false; } };
    const note = (t) => { (t.match(/var\((--[\w-]+)/g) || []).forEach((m) => vars.add(m.slice(4))); };
    const walk = (list, wrap) => {
      const acc = [];
      for (const r of list) {
        if (r.type === 1) { if (matches(r.selectorText)) { acc.push(r.cssText); note(r.cssText); stats.rules++; } }
        else if (r.type === 4 || r.type === 12 || (r.constructor && /Container/.test(r.constructor.name))) { const inner = walk(r.cssRules, true); if (inner.length) { const head = r.cssText.slice(0, r.cssText.indexOf("{")).trim(); acc.push(head + " {\n  " + inner.join("\n  ") + "\n}"); if (r.type === 4) stats.media++; else stats.container++; } }
        else if (r.type === 5 && !wrap) fonts.push(r);
        else if (r.type === 7 && !wrap) keyframes.push(r);
        else if (r.type === 3 || r.type === 6) { /* import / page: skip */ }
        else if (r.cssRules && r.cssText && r.type !== 1) { const inner = walk(r.cssRules, true); if (inner.length) { const head = r.cssText.slice(0, r.cssText.indexOf("{")).trim(); acc.push(head + " {\n  " + inner.join("\n  ") + "\n}"); } }
      }
      return acc;
    };
    for (const sh of document.styleSheets) { let rs; try { rs = sh.cssRules; } catch (e) { continue; } out.push(...walk(rs, false)); }
    const fontCss = fonts.filter((r) => fams.has(String(r.style.getPropertyValue("font-family")).replace(/["']/g, "").trim().toLowerCase())).map((r) => { const t = r.cssText.replace(/url\(["']?([^"')]+)["']?\)/g, (m, u) => { const a = absUrl(u); if (!/^data:/i.test(u)) assets.add(a); return `url("${a}")`; }); return t; });
    const kfCss = keyframes.filter((r) => kfs.has(r.name)).map((r) => r.cssText);
    const rootCs = getComputedStyle(document.documentElement);
    const seenVars = new Set(), varLines = [];
    const addVars = (txts) => { txts.forEach(note); };
    note(out.join("")); note(fontCss.join(""));
    for (let i = 0; i < 3; i++) [...vars].forEach((v) => { if (seenVars.has(v)) return; seenVars.add(v); const val = rootCs.getPropertyValue(v).trim(); if (val) { varLines.push(`  ${v}: ${val};`); note(val); } });
    const cssAbs = (t) => t.replace(/url\(["']?(?!data:|https?:|#)([^"')]+)["']?\)/g, (m, u) => { const a = absUrl(u); assets.add(a); return `url("${a}")`; });
    const par = el.parentElement, pcs = par && getComputedStyle(par);
    const ctx = par && /flex|grid/.test(pcs.display) ? `/* Parent layout this component expects: ${par.tagName.toLowerCase()}${par.className ? "." + String(par.className).trim().split(/\s+/)[0] : ""} { display: ${pcs.display}${pcs.display.includes("grid") ? "; grid-template-columns: " + pcs.gridTemplateColumns : "; flex-direction: " + pcs.flexDirection + "; flex-wrap: " + pcs.flexWrap}; gap: ${pcs.gap}; } */\n` : "";
    const rcs = getComputedStyle(el), selR = el.id ? "#" + CSS.escape(el.id) : el.className && typeof el.className === "string" && el.className.trim() ? "." + el.className.trim().split(/\s+/).map((c) => CSS.escape(c)).join(".") : el.tagName.toLowerCase();
    const inh = `/* Inherited from the page (set here so the component looks the same on its own) */\n${selR} { font-family: ${rcs.fontFamily}; font-size: ${rcs.fontSize}; line-height: ${lhOf(el, rcs)}; color: ${rcs.color}; box-sizing: ${rcs.boxSizing}; }`;
    const css = [(varLines.length ? ":root {\n" + varLines.join("\n") + "\n}" : ""), ...fontCss.map(cssAbs), ...kfCss.map(cssAbs), inh, ...out.map(cssAbs)].filter(Boolean).join("\n\n");
    return { clone, css, ctx, assets: [...assets], stats: { ...stats, vars: varLines.length, fonts: fontCss.length, kf: kfCss.length, assets: assets.size, w: Math.round(el.getBoundingClientRect().width) } };
  };
  const ATTR = { class: "className", for: "htmlFor", tabindex: "tabIndex", srcset: "srcSet", colspan: "colSpan", rowspan: "rowSpan", maxlength: "maxLength", readonly: "readOnly", autocomplete: "autoComplete", autofocus: "autoFocus", crossorigin: "crossOrigin", datetime: "dateTime", enctype: "encType", frameborder: "frameBorder", novalidate: "noValidate", contenteditable: "contentEditable", spellcheck: "spellCheck", "accept-charset": "acceptCharset", "http-equiv": "httpEquiv", viewbox: "viewBox", "stroke-width": "strokeWidth", "stroke-linecap": "strokeLinecap", "stroke-linejoin": "strokeLinejoin", "fill-rule": "fillRule", "clip-rule": "clipRule", "clip-path": "clipPath", "stroke-dasharray": "strokeDasharray", "stroke-dashoffset": "strokeDashoffset", "stroke-miterlimit": "strokeMiterlimit", "stop-color": "stopColor", "stop-opacity": "stopOpacity", "fill-opacity": "fillOpacity", "stroke-opacity": "strokeOpacity", "text-anchor": "textAnchor", "xlink:href": "xlinkHref", "xml:space": "xmlSpace", preserveaspectratio: "preserveAspectRatio", gradientunits: "gradientUnits", gradienttransform: "gradientTransform" };
  const VOID = /^(area|base|br|col|embed|hr|img|input|link|meta|source|track|wbr)$/i;
  const jsxStyle = (st) => "{{ " + st.split(";").map((d) => d.trim()).filter(Boolean).map((d) => { const i = d.indexOf(":"); const k = d.slice(0, i).trim(), v = d.slice(i + 1).trim(); const key = k.startsWith("--") ? JSON.stringify(k) : k.replace(/^-ms-/, "ms-").replace(/-([a-z])/g, (m, c) => c.toUpperCase()); return key + ": " + JSON.stringify(v); }).join(", ") + " }}";
  const toJsx = (n, ind) => {
    const pad = "  ".repeat(ind);
    if (n.nodeType === 3) {
      const t = n.textContent.replace(/\s+/g, " "), prev = n.previousSibling, next = n.nextSibling;
      if (!t.trim()) return prev && next ? pad + '{" "}\n' : "";
      const lead = t.startsWith(" ") && prev ? '{" "}' : "", trail = t.endsWith(" ") && next ? '{" "}' : "";
      return pad + lead + t.trim().replace(/[{}<>]/g, (c) => "{" + JSON.stringify(c) + "}") + trail + "\n";
    }
    if (n.nodeType !== 1) return "";
    const tag = n.tagName.toLowerCase();
    const attrs = [...n.attributes].map((a) => { const k = a.name.toLowerCase(); if (k === "style") return ` style=${jsxStyle(a.value)}`; if (k === "class" && !a.value.trim()) return ""; const nm = ATTR[k] || (k.startsWith("aria-") || k.startsWith("data-") ? k : k.replace(/-([a-z])/g, (m, c) => c.toUpperCase())); if (a.value === "" && /^(disabled|checked|hidden|required|readonly|multiple|selected|autoplay|loop|muted|controls|playsinline|async|defer)$/.test(k)) return ` ${nm}`; return ` ${nm}=${/[{}"\n]/.test(a.value) ? "{" + JSON.stringify(a.value) + "}" : '"' + a.value + '"'}`; }).join("");
    if (VOID.test(tag)) return `${pad}<${tag}${attrs} />\n`;
    const kids = [...n.childNodes].map((c) => toJsx(c, ind + 1)).join("");
    return kids ? `${pad}<${tag}${attrs}>\n${kids}${pad}</${tag}>\n` : `${pad}<${tag}${attrs}></${tag}>\n`;
  };
  /* computed line-height is always px; inheriting that px makes every bigger or smaller text the wrong height.
     If an ancestor with a different font size has the same ratio, the page set a unitless ratio, so write the ratio. */
  const lhOf = (el, cs) => {
    if (cs.lineHeight === "normal") return "normal";
    const r = parseFloat(cs.lineHeight) / parseFloat(cs.fontSize);
    for (let a = el.parentElement; a; a = a.parentElement) {
      const ac = getComputedStyle(a); if (ac.lineHeight === "normal") break; /* the value was set below this ancestor */
      if (ac.fontSize !== cs.fontSize) return Math.abs(parseFloat(ac.lineHeight) / parseFloat(ac.fontSize) - r) < 0.01 ? String(+r.toFixed(3)) : cs.lineHeight;
    }
    return String(+r.toFixed(3));
  };
  const compName = (el) => { const base = (el.id || (el.className && String(el.className).trim().split(/\s+/)[0]) || el.tagName.toLowerCase()).replace(/[^a-zA-Z0-9]+/g, " ").trim(); const n = base.split(" ").filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join(""); return /^[A-Za-z]/.test(n) ? n : "Section" + n; };
  const showCode = (el) => {
    mode = "codeout"; setActive(); lp.classList.add("show"); lp.style.width = "460px";
    lp.innerHTML = `<div class="empty">Reading the component\u2026</div>`;
    setTimeout(() => {
      let d; try { d = collectCode(el); } catch (err) { lp.innerHTML = `<div class="ph"><b>Capture code</b></div><div class="empty">Could not read this element: ${esc(err && err.message || err)}</div>`; return; }
      const name = compName(el), html = d.clone.outerHTML;
      const jsx = toJsx(d.clone, 2).replace(/\s+$/, "");
      const outs = {
        html: `<!-- ${name}.html -->\n${html}\n\n<style>\n${d.ctx}${d.css}\n</style>`,
        react: `// ${name}.jsx\nimport "./${name}.css";\n\nexport default function ${name}() {\n  return (\n${jsx.replace(/^ {4}/, "    ")}\n  );\n}\n\n/* ${name}.css */\n${d.ctx}${d.css}`
      };
      let tab = "react"; const S = d.stats;
      const draw = () => {
        const txt = outs[tab].length > 150000 ? outs[tab].slice(0, 150000) + "\n/* cut at 150k characters */" : outs[tab];
        lp.innerHTML = `<div class="ph"><b>Capture code</b><span class="mono">${esc(selectorOf(el))}</span></div>
          <div class="mnote cnote">Includes ${S.rules} matching rule${S.rules === 1 ? "" : "s"}, ${S.media} media quer${S.media === 1 ? "y" : "ies"}${S.container ? ", " + S.container + " container quer" + (S.container === 1 ? "y" : "ies") : ""}, ${S.vars} CSS variable${S.vars === 1 ? "" : "s"}, ${S.fonts} font rule${S.fonts === 1 ? "" : "s"}, ${S.kf} keyframe set${S.kf === 1 ? "" : "s"}. Measured ${S.w}px wide here. Image and font URLs are made absolute, so they load from the original site.</div>
          <div class="mtabs" style="padding:8px 16px 0"><button class="mtab${tab === "react" ? " on" : ""}" data-ct="react">React (JSX + CSS)</button><button class="mtab${tab === "html" ? " on" : ""}" data-ct="html">HTML + CSS</button></div>
          <div style="padding:8px 16px"><pre class="mcode" style="max-height:340px;overflow:auto;margin:0">${esc(txt)}</pre></div>
          <div class="mnote cnote">${d.assets.length ? d.assets.length + " asset URL" + (d.assets.length === 1 ? "" : "s") + " used (images, backgrounds, fonts). Download them if the component must work offline or off the original site." : "No images or font files found."} Scripts and JavaScript behaviour are not included. Rules are copied as written, so the component keeps its breakpoints. Check it in your project at narrow and wide widths.</div>
          <div class="foot"><button class="pbtn" id="ccopy">Copy ${tab === "react" ? "React component" : "HTML + CSS"}</button></div>`;
        lp.querySelectorAll("[data-ct]").forEach((b) => b.onclick = () => { tab = b.dataset.ct; draw(); });
        $("#ccopy").onclick = () => navigator.clipboard.writeText(outs[tab]).then(() => { $("#ccopy").textContent = "Copied"; }).catch(() => say("Clipboard was blocked."));
        window.__dsxCode = outs;
      };
      draw();
    }, 30);
  };
  const copyCode = (el) => showCode(el);
  const openFigMenu = (btn, kind = "figma") => {
    closeFigMenu(); figMenuOpen = kind; setActive();
    const m = document.createElement("div"); m.className = "fmenu";
    const ic = (d) => `<svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
    if (kind === "motion") {
      m.innerHTML = `<div class="fmh">Motion</div>`
        + `<button data-a="m-inspect">${ic('<path d="M3 3h9v5M3 3v9h4"/><path d="m9 9 6.5 2.4-2.9 1.2-1.2 2.9z"/>')}<span><b>Inspect an element</b><small>Read its animation, copy code or Figma</small></span><kbd>${MAC ? "\u2325" : "Alt+"}M</kbd></button>`
        + `<button data-a="m-record">${ic('<circle cx="9" cy="9" r="6.5"/><circle cx="9" cy="9" r="2.6" fill="currentColor"/>')}<span><b>Record the page</b><small>Catch hover, click and scroll animations</small></span><span class="pro">PRO</span></button>`
        + `<button data-a="m-gallery">${ic('<rect x="2.5" y="2.5" width="5.5" height="5.5" rx="1.2"/><rect x="10" y="2.5" width="5.5" height="5.5" rx="1.2"/><rect x="2.5" y="10" width="5.5" height="5.5" rx="1.2"/><rect x="10" y="10" width="5.5" height="5.5" rx="1.2"/>')}<span><b>Motion gallery</b><small>Your saved animations</small></span></button>`;
    } else if (kind === "shot") {
      m.innerHTML = `<div class="fmh">Screenshot to clipboard</div><button data-a="screen">${ic('<rect x="2" y="3" width="14" height="9.500" rx="1.500"/><path d="M6 15.500h6M9 12.500v3"/>')}<span><b>Screen</b><small>Pick a window or tab to capture</small></span></button><button data-a="visible">${ic('<path d="M3 6V4.500A1.500 1.500 0 0 1 4.500 3H6M12 3h1.500A1.500 1.500 0 0 1 15 4.500V6M15 12v1.500a1.500 1.500 0 0 1-1.500 1.500H12M6 15H4.500A1.500 1.500 0 0 1 3 13.500V12"/>')}<span><b>Visible area</b><small>What you can see now</small></span></button><button data-a="full">${ic('<rect x="4.500" y="2" width="9" height="14" rx="1.500"/><path d="M7 5.500h4M7 8.500h4M7 11.500h2"/>')}<span><b>Full page</b><small>Scrolls and stitches the whole page</small></span></button>`;
    } else
    m.innerHTML = `<div class="fmh">Copy to Figma</div>`
      + `<button data-a="select">${ic('<path d="M3 3h9v5M3 3v9h4"/><path d="m9 9 6.5 2.4-2.9 1.2-1.2 2.9z"/>')}<span><b>An element</b><small>Click any part of the page</small></span><kbd>${MAC ? "\u2325" : "Alt+"}G</kbd></button>`
      + `<button data-a="section">${ic('<rect x="2.5" y="3" width="13" height="12" rx="2"/><path d="M2.5 7.5h13M6 10.5h6M6 12.5h4"/><path d="M14.5 1.5l1 1.5 1.5.5-1.5.5-.5 1.5-.5-1.5L13 3.5l1.5-.5z" fill="currentColor" stroke="none"/>')}<span><b>A section with its motion</b><small>Scroll and loops become a Figma timeline</small></span><span class="pro">PRO</span></button>`
      + `<button data-a="design">${ic('<rect x="2.500" y="3.500" width="13" height="11" rx="2"/><path d="M2.500 7h13"/>')}<span><b>Whole page</b><small>Every section as editable layers</small></span></button>`
      + `<div class="fmh">Copy as code</div>`
      + `<button data-a="code">${ic('<path d="M6.5 3C5 3 4.5 3.8 4.5 5v1.5C4.5 7.6 3.8 8.5 2.8 9c1 .5 1.7 1.4 1.7 2.5V13c0 1.2.5 2 2 2M11.5 3c1.5 0 2 .8 2 2v1.5c0 1.1.7 2 1.7 2.5-1 .5-1.7 1.4-1.7 2.5V13c0 1.2-.5 2-2 2"/>')}<span><b>An element as code</b><small>React or HTML + CSS</small></span></button>`;
    root.appendChild(m); figMenu = m;
    const r = btn.getBoundingClientRect();
    m.style.left = Math.max(8, Math.min(r.left + r.width / 2 - m.offsetWidth / 2, innerWidth - m.offsetWidth - 8)) + "px";
    m.style.bottom = innerHeight - r.top + 10 + "px";
    const re = () => { if (!figMenu) return; const q = btn.getBoundingClientRect(); m.style.left = Math.max(8, Math.min(q.left + q.width / 2 - m.offsetWidth / 2, innerWidth - m.offsetWidth - 8)) + "px"; m.style.bottom = innerHeight - q.top + 10 + "px"; };
    setTimeout(re, 120); setTimeout(re, 480);
    const first = m.querySelector("button"); if (first) setTimeout(() => first.focus({ preventScroll: true }), 0);
    m.addEventListener("keydown", (e) => {
      if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
      const bs = [...m.querySelectorAll("button")], k = bs.indexOf(root.activeElement);
      bs[(k + (e.key === "ArrowDown" ? 1 : -1) + bs.length) % bs.length].focus(); e.preventDefault(); e.stopPropagation();
    });
    m.addEventListener("click", (e) => {
      const b = e.target.closest("button[data-a]"); if (!b) return; e.stopPropagation();
      const a = b.dataset.a; closeFigMenu();
      if (a === "m-inspect") return armMotion(true);
      if (a === "m-record") return startRecording();
      if (a === "m-gallery") return openGallery();
      if (a === "screen") return shotScreen();
      if (a === "visible") return shotVisible();
      if (a === "full") return fullShot();
      if (a === "design") { finishOpen = false; rp.classList.remove("show"); copyFigma(document.body); }
      else if (a === "select") armFigma(true);
      else if (a === "section") armSection();
      else { finishOpen = false; rp.classList.remove("show"); codeArmed = true; setPicking(true); codeArmed = true; setActive(); say("Click the element to copy as code. \u2191 picks the parent, Esc cancels."); }
    });
  };
  onL(document, "mousedown", (e) => { if (figMenu && !e.composedPath().includes(figMenu) && !e.composedPath().some((n) => n.dataset && (n.dataset.m === "figma" || n.dataset.m === "shot" || n.dataset.m === "motion"))) closeFigMenu(); }, true);

  /* ---------- Motion Recorder: keep every animation that plays, so finished ones can still be copied ---------- */
  let recTimer = 0, recPoll = 0, recT0 = 0;
  const recAsk = (type) => new Promise((res) => { try { chrome.runtime.sendMessage({ type }, (x) => res(x && x.ok ? x.data : null)); } catch (e) { res(null); } });
  const REC_MAX = 30;
  const drawRec = (data, live) => {
    const rows = (data && data.rows) || [];
    const left = Math.max(0, REC_MAX - Math.round((Date.now() - recT0) / 1000));
    const trigIcon = (t) => ({ hover: "Hover", click: "Click", scroll: "Scroll", key: "Key", focus: "Focus" }[t] || "Auto");
    lp.innerHTML = `<div class="ph"><b>Motion Recorder</b><span class="scan">${rows.length} animation${rows.length === 1 ? "" : "s"}</span></div>
      <div class="recbar${live ? " live" : ""}"><span class="recdot"></span><span class="rectxt">${live ? `Recording · hover, click and scroll the page · ${left}s` : `Stopped · ${data && data.kept ? data.kept + " animations kept" : "nothing kept"}`}</span><button class="mini${live ? "" : " pri"}" id="recbtn">${live ? "Stop" : "Record again"}</button></div>
      ${rows.length ? rows.map((r) => `<div class="recrow" data-rec="${r.id}"><div class="meta"><div class="nm">${esc(r.el)}${r.group ? ` <span class="tag">group</span>` : ""}</div><div class="sub">${esc(r.props.join(", "))} · ${r.dur ? r.dur + "s" : "instant"}</div></div><span class="rtrig">${r.triggers.map(trigIcon).join(" · ")}</span><div class="ra"><button class="mini" data-ri="${r.id}">Inspect</button><button class="mini ico" data-rf="${r.id}" aria-label="Copy to Figma with motion" data-tip="Copy to Figma with motion">${ICONS.figma}</button></div></div>`).join("")
        : `<div class="empty">${live ? "Waiting for animations.<br>Hover links and cards, click buttons, scroll the page." : "No animations were recorded."}</div>`}
      <div class="foot2">Recorded animations stay inspectable after they finish, even hover and scroll-in effects. ${data && data.on === false && !rows.length ? "" : ""}</div>`;
    const elOf = (id) => document.querySelector(`[data-dsx-rec="${id}"]`);
    lp.querySelector("#recbtn").onclick = () => live ? stopRecording() : startRecording();
    lp.querySelectorAll("[data-ri]").forEach((b) => b.onclick = () => { const el = elOf(b.dataset.ri); if (!el) return say("That element is no longer on the page."); stopRecording(true); showMotion(el); });
    lp.querySelectorAll("[data-rf]").forEach((b) => b.onclick = () => { const el = elOf(b.dataset.rf); if (!el) return say("That element is no longer on the page."); copyFigma(el); });
    lp.querySelectorAll(".recrow").forEach((row) => { row.onmouseenter = () => { const el = elOf(row.dataset.rec); if (!el) return; const r = el.getBoundingClientRect(); Object.assign(hl.style, { display: "block", left: r.left + "px", top: r.top + "px", width: r.width + "px", height: r.height + "px" }); }; row.onmouseleave = () => { hl.style.display = "none"; }; });
  };
  const startRecording = async () => {
    finishOpen = false; rp.classList.remove("show"); closeFigMenu();
    const st = await recAsk("dsx-rec-start");
    if (!st) { say("Could not start recording on this page."); return; }
    mode = "record"; setActive(); lp.classList.add("show"); lp.style.width = "380px"; recT0 = Date.now();
    if (!st.gsap) say("No GSAP on this page yet: CSS animations and transitions are recorded, and GSAP animations are recorded once it loads.");
    const tick = async () => { if (mode !== "record") return; drawRec(await recAsk("dsx-rec-list"), true); };
    clearInterval(recPoll); recPoll = setInterval(tick, 1000); tick();
    clearTimeout(recTimer); recTimer = setTimeout(() => stopRecording(), REC_MAX * 1000);
  };
  const stopRecording = async (quiet) => {
    clearInterval(recPoll); clearTimeout(recTimer);
    await recAsk("dsx-rec-stop");
    if (quiet || mode !== "record") return;
    const data = await recAsk("dsx-rec-list"); drawRec(data, false);
    recAsk("dsx-rec-start"); /* keep remembering in the background */
    say(data && data.rows && data.rows.length ? `Recorded ${data.rows.length} animation${data.rows.length === 1 ? "" : "s"}. Inspect one to copy its code or send it to Figma.` : "No animations were recorded.");
  };
  onL(document, "keydown", (e) => { if (e.key === "Escape" && figMenu) closeFigMenu(); }, true);

  /* ---------- bar wiring ---------- */
  root.querySelectorAll(".bar .btn[data-m]").forEach((b) => b.addEventListener("click", () => {
    const m = b.dataset.m;
    if (m === "notch") return setCollapsed(!collapsed);
    if (m === "theme") { host.classList.toggle("dark"); try { localStorage.setItem("dsx-theme", host.classList.contains("dark") ? "dark" : "light"); } catch (e) {} return; }
    if (m === "close") return requestClose();
    if (m === "pclose") { stopFind(); if (picking) setPicking(false); finishOpen = false; rp.classList.remove("show"); openMode(null); return; }
    if (m === "shot") { if (figMenuOpen === "shot") return closeFigMenu(); releaseTools("shot"); return openFigMenu(b, "shot"); }
    if (m === "figma") { if (figMenuOpen === "figma") return closeFigMenu(); if (figmaArmed || codeArmed) return setPicking(false); releaseTools("figma"); return openFigMenu(b); }
    if (m === "motion") {
      if (mode === "motion" || mode === "record") { if (mode === "record") stopRecording(true); return openMode(null); }
      if (motionArmed) return armMotion(false);
      if (figMenuOpen === "motion") return closeFigMenu();
      releaseTools("motion"); return openFigMenu(b, "motion");
    }
    if (m === "revert") return revertWithUndo();
    if (m === "compare") return toggleCompare();
    if (m === "finish") { if (finishOpen) { finishOpen = false; rp.classList.remove("show"); setActive(); } else { setPicking(false); showFinish(); } return; }
    if (m === "pick") { finishOpen = false; if (picking) { setPicking(false); } else { releaseTools("pick"); rp.classList.remove("show"); setPicking(true); } return; }
    releaseTools(m);
    openMode(mode === m ? null : m);
  }));
  onL(document, "keydown", (e) => { if (e.key === "Escape" && picking) setPicking(false); }, true);


  /* ---------- tooltips with shortcut hints, keyboard shortcuts ---------- */
  const MAC = /Mac|iPhone|iPad/.test(navigator.platform || "");
  const KEYS = { colours: ["Digit1", "1"], text: ["Digit2", "2"], spacing: ["Digit3", "3"], pick: ["Digit4", "4"], review: ["Digit5", "5"], flow: ["Digit6", "6"], finish: ["KeyF", "F"], issues: ["KeyI", "I"], notch: ["KeyD", "D"], compare: ["KeyB", "B"], effects: ["Digit7", "7"], shot: ["KeyP", "P"], figma: ["KeyG", "G"], motion: ["KeyM", "M"] };
  const hint = (m) => KEYS[m] ? (MAC ? "\u2325" + KEYS[m][1] : "Alt+" + KEYS[m][1]) : "";
  const tip = $("#tip");
  root.querySelectorAll(".bar .btn[data-m]").forEach((b) => {
    if (KEYS[b.dataset.m]) b.setAttribute("aria-keyshortcuts", "Alt+" + KEYS[b.dataset.m][1]);
    const show = () => {
      const h = hint(b.dataset.m);
      tip.innerHTML = `<span>${esc(b.dataset.tip || "")}</span>${h ? `<kbd>${esc(h)}</kbd>` : ""}`;
      const r = b.getBoundingClientRect();
      tip.classList.add("show");
      const w = tip.offsetWidth;
      tip.style.left = Math.max(8, Math.min(innerWidth - w - 8, r.left + r.width / 2 - w / 2)) + "px";
      tip.style.top = (r.top + r.height / 2 > innerHeight / 2 ? r.top - tip.offsetHeight - 10 : r.bottom + 10) + "px";
    };
    b.addEventListener("mouseenter", show); b.addEventListener("focus", show);
    b.addEventListener("mouseleave", () => tip.classList.remove("show")); b.addEventListener("blur", () => tip.classList.remove("show"));
    b.addEventListener("click", () => tip.classList.remove("show"));
  });
  /* tooltips for items inside panels (chips, info icons, row actions) */
  root.addEventListener("mouseover", (e) => {
    const t = e.target.closest && e.target.closest(".panel [data-tip]");
    if (!t) return;
    tip.innerHTML = `<span style="white-space:normal;max-width:260px;display:block">${esc(t.dataset.tip)}</span>`;
    const r = t.getBoundingClientRect(); tip.classList.add("show");
    const w = tip.offsetWidth;
    tip.style.left = Math.max(8, Math.min(innerWidth - w - 8, r.left + r.width / 2 - w / 2)) + "px";
    tip.style.top = (r.bottom + 8 + tip.offsetHeight > innerHeight ? r.top - tip.offsetHeight - 8 : r.bottom + 8) + "px";
  });
  root.addEventListener("mouseout", (e) => { if (e.target.closest && e.target.closest(".panel [data-tip]")) tip.classList.remove("show"); });
  onL(document, "keydown", (e) => {
    if (!e.altKey || e.ctrlKey || e.metaKey) return;
    const m = Object.keys(KEYS).find((k) => KEYS[k][0] === e.code);
    if (!m) return;
    const btn = root.querySelector(`.bar .btn[data-m=${m}]`);
    if (!btn || (m !== "notch" && collapsed) || btn.classList.contains("gone")) return;
    e.preventDefault(); e.stopPropagation();
    if (m === "motion") { closeFigMenu(); releaseTools("motion"); return armMotion(!motionArmed); } /* the shortcut goes straight to Inspect */
    btn.click();
  }, true);
  onL(document, "keydown", (e) => {
    if (e.key !== "Escape" || picking || activeKey || !mode) return;
    const a = document.activeElement; if (a && (a.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName))) return;
    openMode(null);
  }, true);

  let collapsed = true;
  const setCollapsed = (c) => {
    collapsed = c;
    $("#bar").classList.toggle("collapsed", c);
    host.classList.toggle("away", c);
    if (c && picking) setPicking(false);
  };
  
  /* ---------- compact the bar (icon-only except active tool) when it does not fit ---------- */
  let fitting = false;
  const fitBar = () => {
    fitting = true; queueMicrotask(() => { fitting = false; });
    const b = $("#bar");
    const narrow = innerWidth < 640; host.classList.toggle("narrow", narrow);
    if (b.classList.contains("collapsed")) { b.classList.remove("compact", "tight"); return; }
    const avail = innerWidth - (!narrow && host.classList.contains("lpopen") ? parseInt(host.style.getPropertyValue("--lpw") || "340", 10) + 44 : 16);
    /* measure on a hidden copy so the real bar's transitions are never interrupted */
    const c = b.cloneNode(true);
    c.classList.add("nofx"); c.classList.remove("compact", "tight", "on");
    c.style.cssText += ";visibility:hidden;pointer-events:none;transition:none";
    b.parentNode.appendChild(c);
    let want = 0;
    if (c.scrollWidth > avail) { want = 1; c.classList.add("compact"); if (c.scrollWidth > avail) { want = 2; c.classList.add("tight"); } }
    c.remove();
    b.classList.toggle("compact", want >= 1); b.classList.toggle("tight", want >= 2);
    if (narrow) requestAnimationFrame(() => { host.style.setProperty("--barh", Math.round(b.getBoundingClientRect().height) + "px"); });
  };
  obsL(new MutationObserver(() => { if (!fitting) setTimeout(fitBar, 0); })).observe(host, { attributes: true, attributeFilter: ["class", "style"] });
  /* only re-measure when something that changes the bar's natural width changed (a button shown/hidden, collapse state).
     Selecting a tool toggles .on only; measuring then used to switch transitions off for a frame and made the bar snap. */
  let barSig = "";
  const sigOf = () => { const b = $("#bar"); return b.className.replace(/\b(compact|tight|nofx)\b/g, "").trim() + "|" + [...b.querySelectorAll(".btn")].map((x) => (x.classList.contains("gone") ? 1 : 0) + (x.classList.contains("has") ? "h" : "")).join(""); };
  obsL(new MutationObserver(() => { if (fitting) return; const sg = sigOf(); if (sg === barSig) return; barSig = sg; setTimeout(fitBar, 0); })).observe($("#bar"), { attributes: true, attributeFilter: ["class"], subtree: true });
  onL(window, "resize", fitBar);
  setTimeout(fitBar, 400);

  /* ---------- drag the bar by the Design button; position remembered per site ---------- */
  const store = {
    get: (k) => new Promise((r) => { try { chrome.storage.local.get(k, (o) => r(o && o[k])); } catch (e) { r(undefined); } }),
    set: (k, v) => { try { chrome.storage.local.set({ [k]: v }); } catch (e) {} },
    del: (k) => { try { chrome.storage.local.remove(k); } catch (e) {} }
  };
  const barEl = $("#bar"), POSKEY = "dsx:pos:" + location.origin;
  const placeBar = (x, y) => {
    const w = barEl.offsetWidth, h = barEl.offsetHeight;
    x = Math.max(8, Math.min(innerWidth - w - 8, x)); y = Math.max(8, Math.min(innerHeight - h - 8, y));
    Object.assign(barEl.style, { left: x + "px", top: y + "px", bottom: "auto", transform: "none" }); barEl.classList.add("moved");
    return { x, y };
  };
  const resetBar = () => { ["left", "top", "bottom", "transform"].forEach((p) => barEl.style[p] = ""); barEl.classList.remove("moved"); };
  const brandBtn = root.querySelector(".btn.brand");
  let dragSt = null, dragged = false;
  brandBtn.addEventListener("mousedown", (e) => { if (e.button !== 0) return; const r = barEl.getBoundingClientRect(); dragSt = { sx: e.clientX, sy: e.clientY, x: r.left, y: r.top }; dragged = false; });
  onL(window, "mousemove", (e) => {
    if (!dragSt) return;
    if (!dragged && Math.hypot(e.clientX - dragSt.sx, e.clientY - dragSt.sy) < 5) return;
    dragged = true; barEl.classList.add("dragging");
    placeBar(dragSt.x + e.clientX - dragSt.sx, dragSt.y + e.clientY - dragSt.sy);
  }, true);
  onL(window, "mouseup", () => {
    if (!dragSt) return;
    if (dragged) { const r = barEl.getBoundingClientRect(); store.set(POSKEY, { x: r.left, y: r.top }); setTimeout(() => { dragged = false; }, 0); }
    dragSt = null; barEl.classList.remove("dragging");
  }, true);
  brandBtn.addEventListener("click", (e) => { if (dragged) { e.stopImmediatePropagation(); e.preventDefault(); } }, true);
  brandBtn.addEventListener("contextmenu", (e) => { e.preventDefault(); resetBar(); store.del(POSKEY); });
  store.get(POSKEY).then((p) => { if (p && typeof p.x === "number") placeBar(p.x, p.y); });
  onL(window, "resize", () => { if (barEl.style.left) { const r = barEl.getBoundingClientRect(); placeBar(r.left, r.top); } });

  host.classList.add("away");
  setTimeout(() => setCollapsed(false), 160);
  /* remember every animation that plays while Blue Dot is open, so a section you already scrolled past still copies */
  setTimeout(() => { try { chrome.runtime.sendMessage({ type: "dsx-rec-start" }, () => void chrome.runtime.lastError); } catch (e) {} }, 300);
  const destroy = () => {
    // closing keeps nothing: edits are temporary, and nothing keeps running after close
    revertAll(); setPicking(false);
    try { stopFind(); } catch (e) {}
    try { if (flowAbort) flowAbort.abort(); } catch (e) {}            /* stop a running flow scan */
    try { if (motionStop) { motionStop(); motionStop = null; } } catch (e) {}  /* stop an active Watch */
    clearInterval(recPoll); clearTimeout(recTimer);                  /* recorder UI timers */
    try { chrome.runtime.sendMessage({ type: "dsx-rec-stop" }, () => void chrome.runtime.lastError); } catch (e) {}
    lifeObs.splice(0).forEach((o) => { try { o.disconnect(); } catch (e) {} });
    lifeLs.splice(0).forEach(([t, n, f, o]) => { try { t.removeEventListener(n, f, o); } catch (e) {} });
    host.remove(); sheet.remove(); delete window.__dsx;
  };
  /* closing discards edits, so ask once when there is unsaved work */
  let closeArm = 0;
  const requestClose = () => {
    const n = log.size;
    if (!n || Date.now() - closeArm < 6000) return destroy();
    closeArm = Date.now();
    say(`Close Blue Dot? Your ${n} change${n === 1 ? "" : "s"} will be lost.`, { label: "Close anyway", fn: destroy });
  };
  window.__dsx = { toggle: requestClose };
  setActive();
})();
