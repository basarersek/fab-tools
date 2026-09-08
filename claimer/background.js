// Watches fab.com/limited-time-free and shows a Chrome notice when new items appear.
// Runs on its own in the service worker, no fab.com tab needed.

const LIMITED_PAGE = "https://www.fab.com/limited-time-free";
const FILTERS_KEY = "fabClaimFilters";
const SEEN_KEY = "fabLimitedSeen";
const DROP_KEY = "fabLimitedDropAt";
const DROP_ALARM = "fab-limited-drop";
const POLL_ALARM = "fab-limited-check";
const BADGE_ALARM = "fab-badge-tick";
const BADGE_MINUTES = 15;
const SAFETY_MINUTES = 1440;
const DROP_GRACE_MS = 5 * 60 * 1000;
const UID_PATTERN = /\/listings\/([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})/g;
const DROP_PATTERN = /Until\s+([A-Za-z]+)\s+(\d{1,2})(?:,?\s*(\d{4}))?\s+at\s+(\d{1,2}):(\d{2})\s*(AM|PM)\s*ET/i;
const MONTHS = {
  january: 0, february: 1, march: 2, april: 3, may: 4, june: 5,
  july: 6, august: 7, september: 8, october: 9, november: 10, december: 11,
};

async function fetchPageHtml() {
  try {
    const res = await fetch(LIMITED_PAGE, { credentials: "include" });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}

async function collectUids() {
  const html = await fetchPageHtml();
  if (!html) return null;
  const uids = new Set();
  let match;
  while ((match = UID_PATTERN.exec(html)) !== null) uids.add(match[1].toLowerCase());
  return [...uids];
}

async function fetchTitle(uid) {
  try {
    const res = await fetch(`https://www.fab.com/i/listings/${uid}`, {
      credentials: "include",
      headers: { "X-Requested-With": "XMLHttpRequest" },
    });
    if (!res.ok) return uid.slice(0, 8);
    return (await res.json()).title || uid.slice(0, 8);
  } catch {
    return uid.slice(0, 8);
  }
}

async function check(seedOnly) {
  const stored = await chrome.storage.local.get([SEEN_KEY, FILTERS_KEY]);
  if (stored[FILTERS_KEY]?.watchLimited === false) return;
  const uids = await collectUids();
  if (!uids) return;
  const seen = new Set(stored[SEEN_KEY] || []);
  const fresh = uids.filter((uid) => !seen.has(uid));
  await chrome.storage.local.set({ [SEEN_KEY]: uids });
  if (seedOnly || !stored[SEEN_KEY] || !fresh.length) return;
  const titles = [];
  for (const uid of fresh.slice(0, 10)) titles.push(await fetchTitle(uid));
  const extra = fresh.length > titles.length ? ` +${fresh.length - titles.length} more` : "";
  await chrome.notifications.create({
    type: "basic",
    iconUrl: "icons/icon128.png",
    title: `Fab: ${fresh.length} new limited time free`,
    message: titles.join("\n") + extra,
    contextMessage: "Click to open the page",
  });
}

// The page names its own end date, so the watch sets one exact timer
// for just after the drop instead of polling often.
function easternToUtcMs(year, month, day, hour, minute) {
  const guess = Date.UTC(year, month, day, hour, minute);
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York", hour12: false,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
  let utc = guess;
  for (let i = 0; i < 3; i++) {
    const parts = {};
    for (const part of fmt.formatToParts(new Date(utc))) parts[part.type] = part.value;
    const asUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour % 24, +parts.minute, +parts.second);
    utc = guess + (guess - asUtc);
  }
  return utc;
}

function parseDropUtc(html) {
  const m = html.match(DROP_PATTERN);
  if (!m) return null;
  const month = MONTHS[m[1].toLowerCase()];
  if (month === undefined) return null;
  let hour = +m[4] % 12;
  if (m[6].toUpperCase() === "PM") hour += 12;
  const year = m[3] ? +m[3] : new Date().getFullYear();
  let utc = easternToUtcMs(year, month, +m[2], hour, +m[5]);
  if (!m[3] && utc < Date.now()) utc = easternToUtcMs(year + 1, month, +m[2], hour, +m[5]);
  return utc;
}

async function ensureScheduled() {
  await updateBadge();
  const stored = await chrome.storage.local.get(FILTERS_KEY);
  if (stored[FILTERS_KEY]?.watchLimited === false) return;
  const html = await fetchPageHtml();
  if (!html) return;
  await chrome.alarms.clear(DROP_ALARM);
  const when = parseDropUtc(html);
  await chrome.storage.local.set({ [DROP_KEY]: when && when > Date.now() ? when : 0 });
  if (when && when > Date.now()) {
    await chrome.alarms.create(DROP_ALARM, { when: when + DROP_GRACE_MS });
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "getDrop") {
    ensureScheduled().then(async () => {
      const stored = await chrome.storage.local.get(DROP_KEY);
      sendResponse({ when: stored[DROP_KEY] || 0 });
    });
    return true;
  }
});

// Short countdown on the toolbar icon itself, refreshed every few minutes.
async function updateBadge() {
  try {
    const stored = await chrome.storage.local.get([DROP_KEY, FILTERS_KEY]);
    if (stored[FILTERS_KEY]?.watchLimited === false) {
      await chrome.action.setBadgeText({ text: "" });
      return;
    }
    const ms = (stored[DROP_KEY] || 0) - Date.now();
    let text = "";
    if (ms > 0) {
      if (ms >= 86400000) text = `${Math.floor(ms / 86400000)}d`;
      else if (ms >= 3600000) text = `${Math.floor(ms / 3600000)}h`;
      else text = `${Math.max(1, Math.floor(ms / 60000))}m`;
    }
    await chrome.action.setBadgeBackgroundColor({ color: "#1d4ed8" });
    await chrome.action.setBadgeText({ text });
  } catch {
    // Action API unavailable, ignore.
  }
}

chrome.runtime.onInstalled.addListener(async () => {
  await chrome.alarms.create(POLL_ALARM, { periodInMinutes: SAFETY_MINUTES });
  await chrome.alarms.create(BADGE_ALARM, { periodInMinutes: BADGE_MINUTES });
  await check(true);
  await ensureScheduled();
});

chrome.runtime.onStartup.addListener(async () => {
  await check(false);
  await ensureScheduled();
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === BADGE_ALARM) {
    await updateBadge();
    return;
  }
  if (alarm.name !== DROP_ALARM && alarm.name !== POLL_ALARM) return;
  await check(false);
  await ensureScheduled();
});

chrome.notifications.onClicked.addListener(() => {
  chrome.tabs.create({ url: LIMITED_PAGE });
});
