// Asks Chrome for the optional "all sites" permission, used only to download images for Figma copies.
const state = document.getElementById("state"), btn = document.getElementById("allow");
const show = (on) => { state.innerHTML = on ? '<span class="ok">Allowed. Go back and copy again.</span>' : ""; btn.hidden = !!on; };
chrome.permissions.contains({ origins: ["<all_urls>"] }, show);
btn.onclick = () => chrome.permissions.request({ origins: ["<all_urls>"] }, (granted) => { show(granted); if (!granted) state.textContent = "Not allowed. Images from other sites stay placeholders."; });
