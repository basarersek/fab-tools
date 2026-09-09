const PROGRESS_KEY = "fabClaimProgress";
const DONE_KEY = "fabClaimDone";
const FILTERS_KEY = "fabClaimFilters";
const EXT_VERSION = chrome.runtime.getManifest().version;
const LIMITED_FREE_KEY = "fabLimitedFree";
const LIMITED_EXPLAIN = "Claims everything on fab.com/limited-time-free, Professional license when free";
const FAB_URL = "https://www.fab.com/";
const CONTENT_SCRIPT_RETRIES = 10;
let startPending = false;
let activeRun = false;
let limitedOwned = false;
let limitedChecking = true;
let limitedCheck = 0;

const fieldIds = [
  "query", "quixelOnly", "minRating", "minRatingCount", "hideMature", "watchLimited",
  "paceMinSec", "paceMaxSec", "batchPages", "parallelPages", "parallelChecks",
];
const defaults = { paceMinSec: 2, paceMaxSec: 4, batchPages: 20, parallelPages: 4, parallelChecks: 8 };
const field = (id) => document.getElementById(id);
const groupBoxes = (name) => [...document.querySelectorAll(`input[name="${name}"]`)];
const clampInt = (id, min, max, fallback) =>
  Math.min(max, Math.max(min, Math.round(Number(field(id).value) || fallback)));

// ---------- advanced section: the toggle only shows or hides it ----------

field("advanced").addEventListener("change", () => {
  field("advancedSection").hidden = !field("advanced").checked;
});

for (const button of document.querySelectorAll(".reset-field")) {
  button.addEventListener("click", () => {
    field(button.dataset.target).value = defaults[button.dataset.target];
  });
}

// ---------- stars ----------

function paintStars(value) {
  for (const star of document.querySelectorAll(".star")) {
    star.classList.toggle("filled", Number(star.dataset.value) <= value);
    star.setAttribute("aria-checked", Number(star.dataset.value) === value);
  }
}

// Click the current star again to clear the filter.
field("stars").addEventListener("click", (event) => {
  const star = event.target.closest(".star");
  if (!star) return;
  const current = Number(field("minRating").value);
  const next = Number(star.dataset.value) === current ? 0 : Number(star.dataset.value);
  field("minRating").value = next;
  paintStars(next);
});

// ---------- tooltip ----------

const tooltip = field("tooltip");
let tooltipTimer = null;

// Centered above the label, kept inside the popup, below when there is no room above.
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

// ---------- select all or none in a chip group ----------

for (const button of document.querySelectorAll(".link[data-group]")) {
  button.addEventListener("click", () => {
    const checked = button.dataset.select === "all";
    for (const box of groupBoxes(button.dataset.group)) box.checked = checked;
  });
}

// ---------- filters ----------

function readFilters() {
  return {
    query: field("query").value.trim(),
    quixelOnly: field("quixelOnly").checked,
    listingTypes: groupBoxes("listingTypes").filter((box) => box.checked).map((box) => box.value),
    channels: groupBoxes("channels").filter((box) => box.checked).map((box) => box.value),
    minRating: Number(field("minRating").value) || 0,
    minRatingCount: Number(field("minRatingCount").value) || 0,
    hideMature: field("hideMature").checked,
    watchLimited: field("watchLimited").checked,
    paceMinSec: Math.max(1, Number(field("paceMinSec").value) || defaults.paceMinSec),
    paceMaxSec: Math.max(1, Number(field("paceMaxSec").value) || defaults.paceMaxSec),
    batchPages: clampInt("batchPages", 1, 100, defaults.batchPages),
    parallelPages: clampInt("parallelPages", 1, 8, defaults.parallelPages),
    parallelChecks: clampInt("parallelChecks", 1, 16, defaults.parallelChecks),
  };
}

function writeFilters(filters) {
  for (const id of fieldIds) {
    const input = field(id);
    if (input.type === "checkbox") input.checked = Boolean(filters[id]);
    else input.value = filters[id] ?? defaults[id] ?? "";
  }
  paintStars(Number(filters.minRating) || 0);
  for (const name of ["listingTypes", "channels"]) {
    const chosen = new Set(filters[name] || []);
    for (const box of groupBoxes(name)) box.checked = chosen.has(box.value);
  }
}

async function restoreFilters() {
  const stored = await chrome.storage.local.get(FILTERS_KEY);
  if (stored[FILTERS_KEY]) writeFilters(stored[FILTERS_KEY]);
}

// The watch toggle saves at once so the background checker sees it without a run.
field("watchLimited").addEventListener("change", async () => {
  await chrome.storage.local.set({ [FILTERS_KEY]: readFilters() });
});

// ---------- fab.com tab ----------

async function getFabTab(create = true) {
  const tabs = await chrome.tabs.query({ url: "https://www.fab.com/*" });
  const eligible = tabs.filter((tab) => !tab.url?.includes("/payment/"));
  const stored = await chrome.storage.local.get(PROGRESS_KEY);
  const owner = eligible.find((tab) => tab.id === stored[PROGRESS_KEY]?.runnerTabId);
  if (owner) return owner;
  if (eligible.length > 0) return eligible.sort((a, b) => a.id - b.id)[0];
  if (!create) return null;
  return chrome.tabs.create({ url: FAB_URL, active: false });
}

// The manifest loads scripts. Only a loading tab needs time before it can answer.
async function sendToFab(message, create = true) {
  const tab = await getFabTab(create);
  if (!tab) throw new Error("No fab.com tab open yet.");
  for (let attempt = 1; attempt <= CONTENT_SCRIPT_RETRIES; attempt++) {
    try {
      if (message.type === "start") {
        const pong = await chrome.tabs.sendMessage(tab.id, { type: "ping" });
        if (pong.revision !== 2) return { ok: false, error: "Reload the Fab tab after reloading the extension." };
      }
      return await chrome.tabs.sendMessage(tab.id, { ...message, runnerTabId: tab.id });
    } catch {
      if (!create || tab.status === "complete") {
        throw new Error("Reload the Fab tab, then press Start again.");
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  throw new Error("No answer from the fab.com tab. Reload it and try again.");
}

// ---------- progress display ----------

const iconByPhase = { collecting: "busy", claiming: "busy", action: "paused", error: "stopped" };

function setPhase(phase) {
  const label = phase[0].toUpperCase() + phase.slice(1);
  field("phase").dataset.tip = label;
  field("phase").setAttribute("aria-label", label);
  field("phaseIcon").setAttribute("href", `#s-${iconByPhase[phase] || phase}`);
  document.body.dataset.phase = phase;
}

function render(progress) {
  activeRun = Boolean(progress?.running);
  if (progress?.mode === "limited" && progress.phase === "finished" && progress.found > 0 &&
    progress.index === progress.found && progress.added + progress.owned === progress.found) limitedOwned = true;
  const startButton = field("start");
  const pauseButton = field("pauseResume");
  if (!progress) {
    setPhase("idle");
    field("status").textContent = "Ready";
    field("barFill").style.width = "0";
    startButton.disabled = startPending;
    paintLimitedButton();
    pauseButton.disabled = true;
    field("stop").disabled = true;
    updateLimitedState();
    return;
  }

  setPhase(progress.phase);
  const claiming = progress.phase !== "collecting";
  const found = `${progress.found}${progress.moreToFind ? "+" : ""}`;
  field("status").textContent = claiming
    ? `${progress.index} of ${found} listings`
    : `Collecting listings... ${found} found`;
  const percent = claiming && progress.found ? (progress.index / progress.found) * 100 : 0;
  field("barFill").style.width = `${percent}%`;

  field("countAdded").textContent = progress.added;
  field("countOwned").textContent = progress.owned;
  field("countSkipped").textContent = progress.skipped;
  field("countFailed").textContent = progress.failed;

  startButton.disabled = startPending || progress.running;
  paintLimitedButton();
  pauseButton.disabled = !progress.running || progress.mode === "limited";
  field("stop").disabled = !progress.running;
  pauseButton.textContent = progress.phase === "paused" ? "Resume" : "Pause";

  if (progress.phase === "action") field("status").textContent = "Action needed in the Fab checkout tab.";

  const logBox = field("log");
  logBox.textContent = progress.log.join("\n");
  logBox.scrollTop = logBox.scrollHeight;
  if (!progress.running) updateLimitedState();
}

async function refresh() {
  const stored = await chrome.storage.local.get(PROGRESS_KEY);
  let progress = stored[PROGRESS_KEY];
  try {
    // Storage may say idle while the tab still runs, after a Reset or a reload.
    const pong = await sendToFab({ type: "ping" }, false);
    if (!pong?.running && progress?.running) {
      progress = { ...progress, running: false, phase: "stopped" };
      await chrome.storage.local.set({ [PROGRESS_KEY]: progress });
    }
    if (pong?.running && !progress?.running) {
      progress = {
        running: true, phase: "claiming", found: 0, index: 0, moreToFind: false,
        added: 0, owned: 0, skipped: 0, failed: 0, log: ["Claim running in the fab tab."],
      };
    }
  } catch {
    // No fab tab yet. Stored progress stands.
  }
  render(progress);
}

chrome.storage.onChanged.addListener((changes) => {
  if (changes[PROGRESS_KEY]) {
    render(changes[PROGRESS_KEY].newValue);
    if (!changes[PROGRESS_KEY].newValue?.running) updateLimitedState();
  } else if (changes[DONE_KEY]) {
    updateLimitedState();
  }
});

function paintLimitedButton() {
  const button = field("claimLimited");
  button.disabled = startPending || activeRun || limitedOwned || limitedChecking;
  button.textContent = limitedOwned ? "Limited free claimed" : "Claim limited time free";
  button.title = limitedOwned ? "Every current promotional asset is in your library." : LIMITED_EXPLAIN;
}

async function updateLimitedState() {
  const check = ++limitedCheck;
  if (startPending || activeRun) return;
  limitedChecking = true;
  paintLimitedButton();
  try {
    const current = await FabLimited.promotion();
    const owned = await FabLimited.owned(current.uids);
    if (check !== limitedCheck || startPending || activeRun) return;
    limitedOwned = current.uids.length > 0 && owned.length === current.uids.length;
  } catch (error) {
    if (check !== limitedCheck || startPending || activeRun) return;
    limitedOwned = false;
    field("claimLimited").title = error.message;
  }
  limitedChecking = false;
  paintLimitedButton();
}

// ---------- next drop countdown ----------

async function refreshDrop() {
  const el = field("dropEta");
  try {
    const res = await chrome.runtime.sendMessage({ type: "getDrop" });
    const when = res?.when || 0;
    if (!when || when < Date.now()) {
      el.hidden = true;
      return;
    }
    el.hidden = false;
    const tick = () => {
      const ms = when - Date.now();
      if (ms <= 0) {
        el.textContent = "Drop time passed. Run the claim.";
        if (Date.now() - (refreshDrop.lastStateCheck || 0) > 60000) {
          refreshDrop.lastStateCheck = Date.now();
          updateLimitedState();
        }
        return;
      }
      const days = Math.floor(ms / 86400000);
      const hours = Math.floor(ms / 3600000) % 24;
      const mins = Math.floor(ms / 60000) % 60;
      const secs = Math.floor(ms / 1000) % 60;
      el.textContent = `Next limited time free in ${days}d ${hours}h ${mins}m ${secs}s`;
    };
    tick();
    clearInterval(refreshDrop.timer);
    refreshDrop.timer = setInterval(tick, 1000);
  } catch {
    el.hidden = true;
  }
}

// ---------- buttons ----------

async function startClaim(mode) {
  if (startPending || activeRun || (mode === "limited" && limitedOwned)) return;
  startPending = true;
  limitedCheck++;
  paintLimitedButton();
  field("start").disabled = true;
  field("status").textContent = "Starting claim...";
  try {
    const filters = { ...readFilters(), mode };
    if (filters.paceMaxSec < filters.paceMinSec) filters.paceMaxSec = filters.paceMinSec;
    await chrome.storage.local.set({ [FILTERS_KEY]: filters });
    const answer = await sendToFab({ type: "start", filters, minVersion: EXT_VERSION });
    if (!answer?.ok) throw new Error(answer?.error || "Fab did not start the claim.");
    activeRun = true;
  } catch (error) {
    field("status").textContent = error.message;
  } finally {
    startPending = false;
    field("start").disabled = activeRun;
    paintLimitedButton();
  }
}

field("filters").addEventListener("submit", (event) => {
  event.preventDefault();
  startClaim("search");
});

field("claimLimited").addEventListener("click", () => startClaim("limited"));

// Resume sends the current form values so changed settings take effect.
field("pauseResume").addEventListener("click", async () => {
  const resuming = field("pauseResume").textContent === "Resume";
  const filters = readFilters();
  if (filters.paceMaxSec < filters.paceMinSec) filters.paceMaxSec = filters.paceMinSec;
  await chrome.storage.local.set({ [FILTERS_KEY]: filters });
  try {
    await sendToFab(resuming ? { type: "resume", filters, minVersion: EXT_VERSION } : { type: "pause" });
  } catch (error) {
    field("status").textContent = error.message;
  }
});

field("stop").addEventListener("click", async () => {
  try {
    await sendToFab({ type: "stop" });
    field("status").textContent = "Stopping after the current item...";
  } catch (error) {
    field("status").textContent = error.message;
  }
});

field("reset").addEventListener("click", async () => {
  try {
    await sendToFab({ type: "stop" });
    await new Promise((resolve) => setTimeout(resolve, 1000));
  } catch {
    // No live run. Just clear.
  }
  await chrome.storage.local.remove([DONE_KEY, PROGRESS_KEY]);
  render(null);
  for (const id of ["countAdded", "countOwned", "countSkipped", "countFailed"]) field(id).textContent = "0";
  field("log").textContent = "Progress cleared.";
});

restoreFilters();
refresh();
refreshDrop();
updateLimitedState();
