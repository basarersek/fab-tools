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

const defaults = { detailsAtOnce: 4, waitMs: 300 };
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

const field = (id) => document.getElementById(id);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const state = {
  items: new Map(),
  filters: { text: "", types: new Set(), sellers: new Set(), tags: new Set(), status: "ok", hideMature: true, sort: "acquired" },
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
    includeRaw: field("includeRaw").checked,
  };
}

async function restoreSettings() {
  const stored = (await chrome.storage.local.get(SETTINGS_KEY))[SETTINGS_KEY] || {};
  field("detailsAtOnce").value = stored.detailsAtOnce ?? defaults.detailsAtOnce;
  field("waitMs").value = stored.waitMs ?? defaults.waitMs;
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

// ---------- resizable side panels ----------

function makeResizable(handle) {
  const panel = field(handle.dataset.target);
  const key = `fabLibraryWidth.${handle.dataset.target}`;
  const grows = handle.dataset.side === "right" ? 1 : -1;
  const apply = (width) => {
    const clamped = Math.min(window.innerWidth * 0.8, Math.max(160, width));
    if (handle.dataset.target === "sidebar") document.documentElement.style.setProperty("--sidebar", `${clamped}px`);
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

for (const target of document.querySelectorAll(".tip")) {
  target.addEventListener("mouseenter", () => {
    tooltipTimer = setTimeout(() => showTooltip(target), 400);
  });
  target.addEventListener("mouseleave", () => {
    clearTimeout(tooltipTimer);
    tooltip.hidden = true;
  });
}

// ---------- phase, status, log ----------

const iconByPhase = { syncing: "busy", rechecking: "busy" };

function setPhase(phase) {
  state.phase = phase;
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

async function showIdleStatus() {
  const meta = (await chrome.storage.local.get(META_KEY))[META_KEY];
  const when = meta?.lastSync ? `, last sync ${new Date(meta.lastSync).toLocaleString()}` : "";
  const count = state.items.size;
  setStatus(count ? `${count} items in catalog${when}` : "No items yet. Log in to fab.com, then press Sync.");
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
    setStatus(`${p.phase}: ${p.updated} updated, ${p.gone} gone, ${p.failed} failed. ${state.items.size} items in catalog.`, 100);
    renderAll();
  }
});

// ---------- filtering and sorting ----------

const isGone = (item) => item.status && item.status !== "ok";

function matches(item) {
  const f = state.filters;
  if (f.status === "ok" && isGone(item)) return false;
  if (f.status === "gone" && !isGone(item)) return false;
  if (f.hideMature && item.isMature) return false;
  if (f.types.size && !f.types.has(item.listingType)) return false;
  if (f.sellers.size && !f.sellers.has(item.seller)) return false;
  if (f.tags.size && ![...f.tags].every((tag) => item.tags.includes(tag))) return false;
  if (!f.text) return true;
  const haystack = [item.title, item.seller, item.category?.path, item.tags.join(" "), item.description]
    .join(" ").toLowerCase();
  return f.text.split(/\s+/).every((word) => haystack.includes(word));
}

const byAcquired = (a, b) => String(b.library?.acquiredAt || b.syncedAt).localeCompare(String(a.library?.acquiredAt || a.syncedAt));
const byTitle = (a, b) => a.title.localeCompare(b.title);
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
  wrapper.append(text);
  if (count !== null) {
    const small = document.createElement("small");
    small.textContent = count;
    wrapper.append(small);
  }
  return wrapper;
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

  const needle = state.tagSearch.toLowerCase();
  const tags = countBy(items, (item) => item.tags)
    .filter(([tag]) => state.filters.tags.has(tag) || !needle || tag.toLowerCase().includes(needle))
    .slice(0, MAX_TAGS_SHOWN);
  field("tagFacet").replaceChildren(...tags.map(([tag, count]) => chip("tags", tag, tag, count, state.filters.tags.has(tag), null)));
}

document.querySelector(".sidebar").addEventListener("change", (event) => {
  const input = event.target;
  const setByName = { types: state.filters.types, sellers: state.filters.sellers, tags: state.filters.tags };
  if (setByName[input.name]) {
    if (input.checked) setByName[input.name].add(input.value);
    else setByName[input.name].delete(input.value);
  }
  if (input.name === "status") state.filters.status = input.value;
  if (input.id === "hideMature") state.filters.hideMature = input.checked;
  if (input.name === "sort") state.filters.sort = input.value;
  state.shown = PAGE_STEP;
  renderAll();
});

for (const button of document.querySelectorAll(".link[data-facet]")) {
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
    state.shown = PAGE_STEP;
    renderGrid();
  }, 200);
});

// ---------- grid ----------

function card(item) {
  const article = document.createElement("article");
  article.className = "card" + (isGone(item) ? " gone" : "") + (item.uid === state.selectedUid ? " selected" : "");
  article.dataset.uid = item.uid;

  const thumb = document.createElement("div");
  thumb.className = "thumb";
  if (item.thumbnail) {
    const img = document.createElement("img");
    img.loading = "lazy";
    img.src = item.thumbnail;
    img.alt = "";
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
  title.textContent = item.title;
  const meta = document.createElement("div");
  meta.className = "card-meta";
  const lines = [item.seller, typeLabels[item.listingType] || item.listingType, isGone(item) ? item.status : null];
  for (const text of lines.filter(Boolean)) {
    const line = document.createElement("span");
    line.textContent = text;
    meta.append(line);
  }
  body.append(title, meta);
  article.append(thumb, body);
  return article;
}

function renderGrid() {
  const items = filteredItems();
  const total = state.items.size;
  field("count").textContent = items.length === total ? `${total} items` : `${items.length} of ${total} items`;
  field("grid").replaceChildren(...items.slice(0, state.shown).map(card));
  field("more").hidden = items.length <= state.shown;
  field("export").disabled = items.length === 0;
  field("exportLabel").textContent = items.length ? `Export ${items.length}` : "Export";
}

function renderAll() {
  renderFacets();
  renderGrid();
}

field("more").addEventListener("click", () => {
  state.shown += PAGE_STEP;
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
    ...fact("Status", isGone(item) ? item.status : "in library"),
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
