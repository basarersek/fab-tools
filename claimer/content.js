// Runs inside fab.com tabs. Does the search and the add to library calls.
// Requests must come from the fab.com page so the CSRF check passes.

const PROGRESS_KEY = "fabClaimProgress";
const DONE_KEY = "fabClaimDone";
const MAX_LOG_LINES = 300;
const MAX_RETRIES = 5;
const RETRY_WAIT_MS = 15000;
const PAGE_SIZE = 24;
const BATCH_WAIT_MS = 300;

let stopRequested = false;
let paused = false;
let recollectRequested = false;
let running = false;
let currentFilters = null;

const searchFilterKeys = ["query", "listingTypes", "channels", "quixelOnly"];

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "start") {
    if (running) {
      sendResponse({ ok: false, error: "Already running in this tab." });
      return;
    }
    runClaim(message.filters);
    sendResponse({ ok: true });
    return;
  }
  if (message.type === "stop") {
    stopRequested = true;
    paused = false;
    sendResponse({ ok: true });
    return;
  }
  if (message.type === "pause") {
    paused = true;
    progress.phase = "paused";
    saveProgress();
    sendResponse({ ok: true });
    return;
  }
  if (message.type === "resume") {
    applyNewFilters(message.filters);
    paused = false;
    sendResponse({ ok: true });
    return;
  }
  if (message.type === "ping") {
    sendResponse({ ok: true, running });
  }
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const randomBetween = (min, max) => min + Math.random() * (max - min);
const getCookie = (name) =>
  document.cookie.split("; ").find((c) => c.startsWith(name + "="))?.split("=")[1];

function applyNewFilters(filters) {
  const searchChanged = searchFilterKeys.some(
    (key) => JSON.stringify(filters[key]) !== JSON.stringify(currentFilters[key]));
  currentFilters = filters;
  if (searchChanged) recollectRequested = true;
}

async function waitWhilePaused() {
  while (paused && !stopRequested) await sleep(300);
}

// ---------- progress and resume storage ----------

const progress = {
  running: false,
  phase: "idle",
  found: 0,
  index: 0,
  added: 0,
  owned: 0,
  skipped: 0,
  doneEarlier: 0,
  failed: 0,
  log: [],
};

// Storage throws after an extension reload. Then this old script must stop.
async function saveProgress() {
  try {
    await chrome.storage.local.set({ [PROGRESS_KEY]: progress });
  } catch {
    stopRequested = true;
  }
}

async function log(line) {
  progress.log.push(line);
  if (progress.log.length > MAX_LOG_LINES) progress.log.shift();
  await saveProgress();
}

async function loadDone() {
  const stored = await chrome.storage.local.get(DONE_KEY);
  return new Set(stored[DONE_KEY] || []);
}

async function saveDone(done) {
  await chrome.storage.local.set({ [DONE_KEY]: [...done] });
}

// ---------- Fab requests ----------

async function getCsrfHeaders() {
  if (!getCookie("fab_csrftoken")) {
    await fetch("/i/csrf", { credentials: "include" });
  }
  const token = getCookie("fab_csrftoken");
  if (!token) return null;
  return { "X-CsrfToken": token, "X-Requested-With": "XMLHttpRequest" };
}

function buildSearchUrl(filters) {
  const params = new URLSearchParams({ is_free: "1" });
  if (filters.query) params.set("q", filters.query);
  if (filters.quixelOnly) params.set("seller", "Quixel Megascans");
  for (const type of filters.listingTypes) params.append("listing_types", type);
  for (const channel of filters.channels) params.append("channels", channel);
  return "/i/listings/search?" + params.toString();
}

function passesFilters(item, filters) {
  if (item.rating < filters.minRating) return false;
  if (item.ratingCount < filters.minRatingCount) return false;
  if (filters.hideMature && item.isMature) return false;
  return true;
}

function toItem(result) {
  return {
    uid: result.uid,
    title: result.title,
    offerId: result.startingPrice?.offerId,
    price: result.startingPrice?.price,
    rating: result.averageRating || 0,
    ratingCount: result.ratings?.total || 0,
    isMature: result.isMature,
  };
}

// Fab cursors are base64 of "o=<offset>", so pages can be fetched out of order.
const pageCursor = (offset) => btoa(`o=${offset}`);

async function fetchPage(baseUrl, offset, headers, attempt = 1) {
  const url = offset ? `${baseUrl}&cursor=${encodeURIComponent(pageCursor(offset))}` : baseUrl;
  const res = await fetch(url, { credentials: "include", headers });
  if (res.status === 429 && attempt < MAX_RETRIES) {
    await sleep(RETRY_WAIT_MS * attempt);
    return fetchPage(baseUrl, offset, headers, attempt + 1);
  }
  if (!res.ok) throw new Error(`Search failed with status ${res.status}`);
  return (await res.json()).results;
}

const countItems = (pages) => pages.reduce((sum, page) => sum + page.length, 0);

// Collects one batch of pages from the offset. Returns the items and where to go on.
async function collectBatch(baseUrl, startOffset, headers) {
  const items = [];
  let offset = startOffset;
  let lastPageSeen = false;
  const endOffset = startOffset + currentFilters.batchPages * PAGE_SIZE;
  while (!lastPageSeen && offset < endOffset && !stopRequested) {
    const offsets = Array.from({ length: currentFilters.parallelPages }, (_, i) => offset + i * PAGE_SIZE);
    const pages = await Promise.all(offsets.map((o) => fetchPage(baseUrl, o, headers)));
    for (const page of pages) {
      items.push(...page.map(toItem));
      if (page.length < PAGE_SIZE) lastPageSeen = true;
    }
    offset += currentFilters.parallelPages * PAGE_SIZE;
    progress.found += countItems(pages);
    await saveProgress();
    await sleep(BATCH_WAIT_MS);
  }
  return { items, nextOffset: offset, lastPageSeen };
}

// Returns true when the library already holds this listing.
async function isOwned(uid, headers) {
  const res = await fetch(`/i/users/me/listings-states/${uid}?fields=ownership`, {
    credentials: "include",
    headers,
  });
  if (res.status === 401 || res.status === 403) throw new Error("auth");
  if (!res.ok) return false;
  const data = await res.json();
  return Array.isArray(data.ownership) && data.ownership.length > 0;
}

// The search offer is the Personal license. Prefer the free Professional one.
async function pickOffer(item, headers) {
  const fallback = { offerId: item.offerId, license: "Personal" };
  const res = await fetch(`/i/listings/${item.uid}`, { credentials: "include", headers });
  if (!res.ok) return fallback;
  const licenses = ((await res.json()).licenses || []).filter((l) => l.offerId && l.priceTier?.price === 0);
  const chosen = licenses.find((l) => l.slug === "professional") || licenses[0];
  return chosen ? { offerId: chosen.offerId, license: chosen.name } : fallback;
}

async function postAddToLibrary(endpoint, headers, contentType, body) {
  return fetch(endpoint, {
    method: "POST",
    credentials: "include",
    headers: { ...headers, "Content-Type": contentType },
    body,
  });
}

// Returns "added", "owned", "auth", or a failure text.
async function addToLibrary(item, headers) {
  const endpoint = `/i/listings/${item.uid}/add-to-library`;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    let res = await postAddToLibrary(
      endpoint, headers, "application/json", JSON.stringify({ offer_id: item.offerId }));

    // Server rejected the JSON format. Try the form encoding once.
    if (res.status === 415 || res.status === 400) {
      const firstText = await res.text();
      res = await postAddToLibrary(
        endpoint, headers, "application/x-www-form-urlencoded",
        new URLSearchParams({ offer_id: item.offerId }).toString());
      if (res.status === 400) {
        const text = (await res.text()) || firstText;
        return /already|owned|entitle/i.test(text) ? "owned" : `failed 400: ${text.slice(0, 200)}`;
      }
    }

    if (res.ok) return "added";
    if (res.status === 401 || res.status === 403) return "auth";
    if (res.status === 429 || res.status >= 500) {
      await log(`Status ${res.status} on "${item.title}", retry ${attempt}/${MAX_RETRIES}`);
      await sleep(RETRY_WAIT_MS * attempt);
      continue;
    }
    return `failed ${res.status}: ${(await res.text()).slice(0, 200)}`;
  }
  return "failed: too many retries";
}

// ---------- main loop ----------

// Returns a skip reason, or null when the item needs an ownership check.
function skipReason(item, done) {
  if (done.has(item.uid)) return "done earlier";
  if (!passesFilters(item, currentFilters)) return "filtered";
  if (!item.offerId || item.price !== 0) return "not free";
  return null;
}

async function markDone(item, done, counter) {
  done.add(item.uid);
  await saveDone(done);
  progress[counter]++;
}

// Returns "stop", "recollect" when the search settings changed, or nothing to go on.
async function claimAll(items, headers) {
  const done = await loadDone();

  for (let start = 0; start < items.length; start += currentFilters.parallelChecks) {
    await waitWhilePaused();
    if (stopRequested) return "stop";
    if (recollectRequested) return "recollect";
    progress.phase = "claiming";

    const candidates = [];
    for (const item of items.slice(start, start + currentFilters.parallelChecks)) {
      const reason = skipReason(item, done);
      if (!reason) {
        candidates.push(item);
        continue;
      }
      progress.skipped++;
      if (reason === "done earlier") progress.doneEarlier++;
      if (reason === "not free") await log(`${item.title}: not free or no offer, skipped`);
    }

    let ownedFlags;
    try {
      ownedFlags = await Promise.all(candidates.map((item) => isOwned(item.uid, headers)));
    } catch (error) {
      await log(error.message === "auth" ? "Not logged in. Log in to fab.com and start again." : `Error: ${error.message}`);
      return "stop";
    }

    for (let i = 0; i < candidates.length; i++) {
      const item = candidates[i];
      if (ownedFlags[i]) {
        await markDone(item, done, "owned");
        continue;
      }
      await waitWhilePaused();
      if (stopRequested) return "stop";

      const offer = await pickOffer(item, headers);
      const result = await addToLibrary({ ...item, offerId: offer.offerId }, headers);
      if (result === "added") {
        await markDone(item, done, "added");
        await log(`${item.title}: added (${offer.license})`);
      } else if (result === "auth") {
        await log("Not logged in. Log in to fab.com and start again.");
        return "stop";
      } else {
        progress.failed++;
        await log(`${item.title}: ${result}`);
      }
      await sleep(randomBetween(currentFilters.paceMinSec * 1000, currentFilters.paceMaxSec * 1000));
    }

    progress.index += Math.min(currentFilters.parallelChecks, items.length - start);
    await saveProgress();
  }
}

// Collects a batch of pages, claims it, then goes on with the next batch.
async function claimInBatches(headers) {
  let baseUrl = buildSearchUrl(currentFilters);
  await log(`Search: ${baseUrl}`);
  let offset = 0;
  while (progress.moreToFind && !stopRequested) {
    recollectRequested = false;
    progress.phase = "collecting";
    await saveProgress();
    const batch = await collectBatch(baseUrl, offset, headers);
    offset = batch.nextOffset;
    progress.moreToFind = !batch.lastPageSeen;
    await log(`Batch of ${batch.items.length} listings found, ${progress.found} so far`);

    const outcome = await claimAll(batch.items, headers);
    if (outcome === "stop") return;
    if (outcome !== "recollect") continue;

    baseUrl = buildSearchUrl(currentFilters);
    await log(`Search changed: ${baseUrl}`);
    offset = 0;
    Object.assign(progress, { found: 0, index: 0, moreToFind: true });
  }
}

async function runClaim(filters) {
  running = true;
  stopRequested = false;
  paused = false;
  currentFilters = filters;
  Object.assign(progress, {
    running: true, phase: "collecting", found: 0, index: 0, moreToFind: true,
    added: 0, owned: 0, skipped: 0, doneEarlier: 0, failed: 0, log: [],
  });

  try {
    const headers = await getCsrfHeaders();
    if (!headers) throw new Error("No CSRF cookie. Log in to fab.com first.");
    await claimInBatches(headers);
  } catch (error) {
    await log(`Error: ${error.message}`);
  }

  progress.running = false;
  progress.phase = stopRequested ? "stopped" : "finished";
  await log(`${progress.phase}: added ${progress.added}, already owned ${progress.owned}, skipped ${progress.skipped} (${progress.doneEarlier} done in earlier runs), failed ${progress.failed}`);
  running = false;
}
