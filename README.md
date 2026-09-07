<p align="center">
  <img src="docs/logo.png" width="96" alt="Fab Free Claimer logo">
</p>

<h1 align="center">Fab Free Claimer</h1>

<p align="center">
  Adds free <a href="https://www.fab.com">Fab</a> listings to your library, with filters.<br>
  Unofficial browser extension for Chrome and Edge.
</p>

<p align="center">
  <img src="docs/claimer-idle.png" width="360" alt="Filters">
  &nbsp;&nbsp;
  <img src="docs/claimer-claiming.png" width="360" alt="Claiming">
</p>

## What it does

- Finds free listings on Fab and adds them to your library, one by one.
- Filters: search text, Quixel Megascans only, listing types, engines, min stars, min rating count, mature content.
- Skips listings you already own. Nothing is added twice.
- Picks the free Professional license when a listing has one, else the free Personal one.
- Works in batches, so adding starts a few seconds after Start.
- Pause, change any setting, Resume. Stop at any time.
- Remembers what it did, so the next run only handles new listings.

## Install

1. Download this repo, or clone it.
2. Open `chrome://extensions` or `edge://extensions`.
3. Turn on **Developer mode** at the top right.
4. Click **Load unpacked** and pick the `claimer` folder.
5. Log in to [fab.com](https://www.fab.com) in the same browser.

## Use

1. Click the extension icon.
2. Set the filters. The defaults get all free Quixel Megascans 3D models.
3. Press **Start**. A fab.com tab opens in the background and does the work. Keep it open.
4. Watch the counts. The log shows every added listing.

Tip: with **Quixel Megascans only** on, leave **Engines** empty. Most Quixel items are FBX and glTF, and only a few carry the Unreal Engine tag.

## Filters

| Filter | Meaning |
| --- | --- |
| Search | Text search on Fab. Optional. |
| Quixel Megascans only | Exact seller match, not a text search. |
| Types | Listing types to include. None checked means all. |
| Engines | Engine tags to include. None checked means all. |
| Min stars | Skip listings with an average rating below this. |
| Min ratings | Skip listings with fewer ratings than this. |
| Hide mature content | Skip listings Fab marks as mature. |

## Advanced

| Setting | Default | Meaning |
| --- | --- | --- |
| Wait | 2 to 4 s | Random wait between two adds. Slower is safer for your account. |
| Pages per batch | 20 | Search pages of 24 listings collected before adding them. |
| Pages fetched at once | 4 | Parallel search page requests. |
| Ownership checks at once | 8 | Parallel checks for listings you already own. |

Each field has a small arrow that restores its default.

## How it works

The extension runs a small script inside your fab.com tab. It calls the same endpoints the Fab site uses, with your own login session. For each listing it first asks Fab if you own it, then reads the listing's licenses and sends one add to library request. Nothing is downloaded. No data leaves your browser.

## Limits and safety

- Fab's terms forbid automated access. Using this may put your account at risk. Use it at your own risk.
- The default wait keeps requests slow. Do not lower it far.
- This project is not affiliated with Epic Games or Fab.

## License

MIT. See [LICENSE](LICENSE). Icons and fonts have their own licenses, see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
