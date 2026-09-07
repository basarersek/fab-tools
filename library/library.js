const DB_NAME = "fab-library";
const STORE = "assets";
const SETTINGS_KEY = "fabLibrarySettings";
const META_KEY = "fabLibraryMeta";
const FAB_URL = "https://www.fab.com/";
const CONTENT_SCRIPT_RETRIES = 10;
const PAGE_STEP = 300;
const MAX_LOG_LINES = 300;
const MAX_TAGS_SHOWN = 60;
const MAX_SELLERS_SHOWN = 40;
const MAX_ANIMATED_CARDS = 48;

const defaults = { detailsAtOnce: 4, waitMs: 300, perPage: 300, cardSize: 210 };
const typeLabels = {
  "3d-model": "3D model",
  material: "Material",
  hdri: "HDRI",
  decal: "Decal",
  brush: "Brush",
  animation: "Animation",
  vfx: "VFX",
  audio: "Audio",
  ui: "UI",
  "game-template": "Game template",
  "game-system": "Game system",
  "tool-and-plugin": "Tool and plugin",
  "tutorials-examples": "Tutorials",
};

// Fab's own format names and groups, keyed by the code stored on each item.
const formatMeta = {
  "unreal-engine": { name: "Unreal Engine", group: "Game Engine Formats" },
  unity: { name: "Unity", group: "Game Engine Formats" },
  uefn: { name: "UEFN", group: "Game Engine Formats" },
  metahuman: { name: "MetaHuman", group: "Other Formats" },
  image: { name: "Image", group: "Other Formats" },
  "additional-files": { name: "Additional files", group: "Other Formats" },
  "converted-files": { name: "Converted files", group: "Other Formats" },
  "3ds-max": { name: "3ds Max", group: "3D DCC Formats" },
  blender: { name: "Blender", group: "3D DCC Formats" },
  "cinema-4d": { name: "Cinema 4D", group: "3D DCC Formats" },
  maya: { name: "Maya", group: "3D DCC Formats" },
  "z-brush": { name: "ZBrush", group: "3D DCC Formats" },
  fbx: { name: "FBX", group: "3D Exchange Formats" },
  glb: { name: "GLB", group: "3D Exchange Formats" },
  gltf: { name: "GLTF", group: "3D Exchange Formats" },
  obj: { name: "OBJ", group: "3D Exchange Formats" },
  usd: { name: "USD", group: "3D Exchange Formats" },
  usdz: { name: "USDZ", group: "3D Exchange Formats" },
  "texture-set": { name: "Texture Set", group: "Material Formats" },
  animationblueprint: { name: "Animation Blueprint", group: "Game Engine Formats" },
  "animation-blueprint": { name: "Animation Blueprint", group: "Game Engine Formats" },
};
const groupIcons = {
  "Game Engine Formats": "g-game-engine",
  "Other Formats": "g-other",
  "3D DCC Formats": "g-dcc",
  "3D Exchange Formats": "g-exchange",
  "Material Formats": "g-material",
};
const formatGroupOrder = ["Game Engine Formats", "Other Formats", "3D DCC Formats", "3D Exchange Formats", "Material Formats"];
// Unknown codes still read well. Hyphens and camel case both become spaces.
const prettyCode = (code) =>
  code.replace(/[-_]/g, " ").replace(/([a-z0-9])([A-Z])/g, "$1 $2").trim().replace(/^./, (c) => c.toUpperCase());
const formatName = (code) => formatMeta[code]?.name || prettyCode(code);
const formatIcon = (code) => (formatMeta[code] ? `f-${code}` : "f-formats");
const knownLicenseIcons = new Set(["personal", "professional"]);
const licenseIcon = (license) => {
  const slug = String(license).toLowerCase();
  return knownLicenseIcons.has(slug) ? `f-${slug}` : "f-licenses";
};
const formatGroup = (code) => formatMeta[code]?.group || "Other Formats";

const field = (id) => document.getElementById(id);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const state = {
  items: new Map(),
  filters: {
    text: "", types: new Set(), sellers: new Set(), tags: new Set(), formats: new Set(), licenses: new Set(),
    status: "ok", hideMature: true, addedSince: "", sort: "acquired",
  },
  tagSearch: "",
  shown: PAGE_STEP,
  selectedUid: null,
  phase: "idle",
  running: false,
  log: [],
};

// ---------- IndexedDB ----------

let dbPromise = null;

// One connection for the whole page. Opening per write is slow.
function openDb() {
  dbPromise ??= new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE, { keyPath: "uid" });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  return dbPromise;
}

function transaction(mode, work) {
  return openDb().then((db) => new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const request = work(tx.objectStore(STORE));
    tx.oncomplete = () => resolve(request?.result);
    tx.onerror = () => reject(tx.error);
  }));
}

const dbGetAll = () => transaction("readonly", (store) => store.getAll());
const dbPutMany = (items) => transaction("readwrite", (store) => items.forEach((item) => store.put(item)));
const dbClear = () => transaction("readwrite", (store) => store.clear());

// ---------- settings ----------

function readSettings() {
  const clamp = (id, min, max, fallback) =>
    Math.min(max, Math.max(min, Math.round(Number(field(id).value) || fallback)));
  return {
    detailsAtOnce: clamp("detailsAtOnce", 1, 8, defaults.detailsAtOnce),
    waitMs: clamp("waitMs", 0, 10000, defaults.waitMs),
    perPage: Math.max(0, Math.round(Number(field("perPage").value)) || 0),
    cardSize: clamp("cardSize", 140, 420, defaults.cardSize),
    includeRaw: field("includeRaw").checked,
  };
}

async function restoreSettings() {
  const stored = (await chrome.storage.local.get(SETTINGS_KEY))[SETTINGS_KEY] || {};
  field("detailsAtOnce").value = stored.detailsAtOnce ?? defaults.detailsAtOnce;
  field("waitMs").value = stored.waitMs ?? defaults.waitMs;
  field("perPage").value = stored.perPage ?? defaults.perPage;
  field("cardSize").value = stored.cardSize ?? defaults.cardSize;
  applyCardSize();
  state.shown = pageSize();
  field("includeRaw").checked = Boolean(stored.includeRaw);
}

const saveSettings = () => chrome.storage.local.set({ [SETTINGS_KEY]: readSettings() });

field("advanced").addEventListener("click", () => {
  const open = field("advancedBar").hidden;
  field("advancedBar").hidden = !open;
  field("advanced").setAttribute("aria-pressed", String(open));
});

for (const button of document.querySelectorAll(".reset-field")) {
  button.addEventListener("click", () => {
    field(button.dataset.target).value = defaults[button.dataset.target];
    saveSettings();
  });
}
for (const id of ["detailsAtOnce", "waitMs", "includeRaw"]) field(id).addEventListener("change", saveSettings);

// Zero means show everything, so a big catalog is one long scroll.
function pageSize() {
  const value = Math.max(0, Math.round(Number(field("perPage").value)));
  return value > 0 ? value : Infinity;
}

function applyCardSize() {
  document.documentElement.style.setProperty("--card", `${field("cardSize").value}px`);
}

field("cardSize").addEventListener("input", applyCardSize);
field("cardSize").addEventListener("change", saveSettings);

field("perPage").addEventListener("change", () => {
  state.shown = pageSize();
  saveSettings();
  renderGrid();
});

// ---------- resizable side panels ----------

function makeResizable(handle) {
  const panel = field(handle.dataset.target);
  const key = `fabLibraryWidth.${handle.dataset.target}`;
  const grows = handle.dataset.side === "right" ? 1 : -1;
  const isSidebar = handle.dataset.target === "sidebar";
  const limits = isSidebar ? { min: 180, share: 0.4 } : { min: 300, share: 0.6 };
  const apply = (width) => {
    const clamped = Math.min(window.innerWidth * limits.share, Math.max(limits.min, width));
    if (isSidebar) document.documentElement.style.setProperty("--sidebar", `${clamped}px`);
    else panel.style.width = `${clamped}px`;
    return clamped;
  };
  const saved = Number(localStorage.getItem(key));
  if (saved) apply(saved);

  handle.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    handle.setPointerCapture(event.pointerId);
    handle.classList.add("active");
    const startX = event.clientX;
    const startWidth = panel.getBoundingClientRect().width;
    let width = startWidth;
    const move = (ev) => { width = apply(startWidth + (ev.clientX - startX) * grows); };
    const stop = () => {
      handle.classList.remove("active");
      handle.removeEventListener("pointermove", move);
      localStorage.setItem(key, String(Math.round(width)));
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", stop, { once: true });
    handle.addEventListener("pointercancel", stop, { once: true });
  });
}

for (const handle of document.querySelectorAll(".resizer")) makeResizable(handle);

// ---------- tooltip ----------

const tooltip = field("tooltip");
let tooltipTimer = null;

function showTooltip(target) {
  tooltip.textContent = target.dataset.tip;
  tooltip.hidden = false;
  const margin = 8;
  const box = target.getBoundingClientRect();
  const bubble = tooltip.getBoundingClientRect();
  const centered = box.left + box.width / 2 - bubble.width / 2;
  const left = Math.max(margin, Math.min(centered, window.innerWidth - margin - bubble.width));
  const above = box.top - bubble.height - 6;
  const top = above < margin ? box.bottom + 6 : above;
  tooltip.style.left = `${left}px`;
  tooltip.style.top = `${top}px`;
}

// Delegated, so cards created later get tips too.
document.addEventListener("mouseover", (event) => {
  const target = event.target.closest(".tip");
  if (!target || target.contains(event.relatedTarget)) return;
  clearTimeout(tooltipTimer);
  tooltipTimer = setTimeout(() => showTooltip(target), 400);
});
document.addEventListener("mouseout", (event) => {
  const target = event.target.closest(".tip");
  if (!target || target.contains(event.relatedTarget)) return;
  clearTimeout(tooltipTimer);
  tooltip.hidden = true;
});

// ---------- phase, status, log ----------

const iconByPhase = { syncing: "busy", rechecking: "busy" };

const syncingPhases = new Set(["collecting", "syncing", "paused"]);

function setPhase(phase) {
  state.phase = phase;
  field("progressBar").hidden = !syncingPhases.has(phase);
  const label = phase[0].toUpperCase() + phase.slice(1);
  field("phase").dataset.tip = label;
  field("phase").setAttribute("aria-label", label);
  field("phaseIcon").setAttribute("href", `#s-${iconByPhase[phase] || phase}`);
  document.body.dataset.phase = phase;
  state.running = phase === "syncing" || phase === "paused";
  field("sync").disabled = state.running;
  field("pauseResume").disabled = !state.running;
  field("stop").disabled = !state.running;
  field("pauseResume").lastChild.textContent = phase === "paused" ? "Resume" : "Pause";
}

function setStatus(text, percent = 0) {
  field("status").textContent = text;
  field("barFill").style.width = `${percent}%`;
}

function addLog(line) {
  state.log.push(line);
  if (state.log.length > MAX_LOG_LINES) state.log.shift();
  const box = field("log");
  box.textContent = state.log.join("\n");
  box.scrollTop = box.scrollHeight;
}

field("logToggle").addEventListener("click", () => {
  const open = field("log").hidden;
  field("log").hidden = !open;
  field("logToggle").setAttribute("aria-pressed", String(open));
});

// The item count already sits above the grid, so this line only carries the sync time.
async function showIdleStatus() {
  const meta = (await chrome.storage.local.get(META_KEY))[META_KEY];
  if (!state.items.size) {
    setStatus("No items yet. Log in to fab.com, then press Sync.");
    return;
  }
  setStatus(meta?.lastSync ? `Last sync ${new Date(meta.lastSync).toLocaleString()}` : "");
}

// ---------- fab.com tab ----------

async function getFabTab() {
  const tabs = await chrome.tabs.query({ url: "https://www.fab.com/*" });
  if (tabs.length > 0) return tabs[0];
  return chrome.tabs.create({ url: FAB_URL, active: false });
}

// A second copy of content.js fails to load, so injecting twice is safe.
async function injectContentScript(tabId) {
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
  } catch {
    // Already loaded, or the tab is still loading. The retry loop handles it.
  }
}

async function sendToFab(message) {
  const tab = await getFabTab();
  for (let attempt = 1; attempt <= CONTENT_SCRIPT_RETRIES; attempt++) {
    try {
      return await chrome.tabs.sendMessage(tab.id, message);
    } catch {
      await injectContentScript(tab.id);
      await sleep(500);
    }
  }
  throw new Error("No answer from the fab.com tab. Reload it and try again.");
}

// ---------- sync ----------

field("sync").addEventListener("click", async () => {
  const settings = readSettings();
  await saveSettings();
  setPhase("syncing");
  setStatus("Reading your library...");
  try {
    const answer = await sendToFab({
      type: "sync",
      knownUids: [...state.items.keys()],
      full: field("fullResync").checked,
      settings,
    });
    if (!answer.ok) throw new Error(answer.error);
  } catch (error) {
    addLog(error.message);
    setPhase("stopped");
    setStatus(error.message);
  }
});

field("pauseResume").addEventListener("click", async () => {
  const resuming = state.phase === "paused";
  await sendToFab({ type: resuming ? "resume" : "pause" });
  setPhase(resuming ? "syncing" : "paused");
});

field("stop").addEventListener("click", async () => {
  await sendToFab({ type: "stop" });
  setStatus("Stopping after the current group...");
});

let renderTimer = null;
function scheduleRender() {
  if (renderTimer) return;
  renderTimer = setTimeout(() => {
    renderTimer = null;
    renderAll();
  }, 1000);
}

async function mergeItems(items) {
  const merged = items.map((item) => {
    const existing = state.items.get(item.uid);
    return existing ? { ...item, raw: item.raw ?? existing.raw } : item;
  });
  await dbPutMany(merged);
  for (const item of merged) state.items.set(item.uid, item);
  scheduleRender();
}

chrome.runtime.onMessage.addListener((message) => {
  if (message.type === "syncItems") mergeItems(message.items);
  if (message.type === "syncLog") addLog(message.line);
  if (message.type === "syncProgress") {
    const p = message.progress;
    const percent = p.found ? (p.processed / p.found) * 100 : 0;
    setStatus(`${p.processed} of ${p.found} new, ${p.known} already in catalog, ${p.updated} updated, ${p.gone} gone, ${p.failed} failed`, percent);
  }
  if (message.type === "syncDone") {
    const p = message.progress;
    setPhase(p.phase);
    chrome.storage.local.set({ [META_KEY]: { lastSync: new Date().toISOString() } });
    addLog(`${p.phase}: ${p.updated} updated, ${p.gone} gone, ${p.failed} failed`);
    setStatus(`${p.phase}: ${p.updated} updated, ${p.gone} gone, ${p.failed} failed.`, 100);
    renderAll();
  }
});

// ---------- filtering and sorting ----------

const isGone = (item) => item.status && item.status !== "ok";
const statusLabel = (item) => (item.status === "gone" ? "unlisted" : item.status);
const statusTip = {
  gone: "The seller removed this product from the store. You still own it and can download it from your Fab library.",
  "not owned": "Fab no longer lists this product in your library. Check your Fab library, then recheck here.",
};

function matches(item) {
  const f = state.filters;
  if (f.status === "ok" && isGone(item)) return false;
  if (f.status === "gone" && !isGone(item)) return false;
  if (f.hideMature && item.isMature) return false;
  if (f.types.size && !f.types.has(item.listingType)) return false;
  if (f.sellers.size && !f.sellers.has(item.seller)) return false;
  if (f.licenses.size && !f.licenses.has(item.library?.license)) return false;
  if (f.formats.size && !item.formats.some((code) => f.formats.has(code))) return false;
  if (f.tags.size && ![...f.tags].every((tag) => item.tags.includes(tag))) return false;
  if (f.addedSince && !addedSince(item, Number(f.addedSince))) return false;
  if (!f.text) return true;
  const haystack = [item.title, item.seller, item.category?.path, item.tags.join(" "), item.description]
    .join(" ").toLowerCase();
  return f.text.split(/\s+/).every((word) => haystack.includes(word));
}

function addedSince(item, days) {
  const when = Date.parse(item.library?.acquiredAt || "");
  if (Number.isNaN(when)) return false;
  return when >= Date.now() - days * 86400000;
}

const byAcquired = (a, b) => String(b.library?.acquiredAt || b.syncedAt).localeCompare(String(a.library?.acquiredAt || a.syncedAt));
// Letters sort first, then numbers, then punctuation and symbols last.
const titleRank = (title) => {
  const first = (title || "").trim().charAt(0);
  if (/\p{L}/u.test(first)) return 0;
  if (/\p{Nd}/u.test(first)) return 1;
  return 2;
};
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
const byTitle = (a, b) =>
  titleRank(a.title) - titleRank(b.title) || collator.compare(a.title || "", b.title || "");
const byType = (a, b) => String(a.listingType).localeCompare(String(b.listingType)) || byTitle(a, b);
const sorters = { acquired: byAcquired, title: byTitle, type: byType };

function filteredItems() {
  return [...state.items.values()].filter(matches).sort(sorters[state.filters.sort]);
}

// ---------- facets ----------

function countBy(items, pick) {
  const counts = new Map();
  for (const item of items) {
    for (const key of pick(item)) {
      if (key) counts.set(key, (counts.get(key) || 0) + 1);
    }
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])));
}

function emptyNote(text) {
  const note = document.createElement("p");
  note.className = "facet-empty";
  note.textContent = text;
  return note;
}

function chip(name, value, label, count, checked, iconId) {
  const wrapper = document.createElement("label");
  wrapper.className = "chip";
  const input = document.createElement("input");
  input.type = "checkbox";
  input.name = name;
  input.value = value;
  input.checked = checked;
  wrapper.append(input);
  if (iconId) {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
    use.setAttribute("href", `#${iconId}`);
    svg.append(use);
    wrapper.append(svg);
  }
  const text = document.createElement("span");
  text.textContent = label;
  wrapper.title = label;
  wrapper.append(text);
  if (count !== null) {
    const small = document.createElement("small");
    small.textContent = count;
    wrapper.append(small);
  }
  return wrapper;
}

// Fab dates can be missing or old, so an empty range is shown and cannot be picked.
function paintAddedCounts(items) {
  const stamps = items
    .map((item) => Date.parse(item.library?.acquiredAt || ""))
    .filter((when) => !Number.isNaN(when));

  for (const small of document.querySelectorAll("[data-added-count]")) {
    const days = Number(small.dataset.addedCount);
    const count = days ? items.filter((item) => addedSince(item, days)).length : items.length;
    small.textContent = count;
    const label = small.closest(".chip");
    const input = label?.querySelector("input");
    if (!label || !input) continue;
    const blocked = days > 0 && count === 0;
    label.classList.toggle("chip-disabled", blocked);
    input.disabled = blocked;
  }

  const note = field("addedNote");
  if (!stamps.length) {
    note.textContent = "Fab did not record when these products were added, so this filter finds nothing.";
    note.hidden = false;
    return;
  }
  const oldest = new Date(Math.min(...stamps)).toLocaleDateString();
  const newest = new Date(Math.max(...stamps)).toLocaleDateString();
  note.textContent = `Recorded dates run from ${oldest} to ${newest}.`;
  note.hidden = false;
}

function renderFacets() {
  const items = [...state.items.values()].filter((item) => state.filters.status !== "ok" || !isGone(item));

  const typeBox = field("typeFacet");
  typeBox.replaceChildren(...countBy(items, (item) => [item.listingType]).map(([type, count]) =>
    chip("types", type, typeLabels[type] || type, count, state.filters.types.has(type), `i-${type}`)));

  const sellerBox = field("sellerFacet");
  sellerBox.replaceChildren(...countBy(items, (item) => [item.seller]).slice(0, MAX_SELLERS_SHOWN).map(([seller, count]) => {
    const row = document.createElement("label");
    row.className = "row";
    const input = document.createElement("input");
    input.type = "checkbox";
    input.className = "checkbox";
    input.name = "sellers";
    input.value = seller;
    input.checked = state.filters.sellers.has(seller);
    const name = document.createElement("span");
    name.textContent = seller;
    const small = document.createElement("small");
    small.textContent = count;
    row.append(input, name, small);
    return row;
  }));

  const formatBox = field("formatFacet");
  const byGroup = new Map();
  for (const [code, count] of countBy(items, (item) => item.formats)) {
    const group = formatGroup(code);
    if (!byGroup.has(group)) byGroup.set(group, []);
    byGroup.get(group).push([code, count]);
  }
  const groupNames = [...byGroup.keys()].sort((a, b) => {
    const rank = (name) => (formatGroupOrder.indexOf(name) + 1 || formatGroupOrder.length + 1);
    return rank(a) - rank(b) || a.localeCompare(b);
  });
  if (!groupNames.length) formatBox.replaceChildren(emptyNote("No formats recorded. Sync to fill them in."));
  else formatBox.replaceChildren(...groupNames.map((group) => {
    const heading = document.createElement("span");
    heading.className = "group-name";
    const headingIcon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    const headingUse = document.createElementNS("http://www.w3.org/2000/svg", "use");
    headingUse.setAttribute("href", `#${groupIcons[group] || "g-other"}`);
    headingIcon.append(headingUse);
    heading.append(headingIcon, document.createTextNode(group));
    const chips = document.createElement("div");
    chips.className = "chips";
    chips.append(...byGroup.get(group).map(([code, count]) =>
      chip("formats", code, formatName(code), count, state.filters.formats.has(code), formatIcon(code))));
    const wrapper = document.createElement("div");
    wrapper.className = "format-group";
    wrapper.append(heading, chips);
    return wrapper;
  }));

  const licenseBox = field("licenseFacet");
  const licenses = countBy(items, (item) => [item.library?.license]);
  licenseBox.replaceChildren(...(licenses.length
    ? licenses.map(([license, count]) => chip("licenses", license, license, count, state.filters.licenses.has(license), licenseIcon(license)))
    : [emptyNote("Fab did not record a license for these products.")]));

  const needle = state.tagSearch.toLowerCase();
  const tags = countBy(items, (item) => item.tags)
    .filter(([tag]) => state.filters.tags.has(tag) || !needle || tag.toLowerCase().includes(needle))
    .slice(0, MAX_TAGS_SHOWN);
  field("tagFacet").replaceChildren(...tags.map(([tag, count]) => chip("tags", tag, tag, count, state.filters.tags.has(tag), null)));

  // Runs last and alone, so a bad date can never stop the panels above from drawing.
  try {
    paintAddedCounts(items);
  } catch (error) {
    addLog(`Date filter counts failed: ${error.message}`);
  }
}

document.querySelector(".sidebar").addEventListener("change", (event) => {
  const input = event.target;
  const setByName = {
    types: state.filters.types, sellers: state.filters.sellers, tags: state.filters.tags,
    formats: state.filters.formats, licenses: state.filters.licenses,
  };
  if (setByName[input.name]) {
    if (input.checked) setByName[input.name].add(input.value);
    else setByName[input.name].delete(input.value);
  }
  if (input.name === "status") state.filters.status = input.value;
  if (input.name === "addedSince") state.filters.addedSince = input.value;
  if (input.id === "hideMature") state.filters.hideMature = input.checked;
  if (input.name === "sort") state.filters.sort = input.value;
  state.shown = pageSize();
  renderAll();
});

for (const button of document.querySelectorAll("[data-facet]")) {
  button.addEventListener("click", () => {
    state.filters[button.dataset.facet].clear();
    renderAll();
  });
}

field("tagSearch").addEventListener("input", () => {
  state.tagSearch = field("tagSearch").value.trim();
  renderFacets();
});

let searchTimer = null;
field("search").addEventListener("input", () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    state.filters.text = field("search").value.trim().toLowerCase();
    state.shown = pageSize();
    renderGrid();
  }, 200);
});

// ---------- grid ----------

function ratingBadge(rating) {
  const wrapper = document.createElement("span");
  wrapper.className = "card-rating tip";
  wrapper.dataset.tip = `${rating.average.toFixed(2)} out of 5 from ${rating.count} ratings on Fab`;
  const stars = document.createElement("span");
  stars.className = "stars-static";
  const filled = Math.round(rating.average);
  for (let i = 1; i <= 5; i++) {
    const star = document.createElement("span");
    star.className = i <= filled ? "star-glyph on" : "star-glyph";
    star.textContent = "★";
    stars.append(star);
  }
  const count = document.createElement("small");
  count.textContent = rating.count;
  wrapper.append(stars, count);
  return wrapper;
}

function card(item, index) {
  const article = document.createElement("article");
  article.className = "card" + (isGone(item) ? " gone" : "") + (item.uid === state.selectedUid ? " selected" : "");
  article.dataset.uid = item.uid;
  if (index < MAX_ANIMATED_CARDS) {
    article.classList.add("card-enter");
    article.style.setProperty("--enter-delay", `${index * 14}ms`);
  }

  const thumb = document.createElement("div");
  thumb.className = "thumb";
  if (item.thumbnail) {
    const img = document.createElement("img");
    img.loading = "lazy";
    img.decoding = "async";
    img.alt = "";
    img.src = item.thumbnail;
    thumb.append(img);
  } else {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
    use.setAttribute("href", "#s-noimage");
    svg.append(use);
    thumb.append(svg);
  }

  const body = document.createElement("div");
  body.className = "card-body";
  const title = document.createElement("div");
  title.className = "card-title";
  const titleText = document.createElement("span");
  titleText.textContent = item.title;
  title.append(titleText);
  const seller = document.createElement("div");
  seller.className = "card-seller";
  seller.textContent = item.seller || "";
  const pills = document.createElement("div");
  pills.className = "card-pills";
  const typePill = document.createElement("span");
  typePill.className = "pill";
  typePill.textContent = typeLabels[item.listingType] || item.listingType || "";
  pills.append(typePill);
  if (isGone(item)) {
    const statusPill = document.createElement("span");
    statusPill.className = "pill tip";
    statusPill.textContent = statusLabel(item);
    statusPill.dataset.tip = statusTip[item.status] || item.status;
    pills.append(statusPill);
  }

  body.append(title, seller);
  if (item.rating?.count) body.append(ratingBadge(item.rating));
  body.append(pills);
  article.append(thumb, body);
  return article;
}

function renderGrid() {
  const items = filteredItems();
  const total = state.items.size;
  const drawn = Math.min(state.shown, items.length);
  if (drawn < items.length) field("count").textContent = `${drawn}/${items.length} items shown`;
  else if (items.length < total) field("count").textContent = `${items.length} of ${total} items`;
  else field("count").textContent = `${total} items`;
  field("grid").replaceChildren(...items.slice(0, state.shown).map((item, index) => card(item, index)));
  field("more").hidden = items.length <= state.shown;
  field("export").disabled = items.length === 0;
  field("exportLabel").textContent = items.length ? `Export ${items.length}` : "Export";
}

function renderAll() {
  try {
    renderFacets();
  } catch (error) {
    addLog(`Filter panel failed to draw: ${error.message}`);
    setStatus(`Filter panel failed to draw: ${error.message}`);
  }
  try {
    renderGrid();
  } catch (error) {
    addLog(`Grid failed to draw: ${error.message}`);
    setStatus(`Grid failed to draw: ${error.message}`);
  }
}

field("more").addEventListener("click", () => {
  state.shown += pageSize();
  renderGrid();
});

field("grid").addEventListener("click", (event) => {
  const article = event.target.closest(".card");
  if (article) openDrawer(article.dataset.uid);
});

// ---------- drawer ----------

function fact(label, value) {
  if (!value) return [];
  const dt = document.createElement("dt");
  dt.textContent = label;
  const dd = document.createElement("dd");
  if (value instanceof Node) dd.append(value);
  else dd.textContent = value;
  return [dt, dd];
}

function link(text, href) {
  const anchor = document.createElement("a");
  anchor.textContent = text;
  anchor.href = href;
  anchor.target = "_blank";
  anchor.rel = "noopener";
  return anchor;
}

function openDrawer(uid) {
  const item = state.items.get(uid);
  if (!item) return;
  state.selectedUid = uid;
  for (const article of field("grid").children) article.classList.toggle("selected", article.dataset.uid === uid);

  field("drawerTitle").textContent = item.title;
  const hero = field("drawerImage");
  hero.src = item.images[0] || item.thumbnail || "";
  hero.hidden = !hero.src;

  field("drawerGallery").replaceChildren(...item.images.map((url, index) => {
    const img = document.createElement("img");
    img.src = url;
    img.alt = "";
    img.loading = "lazy";
    img.className = index === 0 ? "active" : "";
    img.addEventListener("click", () => {
      hero.src = url;
      for (const other of field("drawerGallery").children) other.classList.toggle("active", other === img);
    });
    return img;
  }));

  const acquired = item.library?.acquiredAt ? new Date(item.library.acquiredAt).toLocaleDateString() : null;
  const rating = item.rating?.count ? `${item.rating.average.toFixed(1)} from ${item.rating.count} ratings` : null;
  field("drawerFacts").replaceChildren(
    ...fact("Status", isGone(item) ? `${statusLabel(item)}, still yours to download on Fab` : "in library"),
    ...fact("Type", typeLabels[item.listingType] || item.listingType),
    ...fact("Category", item.category?.path),
    ...fact("Seller", item.sellerUrl ? link(item.seller, item.sellerUrl) : item.seller),
    ...fact("Formats", item.formats.join(", ")),
    ...fact("Rating", rating),
    ...fact("License", item.library?.license),
    ...fact("Acquired", acquired),
    ...fact("Synced", item.syncedAt ? new Date(item.syncedAt).toLocaleString() : null),
  );

  field("drawerTags").replaceChildren(...item.tags.map((tag) => {
    const wrapper = chip("drawerTags", tag, tag, null, state.filters.tags.has(tag), null);
    wrapper.querySelector("input").addEventListener("change", (event) => {
      if (event.target.checked) state.filters.tags.add(tag);
      else state.filters.tags.delete(tag);
      renderAll();
    });
    return wrapper;
  }));
  field("drawerDescription").textContent = item.description;
  field("drawerOpen").href = item.url;
  field("drawer").hidden = false;
}

function closeDrawer() {
  field("drawer").hidden = true;
  state.selectedUid = null;
  for (const article of field("grid").children) article.classList.remove("selected");
}

field("drawerClose").addEventListener("click", closeDrawer);
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") closeDrawer();
});

field("drawerRecheck").addEventListener("click", async () => {
  const item = state.items.get(state.selectedUid);
  if (!item) return;
  const previousPhase = state.phase;
  const wasRunning = state.running;
  setPhase("rechecking");
  try {
    const answer = await sendToFab({ type: "recheck", uid: item.uid, library: item.library });
    if (!answer.ok) throw new Error(answer.error);
    await mergeItems([answer.item]);
    addLog(`${item.title}: rechecked, ${answer.item.status}`);
    openDrawer(item.uid);
  } catch (error) {
    addLog(`${item.title}: recheck failed, ${error.message}`);
  }
  setPhase(wasRunning ? previousPhase : "idle");
});

field("drawerCopy").addEventListener("click", async () => {
  const item = state.items.get(state.selectedUid);
  if (!item) return;
  await navigator.clipboard.writeText(JSON.stringify({ ...item, raw: undefined }, null, 2));
  addLog(`${item.title}: JSON copied`);
});

// ---------- export and clear ----------

field("export").addEventListener("click", () => {
  const includeRaw = field("includeRaw").checked;
  const items = filteredItems().map((item) => (includeRaw ? item : { ...item, raw: undefined }));
  const payload = { exportedAt: new Date().toISOString(), count: items.length, items };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `fab-library-${new Date().toISOString().slice(0, 10)}.json`;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  addLog(`Exported ${items.length} items`);
});

field("diagnostics").addEventListener("click", async () => {
  const items = [...state.items.values()];
  const count = (pick) => Object.fromEntries(countBy(items, pick));
  const sample = items.find((item) => item.raw)?.raw || null;
  const report = {
    version: chrome.runtime.getManifest().version,
    browser: navigator.userAgent,
    settings: readSettings(),
    catalog: { total: items.length, byType: count((item) => [item.listingType]), byStatus: count((item) => [item.status || "ok"]), bySeller: count((item) => [item.seller]) },
    lastSync: (await chrome.storage.local.get(META_KEY))[META_KEY]?.lastSync || null,
    log: state.log,
    sampleLibraryRecord: sample,
  };
  await navigator.clipboard.writeText(JSON.stringify(report, null, 2));
  addLog("Diagnostics copied to the clipboard");
});

field("clear").addEventListener("click", async () => {
  if (!confirm(`Delete all ${state.items.size} items from the local catalog? Your Fab library is not touched.`)) return;
  await dbClear();
  await chrome.storage.local.remove(META_KEY);
  state.items.clear();
  closeDrawer();
  renderAll();
  showIdleStatus();
  addLog("Catalog cleared");
});

// ---------- start ----------

async function init() {
  await restoreSettings();
  for (const item of await dbGetAll()) state.items.set(item.uid, item);
  setPhase("idle");
  renderAll();
  showIdleStatus();
}

init();
