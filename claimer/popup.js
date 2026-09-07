const PROGRESS_KEY = "fabClaimProgress";
const DONE_KEY = "fabClaimDone";
const FILTERS_KEY = "fabClaimFilters";
const FAB_URL = "https://www.fab.com/";
const CONTENT_SCRIPT_RETRIES = 10;

const fieldIds = [
  "query", "quixelOnly", "minRating", "minRatingCount", "hideMature",
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

// No answer means a fresh tab, or a tab left over from before an extension reload.
async function sendToFab(message) {
  const tab = await getFabTab();
  for (let attempt = 1; attempt <= CONTENT_SCRIPT_RETRIES; attempt++) {
    try {
      return await chrome.tabs.sendMessage(tab.id, message);
    } catch {
      await injectContentScript(tab.id);
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  throw new Error("No answer from the fab.com tab. Reload it and try again.");
}

// ---------- progress display ----------

const iconByPhase = { collecting: "busy", claiming: "busy" };

function setPhase(phase) {
  const label = phase[0].toUpperCase() + phase.slice(1);
  field("phase").dataset.tip = label;
  field("phase").setAttribute("aria-label", label);
  field("phaseIcon").setAttribute("href", `#s-${iconByPhase[phase] || phase}`);
  document.body.dataset.phase = phase;
}

function render(progress) {
  const startButton = field("start");
  const pauseButton = field("pauseResume");
  if (!progress) {
    setPhase("idle");
    field("status").textContent = "Ready";
    field("barFill").style.width = "0";
    startButton.disabled = false;
    pauseButton.disabled = true;
    field("stop").disabled = true;
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

  startButton.disabled = progress.running;
  pauseButton.disabled = !progress.running;
  field("stop").disabled = !progress.running;
  pauseButton.textContent = progress.phase === "paused" ? "Resume" : "Pause";

  const logBox = field("log");
  logBox.textContent = progress.log.join("\n");
  logBox.scrollTop = logBox.scrollHeight;
}

async function refresh() {
  const stored = await chrome.storage.local.get(PROGRESS_KEY);
  render(stored[PROGRESS_KEY]);
}

chrome.storage.onChanged.addListener((changes) => {
  if (changes[PROGRESS_KEY]) render(changes[PROGRESS_KEY].newValue);
});

// ---------- buttons ----------

field("filters").addEventListener("submit", async (event) => {
  event.preventDefault();
  const filters = readFilters();
  if (filters.paceMaxSec < filters.paceMinSec) filters.paceMaxSec = filters.paceMinSec;
  await chrome.storage.local.set({ [FILTERS_KEY]: filters });
  try {
    const answer = await sendToFab({ type: "start", filters });
    if (!answer.ok) field("status").textContent = answer.error;
  } catch (error) {
    field("status").textContent = error.message;
  }
});

// Resume sends the current form values so changed settings take effect.
field("pauseResume").addEventListener("click", async () => {
  const resuming = field("pauseResume").textContent === "Resume";
  const filters = readFilters();
  if (filters.paceMaxSec < filters.paceMinSec) filters.paceMaxSec = filters.paceMinSec;
  await chrome.storage.local.set({ [FILTERS_KEY]: filters });
  try {
    await sendToFab(resuming ? { type: "resume", filters } : { type: "pause" });
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
  await chrome.storage.local.remove([DONE_KEY, PROGRESS_KEY]);
  render(null);
  for (const id of ["countAdded", "countOwned", "countSkipped", "countFailed"]) field(id).textContent = "0";
  field("log").textContent = "Progress cleared.";
});

restoreFilters();
refresh();
