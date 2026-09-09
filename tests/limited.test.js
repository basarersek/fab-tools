import { describe, expect, test } from "bun:test";
import vm from "node:vm";

const shared = await Bun.file(new URL("../claimer/limited.js", import.meta.url)).text();
const guard = await Bun.file(new URL("../claimer/checkout-guard.js", import.meta.url)).text();
const popup = await Bun.file(new URL("../claimer/popup.js", import.meta.url)).text();
const content = await Bun.file(new URL("../claimer/content.js", import.meta.url)).text();
const driver = await Bun.file(new URL("../claimer/checkout.js", import.meta.url)).text();
const uid = "a5077033-9401-4b9b-9b31-031d81140604";
const secondUid = "bf734560-f98b-4e4d-9a6c-e473b910a780";
const expected = { offerId: "a".repeat(32), namespace: "b".repeat(32) };
const now = Date.parse("2026-09-09T12:00:00Z");
const discount = { price: 100, discountedPrice: 0, discountStartDate: "2026-09-08T14:00:00Z", discountEndDate: "2026-09-22T13:59:00Z" };

function library(extra = {}) {
  const context = vm.createContext({ URL, URLSearchParams, AbortSignal, ...extra });
  vm.runInContext(shared, context);
  return context;
}

function promotionHtml(uids = [uid]) {
  const data = { "/i/blades/free_content_blade": {
    uid: "promotion", title: "Current promotion", isLimitedFreeContent: true,
    tiles: uids.map((uid) => ({ listing: { uid, description: `<a href="/listings/${secondUid}">Unrelated bundle</a>` } })),
  } };
  return `<a href="/listings/${secondUid}">Outside promotion</a><script id="js-json-data-prefetched-data" type="application/json">${JSON.stringify(data)}</script>`;
}

function order() {
  return {
    orderStatus: "PREVIEW", canQuickPurchase: true,
    lineOffers: [{ ...expected, quantity: 1, totalPrice: 0 }],
    totalPrice: 0, paymentCurrencyAmount: 0, redeemRewardAmount: 0, paymentItems: [],
    purchaseOrderPriceSummary: {
      purchasePrice: { totalPrice: { amount: 0 } }, orderPrice: { amount: 0 }, paymentAmount: { amount: 0 },
    },
  };
}

describe("current promotion", () => {
  test("ignores unrelated links even inside product descriptions", () => {
    expect(library().FabLimited.parsePromotion(promotionHtml()).uids).toEqual([uid]);
  });
  test("rejects missing or malformed authoritative data", () => {
    const api = library().FabLimited;
    expect(() => api.parsePromotion(`<a href="/listings/${uid}">Free</a>`)).toThrow();
    expect(() => api.parsePromotion(promotionHtml(["invalid"]))).toThrow();
  });
  test("new assets change the promotion identity", () => {
    const api = library().FabLimited;
    expect(api.parsePromotion(promotionHtml()).key).not.toBe(api.parsePromotion(promotionHtml([uid, secondUid])).key);
  });
  test("ownership requires a complete fresh server response", async () => {
    const context = library({ fetch: async () => ({ ok: true, json: async () => [{ uid, acquired: true }] }) });
    expect(await context.FabLimited.owned([uid])).toEqual([uid]);
    await expect(context.FabLimited.owned([uid, secondUid])).rejects.toThrow("verified");
  });
});

describe("license and checkout safety", () => {
  const detail = { licenses: [{ slug: "personal", offerId: "personal" }, { slug: "professional", offerId: "professional" }] };
  test("prefers free Professional and falls back only to free Personal", () => {
    const api = library().FabLimited;
    const prices = { offers: detail.licenses.map((license) => ({ offerId: license.offerId, ...discount })) };
    expect(api.chooseLicense(detail, prices, now).slug).toBe("professional");
    prices.offers[1].discountedPrice = 1;
    expect(api.chooseLicense(detail, prices, now).slug).toBe("personal");
    prices.offers[0].discountedPrice = 1;
    expect(() => api.chooseLicense(detail, prices, now)).toThrow();
  });
  test("rejects missing, future, expired, string and percentage only zero prices", () => {
    const api = library().FabLimited;
    for (const price of [undefined, { price: 100, discountPercentage: 100 },
      { ...discount, discountedPrice: "0" }, { ...discount, discountEndDate: "2026-09-09T12:00:00Z" },
      { ...discount, discountStartDate: "2026-09-10T00:00:00Z" }]) {
      expect(api.freePrice(price, now)).toBe(false);
    }
    expect(api.freePrice({ price: 0 }, now)).toBe(true);
  });
  test("constructs one offer without a token or cart", () => {
    const url = new URL(library().FabLimited.checkoutUrl(expected.offerId, expected.namespace, "UE_MKT"));
    expect(url.searchParams.get("offers")).toBe(`1-${expected.namespace}-${expected.offerId}--`);
    expect(url.searchParams.has("purchaseToken")).toBe(false);
  });
  test("requires zero total, zero payment and the exact single offer", () => {
    const api = library().FabLimited;
    expect(api.safeOrder(order(), expected)).toBe(true);
    const changes = [
      (o) => o.lineOffers.push({ ...o.lineOffers[0] }),
      (o) => o.lineOffers[0].offerId = "wrong",
      (o) => o.lineOffers[0].namespace = "wrong",
      (o) => o.lineOffers[0].quantity = 2,
      (o) => o.totalPrice = 1,
      (o) => o.paymentCurrencyAmount = "0",
      (o) => o.redeemRewardAmount = 1,
      (o) => o.purchaseOrderPriceSummary.paymentAmount.amount = 1,
      (o) => o.purchaseOrderPriceSummary.purchasePrice.totalPrice.amount = 1,
      (o) => o.paymentItems.push({ amount: 1 }),
      (o) => delete o.lineOffers,
    ];
    for (const change of changes) {
      const data = order(); change(data);
      expect(api.safeOrder(data, expected)).toBe(false);
    }
  });
});

function guardHarness() {
  const listeners = [];
  const sent = [];
  const reports = [];
  class Xhr {
    listeners = [];
    open(method, url) { this.url = url; }
    send(body) { sent.push({ url: this.url, body }); }
    addEventListener(type, fn) { this.listeners.push(fn); }
    respond(data) {
      this.status = 200; this.responseText = JSON.stringify(data);
      for (const fn of this.listeners) fn();
    }
  }
  const window = {
    addEventListener(type, fn) { listeners.push(fn); },
    postMessage(data) {
      reports.push(data);
      for (const fn of listeners) fn({ source: window, origin: "https://www.fab.com", data });
    },
  };
  const context = library({ window, XMLHttpRequest: Xhr, location: { origin: "https://www.fab.com", href: "https://www.fab.com/payment/web/purchase" } });
  vm.runInContext(guard, context);
  window.postMessage({ type: "fabCheckoutConfigure", expected });
  const request = (path, data) => {
    const xhr = new Xhr(); xhr.open("POST", `https://payment-website-pci.ol.epicgames.com/v2/purchase/${path}`);
    xhr.send(JSON.stringify(data)); return xhr;
  };
  return { request, sent, reports, window };
}

describe("submission guard", () => {
  const payload = { totalAmount: 0, redeemRewardAmount: 0, canQuickPurchase: true, storePaymentMethod: false,
    captchaToken: "test response from official checkout", originatingRequest: "test checkout" };
  test("blocks before a quote, paid payloads, saving payment methods and repeat submission", () => {
    const h = guardHarness();
    expect(() => h.request("confirm-order", payload)).toThrow();
    h.request("order-preview", {}).respond({ orderResponse: order() });
    expect(() => h.request("confirm-order", { ...payload, totalAmount: 1 })).toThrow();
    expect(() => h.request("confirm-order", { ...payload, storePaymentMethod: true })).toThrow();
    expect(() => h.request("confirm-order", { ...payload, captchaToken: "" })).toThrow();
    h.request("confirm-order", payload);
    expect(() => h.request("confirm-order", payload)).toThrow();
    expect(h.sent.filter((r) => r.url.endsWith("confirm-order"))).toHaveLength(1);
  });
  test("invalidates a quote during refresh and blocks after stop", () => {
    const h = guardHarness();
    h.request("order-preview", {}).respond({ orderResponse: order() });
    const refreshing = h.request("order-preview", {});
    expect(() => h.request("confirm-order", payload)).toThrow();
    refreshing.respond({ orderResponse: order() });
    h.window.postMessage({ type: "fabCheckoutCancel" });
    expect(() => h.request("confirm-order", payload)).toThrow();
  });
  test("does not transmit tokens or credentials through status messages", () => {
    const h = guardHarness();
    h.request("order-preview", {}).respond({ orderResponse: { ...order(), identityId: "private" } });
    h.request("confirm-order", payload);
    expect(JSON.stringify(h.reports)).not.toContain(payload.captchaToken);
    expect(JSON.stringify(h.reports)).not.toContain("private");
  });
});

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
function deferred() { let resolve; const promise = new Promise((done) => resolve = done); return { resolve, promise }; }

async function popupHarness() {
  const fields = new Map();
  const field = (id) => {
    if (!fields.has(id)) fields.set(id, { value: "", textContent: "", disabled: false, checked: false, style: {}, dataset: {},
      addEventListener() {}, setAttribute() {}, classList: { toggle() {} } });
    return fields.get(id);
  };
  const context = vm.createContext({ console, setTimeout, clearTimeout, setInterval, clearInterval,
    document: { getElementById: field, querySelectorAll: () => [], body: { dataset: {} } },
    FabLimited: { promotion: async () => ({ uids: [uid] }), owned: async () => [] },
    chrome: { runtime: { getManifest: () => ({ version: "1.5.0" }), sendMessage: async () => ({ when: 0 }) },
      scripting: { executeScript: async () => {} },
      tabs: { query: async () => [{ id: 1, url: "https://www.fab.com/" }], sendMessage: async () => ({ ok: true, running: false, revision: 2 }) },
      storage: { local: { get: async () => ({}), set: async () => {} }, onChanged: { addListener() {} } } },
  });
  vm.runInContext(popup, context);
  await settle();
  return { context, field, run: (code) => vm.runInContext(code, context) };
}

describe("limited claim button", () => {
  test("disables synchronously and cannot be unlocked by an older ownership check", async () => {
    const h = await popupHarness();
    const oldCheck = deferred(); const saving = deferred();
    h.context.FabLimited.promotion = () => oldCheck.promise;
    const checking = h.run("updateLimitedState()");
    h.context.chrome.storage.local.set = () => saving.promise;
    const starting = h.run("startClaim('limited')");
    expect(h.field("claimLimited").disabled).toBe(true);
    oldCheck.resolve({ uids: [uid] }); await checking;
    expect(h.field("claimLimited").disabled).toBe(true);
    saving.resolve(); await starting;
    expect(h.field("claimLimited").disabled).toBe(true);
  });
  test("locks when all current assets are owned and unlocks for a new promotion", async () => {
    const h = await popupHarness();
    h.context.FabLimited.owned = async () => [uid];
    await h.run("updateLimitedState()");
    expect(h.field("claimLimited").disabled).toBe(true);
    h.context.FabLimited.promotion = async () => ({ uids: [uid, secondUid] });
    await h.run("updateLimitedState()");
    expect(h.field("claimLimited").disabled).toBe(false);
  });
  test("shows a start failure and allows retry", async () => {
    const h = await popupHarness();
    h.context.chrome.storage.local.set = async () => { throw new Error("Storage unavailable"); };
    await h.run("startClaim('limited')");
    expect(h.field("claimLimited").disabled).toBe(false);
    expect(h.field("status").textContent).toBe("Storage unavailable");
  });
  test("stays disabled after a verified complete run while the next check is pending", async () => {
    const h = await popupHarness();
    const checking = deferred();
    h.context.FabLimited.promotion = () => checking.promise;
    h.run("render({mode:'limited',running:false,phase:'finished',found:3,index:3,added:1,owned:2,skipped:0,failed:0,log:[]})");
    expect(h.field("claimLimited").disabled).toBe(true);
    checking.resolve({ uids: [] });
    await settle();
  });
});

test("limited claims never trust saved success and verify ownership after checkout", async () => {
  const storage = { fabClaimDone: [uid] };
  let ownershipCalls = 0; let opens = 0;
  const context = vm.createContext({ console, setTimeout: (fn) => { fn(); }, URLSearchParams,
    document: { getElementById: () => ({ textContent: JSON.stringify({ epicFabLiveNamespace: expected.namespace, epicFabMerchantGroup: "UE_MKT" }) }) },
    FabLimited: { promotion: async () => ({ key: "current", uids: [uid] }),
      owned: async () => ++ownershipCalls >= 3 ? [uid] : [],
      request: async (path) => ({ json: async () => path.endsWith("prices-infos") ? {} : { title: "Test item" } }),
      chooseLicense: () => ({ offerId: expected.offerId, name: "Professional" }) },
    chrome: { runtime: { onMessage: { addListener() {} }, sendMessage: async (message) => {
      if (message.type === "openCheckout") { opens++; return { tabId: 2 }; }
      if (message.type === "readCheckout") return { state: "completed" };
      return { ok: true };
    } }, storage: { local: { get: async (key) => ({ [key]: storage[key] }), set: async (data) => Object.assign(storage, structuredClone(data)) } } },
  });
  vm.runInContext(content, context);
  await vm.runInContext("claimLimitedList()", context);
  expect(opens).toBe(1);
  expect(ownershipCalls).toBe(3);
  expect(vm.runInContext("progress.added", context)).toBe(1);
});

test("checkout driver waits for a safe quote and leaves agreement controls to the user", async () => {
  const listeners = [];
  let tick; let clicks = 0; let agreements = [];
  const button = { textContent: "Add to library", disabled: false, getClientRects: () => [1], click: () => clicks++ };
  const window = { addEventListener: (type, fn) => listeners.push(fn), postMessage() {} };
  const context = vm.createContext({ window, URL, Date,
    location: { origin: "https://www.fab.com", href: `https://www.fab.com/payment/web/purchase?offers=1-${expected.namespace}-${expected.offerId}--`, hash: "#/free-checkout" },
    document: { getElementById: () => ({ querySelectorAll: (selector) => selector === "button" ? [button] : agreements }) },
    setInterval: (fn) => { tick = fn; }, clearInterval() {},
    chrome: { runtime: { onMessage: { addListener() {} }, sendMessage: async (message) =>
      message.type === "getCheckout" ? { expected } : { ok: true } } },
  });
  vm.runInContext(driver, context); await settle();
  tick(); expect(clicks).toBe(0);
  for (const fn of listeners) fn({ source: window, origin: "https://www.fab.com", data: { type: "fabCheckoutGuard", status: "ready" } });
  agreements = [{ getClientRects: () => [1] }]; tick(); expect(clicks).toBe(0);
  agreements = []; tick(); tick(); expect(clicks).toBe(1);
});
