# Blue Dot (Chrome, desktop)

## Load it
1. Unzip this folder.
2. Open chrome://extensions and turn on Developer mode (top right).
3. Click "Load unpacked" and pick the unzipped folder.
4. Pin the extension, open any website, click its icon. Click again (or the X) to close.

## Use it
- Colours / Text / Spacing: lists the site's design system. Names come from the site's CSS variables (e.g. --color-ink = "Ink"), otherwise generic (Text 1, Surface 2, Accent 1, Heading 1). Change a value and every use on the page updates.
- Select element: hover to highlight, click to see colour, background, border, font, size, line height, tracking, padding, margin, radius, with variable names where they match. Edit any value live. Esc exits picking.
- Review: audits the page (accessibility, UX heuristics, visual quality), lists findings with severity, reason and offending elements. Click an element in a finding to jump to it. Automated subset only, not a full compliance audit.
- Flow check: crawls same-origin pages with GET requests only (nothing clicked or submitted) and lists flow breakpoints per page: dead links, missing anchors, nowhere links, buttons with no detectable action, forms with no submit, dead-end and orphan pages. Static analysis, so JavaScript-built flows may be missed.
- Live lint: when you change colours, text or element values, red/amber notes appear on that row with the reason (contrast ratio, small text, hierarchy).
- Finish: change summary with old -> new values (hex for colours). Copy list to paste into code or send to a client.
- Revert: restores the page to the original. Closing the bar or reloading also discards all edits (nothing is saved).

Notes: does not run on chrome:// pages or the Web Store. Variable names are matched by colour value, so two variables with the same hex are both shown. Changing a colour swatch changes every element using that exact colour.

## Look and shortcuts (v1.9.0)
Dark grey bar with a blue active tool, dark panels, plain labels on every button (Design, Colours, Text, Spacing, Select element, Review, Flow check, Revert, Finish). Hugeicons icons are inlined, nothing is loaded from the web. There is no light theme or theme toggle. The "Design" button collapses and expands the bar. Hover any button for a tooltip with its shortcut.

Shortcuts: Alt+1 Colours, Alt+2 Text, Alt+3 Spacing, Alt+4 Select element, Alt+5 Review, Alt+6 Flow check, Alt+F Finish, Alt+I Issues, Alt+D collapse or expand (Option on Mac). Esc closes the open panel. Revert has no shortcut on purpose.

## Live issues
When an edit creates a problem (low contrast, tiny text, tight line height, a heading that no longer stands out, a control that blends in), the bar shows a red count badge near the end. Problems that were already on the page before your edits are not counted; the extension compares against the page with your overrides switched off. Click the badge for the list. On the page, affected elements get a red (error) or amber (warning) squiggly underline drawn in the extension overlay. Hover or click it for a card with what is wrong, why it matters, a suggested fix, and Apply fix / Revert this change / Ignore. Nothing is added to the site's own DOM for this. Markers disappear on Revert or close.

## New in 2.1.0 (client sessions and quality)

- **Compare (eye icon, Alt+B)**: flips the page to the original and back. A blue banner shows while you view the original.
- **Edit text on page**: in Select element, press "Edit text on page", type, Enter to commit, Esc to cancel. Logged as a "Copy" change. Works on elements with no child elements only.
- **Sessions were removed in 2.4.0** (and brought back in 3.x: the bookmark icon saves named edits and reopens them). See Gallery below.
- **Near-duplicates**: Colours, Text and Spacing list values that are almost the same, with a Merge button.
- **Effects (Alt+7)**: Radius, Shadow and Z-index tabs with editable values and near-duplicate merge. Merging z-index values can change stacking, so check the page after.
- Limits: sessions find elements by DOM path, so dynamic pages may not restore every edit.

## Branding (2.1.0)
- Name: **Blue Dot**. Logo: `assets/logo.svg`. Toolbar icons: `icons/16, 32, 48, 128.png` (logo on a white rounded tile so it shows on dark and light toolbars).
- Store listing cover: `assets/cover.png` (974x974 original), plus `assets/cover-1280x800.png` and `assets/cover-440x280.png` (centred on white) for the Chrome Web Store image slots. Upload these when publishing; Chrome does not read the cover from the manifest.
- Bar button: logo only (light grey mark, blue dot, no tile or text), as the reference shows. Click to collapse, drag to move.

## New in 2.2.0 (fixes and capture tools)
- **Panels scroll** with the mouse wheel, trackpad and by dragging an empty part of the panel, even on sites that take over scrolling.
- **Close panel**: a round x appears on the bar right after the active tool. Click it to close the panel.
- **Smoother motion**: the bar slides and resizes, labels fade, panels slide and fade in and out. Respects "reduce motion".
- **Select element panel** reworked in sections (Typography, Colour, Layout, Appearance) with compact fields.
- **Merge** is now an icon button with a tooltip.
- **Screenshot** (camera icon, Alt+P): scrolls the page and stitches one full-page PNG into your downloads. Fixed and sticky bars show once at the top. Limits: pages with their own inner scroll area only capture the window scroll; very tall pages stop at 16,000 px; lazy-loaded or animated content may appear mid-load.
- **Figma** (Figma icon, Alt+G): click an element and it is copied as SVG (boxes, borders, rounded corners, text, images, inline SVG). In Figma click the canvas and paste. Not included: shadows, gradients, canvas, video, iframes, cross-site images. Text stays editable but uses the page's fonts, so install them in Figma for a match. This is an SVG paste, not Figma's own clipboard format.

## v2.3.0 - Motion inspector (Alt+M)
Click the Motion button, then an element. The panel shows a looping preview card, detected libraries (GSAP, ScrollTrigger, AOS, Lenis, Lottie, Swiper, Framer and more), and what drives this element: CSS animations, transitions, :hover rules, GSAP tweens, ScrollTrigger, Framer props.
- Copy as CSS, JavaScript (WAAPI), React, Library (GSAP/Framer/AOS) or an AI prompt.
- Watch 8s samples the element while you hover or scroll, and builds approximate keyframes (linear easing).
- Save reference image saves a PNG of the element.
Limits: preview is a styled copy, not the page scripts or scroll links. Minified JS logic cannot be recovered. :hover cannot be forced, so hover during Watch. Library data is read only if the library exposes it.

## v2.4.0 - Before and after gallery
Sessions were gone in this version. The Gallery button (stack icon) captures the whole page as an image, "before" and "after", and keeps them inside the extension until you delete them (Delete all, or per image). Nothing is uploaded. Compare this page with a slider, or download any image as PNG. Uses the unlimitedStorage permission because full-page PNGs are large; at most 30 images are kept.

## v2.5 - Figma icon pastes real layers
The Figma icon (Alt+G) now converts the picked element to native Figma layers (auto layout, real text, fills, radius) using the MIT-licensed @figit/dom-to-figma and @figit/fig-kiwi (see THIRD_PARTY_LICENSES.txt). Click it, then press Ctrl+V on a Figma canvas. It relies on Figma's undocumented clipboard format and can break after a Figma update. If conversion fails it falls back to the old SVG copy.

Motion export: when the page uses GSAP (with or without ScrollTrigger), the Figma icon also samples those animations on the picked element and pastes them as Figma Motion keyframes (move, scale, rotate, opacity) on the layers inside. Scroll-scrubbed animations map to a 0-2s timeline. Text shadow, colour, filter and CSS-only animations are not exported. The top frame itself cannot be animated in Figma.

## v3.0.0 - redesign, exact motion export, gallery
- **One design system.** The stacked styles from earlier versions are replaced by one set of colours, type and spacing. Text contrast passes WCAG AA. Toolbar icons no longer shift when a tool opens, and Close stays visible on narrow windows.
- **Safer actions.** Revert shows an Undo button. Closing with unsaved changes asks first. Finish keeps Revert all as a quiet secondary action.
- **Motion export reproduces the original.** GSAP tweens become exact CSS, JavaScript and React (GSAP easing written as CSS `linear()` curves, repeat, yoyo, repeatDelay, existing transforms kept). Timelines, stagger and parent animations are sampled frame by frame from the page. The GSAP tab rebuilds `gsap.timeline()` with positions, the right group selectors and a valid `scrollTrigger`. Scrubbed animations use CSS scroll-driven animations.
- **How to apply it** steps under the motion code, per tab.
- **Motion gallery** (`gallery.html`): saved animations play as live preview cards with their code.
- **Figma copy** starts inside the click, so slow conversions are no longer blocked; the menu explains each option; ↑/↓ in the picker select the parent/child.
- **Code export** keeps line-height ratios and spaces between words, drops frozen GSAP inline styles.
- **Fixes:** near-duplicate merge no longer chains distant values, findings behind the panel slide it aside, variable labels update after edits, "No border" instead of a fake stroke colour, rounded values, selected element keeps an outline, restyled find bar and fix card.

## v3.1.0 - Motion Pro
- **Motion Recorder** (Motion > Record the page): keeps every GSAP and CSS animation that plays while you hover, click and scroll, including ones GSAP deletes after playing; rows fold letters and items into groups; inspect or copy to Figma afterwards.
- **Component motion:** picking a container exports every animated element inside it with exact keyframes (CSS, JS, React, preview, gallery). Typewriter (`display` steps) supported.
- **Motion to Figma rebuilt:** GSAP + CSS + recorded animations; layers captured on the most visible frame; dense keyframes relative to it; wrapper frame for animated roots; unique keyframe keys (no more scrambling after 90 keyframes); animated layers named after their element; parent motion applied to children (marquee halves).
- **Images in Figma copies:** custom image loader (download, then screenshot crop, then placeholder); optional "images from other sites" permission (`permission.html`).
- **Fixes:** copies no longer hang in background tabs; hidden elements no longer chosen as the capture frame.
- Tested during development on madewithgsap.com (one site, Chrome): every homepage animation exported to code within 0 to 0.44 px of the original and pasted into Figma with playable Motion keyframes. Figma Motion is in open beta, so this can change with Figma updates.

## v3.2.0 - Copy a section with its motion
- Figma menu › **A section with its motion**: the picker selects the whole section; the copy becomes a scroll story in Figma (viewport frame, section slides up as scrolling, scroll animations placed at their scroll position, scrubbed ones stretched to their scroll distance, pins held in place, loops repeated).
- Every ScrollTrigger is paused (pins kept) while the layers are captured, and the page is scrolled to the position that matches the capture frame, so nothing moves during conversion. Scroll position and triggers are restored afterwards.
- Absolute layout for section copies (no auto layout) so layers line up with their keyframes; transparent sections get the background visible behind them.
- Blue Dot remembers every animation that plays while it is open (the Recorder runs quietly in the background).
- Clipboard writes that stall after long conversions fall back to a "Copy now" button; PRO badge layout fixed.
- Tested during development on madewithgsap.com's pinned scroll gallery (one site, Chrome): predicted on-screen positions matched the live page within 0.3 px along the scrubbed timeline. Effects that react to scroll speed (created by scripts on the fly) are not part of a fixed timeline and are not exported.

## v3.2.1 - reliability fixes
- **Section copy to Figma:** a scripting error could fire after the clipboard write, so a successful copy could end without its confirmation message. Fixed.
- **Closing cleans up fully:** every page/window listener, observer, recorder timer, an active Watch and a running flow scan are now stopped when Blue Dot closes, so reopening starts clean.
- **Motion Recorder:** CSS transitions are recorded too (only CSS animations were before), and GSAP is hooked even when it loads after recording started, matching what the panel says.
- **Motion hold recovery:** the page's animations and scroll position are restored even when the motion read times out or fails midway.
