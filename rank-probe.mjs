// LIVE Fest rank probe
// Connects to a TikTok LIVE and records every message type it receives, so we can find
// which (if any) carries the LIVE Fest rank and points. Run it while the stream is live.
//
// Usage:  node rank-probe.mjs <tiktok_username> [minutes]
// Output: a live summary in the console, and probe-log.jsonl with the full content of
//         every message that looks rank-, points- or campaign-related.

import { TikTokLiveConnection, ControlEvent } from 'tiktok-live-connector';
import fs from 'node:fs';

const username = (process.argv[2] || '').replace(/^@/, '');
const minutes = Number(process.argv[3]) || 15;
if (!username) {
  console.error('Usage: node rank-probe.mjs <tiktok_username> [minutes]');
  process.exit(1);
}

const LOG_FILE = new URL('./probe-log.jsonl', import.meta.url);
const log = fs.createWriteStream(LOG_FILE, { flags: 'w' });

// Message types that are never rank data and are very noisy.
const SKIP_DUMP = /^(WebcastChatMessage|WebcastLikeMessage|WebcastMemberMessage|WebcastSocialMessage|WebcastEmoteChatMessage)$/;
// Types or content worth keeping in full.
const INTERESTING_TYPE = /rank|banner|campaign|activity|fest|notice|toast|bottom|barrage|capsule|guide|goal|pin|room|hourly|panel/i;
const INTERESTING_TEXT = /fest|rank|points away|leaderboard|campaign|power league|#\d{1,4}\b/i;

const counts = new Map();
let dumped = 0;

function toJson(value) {
  return JSON.stringify(value, (key, v) => {
    if (typeof v === 'bigint') return v.toString();
    if (v instanceof Uint8Array) return `<${v.length} bytes>`;
    return v;
  });
}

const connection = new TikTokLiveConnection(username, {
  signApiKey: process.env.EULER_API_KEY || undefined,
  enableExtendedGiftInfo: true
});

connection.on(ControlEvent.DECODED_DATA, (type, event) => {
  counts.set(type, (counts.get(type) || 0) + 1);
  if (SKIP_DUMP.test(type)) return;

  let json;
  try { json = toJson(event); } catch { return; }

  if (INTERESTING_TYPE.test(type) || INTERESTING_TEXT.test(json)) {
    log.write(toJson({ time: new Date().toISOString(), type, event }) + '\n');
    dumped++;
    const hint = (json.match(/[^"]{0,60}(fest|rank|points away|#\d{1,4})[^"]{0,60}/i) || [])[0];
    console.log(`[${new Date().toLocaleTimeString()}] ${type}${hint ? `  ->  ${hint}` : ''}`);
  }
});

connection.on(ControlEvent.DISCONNECTED, () => console.log('Disconnected.'));
connection.on(ControlEvent.ERROR, (err) => console.error('Error:', err?.message || err));

function summary() {
  console.log('\n===== Message types seen =====');
  [...counts.entries()].sort((a, b) => b[1] - a[1]).forEach(([t, n]) => console.log(`${String(n).padStart(6)}  ${t}`));
  console.log(`\n${dumped} interesting messages saved to probe-log.jsonl`);
  console.log('Send probe-log.jsonl to Claude to check for the LIVE Fest rank.');
}

function stop() {
  summary();
  try { connection.disconnect(); } catch {}
  log.end(() => process.exit(0));
}

process.on('SIGINT', stop);

console.log(`Connecting to @${username}'s LIVE...`);
try {
  const state = await connection.connect();
  console.log(`Connected to room ${state.roomId}. Listening for ${minutes} minutes (Ctrl+C to stop early).`);
  console.log('Tip: ask a viewer to send a FEST gift or vote while this runs.\n');
  setTimeout(stop, minutes * 60 * 1000);
} catch (err) {
  console.error('Could not connect:', err?.message || err);
  console.error('Make sure you are live right now and the username is correct.');
  log.end(() => process.exit(1));
}
