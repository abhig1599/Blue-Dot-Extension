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
  let mode = null, picking = false, selected = null, finishOpen = false, figmaArmed = false, motionArmed = false, codeArmed = false;

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
    const names = new Set();
    const walk = (rules) => {
      for (const r of rules) {
        if (r.style) for (const n of r.style) if (n.startsWith("--")) names.add(n);
        if (r.cssRules) try { walk(r.cssRules); } catch (e) {}
      }
    };
    for (const sh of document.styleSheets) { try { walk(sh.cssRules); } catch (e) {} }
    const probe = document.createElement("span");
    probe.style.display = "none";
    document.body.appendChild(probe);
    for (const n of names) {
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
    close: hi("<path fill=\"none\" stroke=\"currentColor\" stroke-linecap=\"round\" stroke-linejoin=\"round\" stroke-width=\"1.5\" d=\"M18 6L6 18m12 0L6 6\"/>")
  };
  root.innerHTML = `
  <style>
    :host{all:initial}
    *{box-sizing:border-box;font-family:"SF Pro Text",Inter,-apple-system,"Segoe UI",system-ui,sans-serif;-webkit-font-smoothing:antialiased}
    :host{--bg:#000;--panel:rgba(9,9,9,.88);--line:rgba(255,255,255,.08);--line2:rgba(255,255,255,.14);--fg:#f2f2f2;--mut:#8c8c8c;--fill:#161616;--red:#ff453a;--amb:#ffd60a;--grn:#30d158;--spring:cubic-bezier(.34,1.32,.64,1)}
    .mono,.ph span,.sec,.lbl,.hex,.k2,.vn,.inp,.arrow,.sub.mono{font-family:ui-monospace,"SF Mono","JetBrains Mono",Menlo,monospace}
    /* island bar */
    .bar{position:fixed;top:12px;left:50%;transform:translateX(-50%);display:flex;align-items:center;width:fit-content;max-width:min(980px,calc(100vw - 16px));padding:5px;background:#000;border-radius:999px;box-shadow:0 14px 44px rgba(0,0,0,.5),0 0 0 1px rgba(255,255,255,.1),inset 0 1px 0 rgba(255,255,255,.06);pointer-events:auto;color:var(--fg);overflow:hidden;user-select:none;transition:max-width .7s var(--spring),padding .4s,box-shadow .4s}
    .bar.collapsed{max-width:136px}
    .tools{flex:none;display:flex;align-items:center;gap:2px;margin-left:2px;transition:opacity .3s .12s,transform .5s var(--spring),filter .3s}
    .bar.collapsed .tools{opacity:0;transform:scale(.85);filter:blur(4px);pointer-events:none;transition-delay:0s}
    .btn{all:unset;box-sizing:border-box;display:flex;align-items:center;gap:0;height:34px;min-width:34px;justify-content:center;padding:0 11px;border-radius:999px;cursor:pointer;color:#b8b8b8;font:500 12.5px "SF Pro Text",Inter,system-ui,sans-serif;white-space:nowrap;position:relative;transition:background .2s,color .2s}
    .btn:hover{background:rgba(255,255,255,.1);color:#fff}
    .btn:focus-visible{outline:2px solid #fff;outline-offset:1px}
    .btn>span:not(.badge){margin-left:7px}
    .btn.on{background:rgba(255,255,255,.12);color:#fff}
        .btn.on::after{content:"";position:absolute;bottom:-1px;left:50%;width:4px;height:4px;margin-left:-2px;border-radius:50%;background:var(--grn);box-shadow:0 0 8px var(--grn)}
    .btn[data-m=revert]>span,.btn[data-m=finish]>span:not(.badge){display:none!important}
    .btn.brand{flex:none;color:#fff;padding:0 12px 0 10px;gap:8px;min-width:0}
    .btn.brand>span{margin:0;font-weight:600;letter-spacing:.01em}
    .pdot{width:8px;height:8px;border-radius:50%;background:#fff;box-shadow:0 0 0 3px rgba(255,255,255,.14);flex:none;transition:background .3s,box-shadow .3s}
    .bar:not(.collapsed) .pdot{background:var(--grn);box-shadow:0 0 0 3px rgba(48,209,88,.18),0 0 10px var(--grn)}
    .sep{width:1px;height:18px;background:var(--line2);margin:0 5px}
    .badge{min-width:16px;height:16px;border-radius:8px;background:#fff;color:#000;font:600 11px/16px ui-monospace,Menlo,monospace;text-align:center;padding:0 4px;display:none;margin-left:5px}
    .badge.show{display:inline-block}
    /* panels */
    .panel{position:fixed;top:66px;width:300px;max-height:calc(100vh - 86px);overflow:auto;background-color:var(--panel);background-image:radial-gradient(rgba(255,255,255,.075) 1px,transparent 1.2px);background-size:14px 14px;-webkit-backdrop-filter:blur(28px) saturate(1.4);backdrop-filter:blur(28px) saturate(1.4);color:var(--fg);border-radius:24px;box-shadow:0 28px 70px rgba(0,0,0,.55),0 0 0 1px var(--line),inset 0 1px 0 rgba(255,255,255,.05);pointer-events:auto;font-size:12px;visibility:hidden;opacity:0;transform:translateY(-14px) scale(.94);transform-origin:top center;transition:opacity .25s,transform .55s var(--spring),visibility 0s linear .55s}
    #lp{left:16px;transform-origin:top left}#rp{right:16px;transform-origin:top right}
    .panel.show{visibility:visible;opacity:1;transform:none;transition:opacity .25s,transform .55s var(--spring),visibility 0s}
    :host(.away) .panel.show{visibility:hidden;opacity:0;transform:translateY(-14px) scale(.94);transition:opacity .2s,transform .4s,visibility 0s linear .4s}
    .ph{position:sticky;top:0;background:rgba(9,9,9,.92);-webkit-backdrop-filter:blur(20px);backdrop-filter:blur(20px);padding:16px 18px 12px;border-bottom:1px solid var(--line);display:flex;justify-content:space-between;align-items:baseline;z-index:2}
    .ph b{font-size:14px;font-weight:600;color:#fff;letter-spacing:-.01em}
    .ph span{font-size:11px;color:var(--mut);letter-spacing:.08em;text-transform:uppercase}
    .row{display:flex;align-items:center;gap:12px;padding:10px 18px;border-bottom:1px solid var(--line)}
    .row:hover{background:rgba(255,255,255,.04)}
    .sw{position:relative;width:30px;height:30px;border-radius:50%;flex:none;box-shadow:inset 0 0 0 1px var(--line2);cursor:pointer;overflow:hidden}
    .sw input{position:absolute;inset:-6px;width:42px;height:42px;opacity:0;cursor:pointer}
    .meta{flex:1;min-width:0}
    .nm{color:#fff;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .sub{color:var(--mut);font-size:11px;margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .hex{font-size:11px;color:#bdbdbd;letter-spacing:.02em}
    .chg{color:var(--grn)}
    .inp{all:unset;box-sizing:border-box;background:var(--fill);border-radius:10px;height:28px;padding:0 10px;color:#fff;font-size:11.5px;border:1px solid var(--line);width:100%}
    .inp:focus{border-color:#fff}
    select.inp{display:block;line-height:26px;padding:0 24px 0 10px;background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6'%3E%3Cpath d='M1 1l4 4 4-4' fill='none' stroke='%23888' stroke-width='1.5' stroke-linecap='round'/%3E%3C/svg%3E");background-repeat:no-repeat;background-position:right 9px center;cursor:pointer}
    .tcard{padding:14px 18px;border-bottom:1px solid var(--line)}
    .tprev{color:#fff;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin:8px 0 11px;max-width:100%}
    .grid{display:grid;grid-template-columns:1fr 1fr;gap:8px}
    .lbl{font-size:11px;color:var(--mut);text-transform:uppercase;letter-spacing:.1em;margin-bottom:4px}
    .bars{flex:none;width:96px;height:4px;background:#1c1c1c;border-radius:4px;overflow:hidden}
    .bars i{display:block;height:100%;background:#fff;border-radius:4px;transition:width .4s}
    .sp{display:flex;align-items:center;gap:8px}.sp .inp{width:60px}
    .empty{padding:22px 18px;color:var(--mut)}
    .sec{padding:14px 18px 6px;font-size:11px;color:var(--mut);text-transform:uppercase;letter-spacing:.12em}
    .erow{display:flex;align-items:center;gap:8px;padding:6px 18px}
    .erow .k{width:84px;flex:none;color:var(--mut)}
    .erow .v{flex:1;min-width:0}
    .vn{font-size:11px;color:#fff;margin-top:4px;word-break:break-all;opacity:.85}
    .cw{display:flex;align-items:center;gap:8px}
    .cw .sw{width:22px;height:22px}.cw .sw input{width:34px;height:34px}
    .foot{position:sticky;bottom:0;background:rgba(9,9,9,.92);-webkit-backdrop-filter:blur(20px);backdrop-filter:blur(20px);padding:12px 18px 14px;border-top:1px solid var(--line);display:flex;gap:8px}
    .pbtn{all:unset;flex:1;text-align:center;height:34px;line-height:34px;border-radius:999px;background:#fff;color:#000;font:600 12px "SF Pro Text",Inter,system-ui,sans-serif;cursor:pointer;transition:transform .2s var(--spring),opacity .2s}
    .pbtn.sec2{background:#1a1a1a;color:#f2f2f2;box-shadow:inset 0 0 0 1px var(--line2)}
    .pbtn:hover{transform:scale(1.03)}.pbtn:focus-visible{outline:2px solid #fff;outline-offset:2px}
    .ch{padding:12px 18px;border-bottom:1px solid var(--line)}
    .ch .t{color:#fff;font-weight:500;margin-bottom:7px}
    .arrow{display:flex;align-items:center;gap:8px;font-size:11px;color:#bdbdbd}
    .dot{width:14px;height:14px;border-radius:50%;box-shadow:inset 0 0 0 1px var(--line2);flex:none}
    #hl{position:fixed;pointer-events:none;border:1.5px solid var(--red);background:rgba(255,69,58,.10);border-radius:4px;display:none;transition:all .08s}
    #hlt{position:fixed;pointer-events:none;background:#000;color:#fff;font:500 11px ui-monospace,Menlo,monospace;padding:3px 8px;border-radius:999px;display:none;box-shadow:0 0 0 1px var(--line2)}
    .lt{padding:0 18px 9px 60px;font-size:11px;line-height:1.4;color:var(--red)}
    .lt.warn{color:var(--amb)}.lt.ok{color:var(--grn)}
    .fnrow{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:2px 18px 9px 60px}#elint .fnrow,.tcard .lint .fnrow{padding-left:0}
    .fixnow{all:unset;box-sizing:border-box;min-height:26px;max-width:100%;white-space:nowrap;padding:0 12px;border-radius:12px;background:#0d99ff;color:#fff;font:600 11.5px Inter,system-ui,sans-serif;cursor:pointer;display:inline-flex;align-items:center}.fixnow:hover{background:#2aa6ff}.fixnow.ghost{background:rgba(255,255,255,.14)}.fixnow[disabled]{opacity:.6;cursor:default}
    .fnsub{font:400 11px Inter,system-ui,sans-serif;color:#b8b8b8}
    #elint .lt,.tcard .lint .lt{padding-left:0}
    #elint{padding:10px 18px 2px}.tcard .lint{margin-top:10px}.tcard .lint:empty{display:none}
    .d{display:inline-block;width:8px;height:8px;border-radius:50%;flex:none;margin-right:5px;background:var(--red);box-shadow:0 0 8px rgba(255,69,58,.5)}
    .d.warn{background:var(--amb);box-shadow:0 0 8px rgba(255,214,10,.4)}.d.ok{background:var(--grn);box-shadow:0 0 8px rgba(48,209,88,.4)}
    .gh{display:flex;justify-content:space-between;align-items:center;padding-top:16px;color:#bdbdbd}
    .gh span{display:flex;align-items:center;gap:2px;font-size:11px;letter-spacing:0;text-transform:none;color:var(--mut)}
    .fnd{border-bottom:1px solid var(--line)}
    .fnd summary{display:flex;gap:10px;align-items:flex-start;padding:10px 18px;cursor:pointer;list-style:none}
    .fnd summary::-webkit-details-marker{display:none}
    .fnd summary:hover{background:rgba(255,255,255,.04)}
    .fnd summary .d{margin-top:4px;margin-right:0}
    .fnd .wrap,.fl .wrap{white-space:normal;line-height:1.45}
    .fnd[data-flat] summary{cursor:default}
    .it{display:flex;justify-content:space-between;gap:10px;padding:6px 18px 6px 38px;font-size:11px}
    .it.go{cursor:pointer}.it.go:hover{background:rgba(255,255,255,.08)}
    .it .k2,.fl .k2{font-size:11px;color:#fff;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:160px}
    .it .sub{margin:0;text-align:right;white-space:normal}
    .foot2{padding:14px 18px;font-size:11px;line-height:1.5;color:var(--mut)}
    .fl{display:flex;gap:10px;align-items:flex-start;padding:9px 18px;border-bottom:1px solid var(--line)}
    .fl .d{margin-top:4px;margin-right:0}.fl.go{cursor:pointer}.fl.go:hover{background:rgba(255,255,255,.07)}
    .fl .k2{max-width:none}
    ::-webkit-scrollbar{width:6px}::-webkit-scrollbar-thumb{background:#2a2a2a;border-radius:6px}

    .gone{display:none!important}
    .btn[data-m=issues]{padding:0 4px;min-width:30px}
    .ibadge{font-style:normal;min-width:20px;height:20px;border-radius:10px;background:#d32f2f;color:#fff;font:700 11px/20px ui-monospace,Menlo,monospace;letter-spacing:0;text-align:center;padding:0 5px;box-shadow:0 0 0 2px var(--bar,#000);animation:ipop .35s var(--spring)}
    @keyframes ipop{from{transform:scale(.4)}to{transform:none}}
    #mk{position:fixed;inset:0;pointer-events:none}
    :host(.away) #mk{display:none}
    .mk{position:fixed;pointer-events:none;border-radius:2px}
    .mk.err{background:rgba(211,47,47,.07)}.mk.warn{background:rgba(224,138,0,.07)}
    .mk.act{outline:1.5px dashed #d32f2f;outline-offset:1px}.mk.warn.act{outline-color:#e08a00}
    .sq{position:fixed;height:5px;pointer-events:auto;cursor:pointer;background-repeat:repeat-x;background-position:0 0;outline:none}
    .sq.err{background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='6' height='5'%3E%3Cpath d='M0 4L1.5 1L4.5 4L6 1' fill='none' stroke='%23d32f2f' stroke-width='1.3'/%3E%3C/svg%3E")}
    .sq.warn{background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='6' height='5'%3E%3Cpath d='M0 4L1.5 1L4.5 4L6 1' fill='none' stroke='%23e08a00' stroke-width='1.3'/%3E%3C/svg%3E")}
    .sq:focus-visible{outline:2px solid #fff;box-shadow:0 0 0 4px #d32f2f}
    .pop{position:fixed;width:290px;pointer-events:auto;background:#121212;color:#f2f2f2;border-radius:8px;box-shadow:0 0 0 1px rgba(255,255,255,.18),0 16px 36px rgba(0,0,0,.45);font-size:12px;line-height:1.45;padding:12px 14px 12px;visibility:hidden;opacity:0;transform:translateY(-6px);transition:opacity .15s,transform .25s var(--spring),visibility 0s linear .25s;z-index:5}
    .pop.show{visibility:visible;opacity:1;transform:none;transition:opacity .15s,transform .25s var(--spring),visibility 0s}
    .pop .pt{display:flex;align-items:center;gap:8px;margin-bottom:6px}
    .pop .pt b{font:700 11.5px ui-monospace,Menlo,monospace;letter-spacing:.07em;text-transform:uppercase;flex:1}
    .pop .tag{font:700 11px ui-monospace,Menlo,monospace;letter-spacing:.08em;padding:2px 6px;border-radius:4px;background:#d32f2f;color:#fff}
    .pop .tag.warn{background:#ffb020;color:#000}
    .pop p{margin:0 0 8px;color:inherit;opacity:.85}
    .pop .fx{display:flex;align-items:center;gap:8px;background:rgba(255,255,255,.08);border-radius:6px;padding:7px 9px;margin-bottom:8px}
    .pop .fx i{width:16px;height:16px;border-radius:4px;box-shadow:inset 0 0 0 1px rgba(128,128,128,.6);flex:none}
    .pop .fx span{font:11px ui-monospace,Menlo,monospace}
    .pop .el{font:11px ui-monospace,Menlo,monospace;color:#a8a8a8;margin-bottom:9px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .pop .note{font-size:11px;opacity:.9;margin-bottom:8px}
    .pop .acts{display:flex;gap:6px;flex-wrap:wrap}
    .pb{all:unset;box-sizing:border-box;height:28px;padding:0 10px;border-radius:6px;font:700 11px ui-monospace,Menlo,monospace;letter-spacing:.06em;text-transform:uppercase;cursor:pointer;display:inline-flex;align-items:center;background:var(--org,#ff6a13);color:#000}
    .pb.b2{background:#fff;color:#000}.pb.gh2{background:transparent;color:inherit;box-shadow:inset 0 0 0 1px rgba(128,128,128,.6)}
    .pb:hover{filter:brightness(1.08)}.pb:focus-visible{outline:2px solid #fff;outline-offset:1px}
    .irow{display:flex;gap:10px;align-items:flex-start;padding:10px 18px;border-bottom:1px solid var(--line);cursor:pointer}
    .irow:hover{background:rgba(255,255,255,.06)}
    .irow .d{margin:4px 0 0}.irow .meta .nm{white-space:normal}

    .grp{display:flex;align-items:center;gap:2px}
    .tools{gap:8px}
    #tip{position:fixed;pointer-events:none;background:#1c1c1c;color:#f2f2f2;border-radius:10px;padding:6px 8px 6px 10px;font:500 12px Inter,"SF Pro Text",system-ui,sans-serif;display:flex;gap:8px;align-items:center;opacity:0;transform:translateY(-4px);transition:opacity .12s,transform .18s;white-space:nowrap;box-shadow:0 6px 18px rgba(0,0,0,.35);z-index:9}
    #tip.show{opacity:1;transform:none}
    #tip kbd{font:600 11px ui-monospace,Menlo,monospace;background:rgba(255,255,255,.16);border-radius:5px;padding:2px 6px}
    .btn.dis{opacity:.42}
    /* v1.9 classic look: the original dark Figma-style bar with blue accent. Light theme removed. */
    :host{--panel:#1e1e1e;--line:rgba(255,255,255,.08);--line2:rgba(255,255,255,.14);--fill:#2c2c2c;--grn:#0d99ff;--org:#0d99ff;--bar:#2c2c2c}
    .bar{top:14px;gap:2px;padding:6px;background:#2c2c2c;border-radius:14px;box-shadow:0 8px 28px rgba(0,0,0,.45),0 0 0 1px rgba(255,255,255,.06);width:fit-content;overflow:hidden}
    .bar.collapsed{max-width:132px}
    .tools{gap:2px;margin-left:0}
    .btn{height:32px;min-width:0;padding:0 11px;border-radius:8px;gap:0;color:#e6e6e6;font:500 12.5px Inter,-apple-system,system-ui,sans-serif}
    .btn:hover{background:rgba(255,255,255,.09);color:#fff}
    .btn.on{background:#0d99ff;color:#fff}
    .btn.on::after{display:none}
    .btn:focus-visible{outline:2px solid #fff;outline-offset:1px}
    .btn[data-m=revert]>span,.btn[data-m=finish]>span:not(.badge){display:inline!important}
    .btn.brand{padding:0 8px 0 10px;margin-right:0;border-right:0;border-radius:8px;gap:0}
    .btn.brand:hover{background:none}
    .btn.brand .pdot{width:22.4px;height:20.8px;margin:0 2.8px;border-radius:0;background:none;padding:0;box-sizing:border-box;position:relative;display:block;flex:none}.btn.brand .pdot svg{display:block;width:100%;height:100%}
    
    .bar:not(.collapsed) .pdot{background:none;box-shadow:none}
    .btn.brand>span{font-weight:600}
    .sep{height:22px;margin:0 4px}
    .badge{background:#0d99ff;color:#fff;font:600 10px/16px Inter,system-ui,sans-serif}
    .panel{top:70px;border-radius:12px;background-color:#1e1e1e;background-image:none;-webkit-backdrop-filter:none;backdrop-filter:none;box-shadow:0 12px 36px rgba(0,0,0,.5),0 0 0 1px rgba(255,255,255,.07)}
    .ph,.foot{background:#1e1e1e;-webkit-backdrop-filter:none;backdrop-filter:none}
    .ph{padding:12px 14px 10px}
    .ph b{font-size:12px;letter-spacing:.01em}
    .ph span{letter-spacing:0;text-transform:none;font-family:Inter,system-ui,sans-serif}
    .row,.tcard,.erow{padding-left:14px;padding-right:14px}
    .sw{border-radius:7px}.cw .sw{border-radius:5px}
    .inp{background:#2c2c2c;border-radius:6px;border:1px solid transparent}.inp:focus{border-color:#0d99ff}
    .chg{color:#0d99ff}.vn{color:#0d99ff;opacity:1}
    .bars{background:#2c2c2c}.bars i{background:#0d99ff}
    .pbtn{border-radius:7px;background:#0d99ff;color:#fff;height:30px;line-height:30px;font:500 12px Inter,system-ui,sans-serif}
    .pbtn.sec2{background:#2c2c2c;color:#e6e6e6;box-shadow:none}
    .pbtn:hover{transform:none;filter:brightness(1.12)}
    .pb{background:#0d99ff;color:#fff}.pb.b2{background:#2c2c2c;color:#e6e6e6}
    .dot{border-radius:4px}
    #hl{border-color:#0d99ff;background:rgba(13,153,255,.12)}
    #hlt{background:#0d99ff;border-radius:4px;box-shadow:none}
    ::-webkit-scrollbar{width:8px}::-webkit-scrollbar-thumb{background:#3a3a3a;border-radius:4px}
    .ibadge{box-shadow:0 0 0 2px #2c2c2c}
    .btn.on .badge{background:#fff;color:#0d99ff}
    /* v2.0: bottom bar, docked panel, grouped toolbar, chips, shapes, hover actions */
    :host{--mut:#a8a8a8}
    .bar{top:auto;bottom:18px;max-width:min(1240px,calc(100vw - 16px));transition:max-width .7s var(--spring),padding .4s,box-shadow .4s,opacity .2s}
    .bar.dragging{cursor:grabbing;box-shadow:0 14px 40px rgba(0,0,0,.55),0 0 0 1px rgba(13,153,255,.6)}
    .btn.brand{cursor:grab}
    .tools{gap:6px}
    .sep{margin:0 3px}
    .btn[data-m=revert]{color:#a8a8a8}
    .btn[data-m=revert]:hover{color:#fff}
    .btn[data-m=finish].has{background:#0d99ff;color:#fff}
    .btn[data-m=finish].has:hover{background:#2aa6ff}
    .btn[data-m=finish].has.on{box-shadow:0 0 0 2px #2c2c2c,0 0 0 4px #0d99ff}
    .btn[data-m=finish]>.badge,.btn.on .badge{background:transparent;color:inherit;min-width:0;padding:0;margin-left:5px;font:600 12.5px Inter,system-ui,sans-serif;height:auto;line-height:inherit}
    .badge::before{content:"\\00b7\\00a0"}
    .panel{top:12px;bottom:12px;height:auto;max-height:none;font-size:13px;transform:translateX(24px) scale(.98);transform-origin:right center}
    #lp{left:auto;right:12px;transform-origin:right center;transition:opacity .25s,transform .45s var(--spring),visibility 0s linear .45s}
    #lp.show{transition:opacity .25s,transform .45s var(--spring),visibility 0s}
    #rp{left:auto;right:12px;bottom:auto;max-height:calc(100vh - 24px);transform-origin:right top}
    :host(.lpopen) #rp{right:calc(var(--lpw,300px) + 24px)}
    #lp.peek{transform:translateX(calc(100% + 24px))!important;box-shadow:none;opacity:0}
    #peek{all:unset;box-sizing:border-box;position:fixed;right:0;top:50%;transform:translateY(-50%);background:#0d99ff;color:#fff;font:600 12px Inter,system-ui,sans-serif;padding:10px 12px;border-radius:10px 0 0 10px;cursor:pointer;pointer-events:auto;box-shadow:0 6px 20px rgba(0,0,0,.4);writing-mode:vertical-rl}
    #peek:focus-visible{outline:2px solid #fff}
    .sub{font-size:12px}
    .ph{padding:14px 16px 10px;gap:10px}
    .ph b{font-size:14px}
    .ph span{font-size:12px;color:var(--mut)}
    .ph .scan{display:flex;align-items:center;gap:4px}
    .ibtn{all:unset;display:inline-grid;place-items:center;width:22px;height:22px;border-radius:6px;cursor:pointer;color:var(--mut)}
    .ibtn:hover{background:rgba(255,255,255,.1);color:#fff}.ibtn:focus-visible{outline:2px solid #fff}
    .dtl{display:none;padding:10px 16px;font-size:12px;line-height:1.5;color:var(--mut);background:#262626;border-bottom:1px solid var(--line)}
    .dtl.show{display:block}
    .chips{display:flex;gap:6px;padding:10px 16px;border-bottom:1px solid var(--line);flex-wrap:wrap}
    .chip{all:unset;box-sizing:border-box;display:inline-flex;align-items:center;gap:6px;height:28px;padding:0 11px;border-radius:14px;background:#2c2c2c;color:#e6e6e6;font:500 12.5px Inter,system-ui,sans-serif;cursor:pointer;box-shadow:inset 0 0 0 1px transparent}
    .chip b{font-weight:700;color:#fff}
    .chip:hover{background:#363636}
    .chip.on{background:#0d99ff;color:#fff;box-shadow:none}.chip.on .shp{color:#fff!important}
    .chip:focus-visible{outline:2px solid #fff;outline-offset:1px}
    .shp{flex:none;display:inline-grid;place-items:center;width:18px;font:700 14px/1 Inter,system-ui,sans-serif}
    .shp.err{color:#ff6b61}.shp.warn{color:#ffc933}.shp.ok{color:#6ab7ff}
    .pg{border-bottom:1px solid var(--line)}
    .pg>summary{display:flex;align-items:center;gap:8px;padding:11px 16px;cursor:pointer;list-style:none;position:sticky;top:0;background:#1e1e1e;z-index:1}
    .pg>summary::-webkit-details-marker{display:none}
    .pg>summary:hover{background:#262626}
    .pg>summary code{font:12px ui-monospace,Menlo,monospace;color:#fff;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .pg>summary .pc{font-size:12px;color:var(--mut);white-space:nowrap}
    .pg .chev{transition:transform .2s;flex:none;color:var(--mut)}.pg:not([open]) .chev{transform:rotate(-90deg)}
    code{font:12px ui-monospace,Menlo,monospace;color:#d6e4ff;background:rgba(255,255,255,.07);padding:0 4px;border-radius:4px}
    .fl,.irow,.fnd summary{position:relative;display:flex;gap:10px;align-items:flex-start;padding:10px 16px}
    .fl .shp,.irow .shp,.fnd summary .shp{margin-top:1px}
    .ttl{display:flex;align-items:center;gap:8px;min-width:0}
    .ttl .nm{font-size:13px}
    .tag{flex:none;font:600 11px Inter,system-ui,sans-serif;color:#cfcfcf;background:#333;border-radius:5px;padding:1px 6px}
    .tag.mono{font-family:ui-monospace,Menlo,monospace;font-weight:500}
    .fl .sub,.irow .sub{margin-top:2px;line-height:1.4}
    .fl.go,.irow{cursor:pointer}
    .fl:hover,.irow:hover{background:rgba(255,255,255,.05)}
    .racts{display:none;position:absolute;right:10px;top:5px;gap:0;background:#262626;border-radius:8px;padding:1px;box-shadow:0 2px 10px rgba(0,0,0,.4),0 0 0 1px rgba(255,255,255,.08)}
    .fl:hover .racts,.irow:hover .racts,.fl:focus-within .racts,.irow:focus-within .racts{display:flex}
    .racts button{all:unset;box-sizing:border-box;height:22px;line-height:22px;padding:0 8px;border-radius:6px;font:600 11.5px Inter,system-ui,sans-serif;color:#e6e6e6;cursor:pointer}
    .racts button:hover{background:#0d99ff;color:#fff}.racts button:focus-visible{outline:2px solid #fff}
    .gw .gh{padding:14px 16px 6px;text-transform:none;letter-spacing:0;font:600 12.5px Inter,system-ui,sans-serif;color:#fff;display:flex;justify-content:space-between}
    .gw .gh span{font-weight:500;font-size:12px;color:var(--mut);letter-spacing:0;text-transform:none}
    .it{padding-left:44px}
    .foot{padding:12px 16px}
    .foot .pbtn{height:34px;line-height:34px;font-size:12.5px}
    .tprev,.erow .k{font-size:12px}.lbl{font-size:11.5px}
    .foot{z-index:4}
    .pg>summary code{background:none;padding:0}
    :host(.lpopen) .bar:not(.moved){left:calc((100vw - var(--lpw,300px) - 24px) / 2)}
    :host(.lpopen) .bar{max-width:min(1240px,calc(100vw - var(--lpw,300px) - 44px))}
    .bar.compact .btn:not(.on):not(.brand):not(.has)>span:not(.badge){display:none}
    .bar.compact .btn{padding:0 9px}
    .bar.tight .btn>span:not(.badge){display:none!important}
    .bar.compact .btn[data-m=finish].has{padding:0 11px}
    .panel{display:flex;flex-direction:column}.panel>*{flex:none}
    .panel>.foot{margin-top:auto}
    .bar.tight .btn.brand>span{display:inline!important}
    .pop .pt b{font:600 13px Inter,system-ui,sans-serif;letter-spacing:0;text-transform:none}
    .pop .tag{font:700 11px Inter,system-ui,sans-serif;letter-spacing:.02em;text-transform:none}
    .pb{font:600 12px Inter,system-ui,sans-serif;letter-spacing:0;text-transform:none;height:30px}
    .pop{font-size:13px}
    /* v2.1: compare, text edit, sessions, toast */
    #cmp{all:unset;box-sizing:border-box;position:fixed;left:50%;bottom:76px;transform:translateX(-50%);background:#0d99ff;color:#fff;font:600 13px Inter,system-ui,sans-serif;padding:9px 16px;border-radius:999px;cursor:pointer;pointer-events:auto;box-shadow:0 8px 24px rgba(0,0,0,.35);max-width:calc(100vw - 32px);text-align:center}
    #cmp:focus-visible{outline:2px solid #fff;outline-offset:2px}
    :host(.orig) #mk{display:none}
    #toast{position:fixed;left:50%;bottom:76px;transform:translate(-50%,8px);background:#2c2c2c;color:#fff;font:500 13px Inter,system-ui,sans-serif;padding:9px 16px;border-radius:10px;box-shadow:0 8px 24px rgba(0,0,0,.4),0 0 0 1px rgba(255,255,255,.08);opacity:0;pointer-events:none;transition:opacity .2s,transform .2s;max-width:calc(100vw - 32px)}
    #toast.show{opacity:1;transform:translate(-50%,0)}
    .btn[data-m=compare]>span,.btn[data-m=gallery]>span{display:none!important}
    .btn[data-m=compare],.btn[data-m=gallery]{padding:0 9px}
    .note{padding:12px 16px;font-size:12.5px;line-height:1.5;color:#d6d6d6;background:#262626;border-bottom:1px solid var(--line)}
    .savebox{display:flex;gap:8px;padding:12px 16px 8px}
    .savebox .inp{flex:1}.savebox .pbtn{flex:none;width:76px}
    .pbtn[disabled]{opacity:.4;cursor:default;pointer-events:none}
    .gcmp{position:relative;margin:0 16px;border-radius:12px;overflow:hidden;box-shadow:0 0 0 1px var(--line)}.gcmp img{display:block;width:100%}.gclip{position:absolute;inset:0}.ghandle{position:absolute;top:0;bottom:0;width:2px;background:#0d99ff;transform:translateX(-1px)}.gtag{position:absolute;top:8px;font:600 10px Inter,system-ui,sans-serif;background:rgba(0,0,0,.6);color:#fff;border-radius:999px;padding:3px 8px}.gtag.l{left:8px}.gtag.r{right:8px}.gth{width:56px;height:40px;object-fit:cover;object-position:top;border-radius:6px;flex:none;box-shadow:0 0 0 1px var(--line)}
    .srow{display:flex;gap:8px;align-items:center;padding:10px 16px;border-bottom:1px solid var(--line)}
    .mini{all:unset;box-sizing:border-box;height:28px;padding:0 11px;border-radius:7px;background:#333;color:#e6e6e6;font:600 12px Inter,system-ui,sans-serif;cursor:pointer}
    .mini:hover{background:#444;color:#fff}.mini:focus-visible{outline:2px solid #fff}
    .mini.pri{background:#0d99ff;color:#fff}.mini.pri:hover{background:#2aa6ff}
    /* v2.1 near-duplicates + effects */
    .dups{border-bottom:1px solid var(--line);background:#222}
    .dups>summary{display:flex;align-items:center;gap:8px;padding:11px 16px;cursor:pointer;list-style:none;font:600 13px Inter,system-ui,sans-serif;color:#fff}
    .dups>summary::-webkit-details-marker{display:none}
    .dups>summary b{margin-left:auto;background:#333;border-radius:9px;padding:0 8px;font-size:12px}
    .dnote{padding:0 16px 8px;font-size:12px;line-height:1.45;color:var(--mut)}
    .drow{display:flex;gap:10px;align-items:center;padding:8px 16px;border-top:1px solid var(--line)}
    .drow .nm{white-space:normal;font-size:12.5px}
    .dotp{display:inline-block;width:11px;height:11px;border-radius:50%;margin-right:5px;vertical-align:-1px;box-shadow:inset 0 0 0 1px rgba(255,255,255,.25)}
    .tabs{padding:10px 16px}
    .fxp{flex:none;width:34px;height:34px;background:#fff;box-shadow:inset 0 0 0 1px rgba(0,0,0,.2);border:1px solid #bbb}
    .fxz{flex:none;width:34px;height:34px;display:grid;place-items:center;border-radius:8px;background:#2c2c2c;font:700 13px ui-monospace,Menlo,monospace;color:#cfcfcf}
    @media (max-width:1100px){.btn:not(.on):not(.brand)>span:not(.badge){display:none}.btn{padding:0 9px}}

    /* v2.2: scrolling, element panel, close button, merge icon, motion */
    .panel{overscroll-behavior:contain;touch-action:pan-y;scrollbar-width:thin}
    .panel.dragging{cursor:grabbing;user-select:none}
    .panel:not(.dragging){cursor:default}
    .btn.pclose{width:28px;height:28px;min-width:28px;padding:0;margin:0 2px;border-radius:50%;background:rgba(255,255,255,.12);color:#fff;display:inline-flex;align-items:center;justify-content:center;animation:dsxPop .28s var(--spring) both}
    .btn.pclose:hover{background:rgba(255,255,255,.22)}
    .btn.pclose svg{width:16px;height:16px}
    .mini.ico{width:32px;padding:0;display:inline-flex;align-items:center;justify-content:center}.mini.ico svg{width:17px;height:17px}
    .esec{padding:12px 14px 14px;border-top:1px solid var(--line)}
    .esec .eh{display:flex;align-items:center;justify-content:space-between;margin:0 0 10px}
    .esec h4{margin:0;font:600 12px Inter,system-ui,sans-serif;color:#fff;letter-spacing:0}
    .fgrid{display:grid;grid-template-columns:1fr 1fr;gap:6px}
    .fld{display:flex;align-items:center;gap:8px;height:30px;background:#2c2c2c;border-radius:6px;padding:0 9px;min-width:0;cursor:text}
    .fld.wide{grid-column:1/-1}
    .fld:hover{background:#333}.fld:focus-within{box-shadow:inset 0 0 0 1px #0d99ff;background:#2c2c2c}
    .fld .fk{flex:none;color:#a8a8a8;font:11.5px Inter,system-ui,sans-serif;min-width:34px}
    .fld .inp{all:unset;box-sizing:border-box;flex:1;min-width:0;color:#fff;font:12px ui-monospace,"SF Mono",Menlo,monospace;text-overflow:ellipsis}
    .crow{display:flex;align-items:center;gap:8px;flex-wrap:wrap;min-height:30px;margin-bottom:2px}
    .crow .cw{flex:1;min-width:0;background:#2c2c2c;border-radius:6px;height:30px;padding:0 8px}
    .crow .ck{width:44px;flex:none;color:#a8a8a8;font:11.5px Inter,system-ui,sans-serif;text-align:right}
    .crow .vn{flex:1;min-width:0;margin:0;color:#a8a8a8;text-align:right;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-size:11px}.crow{flex-wrap:nowrap}
    #rp{width:300px}
    #rp .esec:first-of-type{border-top:0}
    @keyframes dsxPop{from{opacity:0;transform:scale(.6)}to{opacity:1;transform:none}}
    @keyframes dsxIn{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}
    .panel.swapin>*{animation:dsxIn .34s cubic-bezier(.22,1,.36,1) both}
    .bar{transition:left .5s cubic-bezier(.22,1,.36,1),max-width .5s cubic-bezier(.22,1,.36,1),box-shadow .3s}
    .bar .btn{transition:background .18s,color .18s,padding .4s cubic-bezier(.22,1,.36,1)}
    .bar .btn>span:not(.badge){display:inline-block!important;overflow:hidden;white-space:nowrap;vertical-align:middle;max-width:150px;opacity:1;transition:max-width .42s cubic-bezier(.22,1,.36,1),opacity .25s ease .05s}
    .bar.compact .btn:not(.on):not(.brand):not(.has)>span:not(.badge),.bar.tight .btn>span:not(.badge),.btn[data-m=revert]>span,.btn[data-m=finish]>span:not(.badge){max-width:0!important;opacity:0;transition:max-width .42s cubic-bezier(.22,1,.36,1),opacity .15s ease}
    .bar.tight .btn.brand>span{max-width:150px!important;opacity:1}
    .bar.nofx,.bar.nofx *{transition:none!important}
    .panel{transition:opacity .35s ease,transform .55s var(--spring),visibility 0s}
    #lp{transition:opacity .3s ease,transform .5s var(--spring),visibility 0s linear .5s}
    #lp.show{transition:opacity .35s ease,transform .55s var(--spring),visibility 0s}

    .mprev{padding:12px 14px 4px}
    .mstage{position:relative;height:170px;border-radius:10px;overflow:hidden;background-color:#161616;background-image:linear-gradient(45deg,#1d1d1d 25%,transparent 25%,transparent 75%,#1d1d1d 75%),linear-gradient(45deg,#1d1d1d 25%,transparent 25%,transparent 75%,#1d1d1d 75%);background-size:16px 16px;background-position:0 0,8px 8px;box-shadow:inset 0 0 0 1px rgba(255,255,255,.08)}
    .mwrap{position:absolute;transform-origin:top left}
    .mbar{display:flex;align-items:center;gap:6px;margin-top:8px}
    .mhint{color:#a8a8a8;font:12px Inter,system-ui,sans-serif;flex:1;min-width:0}
    .mnote{color:#a8a8a8;font:11.5px/1.45 Inter,system-ui,sans-serif;margin:6px 0 8px}
    .mchips{display:flex;flex-wrap:wrap;gap:6px}
    .mchip{background:#2c2c2c;color:#fff;border-radius:999px;padding:4px 10px;font:600 12px Inter,system-ui,sans-serif}.mchip i{font-style:normal;color:#a8a8a8;font-weight:500}
    .mnone{color:#a8a8a8;font:12px Inter,system-ui,sans-serif}
    .mi{display:flex;flex-direction:column;gap:2px;padding:7px 0;border-top:1px solid var(--line)}.mi:first-of-type{border-top:0}
    .mi b{color:#fff;font:600 12.5px Inter,system-ui,sans-serif}.mi span{color:#a8a8a8;font:11.5px ui-monospace,Menlo,monospace;word-break:break-word}
    .mwatch{display:flex;align-items:center;gap:10px;margin-top:10px}.mwatch .pbtn{flex:none;padding:0 14px}
    .mtabs{display:flex;gap:4px;margin-bottom:8px;flex-wrap:wrap}
    .mtab{all:unset;box-sizing:border-box;height:26px;padding:0 10px;border-radius:7px;background:#2c2c2c;color:#e6e6e6;font:600 12px Inter,system-ui,sans-serif;cursor:pointer}.mtab:hover{background:#383838}.mtab.on{background:#0d99ff;color:#fff}.mtab:focus-visible{outline:2px solid #fff}
    .mcode{margin:0;background:#141414;border-radius:8px;padding:10px 12px;color:#e6e6e6;font:11.5px/1.5 ui-monospace,"SF Mono",Menlo,monospace;white-space:pre;overflow:auto;max-height:260px;user-select:text;cursor:text}
    @media (prefers-reduced-motion:reduce){.panel.swapin>*,.btn.pclose{animation:none}.bar,.bar .btn,.bar .btn>span{transition-duration:.01s!important}}
    @media (prefers-reduced-motion:reduce){*{transition-duration:.01s!important;animation-duration:.01s!important}}
    /* v2.4 Apple pass: type scale, hierarchy, concentric radii, material */
    :host{--sf:-apple-system,BlinkMacSystemFont,"SF Pro Text","SF Pro Display",Inter,system-ui,sans-serif;--lab2:rgba(235,235,245,.62);--lab3:rgba(235,235,245,.36)}
    .bar,.panel,.pop,.btn,.pbtn,.inp,.mini{font-family:var(--sf)}
    .bar{border-radius:22px;padding:6px;gap:2px;background:rgba(44,44,46,.78);-webkit-backdrop-filter:blur(30px) saturate(1.8);backdrop-filter:blur(30px) saturate(1.8);box-shadow:0 12px 40px rgba(0,0,0,.4),0 0 0 .5px rgba(255,255,255,.14),inset 0 .5px 0 rgba(255,255,255,.12)}
    .btn{height:36px;border-radius:16px;font:500 13px var(--sf);letter-spacing:-.01em;color:rgba(255,255,255,.88)}
    .btn:hover{background:rgba(255,255,255,.1)}
    .panel{border-radius:22px;background-color:rgba(28,28,30,.95);background-image:none;-webkit-backdrop-filter:blur(40px) saturate(1.8);backdrop-filter:blur(40px) saturate(1.8);box-shadow:0 24px 64px rgba(0,0,0,.5),0 0 0 .5px rgba(255,255,255,.14);font:13px/1.38 var(--sf);letter-spacing:-.008em}
    .ph{padding:18px 20px 12px;border-bottom:0;background:rgba(28,28,30,.9);align-items:flex-end}
    .ph b{font:600 20px/1.15 var(--sf);letter-spacing:.2px;color:#fff}
    .ph .scan{font:400 12px var(--sf);color:var(--lab2);text-transform:none;letter-spacing:0}
    .sec{padding:18px 20px 8px;font:600 13px var(--sf);letter-spacing:-.01em;text-transform:none;color:var(--lab2)}
    .sec span{font-weight:400;color:var(--lab3);margin-left:6px}
    .note{margin:0 16px 12px;padding:12px 14px;border-radius:14px;background:rgba(255,255,255,.06);font:400 13px/1.4 var(--sf);color:var(--lab2)}
    .row,.srow,.irow{padding:12px 20px;min-height:44px;border-bottom:.5px solid rgba(255,255,255,.1)}
    .nm{font:500 14px var(--sf);letter-spacing:-.01em}
    .sub{font:400 12px var(--sf);color:var(--lab2)}
    .inp{height:34px;border-radius:10px;background:rgba(118,118,128,.24);border:0;font:400 14px var(--sf);padding:0 12px}.inp:focus{box-shadow:0 0 0 3px rgba(13,153,255,.45)}
    .pbtn{height:38px;line-height:38px;border-radius:12px;background:#0d99ff;color:#fff;font:600 14px var(--sf);letter-spacing:-.01em}
    .pbtn:hover{filter:brightness(1.08)}.pbtn:active{transform:scale(.97)}
    .pbtn.sec2,.pbtn[style*="3a3a3c"]{background:rgba(118,118,128,.28)!important;color:#fff;box-shadow:none}
    .mini{border-radius:9px;font:500 12px var(--sf)}
    .savebox{padding:4px 16px 12px;gap:10px}
    .foot{padding:12px 16px 16px;border-top:.5px solid rgba(255,255,255,.1);background:rgba(30,30,32,.7)}
    .gcmp{border-radius:14px}.gth{border-radius:8px}
    .fld{height:36px;border-radius:10px;background:rgba(118,118,128,.24);padding:0 12px}
    .fld:hover{background:rgba(118,118,128,.32)}.fld:focus-within{background:rgba(118,118,128,.24);box-shadow:0 0 0 3px rgba(13,153,255,.45)}
    .fld .fk{font:400 13px var(--sf);color:var(--lab2);min-width:40px}
    .fld .inp{font:400 13px var(--sf);font-variant-numeric:tabular-nums;color:#fff}
    .fgrid{gap:8px}
    .lt{font:400 12px var(--sf)}
    .esec{padding:16px 20px 18px;border-top:.5px solid rgba(255,255,255,.1)}
    .esec h4{font:600 15px var(--sf);letter-spacing:-.01em}
    .esec .eh{margin-bottom:12px}
    #etxrow .pbtn{background:rgba(118,118,128,.28)!important;color:#fff;width:100%}
    .btn[data-m=pclose]{display:none!important}
    .ph{gap:10px}.ph .pcx{all:unset;flex:none;width:26px;height:26px;border-radius:50%;background:rgba(118,118,128,.32);color:rgba(255,255,255,.85);display:flex;align-items:center;justify-content:center;cursor:pointer;margin-left:2px;align-self:center;transition:background .2s,transform .2s var(--spring)}
    .ph .pcx:hover{background:rgba(118,118,128,.5)}.ph .pcx:active{transform:scale(.9)}
    .ph .pcx svg{width:12px;height:12px}
    :host(.lpopen) .bar:not(.moved){left:50%}
    :host(.lpopen) .bar{max-width:min(1240px,calc(100vw - 16px))}
    .panel{bottom:78px}
    #rp{max-height:calc(100vh - 92px)}
    .savebox .pbtn{flex:1;width:auto;padding:0 8px;white-space:nowrap}
    .mini.ico{all:unset;box-sizing:border-box;width:32px;height:32px;border-radius:50%;display:flex;align-items:center;justify-content:center;flex:none;cursor:pointer;color:rgba(255,255,255,.85);background:rgba(118,118,128,.24);transition:background .2s,transform .2s var(--spring)}
    .mini.ico:hover{background:rgba(118,118,128,.42)}.mini.ico:active{transform:scale(.9)}.mini.ico.del:hover{color:#ff453a}
    .mini.ico:focus-visible{box-shadow:0 0 0 3px rgba(13,153,255,.55)}
    .ph{background:#1c1c1e!important}.foot{background:#1c1c1e!important}
    .lbl{font:500 12px var(--sf)!important;text-transform:none!important;letter-spacing:0!important;color:var(--lab2)!important;margin-bottom:5px}
    .ph b{white-space:nowrap}
    .inp{font-family:var(--sf)}
    .it .nm,.row .sub{letter-spacing:-.005em}
    .ph b{min-width:0;overflow:hidden;text-overflow:ellipsis}.ph .scan{white-space:nowrap;margin-left:auto}
    /* v2.5 Figma-scale pass: smaller type, rounded-rect toolbar */
    .bar{border-radius:12px;padding:4px;gap:1px}
    .btn{height:32px;min-width:32px;padding:0 9px;border-radius:7px;font:500 11.5px var(--sf);letter-spacing:0}
    .btn.brand{border-radius:7px}
    .panel{border-radius:14px;font:12px/1.4 var(--sf)}
    .ph{padding:14px 16px 10px}.ph b{font:600 14px/1.2 var(--sf);letter-spacing:0}
    .ph .scan{font:400 11px var(--sf)}
    .sec{padding:14px 16px 6px;font:600 11px var(--sf)}
    .note{margin:0 12px 10px;padding:9px 11px;border-radius:8px;font:400 11.5px/1.4 var(--sf)}
    .row,.srow,.irow{padding:9px 16px;min-height:36px}
    .nm{font:500 12px var(--sf)}.sub{font:400 11px var(--sf)}
    .inp{height:28px;border-radius:6px;font:400 12px var(--sf);padding:0 9px}
    .pbtn{height:32px;line-height:32px;border-radius:8px;font:600 12px var(--sf)}
    .mini{border-radius:6px;font:500 11px var(--sf)}
    .fld{height:30px;border-radius:6px;padding:0 9px}
    .fld .fk{font:400 11px var(--sf);min-width:34px}.fld .inp{font:400 12px var(--sf)}
    .lt{font:400 11px var(--sf)}.lbl{font:500 11px var(--sf)!important}
    .esec{padding:12px 16px 14px}.esec h4{font:600 12px var(--sf)}
    .gcmp,.gth{border-radius:8px}.ph .pcx{width:22px;height:22px}.mini.ico{width:28px;height:28px}
    .mchip{font:600 11px var(--sf);border-radius:6px}
    #cmp{font:600 12px var(--sf);border-radius:8px}
    /* v2.5 toolbar: grey bar, darker tray, outlined tabs, yellow accent */
    :host{--bar:#4a4a4a;--ylw:#0d99ff}
    .bar{background:#4a4a4a;-webkit-backdrop-filter:none;backdrop-filter:none;border-radius:13px;padding:6px;gap:6px;box-shadow:0 10px 30px rgba(0,0,0,.35),0 0 0 1px rgba(255,255,255,.05)}
    .bar .btn.brand{width:38px;height:38px;min-width:38px;padding:0;margin:0;border-radius:8px;background:#1f1f1f;justify-content:center;gap:0}
    .bar .btn.brand:hover{background:#262626}
    .bar .btn.brand .pdot{margin:0;width:21px;height:19px}
    .tools{background:#383838;border-radius:9px;padding:4px;gap:6px;margin-left:0}
    .grp{gap:4px}
    .sep{display:none}
    .tools .btn{height:30px;min-width:30px;padding:0 10px;border-radius:7px;background:#424242;box-shadow:inset 0 0 0 1px #4d4d4d;color:#d2d2d2;font:500 11.5px var(--sf)}
    .tools .btn:hover{background:#4b4b4b;color:#fff}
    .tools .btn.on{background:#424242;color:var(--ylw);box-shadow:inset 0 0 0 1px var(--ylw)}
    .tools .btn.on::after{display:none}
    .tools .btn[data-m=finish]{background:var(--ylw);color:#fff;box-shadow:none;font-weight:600}
    .tools .btn[data-m=finish]:hover{background:#3aa9ff;color:#fff}
    .tools .btn[data-m=finish] .badge{background:#fff;color:#0d99ff}
    .btn.brand{color:#fff}
    .badge{background:#0d99ff;color:#fff}
    /* v2.8 dark panels matching the bar */
    .panel{background-color:#3d3d3d;color:#f2f2f2;background-image:none;box-shadow:0 18px 48px rgba(0,0,0,.45),0 0 0 1px rgba(255,255,255,.08);border-radius:10px}
    .ph,.foot{background:#2c2c2c!important;color:#f2f2f2;border-color:rgba(255,255,255,.08)}
    .ph b,.panel b{color:#f5f5f5}
    .row,.srow,.irow,.esec,.foot{border-color:rgba(255,255,255,.08)}
    .row:hover,.srow:hover,.irow:hover{background:rgba(255,255,255,.05)}
    .note{background:#2c2c2c;box-shadow:inset 0 0 0 1px rgba(255,255,255,.08);border-radius:8px}
    .inp,.fld,.panel input,.panel select,.panel textarea{background:#2c2c2c;color:#f2f2f2;box-shadow:inset 0 0 0 1px rgba(255,255,255,.12);border:0}
    .fld .inp{background:transparent;box-shadow:none}
    .inp:focus,.fld:focus-within{box-shadow:inset 0 0 0 1.5px var(--ylw)!important}
    .pbtn,.pbtn:not(.sec2){background:var(--ylw);color:#fff;border-radius:8px}
    .pbtn.sec2,.pbtn[style*="3a3a3c"],#etxrow .pbtn{background:#2c2c2c!important;color:#f2f2f2!important;box-shadow:inset 0 0 0 1px rgba(255,255,255,.14)!important}
    .mini,.mini.ico{background:#2c2c2c;color:#f2f2f2;box-shadow:inset 0 0 0 1px rgba(255,255,255,.12)}
    .mini.ico:hover,.mini:hover{background:#4a4a4a}
    .ph .pcx{background:rgba(255,255,255,.12);color:#fff}.ph .pcx:hover{background:rgba(255,255,255,.22)}
    .mchip{background:#2c2c2c;color:#f2f2f2;box-shadow:inset 0 0 0 1px rgba(255,255,255,.12)}.mchip i{color:#aaa}
    .gcmp,.gth{box-shadow:0 0 0 1px rgba(255,255,255,.12)}
    ::-webkit-scrollbar-thumb{background:#666}
    .chip.on{background:var(--ylw);color:#fff}.chip.on .shp{color:#fff!important}
    .dsxdot{fill:#FFEF82;transition:fill .55s ease}:host(.busy) .dsxdot{fill:#0d99ff}
    /* icons-only idle; label only on the selected tool */
    .tools .btn:not(.on):not(.brand)>span:not(.badge){display:inline-block!important;max-width:0!important;opacity:0!important;margin:0!important;overflow:hidden}
    .tools .btn.on>span:not(.badge){max-width:150px!important;opacity:1!important;margin-left:7px!important}
    /* selected tool: Figma-style solid blue fill, white icon + label, no outline */
    .tools .btn.on{background:#0d99ff!important;color:#fff!important;box-shadow:none!important;border-radius:6px}
    .tools .btn.on svg{color:#fff}
    .tools .btn.on>span:not(.badge){color:#fff}
    /* legible change-count badge: white pill, blue bold number, larger */
    .tools .btn[data-m=finish] .badge,.tools .btn.on .badge{background:#fff!important;color:#0d99ff!important;min-width:20px;height:20px;line-height:20px;border-radius:10px;padding:0 6px;margin-left:7px;font:700 13px/20px Inter,system-ui,sans-serif;font-variant-numeric:tabular-nums;box-sizing:border-box}
    .tools .btn[data-m=finish] .badge::before,.tools .btn.on .badge::before{content:none}
    .tools .btn[data-m=finish].has,.tools .btn[data-m=finish]:has(.badge.show){padding:0 9px 0 10px}
    .fmenu{position:fixed;z-index:2147483646;background:#2c2c2c;border-radius:10px;padding:6px;box-shadow:0 0 0 1px rgba(255,255,255,.08),0 10px 30px rgba(0,0,0,.45);display:flex;flex-direction:column;gap:2px;min-width:190px;pointer-events:auto;animation:fmup .16s cubic-bezier(.22,1,.36,1)}
    .fmenu button{all:unset;box-sizing:border-box;display:flex;align-items:center;gap:12px;height:36px;padding:0 12px;border-radius:6px;color:#fff;font:600 13px Inter,system-ui,sans-serif;cursor:pointer;white-space:nowrap}
    .fmenu button:hover,.fmenu button:focus-visible{background:#3d3d3d}
    .fmenu button svg{flex:none}
    @keyframes fmup{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}
    .mlink{color:#0d99ff;text-decoration:none;font-weight:600}.mlink:hover{text-decoration:underline}
    .mcmd{display:block;font:11.5px ui-monospace,Menlo,monospace;background:#242424;color:#e6e6e6;padding:6px 8px;border-radius:6px;white-space:pre-wrap;word-break:break-all}
    /* v2.7 drag handle */
    .ph{position:relative;cursor:grab;padding-top:20px!important;user-select:none}
    .ph::before{content:"";position:absolute;top:6px;left:50%;width:44px;height:5px;margin-left:-22px;border-radius:3px;background:var(--ylw);box-shadow:0 0 0 1px rgba(0,0,0,.12)}
    .panel.moving{transition:none!important;cursor:grabbing}.panel.moving .ph{cursor:grabbing}
    .panel.moving::after{content:"";position:absolute;inset:0}
    /* centred bar buttons */
    .tools .btn,.bar .btn.brand{display:inline-flex;align-items:center;justify-content:center;gap:0;text-align:center}
    .tools .btn svg{display:block;flex:none;margin:0}
    .tools .btn:not(.on):not(.has)>span:not(.badge){margin-left:0!important}
    .tools .btn.on>span:not(.badge){margin-left:7px}
    .tools .btn{min-width:32px;padding:0 8px}
    .tools .btn.on{padding:0 12px 0 10px}
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
    <div class="grp" data-g="Output">
    <button class="btn" data-m="compare" data-tip="Before / after: show the original" aria-label="Before and after">${ICONS.compare}<span>Compare</span></button>
    <button class="btn" data-m="shot" data-tip="Screenshot: screen, visible area or full page (copies to clipboard)" aria-label="Full-page screenshot">${ICONS.shot}<span>Screenshot</span></button>
    <button class="btn" data-m="motion" data-tip="Motion: read an element's animation, preview it and copy the code" aria-label="Motion inspector">${ICONS.motion}<span>Motion</span></button>
    <button class="btn" data-m="sessions" data-tip="Save and reopen your edits (sessions)" aria-label="Sessions">${ICONS.gallery}<span>Sessions</span></button>
    <button class="btn" data-m="figma" data-tip="Copy an element for Figma (SVG), then click it on the page" aria-label="Copy an element for Figma">${ICONS.figma}<span>Figma</span></button>
    <button class="btn" data-m="revert" data-tip="Revert all edits" aria-label="Revert all edits">${ICONS.revert}<span>Revert</span></button>
    <button class="btn" data-m="finish" data-tip="Finish: change summary" aria-label="Finish: change summary">${ICONS.finish}<span>Finish</span><span class="badge" id="badge">0</span></button>
    </div>
    <button class="btn gone" data-m="issues" id="ibtn" data-tip="Issues caused by your edits" aria-label="Issues caused by your edits"><i class="ibadge" id="ibadge">0</i></button>
    <div class="sep"></div>
    <button class="btn" data-m="close" data-tip="Close" aria-label="Close" style="padding:0 9px">${ICONS.close}</button>
    </div>
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
  window.addEventListener("scroll", reflow, true); window.addEventListener("resize", reflow);
  document.addEventListener("mousedown", (e) => { const p = e.composedPath(); if (activeKey && !p.includes(pop) && !p.some((n) => n.classList && n.classList.contains("sq"))) closePop(); }, true);
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && activeKey) closePop(); }, true);

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
    lp.querySelectorAll(".row .meta").forEach((m) => { const r = m.closest(".row"), inp = r && r.querySelector("input[type=color]"); if (!inp) return; m.style.cursor = "pointer"; m.title = "Show where this colour is used"; m.addEventListener("click", () => { const sw = list[inp.dataset.i]; startFind(sw.els.map((x) => x.el), sw.cur || sw.hex); }); });
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
        <div style="display:flex;justify-content:space-between"><span class="nm">${esc(s.name)}</span><span class="sub">${s.els.length} elements</span></div>
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
        inp.addEventListener("keydown", (e) => { if (e.key === "Enter") inp.blur(); });
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
    lp.querySelectorAll(".row .meta").forEach((m) => { const inp = m.closest(".row").querySelector(".sp .inp"); if (!inp) return; m.style.cursor = "pointer"; m.title = "Show where this spacing is used"; m.addEventListener("click", () => { const sp = list[inp.dataset.i]; startFind(sp.els.map((x) => x.el), sp.value + "px"); }); });
    lp.querySelectorAll(".sp .inp").forEach((inp) => {
      const s = list[inp.dataset.i];
      inp.addEventListener("change", () => {
        const v = parseFloat(inp.value);
        if (isNaN(v) || v < 0) return;
        for (const { el, prop } of s.els) setProp(el, prop, v + "px");
        render();
        record("g:s:" + s.value, `Spacing ${s.value}px (all uses)`, s.value + "px", v + "px", "space");
      });
      inp.addEventListener("keydown", (e) => { if (e.key === "Enter") inp.blur(); });
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
    note.style.cssText = "position:fixed;z-index:2147483647;max-width:340px;background:#2c2c2c;color:#fff;border-radius:8px;padding:10px 12px 10px 12px;font:12px/1.45 Inter,system-ui,sans-serif;box-shadow:0 6px 24px rgba(0,0,0,.4);border-left:4px solid " + sevCol + ";pointer-events:auto";
    const tgt = f.href ? `<div style="margin-top:4px;opacity:.75;word-break:break-all">href: <span style="font-family:ui-monospace,Menlo,monospace;color:#fff">${esc(f.href)}</span></div>` : "";
    const head = f.head || ((f.sev === "error" ? "Broken" : "Check") + " \u00b7 " + (f.label || "element"));
    const BTN = "all:unset;box-sizing:border-box;cursor:pointer;height:26px;padding:0 12px;border-radius:6px;font:600 12px Inter,system-ui,sans-serif;display:inline-flex;align-items:center;";
    const fixHtml = f.fix ? (f.fix.apply ? `<div class="fxs" style="margin-top:8px;padding:8px;border-radius:6px;background:#3a3a3a"><div style="opacity:.7;font-size:11px;margin-bottom:2px">Suggested fix</div><div class="fxd">${esc(f.fix.desc)}</div><div style="margin-top:8px;display:flex;gap:8px"><button class="fxa" style="${BTN}background:#0d99ff;color:#fff">Apply fix</button><button class="fxu" style="${BTN}background:#4a4a4a;color:#fff;display:none">Undo</button></div></div>` : `<div style="margin-top:8px;padding:8px;border-radius:6px;background:#3a3a3a"><div style="opacity:.7;font-size:11px;margin-bottom:2px">How to fix</div><div>${esc(f.fix.desc)}</div></div>`) : "";
    note.innerHTML = `<div style="font-weight:600;color:${f.col ? "#ffd27a" : "#ff8a70"};margin-bottom:2px">${esc(head)}</div><div>${esc(f.reason)}</div>${tgt}${fixHtml}<div style="margin-top:8px"><button class="fxx" style="${BTN}height:22px;padding:0 8px;background:transparent;color:#aaa;font-weight:500;box-shadow:inset 0 0 0 1px #555">Dismiss (Esc)</button></div>`;
    const xa = note.querySelector(".fxa"), xu = note.querySelector(".fxu");
    if (xa) {
      xa.addEventListener("click", (e) => { e.stopPropagation(); try { const d = f.fix.apply(); note.querySelector(".fxd").textContent = d || "Applied"; note.querySelector(".fxs > div").textContent = "Applied on this page only (not saved to the site)"; xa.style.display = "none"; xu.style.display = "inline-flex"; } catch (err) { say("Could not apply: " + (err && err.message || err)); } });
      xu.addEventListener("click", (e) => { e.stopPropagation(); try { f.fix.undo(); note.querySelector(".fxd").textContent = f.fix.desc; note.querySelector(".fxs > div").textContent = "Suggested fix"; xu.style.display = "none"; xa.style.display = "inline-flex"; } catch (err) {} });
    }
    note.querySelector(".fxx").addEventListener("click", (e) => { e.stopPropagation(); clearMark(); });
    root.appendChild(box); root.appendChild(note);
    const st = { box, note, stop: false }; flowMark = st;
    el.scrollIntoView({ block: "center", behavior: "auto" });
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
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && flowMark) clearMark(); }, true);
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
  const say = (msg) => { toast.textContent = msg; toast.classList.add("show"); clearTimeout(say.t); say.t = setTimeout(() => toast.classList.remove("show"), 3600); };
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
  const clusterOf = (items, near) => {
    const par = items.map((_, i) => i), f = (i) => (par[i] === i ? i : (par[i] = f(par[i])));
    for (let i = 0; i < items.length; i++) for (let j = i + 1; j < items.length; j++) if (near(items[i], items[j])) par[f(i)] = f(j);
    const g = new Map(); items.forEach((it, i) => { const r = f(i); if (!g.has(r)) g.set(r, []); g.get(r).push(it); });
    return [...g.values()].filter((x) => x.length > 1).map((x) => { x.sort((a, b) => b.els.length - a.els.length); return { canon: x[0], members: x.slice(1) }; });
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
        let v = inp.value.trim(); if (!v) return;
        if (fxTab === "radius" && /^[\d.]+$/.test(v)) v += "px";
        if (fxTab === "z" && !/^-?\d+$/.test(v)) return;
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
  new MutationObserver(() => { host.classList.toggle("lpopen", lp.classList.contains("show")); host.style.setProperty("--lpw", lp.style.width || "300px"); if (!lp.classList.contains("show")) peek(false); }).observe(lp, { attributes: true, attributeFilter: ["class", "style"] });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && lp.classList.contains("peek")) peek(false); }, true);

  const openMode = (m) => {
    mode = m; setActive();
    if (!m || m === "pick") { if (!m) lp.classList.remove("show"); return; }
    lp.classList.add("show");
    lp.style.width = m === "issues" ? "340px" : m === "gallery" || m === "sessions" ? "340px" : m === "effects" ? "340px" : m === "review" ? "360px" : m === "flow" ? "380px" : "300px";
    if (m !== "flow" && flowAbort) flowAbort.abort();
    lp.innerHTML = `<div class="empty">Scanning\u2026</div>`;
    setTimeout(() => { lp.classList.remove("swapin"); void lp.offsetWidth; lp.classList.add("swapin"); ({ colours: colourPanel, text: textPanel, spacing: spacingPanel, review: reviewPanel, flow: flowPanel, issues: issuesPanel, gallery: galleryPanel, sessions: sessionsPanel, effects: effectsPanel })[m](); }, 20);
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
  const showElement = (el) => {
    selected = el;
    const cs = getComputedStyle(el), vm = buildVarMap(), sel = selectorOf(el), id = elId(el);
    const fld = (label, prop, wide) => { const val = cssShort(cs, prop).split(",")[0].replace(/["']/g, ""); return `<label class="fld${wide ? " wide" : ""}"><span class="fk">${label}</span><input class="inp" data-p="${prop}" data-o="${esc(val)}" value="${esc(val)}"></label>`; };
    const col = (label, prop) => {
      const val = cssShort(cs, prop), hex = toHex(val), vars = hex ? vm.get(hex) || [] : [];
      return `<div class="crow"><div class="cw"><label class="sw" style="background:${hex || "transparent"}"><input type="color" data-p="${prop}" data-o="${hex || ""}" value="${hex || "#ffffff"}"></label><span class="hex">${hex || "transparent"}</span>${vars.length ? `<span class="vn">${vars.map(esc).join(", ")}</span>` : ""}</div><span class="ck">${label}</span></div>`;
    };
    const sec = (t, inner, extra) => `<section class="esec"><div class="eh"><h4>${t}</h4>${extra || ""}</div>${inner}</section>`;
    const rows = sec("Typography", `<div id="etxrow"></div><div class="fgrid">${fld("Font", "font-family", true)}${fld("Size", "font-size")}${fld("Weight", "font-weight")}${fld("Line", "line-height")}${fld("Track", "letter-spacing")}</div>`)
      + sec("Colour", col("Text", "color") + col("Fill", "background-color") + col("Stroke", "border-top-color"))
      + sec("Layout", `<div class="fgrid">${fld("Padding", "padding", true)}${fld("Margin", "margin", true)}</div>`)
      + sec("Appearance", `<div class="fgrid">${fld("Radius", "border-radius")}</div>`)
      + sec("Motion", `<button class="pbtn sec2" id="emo" style="width:100%">Inspect motion on this element</button>`);
    rp.innerHTML = `<div class="ph"><b>${esc(sel)}</b><span>${Math.round(el.getBoundingClientRect().width)} \u00d7 ${Math.round(el.getBoundingClientRect().height)}</span></div><div id="elint"></div>${rows}<div style="height:10px"></div>`;
    rp.classList.add("show");
    rp.querySelector("#etxrow").innerHTML = `<button class="pbtn sec2" id="etx" ${editable(el) ? "" : 'data-tip="This element has other elements inside it. Pick the one that holds the text."'} style="width:100%;margin-bottom:8px;${editable(el) ? "" : "opacity:.5"}">Edit text on page</button>`;
    rp.querySelector("#etx").onclick = () => startTextEdit(el);
    rp.querySelector("#emo").onclick = () => { setPicking(false); showMotion(el); };
    const relint = () => renderLint(rp.querySelector("#elint"), lintMany([el, ...[...el.children].slice(0, 8)]));
    relint();
    rp.querySelectorAll("[data-p]").forEach((inp) => {
      const p = inp.dataset.p, o = inp.dataset.o, label = `${sel} ${p.replace("background-color", "background").replace("border-top-color", "border colour").replace(/-/g, " ")}`;
      const key = `e:${id}:${p}`;
      if (inp.type === "color") {
        inp.addEventListener("input", () => {
          const to = inp.value;
          if (p === "border-top-color") ["top", "right", "bottom", "left"].forEach((s) => setProp(el, `border-${s}-color`, to)); else setProp(el, p, to);
          render();
          inp.parentElement.style.background = to; inp.closest(".cw").querySelector(".hex").textContent = to;
          relint();
          record(key, label, o || "transparent", to, "colour");
          applyAllChip(inp, el, p, o, to);
        });
      } else {
        inp.addEventListener("change", () => {
          let v = inp.value.trim(); if (!v) return;
          if (/^-?[\d.]+$/.test(v) && p !== "font-weight") v += "px";
          if (p === "font-family" && /\s/.test(v) && !/["',]/.test(v)) v = `"${v}"`;
          setProp(el, p, v); render();
          relint();
          record(key, label, o, v.replace(/["']/g, ""), "text");
        });
        inp.addEventListener("keydown", (e) => { if (e.key === "Enter") inp.blur(); });
      }
    });
  };
  const target = (e) => { const cp = e.composedPath(); if (cp.includes(host)) return null; const t = cp[0]; return t && t.nodeType === 1 && !isUI(t) && t !== document.documentElement && t !== document.body ? t : null; };
  const onMove = (e) => {
    if (!picking) return;
    const t = target(e);
    if (!t) { hl.style.display = hlt.style.display = "none"; return; }
    const r = t.getBoundingClientRect();
    Object.assign(hl.style, { display: "block", left: r.left + "px", top: r.top + "px", width: r.width + "px", height: r.height + "px" });
    hlt.textContent = selectorOf(t);
    Object.assign(hlt.style, { display: "block", left: Math.max(0, r.left) + "px", top: Math.max(0, r.top - 22) + "px" });
  };
  const onClick = (e) => {
    if (!picking) return;
    const t = target(e);
    if (!t) return;
    e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
    if (figmaArmed) { const a = t; setPicking(false); copyFigma(a); return; }
    if (motionArmed) { const a = t; setPicking(false); showMotion(a); return; }
    if (codeArmed) { const a = t; setPicking(false); copyCode(a); return; }
    showElement(t);
  };
  const swallow = (e) => { if (picking && target(e)) { e.preventDefault(); e.stopPropagation(); } };
  document.addEventListener("mousemove", onMove, true);
  document.addEventListener("click", onClick, true);
  ["mousedown", "mouseup", "pointerdown", "pointerup", "submit"].forEach((n) => document.addEventListener(n, swallow, true));
  const setPicking = (on) => {
    if (on !== picking) busy(on);
    picking = on;
    if (!on) { hl.style.display = hlt.style.display = "none"; rp.classList.remove("show"); selected = null; figmaArmed = false; motionArmed = false; codeArmed = false; }
    document.documentElement.style.cursor = on ? "crosshair" : "";
    setActive();
  };

  /* ---------- finish ---------- */
  const summaryText = () => [...log.values()].map((c) => `${c.label}: ${c.from} -> ${c.to}`).join("\n");
  const showFinish = () => {
    finishOpen = true;
    const items = [...log.values()];
    rp.innerHTML = `<div class="ph"><b>Change summary</b><span>${items.length} change${items.length === 1 ? "" : "s"}</span></div>` +
      (items.map((c) => `<div class="ch"><div class="t">${esc(c.label)}</div><div class="arrow">${c.kind === "colour" && /^#/.test(c.from) ? `<span class="dot" style="background:${c.from}"></span>` : ""}<span>${esc(c.from)}</span><span>\u2192</span>${c.kind === "colour" ? `<span class="dot" style="background:${c.to}"></span>` : ""}<span style="color:var(--fg)">${esc(c.to)}</span></div></div>`).join("") || `<div class="empty">No changes yet. Edit colours, text or spacing, then press Finish.</div>`) +
      `<div class="foot"><button class="pbtn sec2" id="cp">Copy list</button><button class="pbtn" id="rv">Revert all</button></div>`;
    rp.classList.add("show"); setActive();
    $("#cp").onclick = () => { navigator.clipboard.writeText(summaryText()).then(() => { $("#cp").textContent = "Copied"; }).catch(() => { $("#cp").textContent = "Copy failed"; }); };
    $("#rv").onclick = () => { finishOpen = false; revertAll(); rp.classList.remove("show"); setActive(); };
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
  window.addEventListener("wheel", onWheel, { capture: true, passive: false });
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
  window.addEventListener("pointermove", (e) => {
    if (!mv) return;
    const vw = innerWidth, vh = innerHeight;
    const x = Math.max(8, Math.min(vw - mv.w - 8, e.clientX - mv.dx));
    const y = Math.max(8, Math.min(vh - 80, e.clientY - mv.dy));
    const st = mv.p.style;
    st.left = x + "px"; st.top = y + "px"; st.right = "auto"; st.bottom = "auto"; st.maxHeight = "calc(100vh - " + (y + 8) + "px)"; st.height = "auto"; st.transform = "none";
    e.preventDefault();
  }, true);
  const endMove = () => { if (mv) { mv.p.classList.remove("moving"); mv = null; } };
  window.addEventListener("pointerup", endMove, true); window.addEventListener("pointercancel", endMove, true);
  let drag = null;
  root.addEventListener("pointerdown", (e) => {
    const p = panelOf(e); if (!p || e.button !== 0) return;
    if (e.composedPath().some((n) => n.nodeType === 1 && /^(INPUT|TEXTAREA|SELECT|BUTTON|A|LABEL|SUMMARY)$/.test(n.tagName) || (n.nodeType === 1 && (n.isContentEditable || n.classList && n.classList.contains("sw"))))) return;
    drag = { p, y: e.clientY, top: p.scrollTop, moved: false, id: e.pointerId };
  });
  window.addEventListener("pointermove", (e) => {
    if (!drag) return;
    const dy = e.clientY - drag.y;
    if (!drag.moved && Math.abs(dy) > 4) { drag.moved = true; drag.p.classList.add("dragging"); }
    if (drag.moved) { drag.p.scrollTop = drag.top - dy; e.preventDefault(); }
  }, true);
  const endDrag = () => { if (drag) { drag.p.classList.remove("dragging"); const was = drag.moved; drag = null; if (was) { const swallowClick = (ev) => { ev.stopPropagation(); ev.preventDefault(); }; root.addEventListener("click", swallowClick, { capture: true, once: true }); setTimeout(() => root.removeEventListener("click", swallowClick, true), 50); } } };
  window.addEventListener("pointerup", endDrag, true); window.addEventListener("pointercancel", endDrag, true);

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
  [lp, rp].forEach((pn) => { if (!pn) return; new MutationObserver(() => addClose(pn)).observe(pn, { childList: true, subtree: true }); addClose(pn); });

  const armFigma = (on) => {
    if (on) { if (mode) openMode(null); finishOpen = false; rp.classList.remove("show"); if (mode) openMode(null); figmaArmed = true; setPicking(true); figmaArmed = true; setActive(); say("Click the element you want to copy for Figma. Esc cancels."); }
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
  const copyFigma = (el) => withBusy(() => copyFigma0(el));
  const copyFigma0 = async (el) => {
    const paste = " In Figma, click the canvas and press " + (MAC ? "\u2318V" : "Ctrl+V") + ".";
    try {
      if (await ensureFigma()) {
        say("Preparing Figma layers\u2026");
        const r = el.getBoundingClientRect();
        const f = globalThis.__dsxFigma.createFigmaConverter({ trace: true });
        const result = await f.convert({ element: el, width: Math.max(1, Math.round(r.width)), height: Math.max(1, Math.round(r.height)), name: (el.id ? "#" + el.id : el.tagName.toLowerCase()) });
        let html = result.toClipboardHtml(), mo = null;
        try {
          el.setAttribute("data-dsx-root", "1");
          const m = await new Promise((res) => { try { chrome.runtime.sendMessage({ type: "dsx-motion-collect" }, (x) => res(x && x.ok ? x.data : null)); } catch (e) { res(null); } });
          el.removeAttribute("data-dsx-root");
          if (m && m.items && m.items.length) { mo = globalThis.__dsxFigma.applyMotion(result, m); html = mo.html; mo.libs = m.libs; mo.notes = m.notes; }
        } catch (e) { el.removeAttribute("data-dsx-root"); window.__dsxMotionErr = String(e && e.message || e); host.dataset.motionErr = window.__dsxMotionErr; }
        window.__dsxLastFigmaHtml = html; window.__dsxLastMotion = mo; host.dataset.figmaLen = String(html.length);
        await navigator.clipboard.write([globalThis.__dsxFigma.toClipboardItem(html)]);
        if (mo && mo.withMotion) { say("Copied as Figma layers with " + mo.applied.length + " animated layer" + (mo.applied.length === 1 ? "" : "s") + ". " + paste.trim() + " Motion carries over as keyframes on the layers inside; the top frame itself cannot be animated in Figma."); return; }
        say("Copied as editable Figma layers." + paste);
        return;
      }
    } catch (err) { window.__dsxFigmaErr = String(err && err.message || err); host.dataset.figmaErr = window.__dsxFigmaErr; }
    let res;
    try { res = figmaSvg(el); } catch (err) { say("Could not read that element: " + err.message); return; }
    const miss = res.notes.length ? " Not included: " + res.notes.join(", ") + "." : "";
    try { await navigator.clipboard.writeText(res.svg); say("Layer copy was not available, so this was copied as SVG." + paste + miss); }
    catch (err) { saveBlob(new Blob([res.svg], { type: "image/svg+xml" }), "blue-dot-element.svg"); say("Clipboard was blocked, so the SVG was saved to your downloads. Drag it into Figma." + miss); }
    window.__dsxLastSvg = res.svg;
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
    ["width", "height", "backgroundColor", "color"].forEach((k) => { if (typeof v[k] === "string" || typeof v[k] === "number") o[k.replace(/[A-Z]/g, (c) => "-" + c.toLowerCase())] = typeof v[k] === "number" && /width|height/.test(k) ? v[k] + "px" : String(v[k]); });
    return o;
  };
  const gsapEffect = (probe, el) => {
    const list = (probe && probe.gsap) || []; if (!list.length) return null;
    const pick = list.find((g) => g.on === "this element" && Object.keys(gsapProps(g.vars || {})).length) || list.find((g) => Object.keys(gsapProps(g.vars || {})).length);
    if (!pick) return null;
    const v = pick.vars || {}, end = gsapProps(v), cs = getComputedStyle(el), nat = {};
    Object.keys(end).forEach((k) => { nat[k] = k === "transform" ? "none" : cs.getPropertyValue(k) || (k === "opacity" ? "1" : "none"); });
    const back = !!v.runBackwards, start = v.startAt ? gsapProps(v.startAt) : null;
    const A = back ? end : start || nat, Z = back ? nat : end;
    const dur = Math.max(100, Math.round((pick.duration || v.duration || 0.5) * 1000));
    const rep = v.repeat != null ? v.repeat : 0;
    return { kind: "gsap", label: "From/to values of the GSAP tween (exact values; the page's layout and scripts are not reproduced)", kfs: [{ offset: 0, props: A }, { offset: 1, props: Z }], timing: { duration: dur, delay: Math.round((pick.delay || 0) * 1000), easing: gsapEase(v.ease), iterations: rep === -1 ? "infinite" : 1, direction: v.yoyo ? "alternate" : "normal", fill: "both" }, trigger: "GSAP tween on " + pick.on, gsap: { v, back, ease: v.ease, stagger: !!v.stagger, repeat: rep } };
  };
  const detectStyle = (m, eff, probe) => {
    const st = (probe && probe.st) || [], scrub = st.some((x) => x.scrub), trig = st.length ? (scrub ? "follows the scrollbar" : "plays when scrolled into view") : "";
    const len = (x) => { const mm = /(-?[\d.]+)/.exec(x || ""); return mm ? parseFloat(mm[1]) : 0; };
    const dur = (t) => Math.round(t.duration) + "ms";
    if (eff && eff.kfs && eff.kfs.length > 1) {
      const a = eff.kfs[0].props, z = eff.kfs[eff.kfs.length - 1].props, t = eff.timing;
      const pr = (p) => (p || {});
      const tfA = String(pr(a).transform || "none"), tfZ = String(pr(z).transform || "none");
      const grab = (tf, re) => { const mm = re.exec(tf); return mm ? parseFloat(mm[1]) : 0; };
      const ay = grab(tfA, /translateY\((-?[\d.]+)/), zy = grab(tfZ, /translateY\((-?[\d.]+)/), ax = grab(tfA, /translateX\((-?[\d.]+)/), zx = grab(tfZ, /translateX\((-?[\d.]+)/);
      const as = grab(tfA, /scale\((-?[\d.]+)/) || 1, zs = grab(tfZ, /scale\((-?[\d.]+)/) || 1, ar = grab(tfA, /rotate\((-?[\d.]+)/), zr = grab(tfZ, /rotate\((-?[\d.]+)/);
      const oa = pr(a).opacity != null ? parseFloat(pr(a).opacity) : null, oz = pr(z).opacity != null ? parseFloat(pr(z).opacity) : null;
      const fadeIn = oa != null && oz != null && oz > oa, fadeOut = oa != null && oz != null && oz < oa, dy = zy - ay, dx = zx - ax;
      let name = "", what = [];
      if (t.iterations === "infinite" && Math.abs(dx) > 40 && !fadeIn && !fadeOut && /linear/.test(t.easing)) { name = "Marquee / ticker"; what.push("loops sideways at constant speed"); }
      else if (eff.kind === "hover" || (eff.anim && /transition/i.test(eff.anim.type || ""))) { name = Math.abs(dy) > 0 ? "Hover lift" : zs !== as ? "Hover scale" : "Hover transition"; what.push("moves up " + Math.abs(Math.round(dy)) + "px on hover/state change"); if (!dy) what[0] = "changes on hover/state change"; }
      else {
        if (fadeIn) what.push("fades in"); if (fadeOut) what.push("fades out");
        if (Math.abs(dy) >= 1) what.push((dy < 0 ? "moves up " : "moves down ") + Math.abs(Math.round(dy)) + "px"); if (Math.abs(dx) >= 1) what.push((dx < 0 ? "moves left " : "moves right ") + Math.abs(Math.round(dx)) + "px");
        if (zs !== as) what.push("scales " + as + " to " + zs); if (zr !== ar) what.push("rotates " + (zr - ar) + "deg");
        const mv = Math.abs(dy) >= 1 && Math.abs(dx) < 1 ? (dy > 0 ? "up" : "down") : Math.abs(dx) >= 1 && Math.abs(dy) < 1 ? (dx > 0 ? "left" : "right") : "";
        if (scrub && !fadeIn && !fadeOut && Math.abs(dy) > 60 && zs === as) name = "Parallax";
        else if (fadeIn && Math.abs(dy) >= 1) name = "Fade " + (dy < 0 ? "up" : "down");
        else if (fadeIn && Math.abs(dx) >= 1) name = "Fade in from the " + (dx > 0 ? "left" : "right");
        else if (fadeIn && zs !== as) name = zs > as ? "Zoom in" : "Fade in + shrink";
        else if (fadeIn) name = "Fade in";
        else if (fadeOut) name = "Fade out";
        else if (Math.abs(dx) >= 1 && Math.abs(dy) < 1) name = "Slide " + (dx < 0 ? "in from the right" : "in from the left");
        else if (Math.abs(dy) >= 1) name = "Slide " + (dy < 0 ? "up" : "down");
        else if (zs !== as) name = zs > as ? "Scale up" : "Scale down";
        else if (zr !== ar) name = "Rotate";
        else name = "Property change";
        if (eff.gsap && eff.gsap.stagger) name = "Staggered " + name.charAt(0).toLowerCase() + name.slice(1);
        if (scrub && name !== "Parallax") name = "Scroll-scrubbed " + name.charAt(0).toLowerCase() + name.slice(1);
      }
      const desc = (what.length ? what.join(" and ") : "changes") + ". " + dur(t) + (t.easing && t.easing !== "linear" ? ", " + (eff.gsap && eff.gsap.ease ? String(eff.gsap.ease) : t.easing) : ", linear") + (t.delay ? ", " + Math.round(t.delay) + "ms delay" : "") + (trig ? ". " + trig.charAt(0).toUpperCase() + trig.slice(1) + "." : eff.kind === "hover" ? "." : ". " + (eff.trigger ? eff.trigger.charAt(0).toUpperCase() + eff.trigger.slice(1) : "") + ".");
      return { name, desc: desc.replace(/\.\./g, ".") };
    }
    if (m.trans.length) { const x = m.trans[0]; return { name: "CSS transition", desc: `Animates ${m.trans.map((q) => q.prop).slice(0, 3).join(", ")} over ${x.duration}ms (${x.easing}) when its state changes (hover, focus, class change). No from/to values found yet, so no preview.` }; }
    if (st.length) return { name: scrub ? "Scroll-scrubbed motion" : "Scroll-triggered motion", desc: "A ScrollTrigger drives something on or around this element, but no readable from/to values were found. Watch for 8 s and scroll to capture them." };
    return null;
  };
  const primaryEffect = (m, el, probe) => {
    if (m.samples && m.samples.kfs.length > 1 && !m.anims.some((a) => a.kfs.length > 1 && !a.idle)) return { kind: "sampled", label: "Sampled while you watched (approximate)", kfs: m.samples.kfs, timing: m.samples.timing, trigger: m.samples.trigger };
    const a = m.anims.find((x) => x.kfs.length > 1);
    if (a) return { kind: "anim", label: a.type + ": " + a.name, kfs: a.kfs, timing: a.timing, anim: a, trigger: a.idle ? "set on the element (runs when it renders)" : "running now" };
    if (m.hover.length && m.trans.length) {
      const cs = getComputedStyle(el), decl = Object.assign({}, ...m.hover.map((h) => h.decls));
      const base = {}; Object.keys(decl).forEach((k) => { base[k] = cs.getPropertyValue(k); });
      const t = m.trans[0];
      return { kind: "hover", label: "Hover transition", kfs: [{ offset: 0, props: base }, { offset: 1, props: decl }], timing: { duration: t.duration, delay: t.delay, easing: t.easing, iterations: "infinite", direction: "alternate", fill: "both" }, trigger: "hover" };
    }
    if (m.samples && m.samples.kfs.length > 1) return { kind: "sampled", label: "Sampled while you watched (approximate)", kfs: m.samples.kfs, timing: m.samples.timing, trigger: m.samples.trigger };
    const ge = gsapEffect(probe, el); if (ge) return ge;
    return null;
  };
  const kfToWaapi = (kfs) => kfs.map((k) => { const o = { offset: k.offset }; if (k.easing) o.easing = k.easing; for (const [pn, v] of Object.entries(k.props)) o[camelK(pn)] = v; return o; });
  const waapiTiming = (t) => ({ duration: t.duration, delay: t.delay, easing: t.easing, iterations: t.iterations === "infinite" ? "Infinity" : t.iterations, direction: t.direction, fill: t.fill === "none" ? "both" : t.fill });
  const jsonIter = (o) => JSON.stringify(o, null, 2).replace(/"Infinity"/g, "Infinity");
  const selName = (el) => { const c = [...el.classList][0]; return c ? "." + CSS.escape(c) : el.tagName.toLowerCase(); };
  const genCode = (m, eff, el, lib, probe) => {
    const sel = selName(el), out = { css: "", js: "", react: "", prompt: "" };
    if (eff) {
      const t = eff.timing, nm = eff.anim ? eff.anim.name : "dsx-effect";
      const kfCss = eff.anim && eff.anim.ruleText ? eff.anim.ruleText : `@keyframes ${nm} {\n` + eff.kfs.map((k) => `  ${Math.round(k.offset * 1000) / 10}% { ${Object.entries(k.props).map(([pn, v]) => `${pn}: ${v};`).join(" ")} }`).join("\n") + "\n}";
      if (eff.kind === "hover") {
        out.css = `${sel} {\n  transition: ${m.trans.map((x) => `${x.prop} ${x.duration}ms ${x.easing}${x.delay ? " " + x.delay + "ms" : ""}`).join(", ")};\n}\n` + m.hover.map((h) => `${h.sel} {\n${Object.entries(h.decls).map(([pn, v]) => `  ${pn}: ${v};`).join("\n")}\n}`).join("\n");
      } else {
        out.css = `${kfCss}\n\n${sel} {\n  animation: ${nm} ${t.duration}ms ${(t.easing === "linear" && eff.kind !== "sampled" && eff.kfs && eff.kfs[0] && eff.kfs[0].easing) || t.easing} ${t.delay}ms ${t.iterations} ${t.direction} ${t.fill === "none" ? "both" : t.fill};\n}` + (eff.kind === "sampled" ? "\n/* keyframes were sampled from the running page, so easing is linear and values are approximate */" : "");
      }
      const kfJs = jsonIter(kfToWaapi(eff.kfs)), tmJs = jsonIter(waapiTiming(t));
      out.js = eff.kind === "hover" ? `// hover: use the CSS above. Equivalent with the Web Animations API:\nconst el = document.querySelector("${sel}");\nel.addEventListener("mouseenter", () => el.animate(${kfJs}, { ...${tmJs}, iterations: 1, fill: "forwards" }));\nel.addEventListener("mouseleave", () => el.animate(${kfJs}, { ...${tmJs}, iterations: 1, direction: "reverse", fill: "forwards" }));`
        : `const el = document.querySelector("${sel}");\nel.animate(${kfJs}, ${tmJs});`;
      const scrollish = eff.trigger && /scroll/.test(eff.trigger);
      out.react = `"use client";\nimport { useEffect, useRef } from "react";\n\nconst KEYFRAMES = ${kfJs};\nconst TIMING = ${tmJs};\n\nexport default function Effect({ children }: { children: React.ReactNode }) {\n  const ref = useRef<HTMLDivElement>(null);\n  useEffect(() => {\n    const el = ref.current;\n    if (!el) return;\n` + (scrollish ? `    const io = new IntersectionObserver(([e]) => { if (e.isIntersecting) { el.animate(KEYFRAMES, TIMING); io.disconnect(); } }, { threshold: 0.2 });\n    io.observe(el);\n    return () => io.disconnect();\n` : eff.kind === "hover" ? `    const on = () => el.animate(KEYFRAMES, { ...TIMING, iterations: 1, fill: "forwards" });\n    const off = () => el.animate(KEYFRAMES, { ...TIMING, iterations: 1, direction: "reverse", fill: "forwards" });\n    el.addEventListener("mouseenter", on); el.addEventListener("mouseleave", off);\n    return () => { el.removeEventListener("mouseenter", on); el.removeEventListener("mouseleave", off); };\n` : `    const a = el.animate(KEYFRAMES, TIMING);\n    return () => a.cancel();\n`) + `  }, []);\n  return <div ref={ref}>{children}</div>;\n}`;
    }
    if (probe) {
      const parts = [];
      if (probe.gsap && probe.gsap.length) parts.push("// GSAP tween(s) read from the page (values after function and element references are removed)\n" + probe.gsap.map((g) => `gsap.to("${sel}", ${jsonIter(Object.assign({}, g.vars, { duration: g.duration }, g.delay ? { delay: g.delay } : {}))});`).join("\n") + (probe.st && probe.st.length ? "\n// ScrollTrigger\n" + jsonIter(probe.st[0]) : ""));
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
    const io = new IntersectionObserver(([e]) => { if (e.isIntersecting && !visibleAt) visibleAt = performance.now() - t0; }, { threshold: 0.15 }); io.observe(el);
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
    if (on) { finishOpen = false; rp.classList.remove("show"); if (mode) openMode(null); motionArmed = true; setPicking(true); motionArmed = true; setActive(); say("Click the element whose motion you want to inspect. Esc cancels."); }
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
  const showMotion = async (el) => {
    if (motionStop) { motionStop(); motionStop = null; }
    mode = "motion"; motionArmed = false; setActive();
    lp.classList.add("show"); lp.style.width = "400px";
    lp.innerHTML = `<div class="empty">Reading motion\u2026</div>`;
    el.setAttribute("data-dsx-probe", "1");
    const probe = await probeMain();
    el.removeAttribute("data-dsx-probe");
    let m; try { m = collectMotion(el); } catch (err) { lp.innerHTML = `<div class="ph"><b>Motion</b></div><div class="empty">Could not read this element's motion: ${esc(err && err.message || err)}</div>`; return; }
    let watched = null;
    const render = () => {
      const eff = primaryEffect(m, el, probe), sty = detectStyle(m, eff, probe), code = genCode(m, eff, el, (probe && probe.libs) || [], probe);
      const libs = (probe && probe.libs) || [];
      const chips = libs.length ? libs.map((l) => `<span class="mchip">${esc(l.name)}${l.version ? " <i>" + esc(l.version) + "</i>" : ""}</span>`).join("") : `<span class="mnone">No animation library detected on this page.</span>`;
      const lst = [];
      m.anims.forEach((a) => lst.push(`<div class="mi"><b>${esc(a.type)}: ${esc(a.name)}</b><span>${a.timing.duration}ms \u00b7 ${esc(a.timing.easing)} \u00b7 delay ${a.timing.delay}ms \u00b7 ${esc(String(a.timing.iterations))}\u00d7</span></div>`));
      m.trans.forEach((x) => lst.push(`<div class="mi"><b>Transition: ${esc(x.prop)}</b><span>${x.duration}ms \u00b7 ${esc(x.easing)}${x.delay ? " \u00b7 delay " + x.delay + "ms" : ""}</span></div>`));
      m.hover.forEach((h) => lst.push(`<div class="mi"><b>${esc(h.sel)}</b><span>${esc(Object.entries(h.decls).slice(0, 4).map(([a, b]) => a + ": " + b).join("; "))}</span></div>`));
      if (probe && probe.gsap) probe.gsap.forEach((g) => { const v = g.vars || {}, skip = /^(delay|duration|ease|overwrite|paused|stagger|scrollTrigger|onComplete|onStart|onUpdate|immediateRender|lazy|id|data|repeat|yoyo|repeatDelay|runBackwards|startAt|callbackScope)$/; const to = Object.entries(v).filter(([k, x]) => !skip.test(k) && (typeof x === "number" || typeof x === "string")).slice(0, 6).map(([k, x]) => k + " \u2192 " + x); lst.push(`<div class="mi"><b>GSAP tween (${esc(g.on)})</b><span>${to.length ? "Animates " + esc(to.join(", ")) + ". " : ""}${Math.round(g.duration * 1000)}ms${v.ease ? " \u00b7 ease " + esc(String(v.ease)) : ""}${v.delay ? " \u00b7 delay " + Math.round(v.delay * 1000) + "ms" : ""}${v.stagger ? " \u00b7 staggered across children" : ""}</span></div>`); });
      if (probe && probe.st) probe.st.forEach((x) => lst.push(`<div class="mi"><b>ScrollTrigger</b><span>${esc(stWords(x))}</span></div>`));
      if (probe && probe.framer) lst.push(`<div class="mi"><b>Framer Motion props</b><span>${esc(Object.keys(probe.framer).filter((k) => probe.framer[k] != null).join(", "))}</span></div>`);
      const tabs = [["css", "CSS"], ["js", "JavaScript"], ["react", "React"], ["lib", "Library"], ["prompt", "AI prompt"]].filter(([k]) => k !== "lib" || code.lib);
      if (!tabs.some(([k]) => k === motionTab)) motionTab = "css";
      const txt = code[motionTab] || "";
      lp.innerHTML = `<div class="ph"><b>Motion</b><span class="mono">${esc(selectorOf(el))}</span></div>
        ${sty ? `<div class="mstyle" style="padding:12px 16px 4px"><span class="mchip" style="background:#0d99ff;color:#fff;font-weight:600">${esc(sty.name)}</span><div class="sub" style="margin-top:6px;line-height:1.45;color:#d6d6d6;font-size:12.5px">${esc(sty.desc)}</div></div>` : ""}
        <div class="mprev"><div class="mstage" id="mstage"></div><div class="mbar"><button class="mini" id="mplay" aria-label="Pause or play preview">Pause</button><button class="mini" id="mrst" aria-label="Restart preview">Restart</button><span class="mhint">${eff ? esc(eff.label) : "Nothing to preview yet"}</span></div>
        <div class="mnote">${eff ? (eff.kind === "sampled" ? "Preview replays sampled values, so timing and easing are approximate." : "Preview replays the exact keyframes on a styled copy of the element. Scripts, scroll links and page layout are not reproduced.") : (libs.length ? "No CSS animation to replay: this page animates with JavaScript (" + libs.map((l) => l.name).slice(0, 3).join(", ") + "), usually on scroll or hover. Press Watch for 8 s, then scroll or hover the element, and the real motion is captured into this preview." : "No CSS or Web Animation found right now. Press Watch, then scroll or hover the element.")}</div></div>
        <section class="esec"><div class="eh"><h4>Libraries on this page</h4></div>${libs.length ? libRows(libs) : chips}</section>
        <section class="esec"><div class="eh"><h4>On this element</h4></div>${lst.join("") || `<div class="mnone">No animation, transition or hover rule found.</div>`}
          <div class="mwatch"><button class="pbtn sec2" id="mwatch">Watch for 8 s</button><span class="mhint" id="mw">Catches scroll, hover and script-driven effects that are not running now.</span></div></section>
        <section class="esec"><div class="eh"><h4>Code</h4><button class="mini pri" id="mcopy">Copy</button></div><div class="mtabs">${tabs.map(([k, l]) => `<button class="mtab${k === motionTab ? " on" : ""}" data-mt="${k}">${l}</button>`).join("")}</div><pre class="mcode" id="mcode">${esc(txt || "Nothing to show for this tab.")}</pre>
          <div class="mwatch"><button class="pbtn" id="mfig">Copy to Figma (with motion)</button><span class="mhint">Copies this element as Figma layers with its GSAP and Web Animation keyframes. Paste with Ctrl+V on the Figma canvas.</span></div>
          <div class="mwatch"><button class="pbtn sec2" id="mref">Save reference image</button><span class="mhint">Saves a PNG of the element to attach with the AI prompt.</span></div></section><div style="height:12px"></div>`;
      const stage = lp.querySelector("#mstage");
      requestAnimationFrame(() => mountPreview(stage, el, eff));
      lp.querySelector("#mplay").onclick = (ev) => { if (preview) ev.target.textContent = preview.toggle() ? "Pause" : "Play"; };
      lp.querySelector("#mrst").onclick = () => preview && preview.restart();
      lp.querySelectorAll("[data-mt]").forEach((b) => b.onclick = () => { motionTab = b.dataset.mt; render(); });
      lp.querySelectorAll("[data-copy]").forEach((b) => b.onclick = () => { navigator.clipboard.writeText(b.dataset.copy).then(() => { b.textContent = "Copied"; setTimeout(() => { b.textContent = "Copy"; }, 1400); }).catch(() => say("Clipboard was blocked.")); });
      lp.querySelectorAll("a.mlink").forEach((a) => a.addEventListener("click", (e) => e.stopPropagation()));
      lp.querySelector("#mcopy").onclick = (ev) => { navigator.clipboard.writeText(txt).then(() => { ev.target.textContent = "Copied"; setTimeout(() => { ev.target.textContent = "Copy"; }, 1500); }).catch(() => say("Clipboard was blocked.")); };
      lp.querySelector("#mfig").onclick = () => { copyFigma(el); };
      lp.querySelector("#mref").onclick = async (ev) => { ev.target.textContent = "Saving\u2026"; try { await elementShot(el); say("Saved blue-dot-effect-ref.png to your downloads."); } catch (e) { say("Could not save the image: " + e.message); } ev.target.textContent = "Save reference image"; };
      lp.querySelector("#mwatch").onclick = () => {
        const mw = lp.querySelector("#mw"); lp.querySelector("#mwatch").disabled = true;
        motionStop = watchMotion(el, 8, (res, seen) => {
          motionStop = null;
          if (res) m.samples = res;
          seen.forEach((a) => { if (a.kfs.length > 1 && !m.anims.some((x) => x.name === a.name)) m.anims.push({ type: "Web Animation", name: a.name, timing: a.timing, kfs: a.kfs, ruleText: null }); });
          render();
          say(res || seen.length ? "Watch done. Motion captured." : "Nothing changed on that element while watching.");
        }, (left) => { mw.textContent = "Watching\u2026 scroll or hover now (" + Math.ceil(left) + " s)"; });
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
      chip.style.cssText = "all:unset;box-sizing:border-box;margin:2px 0 8px 20px;white-space:nowrap;height:26px;padding:0 12px;border-radius:13px;background:#0d99ff;color:#fff;font:600 12px Inter,system-ui,sans-serif;cursor:pointer;display:inline-flex;align-items:center;gap:6px;animation:fmup .16s cubic-bezier(.22,1,.36,1)";
      chip._m = found; chip._on = false; host2.after(chip);
      chip.addEventListener("click", (e) => {
        e.stopPropagation();
        const cur = inp.value, key = "g:c:" + orig;
        if (!chip._on) { setAllColour(chip._m, cur); for (const v of (buildVarMap().get(orig) || [])) rootVars.set(v, cur); chip._on = true; render(); record(key, `${orig} (all ${chip._m.length + 1} uses)`, orig, cur, "colour"); }
        else { for (const { el, prop } of chip._m) { const o2 = overrides.get(elId(el)); if (!o2) continue; if (prop === "border") ["top", "right", "bottom", "left"].forEach((sd) => delete o2[`border-${sd}-color`]); else delete o2[prop]; } for (const v of (buildVarMap().get(orig) || [])) rootVars.delete(v); chip._on = false; log.delete(key); updateBadge(); render(); }
        chip.textContent = chip._on ? `Applied to ${chip._m.length + 1} places \u00b7 Undo` : `Apply to all ${chip._m.length + 1}`;
      });
    }
    if (!chip._m.length) { chip.textContent = "No other element uses this colour"; chip.style.background = "#4a4a4a"; chip.style.cursor = "default"; return; }
    if (chip._on) { setAllColour(chip._m, to); for (const v of (buildVarMap().get(orig) || [])) rootVars.set(v, to); render(); record("g:c:" + orig, `${orig} (all ${chip._m.length + 1} uses)`, orig, to, "colour"); }
    else chip.textContent = `Apply to all ${chip._m.length + 1}`;
  };
  /* ---------- Find-style usage navigation (3 of 12, prev/next) ---------- */
  let finder = null;
  const stopFind = () => { if (!finder) return; finder.stop = true; finder.bar.remove(); finder.boxes.forEach((b) => b.remove()); finder = null; };
  const startFind = (els, label) => {
    stopFind();
    const list = [...new Set(els)].filter((e) => e && e.isConnected && !isUI(e));
    if (!list.length) { say("Nothing on this page uses that."); return; }
    const bar = document.createElement("div"); bar.className = "findbar";
    bar.style.cssText = "position:fixed;left:50%;bottom:76px;transform:translateX(-50%);z-index:2147483647;display:flex;align-items:center;gap:6px;background:#2c2c2c;color:#fff;border-radius:10px;padding:6px 8px 6px 14px;font:600 13px Inter,system-ui,sans-serif;box-shadow:0 8px 28px rgba(0,0,0,.45);pointer-events:auto;animation:fmup .16s cubic-bezier(.22,1,.36,1)";
    const B = "all:unset;box-sizing:border-box;width:28px;height:28px;border-radius:6px;display:inline-flex;align-items:center;justify-content:center;cursor:pointer;background:#3d3d3d;color:#fff;font:600 15px Inter,system-ui,sans-serif";
    bar.innerHTML = `<span style="opacity:.7;font-weight:500;max-width:150px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(label)}</span><span class="fc" style="min-width:64px;text-align:center;font-variant-numeric:tabular-nums">1 of ${list.length}</span><button class="fp" style="${B}" aria-label="Previous match" title="Previous (Shift+Enter)">\u2039</button><button class="fn" style="${B}" aria-label="Next match" title="Next (Enter)">\u203a</button><button class="fx" style="${B};background:transparent" aria-label="Close find" title="Close (Esc)">\u2715</button>`;
    root.appendChild(bar);
    const mk = (cur) => { const b = document.createElement("div"); b.style.cssText = "position:fixed;z-index:2147483645;pointer-events:none;box-sizing:border-box;border-radius:3px;transition:opacity .15s;" + (cur ? "border:2px solid #f24822;box-shadow:0 0 0 3px rgba(242,72,34,.25);z-index:2147483646" : "border:1px dashed rgba(13,153,255,.9);background:rgba(13,153,255,.08)"); root.appendChild(b); return b; };
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
  document.addEventListener("keydown", (e) => {
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
    const inh = `/* Inherited from the page (set here so the component looks the same on its own) */\n${selR} { font-family: ${rcs.fontFamily}; font-size: ${rcs.fontSize}; line-height: ${rcs.lineHeight}; color: ${rcs.color}; box-sizing: ${rcs.boxSizing}; }`;
    const css = [(varLines.length ? ":root {\n" + varLines.join("\n") + "\n}" : ""), ...fontCss.map(cssAbs), ...kfCss.map(cssAbs), inh, ...out.map(cssAbs)].filter(Boolean).join("\n\n");
    return { clone, css, ctx, assets: [...assets], stats: { ...stats, vars: varLines.length, fonts: fontCss.length, kf: kfCss.length, assets: assets.size, w: Math.round(el.getBoundingClientRect().width) } };
  };
  const ATTR = { class: "className", for: "htmlFor", tabindex: "tabIndex", srcset: "srcSet", colspan: "colSpan", rowspan: "rowSpan", maxlength: "maxLength", readonly: "readOnly", autocomplete: "autoComplete", autofocus: "autoFocus", crossorigin: "crossOrigin", datetime: "dateTime", enctype: "encType", frameborder: "frameBorder", novalidate: "noValidate", contenteditable: "contentEditable", spellcheck: "spellCheck", "accept-charset": "acceptCharset", "http-equiv": "httpEquiv", viewbox: "viewBox", "stroke-width": "strokeWidth", "stroke-linecap": "strokeLinecap", "stroke-linejoin": "strokeLinejoin", "fill-rule": "fillRule", "clip-rule": "clipRule", "clip-path": "clipPath", "stroke-dasharray": "strokeDasharray", "stroke-dashoffset": "strokeDashoffset", "stroke-miterlimit": "strokeMiterlimit", "stop-color": "stopColor", "stop-opacity": "stopOpacity", "fill-opacity": "fillOpacity", "stroke-opacity": "strokeOpacity", "text-anchor": "textAnchor", "xlink:href": "xlinkHref", "xml:space": "xmlSpace", preserveaspectratio: "preserveAspectRatio", gradientunits: "gradientUnits", gradienttransform: "gradientTransform" };
  const VOID = /^(area|base|br|col|embed|hr|img|input|link|meta|source|track|wbr)$/i;
  const jsxStyle = (st) => "{{ " + st.split(";").map((d) => d.trim()).filter(Boolean).map((d) => { const i = d.indexOf(":"); const k = d.slice(0, i).trim(), v = d.slice(i + 1).trim(); const key = k.startsWith("--") ? JSON.stringify(k) : k.replace(/^-ms-/, "ms-").replace(/-([a-z])/g, (m, c) => c.toUpperCase()); return key + ": " + JSON.stringify(v); }).join(", ") + " }}";
  const toJsx = (n, ind) => {
    const pad = "  ".repeat(ind);
    if (n.nodeType === 3) { const t = n.textContent.replace(/\s+/g, " "); if (!t.trim()) return ""; return pad + t.trim().replace(/[{}<>]/g, (c) => "{" + JSON.stringify(c) + "}") + "\n"; }
    if (n.nodeType !== 1) return "";
    const tag = n.tagName.toLowerCase();
    const attrs = [...n.attributes].map((a) => { const k = a.name.toLowerCase(); if (k === "style") return ` style=${jsxStyle(a.value)}`; if (k === "class" && !a.value.trim()) return ""; const nm = ATTR[k] || (k.startsWith("aria-") || k.startsWith("data-") ? k : k.replace(/-([a-z])/g, (m, c) => c.toUpperCase())); if (a.value === "" && /^(disabled|checked|hidden|required|readonly|multiple|selected|autoplay|loop|muted|controls|playsinline|async|defer)$/.test(k)) return ` ${nm}`; return ` ${nm}=${/[{}"\n]/.test(a.value) ? "{" + JSON.stringify(a.value) + "}" : '"' + a.value + '"'}`; }).join("");
    if (VOID.test(tag)) return `${pad}<${tag}${attrs} />\n`;
    const kids = [...n.childNodes].map((c) => toJsx(c, ind + 1)).join("");
    return kids ? `${pad}<${tag}${attrs}>\n${kids}${pad}</${tag}>\n` : `${pad}<${tag}${attrs}></${tag}>\n`;
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
          <div class="mnote">Includes ${S.rules} matching rule${S.rules === 1 ? "" : "s"}, ${S.media} media quer${S.media === 1 ? "y" : "ies"}${S.container ? ", " + S.container + " container quer" + (S.container === 1 ? "y" : "ies") : ""}, ${S.vars} CSS variable${S.vars === 1 ? "" : "s"}, ${S.fonts} font rule${S.fonts === 1 ? "" : "s"}, ${S.kf} keyframe set${S.kf === 1 ? "" : "s"}. Measured ${S.w}px wide here. Image and font URLs are made absolute, so they load from the original site.</div>
          <div class="mtabs" style="padding:8px 16px 0"><button class="mtab${tab === "react" ? " on" : ""}" data-ct="react">React (JSX + CSS)</button><button class="mtab${tab === "html" ? " on" : ""}" data-ct="html">HTML + CSS</button></div>
          <div style="padding:8px 16px"><pre class="mcode" style="max-height:340px;overflow:auto;margin:0">${esc(txt)}</pre></div>
          <div class="foot"><button class="pbtn" id="ccopy">Copy ${tab === "react" ? "React component" : "HTML + CSS"}</button></div>
          <div class="mnote" style="margin-top:8px">${d.assets.length ? d.assets.length + " asset URL" + (d.assets.length === 1 ? "" : "s") + " used (images, backgrounds, fonts). Download them if the component must work offline or off the original site." : "No images or font files found."} Scripts and JavaScript behaviour are not included. Rules are copied as written, so the component keeps its breakpoints. Check it in your project at narrow and wide widths.</div>`;
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
    if (kind === "shot") {
      m.innerHTML = `<button data-a="screen">${ic('<rect x="2" y="3" width="14" height="9.500" rx="1.500"/><path d="M6 15.500h6M9 12.500v3"/>')}<span>Capture screen</span></button><button data-a="visible">${ic('<path d="M3 6V4.500A1.500 1.500 0 0 1 4.500 3H6M12 3h1.500A1.500 1.500 0 0 1 15 4.500V6M15 12v1.500a1.500 1.500 0 0 1-1.500 1.500H12M6 15H4.500A1.500 1.500 0 0 1 3 13.500V12"/>')}<span>Capture visible area</span></button><button data-a="full">${ic('<rect x="4.500" y="2" width="9" height="14" rx="1.500"/><path d="M7 5.500h4M7 8.500h4M7 11.500h2"/>')}<span>Capture full page</span></button>`;
    } else
    m.innerHTML = `<button data-a="code">${ic('<path d="M6.5 3C5 3 4.5 3.8 4.5 5v1.5C4.5 7.6 3.8 8.5 2.8 9c1 .5 1.7 1.4 1.7 2.5V13c0 1.200.5 2 2 2M11.5 3c1.500 0 2 .8 2 2v1.500c0 1.100.7 2 1.700 2.500-1 .5-1.700 1.400-1.700 2.500V13c0 1.200-.5 2-2 2"/>')}<span>Capture code</span></button><button data-a="design">${ic('<rect x="2.500" y="3.500" width="13" height="11" rx="2"/><path d="M2.500 7h13"/>')}<span>Capture design</span></button><button data-a="select">${ic('<path d="M3 3h9v5M3 3v9h4M9 9l1.500 6 1.800-2.300 2.700-.4z"/>')}<span>Select element</span></button>`;
    root.appendChild(m); figMenu = m;
    const r = btn.getBoundingClientRect();
    m.style.left = Math.max(8, Math.min(r.left + r.width / 2 - m.offsetWidth / 2, innerWidth - m.offsetWidth - 8)) + "px";
    m.style.bottom = innerHeight - r.top + 10 + "px";
    const re = () => { if (!figMenu) return; const q = btn.getBoundingClientRect(); m.style.left = Math.max(8, Math.min(q.left + q.width / 2 - m.offsetWidth / 2, innerWidth - m.offsetWidth - 8)) + "px"; m.style.bottom = innerHeight - q.top + 10 + "px"; };
    setTimeout(re, 120); setTimeout(re, 480);
    m.addEventListener("click", (e) => {
      const b = e.target.closest("button[data-a]"); if (!b) return; e.stopPropagation();
      const a = b.dataset.a; closeFigMenu();
      if (a === "screen") return shotScreen();
      if (a === "visible") return shotVisible();
      if (a === "full") return fullShot();
      if (a === "design") { finishOpen = false; rp.classList.remove("show"); copyFigma(document.body); }
      else if (a === "select") armFigma(true);
      else { finishOpen = false; rp.classList.remove("show"); codeArmed = true; setPicking(true); codeArmed = true; setActive(); say("Click the element whose code you want to copy. Esc cancels."); }
    });
  };
  document.addEventListener("mousedown", (e) => { if (figMenu && !e.composedPath().includes(figMenu) && !e.composedPath().some((n) => n.dataset && (n.dataset.m === "figma" || n.dataset.m === "shot"))) closeFigMenu(); }, true);
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && figMenu) closeFigMenu(); }, true);

  /* ---------- bar wiring ---------- */
  root.querySelectorAll(".bar .btn[data-m]").forEach((b) => b.addEventListener("click", () => {
    const m = b.dataset.m;
    if (m === "notch") return setCollapsed(!collapsed);
    if (m === "theme") { host.classList.toggle("dark"); try { localStorage.setItem("dsx-theme", host.classList.contains("dark") ? "dark" : "light"); } catch (e) {} return; }
    if (m === "close") return destroy();
    if (m === "pclose") { stopFind(); if (picking) setPicking(false); finishOpen = false; rp.classList.remove("show"); openMode(null); return; }
    if (m === "shot") { if (figMenuOpen === "shot") return closeFigMenu(); releaseTools("shot"); return openFigMenu(b, "shot"); }
    if (m === "figma") { if (figMenuOpen === "figma") return closeFigMenu(); if (figmaArmed || codeArmed) return setPicking(false); releaseTools("figma"); return openFigMenu(b); }
    if (m === "motion") { if (mode === "motion") return openMode(null); if (!motionArmed) releaseTools("motion"); return armMotion(!motionArmed); }
    if (m === "revert") return revertAll();
    if (m === "compare") return toggleCompare();
    if (m === "finish") { if (finishOpen) { finishOpen = false; rp.classList.remove("show"); setActive(); } else { setPicking(false); showFinish(); } return; }
    if (m === "pick") { finishOpen = false; if (picking) { setPicking(false); } else { releaseTools("pick"); rp.classList.remove("show"); setPicking(true); } return; }
    releaseTools(m);
    openMode(mode === m ? null : m);
  }));
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && picking) setPicking(false); }, true);


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
  document.addEventListener("keydown", (e) => {
    if (!e.altKey || e.ctrlKey || e.metaKey) return;
    const m = Object.keys(KEYS).find((k) => KEYS[k][0] === e.code);
    if (!m) return;
    const btn = root.querySelector(`.bar .btn[data-m=${m}]`);
    if (!btn || (m !== "notch" && collapsed) || btn.classList.contains("gone")) return;
    e.preventDefault(); e.stopPropagation(); btn.click();
  }, true);
  document.addEventListener("keydown", (e) => {
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
    if (b.classList.contains("collapsed")) { b.classList.remove("compact", "tight"); return; }
    const avail = innerWidth - (host.classList.contains("lpopen") ? parseInt(host.style.getPropertyValue("--lpw") || "300", 10) + 44 : 16);
    /* measure on a hidden copy so the real bar's transitions are never interrupted */
    const c = b.cloneNode(true);
    c.classList.add("nofx"); c.classList.remove("compact", "tight", "on");
    c.style.cssText += ";visibility:hidden;pointer-events:none;transition:none";
    b.parentNode.appendChild(c);
    let want = 0;
    if (c.scrollWidth > avail) { want = 1; c.classList.add("compact"); if (c.scrollWidth > avail) { want = 2; c.classList.add("tight"); } }
    c.remove();
    b.classList.toggle("compact", want >= 1); b.classList.toggle("tight", want >= 2);
  };
  new MutationObserver(() => { if (!fitting) setTimeout(fitBar, 0); }).observe(host, { attributes: true, attributeFilter: ["class", "style"] });
  /* only re-measure when something that changes the bar's natural width changed (a button shown/hidden, collapse state).
     Selecting a tool toggles .on only; measuring then used to switch transitions off for a frame and made the bar snap. */
  let barSig = "";
  const sigOf = () => { const b = $("#bar"); return b.className.replace(/\b(compact|tight|nofx)\b/g, "").trim() + "|" + [...b.querySelectorAll(".btn")].map((x) => (x.classList.contains("gone") ? 1 : 0) + (x.classList.contains("has") ? "h" : "")).join(""); };
  new MutationObserver(() => { if (fitting) return; const sg = sigOf(); if (sg === barSig) return; barSig = sg; setTimeout(fitBar, 0); }).observe($("#bar"), { attributes: true, attributeFilter: ["class"], subtree: true });
  window.addEventListener("resize", fitBar);
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
  window.addEventListener("mousemove", (e) => {
    if (!dragSt) return;
    if (!dragged && Math.hypot(e.clientX - dragSt.sx, e.clientY - dragSt.sy) < 5) return;
    dragged = true; barEl.classList.add("dragging");
    placeBar(dragSt.x + e.clientX - dragSt.sx, dragSt.y + e.clientY - dragSt.sy);
  }, true);
  window.addEventListener("mouseup", () => {
    if (!dragSt) return;
    if (dragged) { const r = barEl.getBoundingClientRect(); store.set(POSKEY, { x: r.left, y: r.top }); setTimeout(() => { dragged = false; }, 0); }
    dragSt = null; barEl.classList.remove("dragging");
  }, true);
  brandBtn.addEventListener("click", (e) => { if (dragged) { e.stopImmediatePropagation(); e.preventDefault(); } }, true);
  brandBtn.addEventListener("contextmenu", (e) => { e.preventDefault(); resetBar(); store.del(POSKEY); });
  store.get(POSKEY).then((p) => { if (p && typeof p.x === "number") placeBar(p.x, p.y); });
  window.addEventListener("resize", () => { if (barEl.style.left) { const r = barEl.getBoundingClientRect(); placeBar(r.left, r.top); } });

  host.classList.add("away");
  setTimeout(() => setCollapsed(false), 160);
  const destroy = () => {
    // closing keeps nothing: edits are temporary
    revertAll(); setPicking(false);
    document.removeEventListener("mousemove", onMove, true);
    document.removeEventListener("click", onClick, true);
    window.removeEventListener('scroll', reflow, true); window.removeEventListener('resize', reflow); host.remove(); sheet.remove(); delete window.__dsx;
  };
  window.__dsx = { toggle: destroy };
  setActive();
})();
