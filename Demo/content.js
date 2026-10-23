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
  let mode = null, picking = false, selected = null, finishOpen = false;

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
        if (!e) m.set(i.key, { ...i, count: 1 });
        else { e.count++; if (i.ratio !== undefined && i.ratio < e.ratio) { e.ratio = i.ratio; e.msg = i.msg; } }
      }
    }
    return [...m.values()].sort((a, b) => (a.sev === "error" ? 0 : 1) - (b.sev === "error" ? 0 : 1));
  };
  const renderLint = (node, issues) => {
    if (!node) return;
    node.innerHTML = issues.length
      ? issues.map((i) => `<div class="lt ${i.sev === "error" ? "err" : "warn"}">${i.sev === "error" ? "\u25cf" : "\u25b2"} ${esc(i.msg)}${i.count > 1 ? " \u00b7 " + i.count + " elements" : ""}</div>`).join("")
      : `<div class="lt ok">\u2713 No contrast or hierarchy issues</div>`;
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
    sessions: hi("<path fill=\"none\" stroke=\"currentColor\" stroke-linecap=\"round\" stroke-linejoin=\"round\" stroke-width=\"1.5\" d=\"M4 17.98V9.709c0-3.634 0-5.45 1.172-6.58S8.229 2 12 2s5.657 0 6.828 1.129C20 4.257 20 6.074 20 9.708v8.273c0 2.306 0 3.459-.773 3.871c-1.497.8-4.304-1.867-5.637-2.67c-.773-.465-1.16-.698-1.59-.698s-.817.233-1.59.698c-1.333.803-4.14 3.47-5.637 2.67C4 21.44 4 20.287 4 17.981\"/>"),
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
    .btn[data-m=compare]>span,.btn[data-m=sessions]>span{display:none!important}
    .btn[data-m=compare],.btn[data-m=sessions]{padding:0 9px}
    .note{padding:12px 16px;font-size:12.5px;line-height:1.5;color:#d6d6d6;background:#262626;border-bottom:1px solid var(--line)}
    .savebox{display:flex;gap:8px;padding:12px 16px 8px}
    .savebox .inp{flex:1}.savebox .pbtn{flex:none;width:76px}
    .pbtn[disabled]{opacity:.4;cursor:default;pointer-events:none}
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
    @media (prefers-reduced-motion:reduce){*{transition-duration:.01s!important}}
  </style>
  <div class="bar collapsed" id="bar" role="toolbar" aria-label="Blue Dot">
    <button class="btn brand" data-m="notch" data-tip="Click to collapse. Drag to move. Right-click to reset position." aria-label="Collapse or expand. Drag to move."><i class="pdot"><svg width="100%" height="100%" viewBox="0 0 313 282" fill="none" xmlns="http://www.w3.org/2000/svg"> <path d="M147.563 0.155904C166.822 -1.06346 180.108 4.81879 192.46 19.6024C182.771 27.8644 175.562 35.954 169.65 47.4227C159.347 67.4963 157.424 90.8374 164.31 112.325C171.282 133.86 186.559 151.728 206.752 161.96C228.545 172.989 251.081 173.589 273.988 166.01L289.416 193.768C299.633 212.179 308.197 226.051 300.208 247.84C295.608 260.439 286.207 270.71 274.056 276.406C258.793 283.393 244.727 281.218 229.486 275.724C220.66 272.54 213.358 267.063 205.128 262.707C198.907 259.412 192.643 256.802 186.07 254.323C161.5 245.946 133.997 243.283 110.632 256.971C106.947 259.131 100.895 263.354 97.2414 265.895C83.7591 275.267 73.2628 278.936 57.1452 281.251C43.5368 283.206 30.775 280.388 19.7407 271.907C9.04968 263.738 2.07242 251.631 0.366111 238.287C-0.660982 229.975 0.481823 221.537 3.68314 213.796C5.48684 209.444 8.63569 204.165 11.0086 199.96L22.3052 179.961L59.2195 114.467L94.4825 51.8631L104.731 33.6371C107.684 28.3913 110.582 22.8612 114.317 18.1559C122.704 7.58885 134.281 1.69115 147.563 0.155904Z" fill="#d9d9d9"/> <path d="M242.1 18.504C279.561 16.8958 311.218 45.9775 312.789 83.437C314.363 120.895 285.25 152.527 247.789 154.061C210.378 155.596 178.8 126.533 177.233 89.1244C175.662 51.7164 204.696 20.1097 242.1 18.504Z" fill="#063BC0"/> </svg> </i></button>
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
    <button class="btn" data-m="sessions" data-tip="Saved sessions" aria-label="Saved sessions">${ICONS.sessions}<span>Sessions</span></button>
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
      const t = textContrast(el), f = fixColour(el);
      return { title: "Hard to read", why: `This text is ${i.ratio.toFixed(1)}:1 against its background. WCAG AA needs ${t ? t.need : 4.5}:1, so low-vision users and anyone in bright light will struggle to read it.`, fix: f && { prop: "color", val: f.hex, from: f.from, label: `Use ${f.hex} (${f.ratio.toFixed(1)}:1)`, swatch: f.hex, kind: "colour", name: "text colour" } };
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
      <div class="acts">${d.fix ? `<button class="pb" data-a="fix">Apply fix</button>` : ""}${ov ? `<button class="pb b2" data-a="rev">Revert this change</button>` : ""}<button class="pb gh2" data-a="ign">Ignore</button></div>`;
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
    let html = `<div class="ph"><b>Issues from your edits</b><span class="scan">${L.length} open</span></div>`;
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
  const setActive = () => root.querySelectorAll(".bar .btn[data-m]").forEach((b) => b.classList.toggle("on", b.dataset.m === mode || (b.dataset.m === "pick" && picking) || (b.dataset.m === "finish" && finishOpen) || (b.dataset.m === "compare" && showOrig)));

  const colourPanel = () => {
    const list = cache.colours || (cache.colours = scanColors());
    lp.innerHTML = `<div class="ph"><b>Colours</b><span>${list.length} found</span></div>` + list.map((s, i) => `
      <div class="row"><label class="sw" style="background:${s.cur || s.hex}"><input type="color" data-i="${i}" value="${s.cur || s.hex}"></label>
      <div class="meta"><div class="nm">${esc(s.name)}</div><div class="sub">${s.vars.length ? esc(s.vars[0]) + " \u00b7 " : ""}${esc(s.role)}</div></div>
      <div class="hex ${s.cur ? "chg" : ""}">${s.cur || s.hex}</div></div><div data-l="${i}"></div>`).join("") || `<div class="empty">No colours found.</div>`;
    { const cl = colourDups(list); const L = (c) => `Used ${uses(c)}`; L.main = (c) => c.canon.cur || c.canon.hex;
      addDups(cl, L, (c) => [...c.members, c.canon].map((m) => `<span class="dotp" style="background:${m.cur || m.hex}"></span>${m.cur || m.hex}`).join(" \u00b7 "), "These colours look almost identical. Merge them into the most used one.", (c) => mergeColours(list, c)); }
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
    lp.querySelectorAll(".it.go").forEach((n) => n.addEventListener("click", () => { const it = F[n.dataset.f].items[n.dataset.i]; if (it && it.el) flash(it.el); }));
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
  const analyzeDoc = (doc, live, pageUrl) => {
    const out = [], R = route(pageUrl);
    const q = (s) => [...doc.querySelectorAll(s)].filter((e) => !live || !isUI(e));
    const add = (sev, el, reason, extra) => out.push({ page: R, sev, label: el ? labelOf(el) : "page", reason, el: live ? el : null, ...extra });
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
  const flowPanel = async () => {
    const run = ++flowRun;
    if (flowAbort) flowAbort.abort();
    const ctl = (flowAbort = new AbortController());
    const origin = location.origin, startU = new URL(location.href); startU.hash = ""; startU.pathname = startU.pathname.replace(/\/index\.(html?|php)$/, "/");
    const pages = new Map(), seen = new Set([startU.href]), queue = [{ url: startU.href, depth: 0 }];
    const refs = [];       // {from,text,target,hash,el}
    const findings = [], skipped = new Set(); let external = 0, capped = 0, fetched = 0, active = 0;
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
          refs.push({ from: route(pageUrl), text, target: u.href, hash, el: live ? a : null });
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
        if (reported.has(key)) continue; reported.add(key);
        const gated = t.status === 401 || t.status === 403;
        findings.push({ page: r.from, sev: gated ? "warn" : "error", label: r.text, reason: t.err ? `Link to ${route(r.target)} fails: ${t.err}` : gated ? `Link to ${route(r.target)} needs sign-in (${t.status}), not checked` : `Link to ${route(r.target)} returns ${t.status}`, el: r.el });
      } else if (t.redirected && /\/(log-?in|sign-?in|auth)\b/i.test(route(t.final))) {
        if (reported.has(key)) continue; reported.add(key);
        findings.push({ page: r.from, sev: "warn", label: r.text, reason: `${route(r.target)} redirects to sign-in, so its content was not checked`, el: r.el });
      } else if (r.hash && t.doc && t.status === 200) {
        const id = decodeURIComponent(r.hash);
        if (!t.doc.getElementById(id) && !t.doc.querySelector(`a[name="${CSS.escape(id)}"]`) && !reported.has(key + "#")) { reported.add(key + "#"); findings.push({ page: r.from, sev: "error", label: r.text, reason: `${route(r.target)} has no element with id "${id}"`, el: r.el }); }
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
        html += `<div class="fl ${f.el ? "go" : ""}" data-sev="${f.sev}" data-i="${idx}"><span class="shp ${f.sev === "error" ? "err" : "warn"}" aria-label="${f.sev === "error" ? "Broken" : "Check"}">${f.sev === "error" ? SHAPE.error : SHAPE.warn}</span><div class="meta"><div class="ttl"><span class="nm">${esc(L.title)}</span>${L.tag ? `<span class="tag">${esc(L.tag)}</span>` : ""}</div><div class="sub wrap">${codeify(esc(shortReason(f.reason)))}</div></div><div class="racts">${f.el ? `<button data-a="loc">Locate</button>` : ""}<button data-a="cp">Copy</button><button data-a="ig">Ignore</button></div></div>`;
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
          if (a.dataset.a === "loc" && f.el) flash(f.el);
          if (a.dataset.a === "cp") navigator.clipboard.writeText(`${f.label}: ${f.reason}`).then(() => { a.textContent = "Copied"; setTimeout(() => { a.textContent = "Copy"; }, 1200); }).catch(() => {});
          if (a.dataset.a === "ig") { gone.add(f); refresh(); }
          return;
        }
        if (f.el) flash(f.el);
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
  const SKEY = () => "dsx:sessions:" + location.origin + location.pathname;
  const storeOk = () => { try { return !!(chrome && chrome.storage && chrome.storage.local); } catch (e) { return false; } };
  const sessionsPanel = async () => {
    const ok = storeOk(), list = ok ? ((await store.get(SKEY())) || []) : [], n = log.size;
    lp.innerHTML = `<div class="ph"><b>Saved sessions</b><span class="scan">this page</span></div>
      <div class="note">Saving is opt-in. Nothing is stored unless you press Save. Sessions stay on this computer, inside the extension, for this page address only. If you close the bar without saving, your edits are discarded.</div>
      <div class="savebox"><input class="inp" id="sname" maxlength="40" value="Session ${list.length + 1}" aria-label="Session name"><button class="pbtn" id="ssave" ${n && ok ? "" : "disabled"}>Save</button></div>
      <div class="sub" style="padding:0 16px 10px">${ok ? `${n} change${n === 1 ? "" : "s"} to save${n ? "" : ". Make an edit first."}` : "Storage is not available here, so sessions cannot be saved."}</div>` +
      (list.length ? `<div class="sec gh">Saved for this page<span>${list.length}</span></div>` + list.map((x) => `<div class="srow" data-id="${esc(x.id)}"><div class="meta"><div class="nm">${esc(x.name)}</div><div class="sub">${x.n} change${x.n === 1 ? "" : "s"} \u00b7 ${esc(new Date(x.at).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }))}</div></div><button class="mini" data-a="load">Load</button><button class="mini" data-a="del">Delete</button></div>`).join("") + `<div class="foot2">Loading replaces your current edits.</div>` : `<div class="empty">No saved sessions for this page yet.</div>`);
    const sv = $("#ssave"); if (sv) sv.onclick = async () => {
      const name = ($("#sname").value || "").trim() || "Session " + (list.length + 1);
      list.unshift({ id: Date.now().toString(36), name, at: Date.now(), n: log.size, data: snapshot() });
      store.set(SKEY(), list.slice(0, 20)); say("Saved \u201c" + name + "\u201d"); sessionsPanel();
    };
    lp.querySelectorAll(".srow .mini").forEach((b) => b.addEventListener("click", () => {
      const id = b.closest(".srow").dataset.id, x = list.find((i) => i.id === id); if (!x) return;
      if (b.dataset.a === "del") { store.set(SKEY(), list.filter((i) => i.id !== id)); sessionsPanel(); return; }
      const miss = restore(x.data);
      say(miss ? `Loaded. ${miss} edit${miss === 1 ? "" : "s"} could not find ${miss === 1 ? "its" : "their"} element on this page.` : "Loaded \u201c" + x.name + "\u201d");
      sessionsPanel();
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
  const dupHtml = (cl, label, fmt, note) => cl.length ? `<details class="dups" open><summary><span class="shp warn">\u25b3</span>Near-duplicates<b>${cl.length}</b></summary><div class="dnote">${esc(note)}</div>` + cl.map((c, i) => `<div class="drow"><div class="meta"><div class="nm">${fmt(c)}</div><div class="sub">${esc(label(c))}</div></div><button class="mini pri" data-merge="${i}" data-tip="Change every use of the similar values to ${esc(label.main ? label.main(c) : "the main one")}. You can undo it with Revert.">Merge</button></div>`).join("") + `</details>` : "";
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
    lp.style.width = m === "issues" ? "340px" : m === "sessions" ? "340px" : m === "effects" ? "340px" : m === "review" ? "360px" : m === "flow" ? "380px" : "300px";
    if (m !== "flow" && flowAbort) flowAbort.abort();
    lp.innerHTML = `<div class="empty">Scanning\u2026</div>`;
    setTimeout(() => ({ colours: colourPanel, text: textPanel, spacing: spacingPanel, review: reviewPanel, flow: flowPanel, issues: issuesPanel, sessions: sessionsPanel, effects: effectsPanel })[m](), 20);
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
    const rows = EP.map(([label, prop, kind]) => {
      const val = cssShort(cs, prop);
      if (kind === "c") {
        const hex = toHex(val), vars = hex ? vm.get(hex) || [] : [];
        return `<div class="erow"><div class="k">${label}</div><div class="v"><div class="cw"><label class="sw" style="background:${hex || "transparent"}"><input type="color" data-p="${prop}" data-o="${hex || ""}" value="${hex || "#ffffff"}"></label><span class="hex">${hex || "transparent"}</span></div>${vars.length ? `<div class="vn">${vars.map(esc).join(", ")}</div>` : ""}</div></div>`;
      }
      return `<div class="erow"><div class="k">${label}</div><div class="v"><input class="inp" data-p="${prop}" data-o="${esc(val.split(",")[0].replace(/["']/g, ""))}" value="${esc(val.split(",")[0].replace(/["']/g, ""))}"></div></div>`;
    }).join("");
    rp.innerHTML = `<div class="ph"><b>${esc(sel)}</b><span>${Math.round(el.getBoundingClientRect().width)} \u00d7 ${Math.round(el.getBoundingClientRect().height)}</span></div><div id="elint"></div>${rows}<div style="height:10px"></div>`;
    rp.classList.add("show");
    rp.querySelector("#elint").insertAdjacentHTML("afterend", `<div class="erow"><button class="pbtn sec2" id="etx" ${editable(el) ? "" : 'data-tip="This element has other elements inside it. Pick the one that holds the text."'} style="flex:none;padding:0 14px;${editable(el) ? "" : "opacity:.5"}">Edit text on page</button></div>`);
    rp.querySelector("#etx").onclick = () => startTextEdit(el);
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
    showElement(t);
  };
  const swallow = (e) => { if (picking && target(e)) { e.preventDefault(); e.stopPropagation(); } };
  document.addEventListener("mousemove", onMove, true);
  document.addEventListener("click", onClick, true);
  ["mousedown", "mouseup", "pointerdown", "pointerup", "submit"].forEach((n) => document.addEventListener(n, swallow, true));
  const setPicking = (on) => {
    picking = on;
    if (!on) { hl.style.display = hlt.style.display = "none"; rp.classList.remove("show"); selected = null; }
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

  /* ---------- bar wiring ---------- */
  root.querySelectorAll(".bar .btn[data-m]").forEach((b) => b.addEventListener("click", () => {
    const m = b.dataset.m;
    if (m === "notch") return setCollapsed(!collapsed);
    if (m === "theme") { host.classList.toggle("dark"); try { localStorage.setItem("dsx-theme", host.classList.contains("dark") ? "dark" : "light"); } catch (e) {} return; }
    if (m === "close") return destroy();
    if (m === "revert") return revertAll();
    if (m === "compare") return toggleCompare();
    if (m === "finish") { if (finishOpen) { finishOpen = false; rp.classList.remove("show"); setActive(); } else { setPicking(false); showFinish(); } return; }
    if (m === "pick") { finishOpen = false; if (picking) { setPicking(false); } else { rp.classList.remove("show"); setPicking(true); } return; }
    if (picking) setPicking(false);
    openMode(mode === m ? null : m);
  }));
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && picking) setPicking(false); }, true);


  /* ---------- tooltips with shortcut hints, keyboard shortcuts ---------- */
  const MAC = /Mac|iPhone|iPad/.test(navigator.platform || "");
  const KEYS = { colours: ["Digit1", "1"], text: ["Digit2", "2"], spacing: ["Digit3", "3"], pick: ["Digit4", "4"], review: ["Digit5", "5"], flow: ["Digit6", "6"], finish: ["KeyF", "F"], issues: ["KeyI", "I"], notch: ["KeyD", "D"], compare: ["KeyB", "B"], sessions: ["KeyS", "S"], effects: ["Digit7", "7"] };
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
    const b = $("#bar"); b.classList.remove("compact", "tight");
    if (b.classList.contains("collapsed")) return;
    const avail = innerWidth - (host.classList.contains("lpopen") ? parseInt(host.style.getPropertyValue("--lpw") || "300", 10) + 44 : 16);
    if (b.scrollWidth > avail) { b.classList.add("compact"); if (b.scrollWidth > avail) b.classList.add("tight"); }
  };
  new MutationObserver(() => { if (!fitting) setTimeout(fitBar, 0); }).observe(host, { attributes: true, attributeFilter: ["class", "style"] });
  new MutationObserver(() => { if (!fitting) setTimeout(fitBar, 0); }).observe($("#bar"), { attributes: true, attributeFilter: ["class"], subtree: true });
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
