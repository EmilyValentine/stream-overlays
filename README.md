# Stream Overlays

Overlays for TikTok LIVE Studio and OBS.

## Overlays

| Overlay | File | Size |
|---|---|---|
| LIVE Fest 2026 gift banner | `livefest-banner.html` | 1080 × 380 |

## Use the hosted link (GitHub Pages)

Paste this into TikTok LIVE Studio → **Add source → Link**:

```
https://emilyvalentine.github.io/stream-overlays/livefest-banner.html
```

## Run it locally

Requires [Node.js](https://nodejs.org) 18 or newer. No packages to install.

- Windows: double-click `start-overlays.bat`
- Or from a terminal in this folder: `npm start`

Then use:

```
http://localhost:3000/livefest-banner.html
```

Keep the server window open while streaming. Open `http://localhost:3000/` for a preview page with all overlay links.

## Banner settings

Add these to the end of the link, for example `livefest-banner.html?points=849&goal=5040`.

| Setting | What it does | Default |
|---|---|---|
| `points` | Current LIVE Fest points (shows progress on the bar) | none |
| `goal` | Points needed to reach the advancing rank | none |
| `round` | Power League round number | `2` |
| `top` | Rank needed to advance | `200` |
| `next` | Label for the next round | `Round 3` |
| `ends` | Round end text | `Dec 1` |
| `handle` | Team name | `CuddleMeXO` |
| `mult` | FEST gift points per coin | `2` |
| `speed` | Seconds each gift is shown | `4` |
| `bg` | `transparent`, `green` or `dark` | `transparent` |

## LIVE Fest rank probe

Finds out whether TikTok's live event feed includes your LIVE Fest rank. Run it while you are live:

- Windows: double-click `run-rank-probe.bat` and enter your TikTok username
- Or: `npm install` then `npm run probe -- <username> 15`

It listens for 15 minutes, prints anything rank-related as it arrives, and saves the details to `probe-log.jsonl`.
The probe uses the unofficial `tiktok-live-connector` library; set `EULER_API_KEY` if the free signing tier is rate-limited.
