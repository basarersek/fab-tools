var FabLimited = (() => {
  const origin = "https://www.fab.com";
  const uidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  function readPageData(html, id) {
    const scripts = html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi);
    for (const [, attributes, body] of scripts) {
      if (new RegExp(`\\bid=["']${id}["']`).test(attributes)) return JSON.parse(body);
    }
    throw new Error("Fab page data is missing. Reload Fab and try again.");
  }

  function parsePromotion(html) {
    const data = readPageData(html, "js-json-data-prefetched-data");
    const blade = data["/i/blades/free_content_blade"];
    if (blade?.isLimitedFreeContent !== true || !Array.isArray(blade.tiles)) {
      throw new Error("Fab did not return its current promotion list.");
    }
    const uids = blade.tiles.map((tile) => tile.listing?.uid);
    if (uids.some((uid) => typeof uid !== "string" || !uidPattern.test(uid))) {
      throw new Error("Fab returned an invalid promotion listing.");
    }
    const unique = [...new Set(uids.map((uid) => uid.toLowerCase()))].sort();
    return { uids: unique, key: JSON.stringify([blade.uid, blade.title, unique]) };
  }

  async function request(path) {
    const response = await fetch(origin + path, {
      credentials: "include", cache: "no-store", signal: AbortSignal.timeout(20000),
      headers: { "X-Requested-With": "XMLHttpRequest" },
    });
    if (!response.ok) throw new Error(`Fab answered ${response.status}. Reload Fab and check your sign in.`);
    return response;
  }

  async function promotion() {
    return parsePromotion(await (await request("/limited-time-free")).text());
  }

  async function owned(uids) {
    if (!uids.length) return [];
    const query = new URLSearchParams();
    for (const uid of uids) query.append("listing_ids", uid);
    const states = await (await request(`/i/users/me/listings-states?${query}`)).json();
    if (!Array.isArray(states)) throw new Error("Fab ownership response is missing.");
    return uids.filter((uid) => {
      const matches = states.filter((state) => state.uid === uid);
      if (matches.length !== 1 || typeof matches[0].acquired !== "boolean") {
        throw new Error("Fab ownership could not be verified.");
      }
      return matches[0].acquired;
    });
  }

  function freePrice(price, now = Date.now()) {
    if (price?.price === 0) return true;
    return price?.discountedPrice === 0 &&
      Date.parse(price.discountStartDate) <= now && Date.parse(price.discountEndDate) > now;
  }

  function chooseLicense(detail, prices, now = Date.now()) {
    for (const slug of ["professional", "personal"]) {
      const license = detail.licenses?.find((item) => item.slug === slug);
      const price = prices.offers?.find((item) => item.offerId === license?.offerId);
      if (license?.offerId && freePrice(price, now)) return { ...license, price };
    }
    throw new Error("Neither Professional nor Personal has a current zero price.");
  }

  function checkoutUrl(offerId, namespace, merchantGroup) {
    if (!/^[0-9a-f]{32}$/i.test(offerId) || !/^[0-9a-f]{32}$/i.test(namespace) || merchantGroup !== "UE_MKT") {
      throw new Error("Fab checkout identifiers are invalid.");
    }
    const query = new URLSearchParams({
      highlightColor: "26bbff", lang: "en", merchantGroup,
      offers: `1-${namespace}-${offerId}--`, salesChannel: "Windows-Store-FabWeb", showNavigation: "true",
    });
    return `${origin}/payment/web/purchase?${query}`;
  }

  function safeOrder(order, expected) {
    const line = order?.lineOffers?.[0];
    const summary = order?.purchaseOrderPriceSummary;
    return order?.orderStatus === "PREVIEW" && order.canQuickPurchase === true &&
      Array.isArray(order.lineOffers) && order.lineOffers.length === 1 && line?.offerId === expected.offerId &&
      line.namespace === expected.namespace && line.quantity === 1 && line.totalPrice === 0 &&
      order.totalPrice === 0 && order.paymentCurrencyAmount === 0 && order.redeemRewardAmount === 0 &&
      summary?.purchasePrice?.totalPrice?.amount === 0 && summary.orderPrice?.amount === 0 &&
      summary.paymentAmount?.amount === 0 && Array.isArray(order.paymentItems) && order.paymentItems.length === 0;
  }

  return { readPageData, parsePromotion, request, promotion, owned, freePrice, chooseLicense, checkoutUrl, safeOrder };
})();
