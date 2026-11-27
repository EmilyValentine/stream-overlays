// Live bridge: your own TikTok LIVE data feed for the stream overlays.
//
// How it works
//   1. Opens your TikTok LIVE page in a dedicated Chrome window (your own browser does TikTok's
//      request signing, so no third-party API or key is needed).
//   2. Listens to the live data Chrome receives and decodes it.
//   3. Tracks LIVE Fest points for this stream and serves them to the overlays at
//      http://localhost:3000 (Server-Sent Events at /events).
//
// Run with start-live.bat, or: node live-bridge.mjs
// Settings live in config.json (created on first run).

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { deserializeWebSocketMessage, deserializeMessage } from 'tiktok-live-connector';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_FILE = path.join(ROOT, 'config.json');
const LOG_FILE = path.join(ROOT, 'bridge-log.jsonl');
const PROFILE_DIR = path.join(ROOT, 'browser-profile');

// ---------------------------------------------------------------- config

const DEFAULT_CONFIG = {
  username: '',
  port: 3000,
  startPoints: 0,
  goal: 0,
  rank: null,
  multiplier: 2,
  festGifts: ['LIVE FEST 26', 'FEST Explorer', 'FEST Energy', 'FEST Showtime!', 'FEST World'],
  blockVideo: true,
  logRawMessages: true
};

function loadConfig() {
  let saved = {};
  try { saved = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch { /* first run */ }
  return { ...DEFAULT_CONFIG, ...saved };
}
function saveConfig() {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2) + '\n');
}

const config = loadConfig();
const argUser = (process.argv[2] || '').replace(/^@/, '').trim();
if (argUser) config.username = argUser;
saveConfig();

// ---------------------------------------------------------------- state

const state = {
  bridge: { status: 'starting', message: 'Starting up', lastEventAt: null, room: null },
  points: { start: config.startPoints, session: 0, total: config.startPoints, goal: config.goal, rank: config.rank, multiplier: config.multiplier },
  session: { coins: 0, festCoins: 0, gifts: 0, likes: 0, startedAt: new Date().toISOString() },
  topGifters: [],
  lastGift: null,
  rankHint: null,
  rankCandidates: [],
  messageTypes: {}
};

const gifters = new Map();

function festNameSet() {
  return new Set(config.festGifts.map((n) => n.toLowerCase().trim()));
}
let festNames = festNameSet();

function recalc() {
  state.points.start = Number(config.startPoints) || 0;
  state.points.goal = Number(config.goal) || 0;
  state.points.rank = config.rank === null || config.rank === '' ? null : Number(config.rank);
  state.points.multiplier = Number(config.multiplier) || 2;
  state.points.total = state.points.start + state.points.session;
  state.topGifters = [...gifters.values()].sort((a, b) => b.coins - a.coins).slice(0, 5);
}

function setStatus(status, message) {
  state.bridge.status = status;
  state.bridge.message = message;
  console.log(`[${new Date().toLocaleTimeString()}] ${status.toUpperCase()}: ${message}`);
  broadcast('state', publicState());
}

function publicState() {
  recalc();
  return state;
}

// ---------------------------------------------------------------- server (static files + SSE)

const clients = new Set();

function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) {
    try { res.write(payload); } catch { clients.delete(res); }
  }
}

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.txt': 'text/plain; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.gif': 'image/gif'
};
const PRIVATE_FILES = new Set(['config.json', 'bridge-log.jsonl', 'tiktool-key.txt', 'probe-log.jsonl']);

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Private-Network', 'true');
}

function readBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 1e5) req.destroy(); });
    req.on('end', () => resolve(body));
  });
}

const server = http.createServer(async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') { res.writeHead(204).end(); return; }

  const url = new URL(req.url, 'http://localhost');
  const route = url.pathname;

  if (route === '/events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
    res.write(`retry: 3000\n\n`);
    res.write(`event: state\ndata: ${JSON.stringify(publicState())}\n\n`);
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }

  if (route === '/state') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(publicState()));
    return;
  }

  if (route === '/config' && req.method === 'POST') {
    let body;
    try { body = JSON.parse(await readBody(req)); } catch { res.writeHead(400).end('Invalid JSON'); return; }
    if (body.startPoints !== undefined) {
      // A new official total from the app already includes everything earned so far,
      // so this stream's counter starts again from zero.
      config.startPoints = Math.max(0, Number(body.startPoints) || 0);
      state.points.session = 0;
    }
    if (body.goal !== undefined) config.goal = Math.max(0, Number(body.goal) || 0);
    if (body.rank !== undefined) config.rank = body.rank === '' || body.rank === null ? null : Math.max(1, Number(body.rank) || 1);
    if (body.multiplier !== undefined) config.multiplier = Math.max(1, Number(body.multiplier) || 2);
    if (Array.isArray(body.festGifts)) { config.festGifts = body.festGifts.map(String); festNames = festNameSet(); }
    saveConfig();
    broadcast('state', publicState());
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(publicState()));
    return;
  }

  // Test hook for checking the overlays without being live: POST /test/gift {"name":"FEST World","coins":9999,"count":1,"user":"tester"}
  if (route === '/test/gift' && req.method === 'POST') {
    let body = {};
    try { body = JSON.parse((await readBody(req)) || '{}'); } catch { /* use defaults */ }
    recordGift({
      name: body.name || 'FEST Energy',
      coinsEach: Number(body.coins) || 299,
      count: Number(body.count) || 1,
      user: body.user || 'test_viewer',
      nickname: body.user || 'Test viewer',
      test: true
    });
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(publicState()));
    return;
  }

  // Static files
  let filePath = route === '/' ? '/index.html' : route === '/control' ? '/control.html' : route;
  try { filePath = decodeURIComponent(filePath); } catch { res.writeHead(400).end(); return; }
  const full = path.normalize(path.join(ROOT, filePath));
  if (!full.startsWith(ROOT + path.sep) || PRIVATE_FILES.has(path.basename(full)) || full.includes(`${path.sep}browser-profile`) || full.includes(`${path.sep}node_modules`)) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  fs.readFile(full, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(full).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(data);
  });
});

// Keep SSE connections alive through idle periods.
setInterval(() => { for (const res of clients) { try { res.write(': ping\n\n'); } catch { clients.delete(res); } } }, 20000);

// ---------------------------------------------------------------- message handling

const seenIds = new Set();
const seenQueue = [];
function alreadySeen(id) {
  if (!id || id === '0') return false;
  if (seenIds.has(id)) return true;
  seenIds.add(id);
  seenQueue.push(id);
  if (seenQueue.length > 5000) seenIds.delete(seenQueue.shift());
  return false;
}

const log = fs.createWriteStream(LOG_FILE, { flags: 'a' });
const LOG_TYPE = /rank|banner|campaign|activity|fest|notice|toast|bottom|barrage|capsule|guide|goal|pin|hourly|panel|board|task|mission|league/i;
const LOG_TEXT = /fest|rank|points away|leaderboard|campaign|power league|league/i;
const RANK_TEXT = /(points? away from (?:becoming |reaching )?#\s?\d{1,5}|#\s?\d{1,5}\b[^"]{0,40}(?:rank|league)|rank(?:ed)?[^"]{0,20}#\s?\d{1,5})/i;

function toJson(value) {
  return JSON.stringify(value, (k, v) => {
    if (typeof v === 'bigint') return v.toString();
    if (v instanceof Uint8Array || (v && v.type === 'Buffer' && Array.isArray(v.data))) return undefined;
    return v;
  });
}

function handleMessages(messages, source) {
  for (const m of messages || []) {
    const type = m.method || 'unknown';
    const id = m.msgId !== undefined ? String(m.msgId) : null;
    if (alreadySeen(id)) continue;

    state.messageTypes[type] = (state.messageTypes[type] || 0) + 1;
    state.bridge.lastEventAt = new Date().toISOString();
    if (state.bridge.status !== 'connected') setStatus('connected', `Receiving live data (${source})`);

    const data = m.decodedData?.data;

    if (type === 'WebcastGiftMessage' && data) handleGift(data);
    else if (type === 'WebcastLikeMessage' && data) state.session.likes += Number(data.likeCount) || 0;

    if (config.logRawMessages && data && type !== 'WebcastChatMessage' && type !== 'WebcastLikeMessage' && type !== 'WebcastMemberMessage') {
      let json;
      try { json = toJson(data); } catch { json = null; }
      if (json && (LOG_TYPE.test(type) || LOG_TEXT.test(json))) {
        log.write(`{"time":"${new Date().toISOString()}","type":"${type}","data":${json}}\n`);
        const hint = json.match(RANK_TEXT);
        if (hint) {
          state.rankHint = { type, text: hint[0], at: new Date().toISOString() };
          console.log(`  Possible rank info in ${type}: ${hint[0]}`);
          broadcast('state', publicState());
        }
      }
    }
  }
}

function handleGift(data) {
  // Current schema: data.gift { name, diamondCount, type, combo }. Older schema: data.giftDetails { giftName, giftType }.
  const d = data.gift || data.giftDetails || {};
  const giftType = Number(d.type ?? d.giftType ?? data.giftType);
  const streakable = giftType === 1 || d.combo === true;
  const repeatEnd = Boolean(Number(data.repeatEnd));
  // Streakable gifts send updates during the combo; count them once when the streak ends.
  if (streakable && !repeatEnd) return;

  recordGift({
    name: d.name || d.giftName || data.extendedGiftInfo?.name || `Gift ${data.giftId}`,
    coinsEach: Number(d.diamondCount ?? data.extendedGiftInfo?.diamond_count) || 0,
    count: Math.max(1, Number(data.repeatCount) || 1),
    user: data.user?.uniqueId || data.user?.displayId || '',
    nickname: data.user?.nickname || data.user?.uniqueId || data.user?.displayId || 'Someone',
    giftId: data.giftId
  });
}

function recordGift({ name, coinsEach, count, user, nickname, giftId, test }) {
  const coins = coinsEach * count;
  const fest = festNames.has(String(name).toLowerCase().trim());
  const mult = fest ? (Number(config.multiplier) || 2) : 1;
  const points = coins * mult;

  state.points.session += points;
  state.session.coins += coins;
  state.session.gifts += count;
  if (fest) state.session.festCoins += coins;

  const key = user || nickname;
  const g = gifters.get(key) || { user, nickname, coins: 0, points: 0 };
  g.coins += coins;
  g.points += points;
  gifters.set(key, g);

  state.lastGift = { name, count, coins, points, fest, user, nickname, giftId: giftId ?? null, at: new Date().toISOString(), test: Boolean(test) };
  console.log(`  ${test ? '[TEST] ' : ''}${nickname} sent ${name} x${count} = ${coins} coins -> +${points} pts${fest ? ' (FEST)' : ''}`);
  broadcast('gift', state.lastGift);
  broadcast('state', publicState());
}

// ---------------------------------------------------------------- rank sniffing (HTTP)
// The LIVE page fetches ranking data (LIVE Fest, leagues, daily rank) over normal HTTP requests,
// separately from the live message stream. Log those and look for your own rank in them.

const RANK_URL = /rank|league|fest|campaign|activity|competition|leaderboard|anchor.*(score|level)|gift_?panel/i;
const RANK_BODY = /fest|league|rank/i;
const RANK_KEYS = ['rank', 'ranking', 'user_rank', 'my_rank', 'self_rank', 'cur_rank', 'current_rank', 'rank_index', 'position'];
const SCORE_KEYS = ['score', 'points', 'point', 'total_score', 'value', 'fest_score', 'gap', 'gap_score', 'gap_to_previous', 'diff_score', 'distance'];
const SELF_HINT = /self|owner|anchor|my_|current_user|mine|host/i;

function safeUrl(u) {
  try { const x = new URL(u); return x.origin + x.pathname; } catch { return String(u).split('?')[0]; }
}

function findRankCandidates(obj, url) {
  const found = [];
  const me = String(config.username || '').toLowerCase();
  const walk = (node, pathKeys, depth) => {
    if (!node || typeof node !== 'object' || depth > 12 || found.length > 20) return;
    if (Array.isArray(node)) { node.forEach((v, i) => walk(v, pathKeys.concat(i), depth + 1)); return; }
    const keys = Object.keys(node);
    const rankKey = keys.find((k) => RANK_KEYS.includes(k.toLowerCase()));
    const scoreKey = keys.find((k) => SCORE_KEYS.includes(k.toLowerCase()));
    if (rankKey && scoreKey) {
      const rank = Number(node[rankKey]);
      const json = JSON.stringify(node).toLowerCase();
      const pathStr = pathKeys.join('.');
      const isMe = (me && json.includes(`"${me}"`)) || SELF_HINT.test(pathStr);
      if (rank >= 1 && rank <= 100000) {
        found.push({ url: safeUrl(url), path: pathStr, rank, rankKey, score: node[scoreKey], scoreKey, isMe, at: new Date().toISOString() });
      }
    }
    for (const k of keys) walk(node[k], pathKeys.concat(k), depth + 1);
  };
  walk(obj, [], 0);
  return found;
}

async function sniffHttp(response) {
  const url = response.url();
  if (!/tiktok\.com|tiktokv\.com|tiktokcdn/i.test(url)) return;
  if (/\/webcast\/im\/fetch/i.test(url)) return;
  const ct = (response.headers()['content-type'] || '').toLowerCase();
  if (!ct.includes('json')) return;
  let text;
  try { text = await response.text(); } catch { return; }
  if (!text || text.length > 2_000_000) return;
  if (!RANK_URL.test(url) && !RANK_BODY.test(text)) return;

  let body;
  try { body = JSON.parse(text); } catch { return; }
  if (config.logRawMessages) log.write(JSON.stringify({ time: new Date().toISOString(), type: 'http', url: safeUrl(url), data: body }) + '\n');

  const candidates = findRankCandidates(body, url);
  if (candidates.length) {
    const mine = candidates.filter((c) => c.isMe);
    const keep = (mine.length ? mine : candidates).slice(0, 5);
    state.rankCandidates = keep.concat(state.rankCandidates).slice(0, 15);
    for (const c of keep) console.log(`  Rank data${c.isMe ? ' (looks like yours)' : ''}: #${c.rank} ${c.scoreKey}=${c.score}  [${c.url.replace(/^https?:\/\/[^/]+/, '')} ${c.path}]`);
    broadcast('state', publicState());
  }
}

// ---------------------------------------------------------------- browser capture

async function launchBrowser() {
  const options = {
    headless: false,
    viewport: { width: 1100, height: 760 },
    args: ['--mute-audio', '--autoplay-policy=no-user-gesture-required', '--disable-features=Translate']
  };
  for (const channel of ['chrome', 'msedge']) {
    try {
      return await chromium.launchPersistentContext(PROFILE_DIR, { ...options, channel });
    } catch (err) {
      if (!/not found|Executable|install/i.test(err.message)) throw err;
    }
  }
  throw new Error('Could not find Google Chrome or Microsoft Edge on this PC.');
}

async function startCapture() {
  if (!config.username) {
    setStatus('error', 'No TikTok username set. Run: node live-bridge.mjs <username>');
    return;
  }

  setStatus('browser', 'Opening Chrome');
  const context = await launchBrowser();
  const page = context.pages()[0] || await context.newPage();

  if (config.blockVideo) {
    // Skip downloading the video and audio stream: only the live data is needed.
    await context.route(/\.(flv|m3u8|ts|m4s|mp4)(\?|$)|pull-[^/]*\.tiktokcdn|pull-.*\.tiktok/i, (route) => route.abort());
  }

  let lastSocketAt = 0;

  page.on('websocket', (ws) => {
    if (!/webcast|im\/push|\/ws\//i.test(ws.url())) return;
    lastSocketAt = Date.now();
    setStatus('watching', 'Live connection opened, waiting for data');
    ws.on('framereceived', async ({ payload }) => {
      if (typeof payload === 'string') return;
      try {
        const frame = await deserializeWebSocketMessage(Buffer.from(payload));
        if (frame.protoMessageFetchResult) handleMessages(frame.protoMessageFetchResult.messages, 'websocket');
      } catch { /* not a webcast frame */ }
    });
    ws.on('close', () => {
      setStatus('watching', 'Live connection closed, waiting for it to reopen');
      lastSocketAt = 0;
    });
  });

  page.on('response', (response) => { sniffHttp(response).catch(() => {}); });

  page.on('response', async (response) => {
    if (!/\/webcast\/im\/fetch/i.test(response.url())) return;
    try {
      const body = await response.body();
      const result = deserializeMessage('ProtoMessageFetchResult', body);
      handleMessages(result.messages, 'polling');
    } catch { /* not decodable */ }
  });

  page.on('close', () => {
    setStatus('offline', 'The TikTok window was closed. Restart start-live.bat to reconnect.');
  });

  const liveUrl = `https://www.tiktok.com/@${encodeURIComponent(config.username)}/live`;
  setStatus('browser', `Opening ${liveUrl}`);
  await page.goto(liveUrl, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});

  // If no live data arrives, reload the page now and then (covers starting the bridge before going live).
  setInterval(async () => {
    const quiet = !state.bridge.lastEventAt || Date.now() - new Date(state.bridge.lastEventAt).getTime() > 90000;
    if (quiet && Date.now() - lastSocketAt > 90000 && !page.isClosed()) {
      setStatus('watching', 'No live data yet. Reloading the live page (are you live?)');
      await page.goto(liveUrl, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
    }
  }, 120000);
}

// ---------------------------------------------------------------- start

server.listen(config.port, '127.0.0.1', async () => {
  console.log('');
  console.log('  Live bridge running');
  console.log(`  Banner:   http://localhost:${config.port}/livefest-banner.html`);
  console.log(`  Control:  http://localhost:${config.port}/control`);
  console.log(`  Watching: @${config.username || '(no username set)'}`);
  console.log('  Keep this window and the TikTok window open while you stream. Ctrl+C to stop.');
  console.log('');
  if (process.env.BRIDGE_NO_BROWSER === '1') {
    setStatus('offline', 'Browser capture disabled (test mode)');
    return;
  }
  try {
    await startCapture();
  } catch (err) {
    setStatus('error', err.message);
  }
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${config.port} is already in use. Close start-overlays.bat or the other bridge window first.`);
  } else {
    console.error(err);
  }
  process.exit(1);
});

export { handleMessages, recordGift, findRankCandidates, state };
