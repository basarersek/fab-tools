(() => {
  const api = "https://payment-website-pci.ol.epicgames.com/v2/purchase/";
  const requests = new WeakMap();
  const open = XMLHttpRequest.prototype.open;
  const send = XMLHttpRequest.prototype.send;
  let expected = null;
  let order = null;
  let submitted = false;
  let cancelled = false;

  function report(status, message = "") {
    window.postMessage({ type: "fabCheckoutGuard", status, message }, location.origin);
  }

  function publishQuote() {
    if (!expected || !order) return;
    const safe = FabLimited.safeOrder(order, expected);
    report(safe ? "ready" : "unsafe", safe ? "Zero total verified for the selected license." :
      "Checkout must contain only the selected license with zero total and zero payment.");
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window || event.origin !== location.origin) return;
    if (event.data?.type === "fabCheckoutConfigure" && !expected) {
      expected = event.data.expected;
      report("guarded");
      publishQuote();
    }
    if (event.data?.type === "fabCheckoutCancel") cancelled = true;
  });

  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    requests.set(this, new URL(url, location.href).href);
    return open.call(this, method, url, ...rest);
  };

  XMLHttpRequest.prototype.send = function (body) {
    const url = requests.get(this);
    if (url === api + "order-preview") {
      order = null;
      if (expected) report("loading");
      this.addEventListener("load", () => {
        try {
          const data = this.responseType === "json" ? this.response : JSON.parse(this.responseText);
          order = this.status === 200 ? data.orderResponse : null;
          publishQuote();
        } catch {
          if (expected) report("unsafe", "Checkout preview could not be read.");
        }
      }, { once: true });
    }
    if (expected && url === api + "confirm-order") {
      let payload = null;
      try { payload = JSON.parse(body); } catch { /* Invalid requests must not be submitted. */ }
      const safe = !cancelled && !submitted && FabLimited.safeOrder(order, expected) &&
        payload?.totalAmount === 0 && payload.redeemRewardAmount === 0 && payload.canQuickPurchase === true &&
        payload.storePaymentMethod === false && typeof payload.captchaToken === "string" &&
        payload.captchaToken.length > 0 && typeof payload.originatingRequest === "string";
      if (!safe) {
        report("unsafe", "Submission stopped: checkout safety checks failed.");
        throw new Error("Fab Free Claimer stopped an unverified checkout.");
      }
      submitted = true;
      report("confirming");
      this.addEventListener("load", () => {
        try {
          const data = this.responseType === "json" ? this.response : JSON.parse(this.responseText);
          report(data.orderResponse?.orderStatus === "COMPLETED" ? "completed" : "action",
            "Check Fab checkout. Ownership is not yet verified.");
        } catch { report("action", "Check Fab checkout. Ownership is not yet verified."); }
      }, { once: true });
    }
    return send.call(this, body);
  };
})();
