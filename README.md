# Blue Dot

A live design-system inspector for designers, as a Chrome extension. Open any website, see its colours, type and spacing, change them live, show a client the before and after, then hand the developer an exact list of what changed.

Built for client sessions: edits are temporary, nothing is saved unless you save a session, and nothing leaves your browser.

<img width="114*5" height="49*5" alt="image" rounded="2xl" src="https://github.com/user-attachments/assets/974ce1f6-fd69-4a1d-8da5-10fb0daf0b2e" />

<img width="680*5" height="83*5" alt="image" src="https://github.com/user-attachments/assets/b652a24e-d1f9-41ac-97f1-b276084cf70b" />

## Features

### The bar
A dark, minimal bar sits at the bottom centre of the page. Icons only when idle. The tool you pick expands with a blue label, Figma style. One tool is open at a time. Drag the logo to move the bar, click it to collapse it.

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
Pick an element and Blue Dot detects its animation style (fade, slide, hover lift and more), plays a looping preview, lists the animation libraries on the page (GSAP, AOS, Framer Motion, Lenis and others), and shows the code. Copy it as CSS, JavaScript, React or an AI prompt. CSS animations are read exactly. GSAP is sampled with "Watch 8s".

<img width="600" height="auto" alt="image" src="https://github.com/user-attachments/assets/e16dbd90-ea84-4f0e-a553-f45ebecb1036" />


### Figma
Copy designs out of the browser and paste them into Figma with a plain Ctrl+V or Cmd+V. No plugin.

- **Capture design**: the whole page as editable Figma layers
- **Select element**: one element
- **Capture code**: React (JSX plus CSS) or HTML plus CSS, including responsive rules

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
- Motion: CSS is read exactly, GSAP is sampled and approximate, and minified JavaScript logic cannot be recovered.
- Merging z-index values can change stacking. Check the page afterwards.

## Credits

Figma conversion uses the MIT-licensed `@figit/dom-to-figma` and `@figit/fig-kiwi`. See `THIRD_PARTY_LICENSES.txt`.
