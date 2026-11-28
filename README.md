# Blue Dot

**Reusable Figma styles.** Copy a page’s typography, colours and spacing from the extension and paste in the included Blue Dot Styles Figma importer. [Setup and usage](MVP/README.md#import-reusable-figma-styles)


A live design-system inspector for designers, as a Chrome extension. Open any website, see its colours, type and spacing, change them live, show a client the before and after, then hand the developer an exact list of what changed.

Built for client sessions: edits are temporary, nothing is saved unless you save a session, and nothing leaves your browser.

<img width="114*5" height="49*5" alt="image" rounded="2xl" src="https://github.com/user-attachments/assets/974ce1f6-fd69-4a1d-8da5-10fb0daf0b2e" />

<img width="680*5" height="83*5" alt="image" src="https://github.com/user-attachments/assets/b652a24e-d1f9-41ac-97f1-b276084cf70b" />

## Features

### The bar
A dark, minimal bar sits at the bottom centre of the page, with tools grouped as Inspect, Check, Capture and Finish. Icons stay in fixed places, so nothing moves under your cursor; hover any icon for its name and shortcut. One tool is open at a time. Drag the logo to move the bar, click it to collapse it. On narrow windows the bar tightens and the Close button always stays visible.

**Safe by default:** Revert can be undone from the toast, and closing Blue Dot with unsaved changes asks first.

### Colours
Lists every colour on the page with its name (taken from the site's CSS variables when they exist), hex value and where it is used. Change one swatch and every use on the page updates. Near-duplicate colours show a Merge button.

<img width="600" height="auto" alt="image" src="https://github.com/user-attachments/assets/b6be6ac2-5f36-40c5-b009-8613ed36b742" />


**Find.** Click a colour to highlight every place it is used. Step through them with next and previous ("1 of 22").

<img width="600" height="auto" alt="image" src="https://github.com/user-attachments/assets/c75dc380-50de-48f1-a0d7-57e386343611" />


### Text
Every font, size, weight and line height in use, with live editing and near-duplicate merge.

<img width="600" height="auto" alt="image" src="https://github.com/user-attachments/assets/c2f84b61-4f98-42ef-8850-9e9bd287c646" />


### Spacing
Padding, margin and gap values used on the page. Edit one value and it changes everywhere it is used.

<img width="600" height="auto" alt="image" src="https://github.com/user-attachments/assets/15c7b72d-1a0d-48a4-a568-4a74a2361542" />


### Effects
Radius, shadow and z-index values, each editable, with near-duplicate merge.

<img width="600" height="auto" alt="image" src="https://github.com/user-attachments/assets/ad80c360-8275-40d8-80ac-141b56ee931a" />


### Select element
Hover to highlight, click to inspect a single element: typography, colour, layout and appearance, with variable names where they match. Edit any value live, or edit the text directly on the page.

<img width="600" height="auto" alt="image" src="https://github.com/user-attachments/assets/fa603c78-328d-42d1-aabf-16ea719d760e" />


### Review
An automated audit of accessibility (WCAG 2.2 AA), UX heuristics and visual consistency. Each finding says what is wrong and why. Click an affected element to jump to it on the page, where it gets a red outline and a card with a suggested fix.

<img width="600" height="auto" alt="image" src="https://github.com/user-attachments/assets/cb333aa1-0240-4091-9a00-55b48801c15e" />


<img width="600" height="auto" alt="image" src="https://github.com/user-attachments/assets/b8c2fbf6-e797-4339-aa70-70a9f3701b42" />


### Fix now
When one of your edits creates a problem, such as low contrast, the row shows the issue and a **Fix now** button with the exact change it will make. A red badge on the bar counts issues caused by your edits. Everything can be undone.

<img width="600" height="auto" alt="image" src="https://github.com/user-attachments/assets/240ef30a-c48e-4f01-9a5f-99121a295844" />

### Flow check
Crawls the site for broken flows: dead links, missing anchors, buttons that do nothing. Click a row to jump to the element, even on another page. Pages that need a login are left out so you only see real breaks.

<img width="600" height="auto" alt="image" src="https://github.com/user-attachments/assets/30219972-311f-4dfa-a4d0-5d81bfaa76d0" />


### Motion
Pick an element and Blue Dot names its animation (fade up, slide + spin, marquee, colour morph and more), plays a looping preview, lists the animation libraries on the page (GSAP, ScrollTrigger, AOS, Framer Motion, Lenis and others), and gives you code that reproduces it: CSS, JavaScript, React, GSAP or an AI prompt.

- **GSAP is converted exactly:** values, GSAP's own easing curves (back, elastic, bounce, expo… written as CSS `linear()` curves), repeat, yoyo and the pause between loops. Timelines, stagger and several tweens on one element are read frame by frame from the live page.
- **The GSAP tab rebuilds the original code:** `gsap.from / to / fromTo`, the timeline with each tween's position, the whole staggered group, and a valid `scrollTrigger`.
- **Scroll is kept:** scrubbed animations become native CSS scroll-driven animations (`animation-timeline`), and play-on-scroll animations start when the element enters the viewport.
- **How to apply it:** step-by-step instructions under the code for the tab you picked, with install commands and a React / Next.js (`useGSAP`) example.
- **Component motion:** pick a card, a heading or a whole section and every animated element inside it is exported together (letters of a typewriter, staggered items, images in a scroll gallery), each with its exact keyframes.
- **Moves with its parent:** pick a child of an animated element (one half of a marquee, an item in a slider) and it gets the parent's motion.
- **Watch 8s** catches hover and scroll effects that are not running when you click.
- **Add to gallery** keeps the animation (see Motion gallery below).

### Motion Recorder (PRO)
GSAP deletes an animation once it has played, so hover effects, click effects and scroll-in reveals normally cannot be read afterwards. Choose **Motion > Record the page**, then hover, click and scroll for up to 30 seconds. Blue Dot keeps every animation that plays (GSAP tweens, CSS animations and CSS transitions; GSAP is picked up even if it loads after recording starts), lists it with what triggered it, and folds letter-by-letter and item-by-item animations into one row. Each row can be inspected (code, preview, gallery) or sent straight to Figma, even after it finished.

### Motion to Figma
Copy an animated element, component or section and paste it into Figma: the layers arrive with Figma Motion keyframes (move, scale, rotate, opacity), ready to play in the Motion timeline.

**A section with its motion (PRO).** Figma menu › *A section with its motion*, then click anywhere in a section. Blue Dot copies the whole section design and turns its scroll experience into a Figma timeline:

- The copy sits in a frame the size of your browser window, and the section slides up inside it as if someone were scrolling (1,000 px of scroll = 1 second).
- Every scroll animation starts at the moment its scroll position is reached; scrubbed ones last as long as their scroll distance.
- Pinned parts stay put on screen while pinned, exactly like on the site.
- Loops (marquees, spinners) repeat for the whole section timeline.
- The section keeps the background you see behind it, and every layer sits exactly where the page draws it.
- Animations that already played while Blue Dot was open are remembered and included.

- Every animation inside the copied element is included: GSAP tweens and timelines, CSS animations, and anything caught by the Recorder.
- Each animation is paused on its most visible frame while the layers are captured, and the keyframes are written relative to that frame, so nothing starts invisible or squashed.
- Keyframes are sampled densely and simplified within 0.1 px, so elastic and bounce motion keeps its shape.
- If the picked element itself moves, it is wrapped in a parent frame (Figma cannot animate a top-level frame).
- Letter-by-letter animations become per-letter layers; `display`/`visibility` steps become opacity steps.
- Images from other sites (CDNs) are kept: Blue Dot downloads or screenshots them, and otherwise inserts a placeholder so the layer and its motion survive. Allow "images from other sites" once to always get the real image.

<img width="600" height="auto" alt="image" src="https://github.com/user-attachments/assets/e16dbd90-ea84-4f0e-a553-f45ebecb1036" />


### Motion gallery
Every animation you add from the Motion panel is kept as a live preview card in a gallery page inside the extension: the real element, animating on a dark stage. Filter by library or ease, search, slow everything to 0.25×, and open a card for a big preview with its CSS, JavaScript, React, GSAP and AI-prompt code.

### Figma
Copy designs out of the browser and paste them into Figma with a plain Ctrl+V or Cmd+V. No plugin.

- **An element**: click any part of the page (press ↑ to pick the parent, ↓ to go back)
- **Whole page**: every section as editable Figma layers
- **An element as code**: React (JSX plus CSS) or HTML plus CSS, including responsive rules. Line height, spacing between words and the element's resting state (not a frozen animation frame) are kept.

The copy starts the moment you click, so large elements and whole pages are not blocked by the browser's clipboard time limit. If the browser still blocks it, a **Copy now** button appears.

Motion is copied too, as Figma Motion keyframes (position, scale, rotation, opacity).

<img width="600" height="auto" alt="image" src="https://github.com/user-attachments/assets/a0055c74-aaa3-4249-b544-83e0024dc3be" />


<img width="600" height="auto" alt="image" src="https://github.com/user-attachments/assets/69f40b55-7c11-4cc0-80d1-5bc8e93eb29f" />


### Screenshot
Capture the screen, the visible area or the full page. The image is copied to your clipboard.

<img width="600" height="auto" alt="image" src="https://github.com/user-attachments/assets/d8216e6c-6632-4040-be7a-5254d2becf1a" />


### Compare (before and after)
The eye icon flips the page between the original and your edits, so you can show a client the change in the meeting. A banner tells you when you are looking at the original.

<img width="600" height="auto" alt="image" src="https://github.com/user-attachments/assets/041f7511-0bc6-4382-a3d9-ead669338eed" />


### Sessions
Name and save your edits, then reopen them later on the same site.

<img width="600" height="auto" alt="image" src="https://github.com/user-attachments/assets/d11f939b-d0d6-4076-b7d2-9debfbb63cd9" />


### Finish
A change list in the form old value to new value (hex codes, CSS variable names), with a count badge. Copy it so the developer builds only what the client approved. **Revert all** puts the page back.

<img width="600" height="auto" alt="image" src="https://github.com/user-attachments/assets/b3865dc0-49fc-4cbf-b3da-e94f52fa64fc" />


## Install

Blue Dot is a Manifest V3 extension for Chrome on desktop. It is not on the Chrome Web Store yet.

1. Download or clone this repo and unzip the extension folder (`MVP`).
2. Open `chrome://extensions` and turn on **Developer mode** (top right).
3. Click **Load unpacked** and pick the folder.
4. Pin Blue Dot, open any website, and click its icon. Click again, or the X on the bar, to close.

## Shortcuts

On Mac use Option instead of Alt.

| Shortcut | Tool |
| --- | --- |
| Alt+1 | Colours |
| Alt+2 | Text |
| Alt+3 | Spacing |
| Alt+4 | Select element |
| Alt+5 | Review |
| Alt+6 | Flow check |
| Alt+7 | Effects |
| Alt+M | Motion |
| Alt+G | Figma |
| Alt+P | Screenshot |
| Alt+B | Compare |
| Alt+F | Finish |
| Alt+I | Issues |
| Alt+D | Collapse or expand the bar |
| Esc | Close the open panel |

## Limits

- Desktop Chrome only. It does not run on `chrome://` pages or the Chrome Web Store.
- Edits are temporary. Reloading the page discards them unless you saved a session. Sessions find elements by DOM path, so dynamic pages may not restore every edit.
- Review is an automated subset of WCAG 2.2 AA and common heuristics. It is not a full compliance audit.
- Flow check reads pages with GET requests only and never clicks or submits. Flows built in JavaScript may be missed.
- Figma paste uses Figma's undocumented clipboard format and can break after a Figma update. Text keeps the page's fonts, so install them in Figma for a match.
- Motion: CSS animations and GSAP tweens are read from the live page and exported with their real values and timing; sampled or minified sources can be approximate. Figma Motion is in open beta, so pasted motion keyframes rely on Figma's current behaviour and can change. An entrance animation that already finished before you opened Blue Dot (on page load) cannot be read; hover, click and scroll animations can be caught with the Recorder. Figma Motion exports move, scale, rotation and opacity; colour, radius and clip-path changes are not exported to Figma (they are in the CSS/JS/React code). Looping animations are exported as one cycle. GSAP must be reachable on the page (`window.gsap`). For a staggered group, the CSS, JavaScript and React tabs cover the element you picked; the GSAP tab covers the whole group. Scroll-driven CSS needs Chrome or Edge 115+. Minified JavaScript logic cannot be recovered.
- Merging z-index values can change stacking. Check the page afterwards.

## Credits

Figma conversion uses the MIT-licensed `@figit/dom-to-figma` and `@figit/fig-kiwi`. See `THIRD_PARTY_LICENSES.txt`.
