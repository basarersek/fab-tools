# Limited claims

## Verified checkout

Observed in Chrome on September 9, 2026.

The promotion page contains `js-json-data-prefetched-data`. Its `/i/blades/free_content_blade` entry lists the current assets in `tiles[].listing`. Links in descriptions are not promotion members.

Fab supplies license offer IDs in `/i/listings/{uid}`. The product page refreshes prices through `/i/listings/{uid}/prices-infos`. Select free Professional first, then free Personal. A discount percentage alone is not enough.

The page configuration supplies `epicFabLiveNamespace` and `epicFabMerchantGroup`. Fab opens `/payment/web/purchase` with `offers=1-{namespace}-{offerId}--`, `merchantGroup=UE_MKT`, and `salesChannel=Windows-Store-FabWeb`.

The checkout document supplies a fresh `purchaseToken` input. Fab handles this token and CAPTCHA. The extension does not save or reuse either value.

The checkout requests `/v2/purchase/initialize`, then `/v2/purchase/order-preview` from `payment-website-pci.ol.epicgames.com`. The observed preview has one Professional offer, zero total, zero payment, and no payment items.

The extension waits for that preview. It clicks the official free checkout button only after the selected offer and zero amounts pass checks. The submission guard checks `/v2/purchase/confirm-order` again. It rejects nonzero amounts, reward spending, saved payment methods, missing CAPTCHA results, and duplicate submissions. Any agreement controls require user action.

Success requires a fresh `/i/users/me/listings-states?listing_ids={uid}` response with `acquired: true`. A completed checkout response or an old saved success is not enough.

## Local checks

From `C:\Users\DevUser\fab-tools`, run `bun test tests/limited.test.js`.

The checks cover promotion membership, new promotions, current free prices, license choice, unsafe orders, submission guards, button races, and ownership verification. No build is required.

## Live result

The limited claim run changed RPG Crafting and Environment VFX from `acquired: false` to `acquired: true`. The other two current assets were already owned. Fab reported all three as owned after the run. The user confirmed that the popup showed “Limited free claimed” with its button disabled.

The last button changes also prevent a brief enabled state during startup and after completion. Reload the extension and Fab to load these last changes.

The fix ships in Fab Free Claimer 1.5.1. Fab Owned Library remains at 1.4.0. Release archives contain the extension files without a build step.
