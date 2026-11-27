// LIVE Fest rank probe
// Connects to a TikTok LIVE through TikTool's WebSocket API (https://tik.tools) and records every
// event type it receives, so we can find which (if any) carries the LIVE Fest rank and points.
// Run it while the stream is live.
//
// Setup:  put your free TikTool API key in a file called tiktool-key.txt next to this script
// Usage:  node rank-probe.mjs <tiktok_username> [minutes]
// Output: a live summary in the console, and probe-log.jsonl with the full content of
//         every event that looks rank-, points- or campaign-related.
// Requires Node.js 22 or newer (built-in WebSocket).

import fs from 'node:fs';

const username = (process.argv[2] || '').replace(/^@/, '').trim();
const minutes = Number(process.argv[3]) || 15;
if (!username) {
  console.error('Usage: node rank-probe.mjs <tiktok_username> [minutes]');
  process.exit(1);
}

const keyFile = new URL('./tiktool-key.txt', import.meta.url);
const apiKey = (process.env.TIKTOOL_API_KEY || (fs.existsSync(keyFile) ? fs.readFileSync(keyFile, 'utf8') : '')).trim();
if (!apiKey) {
  console.error('No TikTool API key found.');
  console.error('Get a free key at https://tik.tools, then save it in tiktool-key.txt in this folder.');
  process.exit(1);
}

if (typeof WebSocket === 'undefined') {
  console.error(`Node.js ${process.version} has no built-in WebSocket. Install Node.js 22 LTS or newer from https://nodejs.org`);
  process.exit(1);
}

const log = fs.createWriteStream(new URL('./probe-log.jsonl', import.meta.url), { flags: 'w' });

// Event types that are never rank data and are very noisy.
const SKIP_DUMP = /^(chat|like|member|social|emote|roomUser)$/i;
// Types or content worth keeping in full.
const INTERESTING_TYPE = /rank|banner|campaign|activity|fest|notice|toast|bottom|barrage|capsule|guide|goal|pin|room|hourly|panel|board|task|mission/i;
const INTERESTING_TEXT = /fest|rank|points away|leaderboard|campaign|power league|#\d{1,4}\b/i;

const counts = new Map();
let dumped = 0;
let finished = false;

const url = `wss://api.tik.tools?uniqueId=${encodeURIComponent(username)}&apiKey=${encodeURIComponent(apiKey)}`;
console.log(`Connecting to @${username}'s LIVE via TikTool...`);
const ws = new WebSocket(url);

ws.addEventListener('open', () => {
  console.log(`Connected. Listening for ${minutes} minutes (Ctrl+C to stop early).`);
  console.log('Tip: ask a viewer to send a FEST gift or vote while this runs.\n');
  setTimeout(stop, minutes * 60 * 1000);
});

ws.addEventListener('message', (msg) => {
  let parsed;
  try { parsed = JSON.parse(typeof msg.data === 'string' ? msg.data : msg.data.toString()); } catch { return; }
  const type = String(parsed.event ?? parsed.type ?? 'unknown');
  counts.set(type, (counts.get(type) || 0) + 1);

  if (/^(error|disconnected|streamEnd)$/i.test(type)) {
    console.log(`[${type}]`, JSON.stringify(parsed.data ?? parsed).slice(0, 300));
  }
  if (SKIP_DUMP.test(type)) return;

  const json = JSON.stringify(parsed);
  if (INTERESTING_TYPE.test(type) || INTERESTING_TEXT.test(json)) {
    log.write(JSON.stringify({ time: new Date().toISOString(), type, message: parsed }) + '\n');
    dumped++;
    const hint = (json.match(/[^"]{0,60}(fest|rank|points away|#\d{1,4})[^"]{0,60}/i) || [])[0];
    console.log(`[${new Date().toLocaleTimeString()}] ${type}${hint ? `  ->  ${hint}` : ''}`);
  }
});

ws.addEventListener('error', () => console.error('WebSocket error. Check the username, that you are live, and that the API key is valid.'));
ws.addEventListener('close', (e) => {
  if (!finished) {
    console.log(`Connection closed (code ${e.code}${e.reason ? `: ${e.reason}` : ''}).`);
    stop();
  }
});

function stop() {
  if (finished) return;
  finished = true;
  console.log('\n===== Event types seen =====');
  [...counts.entries()].sort((a, b) => b[1] - a[1]).forEach(([t, n]) => console.log(`${String(n).padStart(6)}  ${t}`));
  console.log(`\n${dumped} interesting events saved to probe-log.jsonl`);
  console.log('Send probe-log.jsonl to Claude to check for the LIVE Fest rank.');
  try { ws.close(); } catch {}
  log.end(() => process.exit(0));
}

process.on('SIGINT', stop);
