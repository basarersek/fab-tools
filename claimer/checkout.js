(() => {
  let expected = null;
  let ready = false;
  let clicked = false;
  let ended = false;
  let loadingReported = false;

  function status(state, message = "") {
    chrome.runtime.sendMessage({ type: "checkoutStatus", state, message }).catch(() => {});
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window || event.origin !== location.origin || event.data?.type !== "fabCheckoutGuard") return;
    if (!expected || ended) return;
    ready = event.data.status === "ready";
    if (event.data.status === "unsafe") ended = true;
    status(event.data.status, event.data.message);
  });

  chrome.runtime.onMessage.addListener((message) => {
    if (message.type !== "cancelCheckout") return;
    ended = true;
    window.postMessage({ type: "fabCheckoutCancel" }, location.origin);
  });

  const visible = (element) => element.getClientRects().length > 0;

  async function start() {
    const answer = await chrome.runtime.sendMessage({ type: "getCheckout" });
    if (!answer?.expected) return;
    expected = answer.expected;
    const url = new URL(location.href);
    if (url.searchParams.get("offers") !== `1-${expected.namespace}-${expected.offerId}--`) {
      status("unsafe", "Checkout contains a different offer.");
      return;
    }
    window.postMessage({ type: "fabCheckoutConfigure", expected }, location.origin);
    const started = Date.now();
    const timer = setInterval(() => {
      if (ended) { clearInterval(timer); return; }
      if (clicked) return;
      if (!ready) {
        if (Date.now() - started <= 20000 || loadingReported) return;
        loadingReported = true;
        status("action", "Checkout is loading. Check the open Fab checkout tab.");
        return;
      }
      const root = document.getElementById("purchase-app-root");
      if (!root) return;
      const agreements = [...root.querySelectorAll('input[type="checkbox"], [role="checkbox"]')].filter(visible);
      if (agreements.length) {
        status("action", "Fab requires your review. Complete the form in the checkout tab.");
        return;
      }
      const buttons = [...root.querySelectorAll("button")].filter((button) =>
        visible(button) && button.textContent.trim().toLowerCase() === "add to library" && !button.disabled);
      if (buttons.length !== 1 || !location.hash.startsWith("#/free-checkout")) return;
      clicked = true;
      status("action", "Confirming the free claim. Complete CAPTCHA in Fab if shown.");
      buttons[0].click();
    }, 500);
  }

  start().catch(() => status("action", "Reload the extension and start the claim again."));
})();
