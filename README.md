# Stream Overlays

Overlays for TikTok LIVE Studio and OBS.

## Overlays

| Overlay | File | Size |
|---|---|---|
| LIVE Fest 2026 gift banner | `livefest-banner.html` | 1080 × 380 |
| LIVE Fest next target | `next-target.html` | 760 × 200 |
| League progress | `league-pill.html` | 760 × 200 |
| Battle boosts and power-ups | `battle-boost.html` | 760 × 260 |

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

## Live bridge (your own TikTok LIVE feed)

`live-bridge.mjs` gives the banner live LIVE Fest points without any third-party service or API key.
It opens your TikTok LIVE page in its own Chrome window, so Chrome does TikTok's request signing itself,
then decodes the live data Chrome receives and pushes it to the overlays.

Requires Node.js 22+ and Google Chrome (or Microsoft Edge).

1. Double-click `start-live.bat`. The first run installs dependencies and asks for your TikTok username.
2. A Chrome window opens on your LIVE page. Log in there if TikTok asks (it remembers you). Leave it open; the video is blocked to save bandwidth.
3. Open `http://localhost:3000/control`, enter your points, points needed and rank from the LIVE Fest screen, and click **Sync to banner**.
4. In TikTok LIVE Studio use `http://localhost:3000/livefest-banner.html` as the Link source (1080 × 380).

**Euler Stream mode (recommended if the Chrome window gets no data):** create a free Community account at
https://www.eulerstream.com, copy your API key into a file called `euler-key.txt` in this folder (or the
`eulerApiKey` field in `config.json`), and restart `start-live.bat`. With a key set, the bridge connects through
Euler instead of opening Chrome. The key file is ignored by git.

**Battle boosts:** the bridge spots x2/x3 battle challenges from TikTok's battle task messages and tracks
challenge → progress → success/fail → active boost window → ended. It shows on the control page and is sent to
overlays as `boost` events. Which side earned it is a best guess (`sideVerified: false`).

**Recording and replay:** every stream is recorded to `sessions/` (private, ignored by git). Double-click
`replay-last.bat` to replay the latest stream at 5x speed and test overlays without going live, or run
`node live-bridge.mjs --replay sessions/<file> --speed 2`. Set `"record": false` in `config.json` to turn recording off.

Points are counted as FEST gifts × 2 per coin and other gifts × 1 per coin, added to the synced total.
Votes are not included, so sync from the app now and then. Messages that might contain rank information
are saved to `bridge-log.jsonl`, and the control page flags any it spots.

Private files (`config.json`, `bridge-log.jsonl`, `browser-profile/`) stay on your PC and are ignored by git.
The bridge uses TikTok's website the way a viewer does; it is unofficial and may need updating if TikTok changes its site.

## LIVE Fest rank probe

Finds out whether TikTok's live event feed includes your LIVE Fest rank. It connects through
[TikTool](https://tik.tools)'s WebSocket API, which has a free tier. Requires Node.js 22 or newer.

1. Get a free API key at https://tik.tools
2. While you are live, double-click `run-rank-probe.bat`. The first run asks for the key and saves it to
   `tiktool-key.txt` (ignored by git, so it is never uploaded).
3. Enter your TikTok username. The probe listens for 15 minutes, prints anything rank-related as it arrives,
   and saves the details to `probe-log.jsonl`.

## Updates

The banner checks `version.txt` every minute and reloads itself when it changes, so updates appear on stream within a few minutes without touching LIVE Studio. Bump `version.txt` with every change to the banner.
