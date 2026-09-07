// The toolbar button opens the library page in a tab, or focuses the open one.

const LIBRARY_URL = chrome.runtime.getURL("library.html");

chrome.action.onClicked.addListener(async () => {
  const [existing] = await chrome.tabs.query({ url: LIBRARY_URL }).catch(() => []);
  if (existing) {
    await chrome.tabs.update(existing.id, { active: true });
    await chrome.windows.update(existing.windowId, { focused: true });
    return;
  }
  await chrome.tabs.create({ url: LIBRARY_URL });
});
