// Runs inside fab.com tabs. Does the search and the add to library calls.
// Requests must come from the fab.com page so the CSRF check passes.
// Bump with the manifest version so the popup can spot a stale tab.
const SCRIPT_VERSION = "1.5.1";

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
    if (message.minVersion && message.minVersion !== SCRIPT_VERSION) {
      sendResponse({ ok: false, error: `Tab runs claimer ${SCRIPT_VERSION}, popup is ${message.minVersion}. Reload the fab.com tab and start again.` });
      return;
    }
    if (running) {
      sendResponse({ ok: false, error: "Already running in this tab." });
      return;
    }
    running = true;
    chrome.runtime.sendMessage({ type: "acquireClaim" }).then((answer) => {
      if (!answer?.tabId) {
        running = false;
        sendResponse({ ok: false, error: answer?.error || "Could not start the claim." });
        return;
      }
      runClaim(message.filters, answer.tabId);
      sendResponse({ ok: true });
    }).catch((error) => {
      running = false;
      sendResponse({ ok: false, error: error.message });
    });
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
    sendResponse({ ok: true, running, revision: 2 });
  }
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const randomBetween = (min, max) => min + Math.random() * (max - min);
const getCookie = (name) =>
  document.cookie.split("; ").find((c) => c.startsWith(name + "="))?.split("=")[1];

function applyNewFilters(filters) {
  if (!filters.mode) filters.mode = currentFilters.mode;
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
  filtered: 0,
  notFree: 0,
  repeated: 0,
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
// Throws on auth or repeated failure so a failed check never looks like not owned.
async function isOwned(uid, headers) {
  const url = `/i/users/me/listings-states/${uid}?fields=ownership`;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const res = await fetch(url, { credentials: "include", headers });
    if (res.status === 401 || res.status === 403) throw new Error("auth");
    if (res.ok) {
      const data = await res.json();
      return Array.isArray(data.ownership) && data.ownership.length > 0;
    }
    if ((res.status === 429 || res.status >= 500) && attempt < MAX_RETRIES) {
      await sleep(RETRY_WAIT_MS * attempt);
      continue;
    }
    throw new Error(`ownership check answered ${res.status}`);
  }
}

// One listing page read, shared so each item costs a single fetch.
async function fetchDetail(uid, headers) {
  const res = await fetch(`/i/listings/${uid}`, { credentials: "include", headers });
  if (!res.ok) return { status: res.status, data: null };
  return { status: 0, data: await res.json() };
}

function detailIsFree(data) {
  return data.isFree === true || data.startingPrice?.price === 0;
}

// The search offer is the Personal license. Prefer the free Professional one.
// Limited time items are paid assets cut to free, so several price shapes count as free.
function chooseOffer(item, data) {
  const fallback = { offerId: item.offerId, license: "Personal", title: item.title };
  const title = data.title || item.title;
  const licenses = data.licenses || [];
  const isFreePrice = (l) =>
    l.priceTier?.price === 0 || l.price === 0 ||
    l.priceTier?.discountedPrice === 0 || l.priceTier?.finalPrice === 0 ||
    l.priceTier?.salePrice === 0 || l.discountedPrice === 0 || l.finalPrice === 0 ||
    l.discountPercentage === 100 || l.discount === 100;
  const free = licenses.filter((l) => l.offerId && isFreePrice(l));
  const chosen = free.find((l) => l.slug === "professional") || free[0];
  if (chosen) return { offerId: chosen.offerId, license: chosen.name, title };
  const sample = licenses[0] ? JSON.stringify(licenses[0]).slice(0, 500) : "none";
  return { ...fallback, title, detailFree: detailIsFree(data), debug: `${licenses.length} licenses, page keys: ${Object.keys(data).join(",")}, first: ${sample}` };
}

// Same fetch, kept for search mode.
async function pickOffer(item, headers) {
  const { status, data } = await fetchDetail(item.uid, headers);
  if (!data) return { offerId: item.offerId, license: "Personal", title: item.title, detailStatus: status };
  return chooseOffer(item, data);
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

const LIMITED_FREE_KEY = "fabLimitedFree";

async function claimPromotionItem(uid, done) {
  const detail = await (await FabLimited.request(`/i/listings/${uid}`)).json();
  const prices = await (await FabLimited.request(`/i/listings/${uid}/prices-infos`)).json();
  const license = FabLimited.chooseLicense(detail, prices);
  const runtime = document.getElementById("js-json-data-sketchfab-runtime");
  const config = runtime ? JSON.parse(runtime.textContent) : {};
  const expected = {
    uid, title: detail.title, offerId: license.offerId,
    namespace: config.epicFabLiveNamespace, merchantGroup: config.epicFabMerchantGroup,
  };
  if (stopRequested) return;
  const answer = await chrome.runtime.sendMessage({ type: "openCheckout", expected });
  if (!answer?.tabId) throw new Error(answer?.error || "Fab checkout could not open.");
  await log(`${detail.title}: opening free ${license.name} checkout.`);
  let lastMessage = "";
  const deadline = Date.now() + 10 * 60 * 1000;
  try {
    while (!stopRequested && Date.now() < deadline) {
      if ((await FabLimited.owned([uid])).includes(uid)) {
        await markDone({ uid }, done, "added");
        await log(`${detail.title}: ownership verified (${license.name}).`);
        return;
      }
      const state = await chrome.runtime.sendMessage({ type: "readCheckout", tabId: answer.tabId });
      if (!state || state.error) throw new Error(state?.error || "Checkout stopped responding.");
      if (["unsafe", "closed"].includes(state.state)) throw new Error(state.message);
      progress.phase = state.state === "action" ? "action" : "claiming";
      if (state.message && state.message !== lastMessage) {
        lastMessage = state.message;
        await log(lastMessage);
      }
      await saveProgress();
      await sleep(2000);
    }
    if (!stopRequested) throw new Error("Checkout timed out. Ownership was not verified. Start again.");
  } finally {
    await chrome.runtime.sendMessage({ type: "closeCheckout", tabId: answer.tabId }).catch(() => {});
  }
}

async function claimLimitedList() {
  const promotion = await FabLimited.promotion();
  const done = await loadDone();
  await chrome.storage.local.set({ [LIMITED_FREE_KEY]: promotion.uids });
  progress.found = promotion.uids.length;
  progress.moreToFind = false;
  await log(`Current promotion: ${promotion.uids.length} listings.`);
  for (const uid of promotion.uids) {
    await waitWhilePaused();
    if (stopRequested) return;
    try {
      if ((await FabLimited.owned([uid])).includes(uid)) {
        await markDone({ uid }, done, "owned");
        progress.index++;
        await saveProgress();
        continue;
      }
      const current = await FabLimited.promotion();
      if (current.key !== promotion.key) throw new Error("The promotion changed. Start a new limited claim.");
      await claimPromotionItem(uid, done);
    } catch (error) {
      progress.failed++;
      await log(`Limited claim stopped: ${error.message}`);
      return;
    }
    progress.index++;
    await saveProgress();
  }
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
  const batchStart = {
    added: progress.added, owned: progress.owned,
    doneEarlier: progress.doneEarlier, filtered: progress.filtered,
  };

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
      if (reason === "filtered") progress.filtered++;
      if (reason === "not free") progress.notFree++;
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

  const added = progress.added - batchStart.added;
  const owned = progress.owned - batchStart.owned;
  const seen = progress.doneEarlier - batchStart.doneEarlier;
  const cut = progress.filtered - batchStart.filtered;
  await log(`Batch done: ${added} added, ${owned} already owned, ${seen} claimed earlier, ${cut} cut by your filters`);
}

// Collects a batch of pages, claims it, then goes on with the next batch.
async function claimInBatches(headers) {
  let baseUrl = buildSearchUrl(currentFilters);
  await log(`Search: ${baseUrl}`);
  const seenUids = new Set();
  let offset = 0;
  while (progress.moreToFind && !stopRequested) {
    recollectRequested = false;
    progress.phase = "collecting";
    await saveProgress();
    const batch = await collectBatch(baseUrl, offset, headers);
    offset = batch.nextOffset;
    progress.moreToFind = !batch.lastPageSeen;
    await log(`Batch of ${batch.items.length} listings found, ${progress.found} so far`);

    const fresh = batch.items.filter((item) => !seenUids.has(item.uid));
    progress.repeated += batch.items.length - fresh.length;
    for (const item of fresh) seenUids.add(item.uid);

    // Fab stops honouring the offset past a depth and repeats its last page forever.
    if (batch.items.length && !fresh.length) {
      progress.moreToFind = false;
      await log(`Fab stopped returning new listings at ${progress.found}. Reached the end of what its search will page through.`);
      break;
    }

    const outcome = await claimAll(fresh, headers);
    if (outcome === "stop") return;
    if (outcome !== "recollect") continue;

    baseUrl = buildSearchUrl(currentFilters);
    await log(`Search changed: ${baseUrl}`);
    offset = 0;
    seenUids.clear();
    Object.assign(progress, { found: 0, index: 0, moreToFind: true });
  }
}

async function runClaim(filters, runnerTabId) {
  running = true;
  stopRequested = false;
  paused = false;
  currentFilters = filters;
  Object.assign(progress, {
    running: true, runnerTabId, mode: filters.mode, phase: "collecting", found: 0, index: 0, moreToFind: true,
    added: 0, owned: 0, skipped: 0, doneEarlier: 0, filtered: 0, notFree: 0, repeated: 0, failed: 0, log: [],
  });

  try {
    await saveProgress();
    if (currentFilters.mode === "limited") {
      await log("Limited time free: search filters do not apply, only the wait setting.");
      await claimLimitedList();
    } else {
      const headers = await getCsrfHeaders();
      if (!headers) throw new Error("No CSRF cookie. Log in to fab.com first.");
      await claimInBatches(headers);
    }
  } catch (error) {
    progress.failed++;
    await log(`Error: ${error.message}`);
  }

  progress.phase = stopRequested ? "stopped" : progress.failed ? "error" : "finished";
  await log(`${progress.phase}: ${progress.added} added, ${progress.owned} already owned, ${progress.failed} failed.`);
  await log(`Skipped ${progress.skipped}: ${progress.filtered} cut by your filters, ${progress.doneEarlier} claimed in an earlier run, ${progress.notFree} not free, ${progress.repeated} sent twice by Fab.`);
  await chrome.runtime.sendMessage({ type: "releaseClaim" }).catch(() => {});
  running = false;
  progress.running = false;
  await saveProgress();
}
