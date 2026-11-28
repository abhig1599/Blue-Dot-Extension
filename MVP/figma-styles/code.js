function fontWeight(style) {
  const name = style.toLowerCase().replace(/[ -]/g, "");
  for (const [pattern, weight] of [[/thin|hairline/,100],[/extralight|ultralight/,200],[/light/,300],[/medium/,500],[/semibold|demibold/,600],[/extrabold|ultrabold/,800],[/black|heavy/,900],[/bold/,700]]) {
    if (pattern.test(name)) return weight;
  }
  return 400;
}

function chooseFont(type, fonts) {
  const families = type.family.split(",").map(name => name.trim().replace(/^["']|["']$/g, "").toLowerCase());
  const aliases = { "sans-serif":"arial", serif:"times new roman", monospace:"courier new", "system-ui":"inter", "-apple-system":"sf pro text" };
  for (const requested of families.concat("inter")) {
    const family = aliases[requested] || requested;
    const matches = fonts.filter(font => font.family.toLowerCase() === family);
    if (!matches.length) continue;
    const score = font => Math.abs(fontWeight(font.style) - Number(type.weight))
      + ((/italic|oblique/i.test(font.style) === /italic|oblique/i.test(type.style)) ? 0 : 1000);
    return matches.sort((a,b) => score(a) - score(b))[0];
  }
}

async function importStyles(pack) {
  if (!pack || pack.format !== "blue-dot/styles/1" || typeof pack.site !== "string" ||
      ![pack.types, pack.paints, pack.spaces].every(Array.isArray)) throw Error("Copy reusable styles from Blue Dot first.");
  const [fonts, text, paint, collections, variables] = await Promise.all([
    figma.listAvailableFontsAsync(), figma.getLocalTextStylesAsync(), figma.getLocalPaintStylesAsync(),
    figma.variables.getLocalVariableCollectionsAsync(), figma.variables.getLocalVariablesAsync("FLOAT")
  ]);
  const families = fonts.map(entry => entry.fontName);
  const prefix = pack.site.replace(/\//g, "-") + "/";
  const imported = new Set(text.concat(paint).map(item => item.getPluginData("capture")));
  let added = 0, skipped = 0, substitutions = 0;
  for (const t of pack.types) {
    const key = JSON.stringify([prefix, t]);
    if (imported.has(key)) continue;
    const pixels = value => /^-?\d+(\.\d+)?px$/.test(value) ? parseFloat(value) : NaN;
    const size = pixels(t.size);
    const height = pixels(t.lineHeight);
    const tracking = pixels(t.tracking);
    if (!(size > 0) || typeof t.family !== "string" || !(t.lineHeight === "normal" || height >= 0) ||
        !(t.tracking === "normal" || Number.isFinite(tracking))) { skipped++; continue; }
    const font = chooseFont(t, families);
    if (!font) { skipped++; continue; }
    try { await figma.loadFontAsync(font); } catch { skipped++; continue; }
    const style = figma.createTextStyle();
    try {
      style.name = prefix + (t.role === "Body" ? "p" : String(t.role).toLowerCase());
      if (text.some(item => item.name === style.name)) style.name += " · " + size + " " + font.style + " " + font.family;
      style.fontName = font;
      style.fontSize = size;
      style.lineHeight = t.lineHeight === "normal" ? {unit:"AUTO"} : {unit:"PIXELS", value:height};
      style.letterSpacing = {unit:"PIXELS", value:tracking || 0};
      style.description = t.family + " · CSS weight " + t.weight + " · " + t.style;
      style.setPluginData("capture", key);
      text.push(style);
      imported.add(key);
      added++;
      if (font.family.toLowerCase() !== t.family.split(",")[0].trim().replace(/^["']|["']$/g, "").toLowerCase() ||
          fontWeight(font.style) !== Number(t.weight)) substitutions++;
    } catch { style.remove(); skipped++; }
  }
  for (const p of pack.paints) {
    if (!Array.isArray(p.rgba) || p.rgba.length !== 4 || !p.rgba.every(n => Number.isInteger(n) && n >= 0 && n <= 255)) { skipped++; continue; }
    const key = JSON.stringify([prefix, p.rgba]);
    if (imported.has(key)) continue;
    const [r,g,b,a] = p.rgba.map(n => n / 255);
    const style = figma.createPaintStyle();
    try {
      style.name = prefix + p.role + " " + p.rgba.map(n => ("0" + n.toString(16)).slice(-2)).join("");
      style.paints = [{type:"SOLID", color:{r,g,b}, opacity:a}];
      style.setPluginData("capture", key);
      imported.add(key);
      added++;
    } catch { style.remove(); skipped++; }
  }
  const collectionName = pack.site + " spacing";
  let collection = collections.find(c => c.getPluginData("source") === prefix);
  const existing = new Set(variables.filter(v => collection && v.variableCollectionId === collection.id).map(v => v.name));
  for (const n of pack.spaces) {
    if (!Number.isFinite(n)) { skipped++; continue; }
    const name = String(n).replace(".", "_") + " px";
    if (existing.has(name)) continue;
    if (!collection) {
      collection = figma.variables.createVariableCollection(collectionName);
      collection.setPluginData("source", prefix);
    }
    const variable = figma.variables.createVariable(name, collection, "FLOAT");
    try {
      variable.setValueForMode(collection.defaultModeId, n);
      existing.add(name);
      added++;
    } catch { variable.remove(); skipped++; }
  }
  return added + " new styles and variables. " + substitutions + " font substitutions. " + skipped + " skipped.";
}

figma.showUI(__html__, {width:360, height:210, themeColors:true});
figma.ui.onmessage = async pack => {
  try { figma.ui.postMessage(await importStyles(pack)); }
  catch (error) { figma.ui.postMessage("Import stopped. " + error.message); }
};
