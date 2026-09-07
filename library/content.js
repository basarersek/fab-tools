// Runs inside fab.com tabs. Reads the library and listing details for the Fab Library page.
// Requests must come from the fab.com page so cookies and Cloudflare checks pass.

const HEADERS = { "X-Requested-With": "XMLHttpRequest" };
const PAGE_WAIT_MS = 300;
const PAGE_SIZE = 24;
const PAGES_AT_ONCE = 4;
const MAX_RETRIES = 4;
const RETRY_WAIT_MS = 10000;

let stopRequested = false;
let paused = false;
let running = false;
let settings = { detailsAtOnce: 4, waitMs: 300 };

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "sync") {
    if (running) {
      sendResponse({ ok: false, error: "A sync is already running." });
      return;
    }
    runSync(message);
    sendResponse({ ok: true });
    return;
  }
  if (message.type === "recheck") {
    recheck(message).then(sendResponse);
    return true;
  }
  if (message.type === "stop") {
    stopRequested = true;
    paused = false;
    sendResponse({ ok: true });
    return;
  }
  if (message.type === "pause") {
    paused = true;
    sendResponse({ ok: true });
    return;
  }
  if (message.type === "resume") {
    paused = false;
    sendResponse({ ok: true });
    return;
  }
  if (message.type === "ping") {
    sendResponse({ ok: true, running });
  }
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitWhilePaused() {
  while (paused && !stopRequested) await sleep(300);
}

// ---------- talking to the library page ----------

// A failed send means the library page is closed, so the sync stops.
async function toPage(message) {
  try {
    await chrome.runtime.sendMessage(message);
  } catch {
    stopRequested = true;
  }
}

const report = (progress) => toPage({ type: "syncProgress", progress });
const log = (line) => toPage({ type: "syncLog", line });

// ---------- Fab requests ----------

async function fetchJson(url, attempt = 1) {
  const res = await fetch(url, { credentials: "include", headers: HEADERS });
  if (res.status === 401 || res.status === 403) throw new Error("auth");
  if (res.status === 404) return null;
  if ((res.status === 429 || res.status >= 500) && attempt < MAX_RETRIES) {
    await sleep(RETRY_WAIT_MS * attempt);
    return fetchJson(url, attempt + 1);
  }
  if (!res.ok) throw new Error(`Fab answered ${res.status} for ${url}`);
  return res.json();
}

// ---------- shaping items ----------

const largest = (images = []) =>
  images.reduce((best, image) => (image.width > (best?.width || 0) ? image : best), null)?.url || null;

const plainText = (html) =>
  html ? new DOMParser().parseFromString(html, "text/html").body.textContent.replace(/\s+/g, " ").trim() : "";

// The library reply shape is only known in part, so every read here is guarded.
function libraryEntry(entry) {
  const listing = entry.listing && typeof entry.listing === "object" ? entry.listing : null;
  const entitlement = entry.entitlement || {};
  return {
    assetUid: entry.uid || null,
    listingUid: listing?.uid || entry.listingUid || (typeof entry.listing === "string" ? entry.listing : null),
    title: listing?.title || entry.title || "",
    acquiredAt: entry.createdAt || entry.acquiredAt || entitlement.createdAt || null,
    license: entitlement.license?.name || entitlement.licenseName || entitlement.license?.slug || null,
    raw: entry,
  };
}

function buildItem(summary, detail) {
  const images = (detail.medias || [])
    .filter((media) => media.type === "image")
    .map((media) => largest(media.images))
    .filter(Boolean);
  return {
    uid: detail.uid,
    title: detail.title || summary.title,
    url: `https://www.fab.com/listings/${detail.uid}`,
    listingType: detail.listingType || null,
    category: detail.category ? { name: detail.category.name, path: detail.category.path } : null,
    tags: (detail.tags || []).map((tag) => tag.name),
    seller: detail.user?.sellerName || null,
    sellerUrl: detail.user?.profileUrl || null,
    thumbnail: largest(detail.thumbnails?.[0]?.images) || images[0] || null,
    images,
    formats: (detail.assetFormats || []).map((format) => format.assetFormatType?.code).filter(Boolean),
    rating: { average: detail.averageRating || 0, count: detail.ratings?.total || 0 },
    isFree: Boolean(detail.isFree),
    isMature: Boolean(detail.isMature),
    publishedAt: detail.publishedAt || null,
    description: plainText(detail.description),
    library: { assetUid: summary.assetUid, acquiredAt: summary.acquiredAt, license: summary.license },
    status: "ok",
    syncedAt: new Date().toISOString(),
    raw: summary.raw,
  };
}

function goneItem(summary) {
  return {
    uid: summary.listingUid,
    title: summary.title || summary.listingUid,
    url: `https://www.fab.com/listings/${summary.listingUid}`,
    listingType: null,
    category: null,
    tags: [],
    seller: null,
    sellerUrl: null,
    thumbnail: null,
    images: [],
    formats: [],
    rating: { average: 0, count: 0 },
    isFree: false,
    isMature: false,
    publishedAt: null,
    description: "",
    library: { assetUid: summary.assetUid, acquiredAt: summary.acquiredAt, license: summary.license },
    status: "gone",
    syncedAt: new Date().toISOString(),
    raw: summary.raw,
  };
}

// ---------- sync ----------

// Fab gives a full next link, or only a cursor. Both are handled.
function nextPageUrl(currentUrl, data) {
  if (data.next) return data.next.replace("https://www.fab.com", "");
  if (!data.cursors?.next) return null;
  const url = new URL(currentUrl, "https://www.fab.com");
  url.searchParams.set("cursor", data.cursors.next);
  return url.pathname + url.search;
}

const pageCursor = (offset) => btoa(`o=${offset}`);
const decodeCursor = (cursor) => {
  try {
    return atob(cursor || "");
  } catch {
    return "";
  }
};

// Fab cursors are usually base64 of "o=<offset>". Then pages load 4 at once.
async function walkLibrary(onEntries) {
  const baseUrl = "/i/library/search?sort_by=-createdAt";
  const first = await fetchJson(baseUrl);
  if (!first) throw new Error("Library search returned nothing.");
  const firstEntries = first.results || [];
  await onEntries(firstEntries);
  if (decodeCursor(first.cursors?.next) !== `o=${PAGE_SIZE}`) return walkSequential(baseUrl, first, onEntries);

  let offset = PAGE_SIZE;
  let lastPageSeen = firstEntries.length < PAGE_SIZE;
  while (!lastPageSeen && !stopRequested) {
    await waitWhilePaused();
    const offsets = Array.from({ length: PAGES_AT_ONCE }, (_, i) => offset + i * PAGE_SIZE);
    const pages = await Promise.all(offsets.map((o) => fetchJson(`${baseUrl}&cursor=${encodeURIComponent(pageCursor(o))}`)));
    for (const page of pages) {
      const entries = page?.results || [];
      await onEntries(entries);
      if (entries.length < PAGE_SIZE) lastPageSeen = true;
    }
    offset += PAGES_AT_ONCE * PAGE_SIZE;
    await sleep(PAGE_WAIT_MS);
  }
}

async function walkSequential(baseUrl, first, onEntries) {
  let url = nextPageUrl(baseUrl, first);
  while (url && !stopRequested) {
    await waitWhilePaused();
    const data = await fetchJson(url);
    if (!data) return;
    await onEntries(data.results || []);
    url = nextPageUrl(url, data);
    await sleep(PAGE_WAIT_MS);
  }
}

async function fetchItem(summary) {
  try {
    const detail = await fetchJson(`/i/listings/${summary.listingUid}`);
    return detail ? buildItem(summary, detail) : goneItem(summary);
  } catch (error) {
    if (error.message === "auth") throw error;
    await log(`${summary.title || summary.listingUid}: ${error.message}`);
    return null;
  }
}

async function processChunk(chunk, progress) {
  await waitWhilePaused();
  if (stopRequested) return;
  const items = await Promise.all(chunk.map(fetchItem));
  for (const item of items) {
    if (!item) progress.failed++;
    else if (item.status === "gone") progress.gone++;
    else progress.updated++;
  }
  progress.processed += chunk.length;
  await toPage({ type: "syncItems", items: items.filter(Boolean) });
  await report(progress);
  await sleep(settings.waitMs);
}

async function runSync(message) {
  running = true;
  stopRequested = false;
  paused = false;
  settings = message.settings;
  const known = new Set(message.knownUids);
  const full = message.full;
  const progress = { phase: "syncing", found: 0, known: 0, processed: 0, updated: 0, gone: 0, failed: 0 };
  await report(progress);
  await log(full ? "Full resync: every item is fetched again." : "Sync: whole library list, details only for new items.");

  const pending = [];
  let firstPage = true;
  const onEntries = async (entries) => {
    if (firstPage && entries[0]) {
      await log(`Library item keys: ${Object.keys(entries[0]).join(", ")}`);
      firstPage = false;
    }
    for (const entry of entries) {
      const summary = libraryEntry(entry);
      if (!summary.listingUid) continue;
      if (!full && known.has(summary.listingUid)) {
        progress.known++;
        continue;
      }
      progress.found++;
      pending.push(summary);
    }
    await report(progress);
    while (pending.length >= settings.detailsAtOnce && !stopRequested) {
      await processChunk(pending.splice(0, settings.detailsAtOnce), progress);
    }
  };

  try {
    await walkLibrary(onEntries);
    while (pending.length && !stopRequested) {
      await processChunk(pending.splice(0, settings.detailsAtOnce), progress);
    }
  } catch (error) {
    await log(error.message === "auth" ? "Fab refused the request. Log in to fab.com and try again." : `Error: ${error.message}`);
  }

  progress.phase = stopRequested ? "stopped" : "finished";
  await log(`Library list: ${progress.found + progress.known} items, ${progress.known} already in catalog.`);
  await report(progress);
  await toPage({ type: "syncDone", progress });
  running = false;
}

// ---------- recheck one listing ----------

async function recheck({ uid, library }) {
  const summary = {
    listingUid: uid,
    title: "",
    assetUid: library?.assetUid || null,
    acquiredAt: library?.acquiredAt || null,
    license: library?.license || null,
    raw: undefined,
  };
  try {
    const detail = await fetchJson(`/i/listings/${uid}`);
    if (!detail) return { ok: true, item: goneItem(summary) };
    const item = buildItem(summary, detail);
    const state = await fetchJson(`/i/users/me/listings-states/${uid}?fields=ownership`);
    const owned = Array.isArray(state?.ownership) && state.ownership.length > 0;
    item.status = owned ? "ok" : "not owned";
    return { ok: true, item };
  } catch (error) {
    return { ok: false, error: error.message === "auth" ? "Log in to fab.com first." : error.message };
  }
}
