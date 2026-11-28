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
import { deserializeMessage, WebcastPushFrame, TikTokLiveConnection, ControlEvent } from 'tiktok-live-connector';
import zlib from 'node:zlib';

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
  eulerApiKey: '',
  hostUserId: '',
  leagueSync: null,
  record: true,
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
const REPLAY_INDEX = process.argv.indexOf('--replay');
const REPLAY_FILE = REPLAY_INDEX > -1 ? process.argv[REPLAY_INDEX + 1] : null;
const REPLAY_SPEED = Number(process.argv[process.argv.indexOf('--speed') + 1]) || 1;
const argUser = (process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : '').replace(/^@/, '').trim();
if (argUser) config.username = argUser;
// Session coin counts restart at zero, so carry league progress forward from zero too.
if (config.leagueSync) config.leagueSync.baselineCoins = 0;
saveConfig();

// ---------------------------------------------------------------- state

const state = {
  bridge: { status: 'starting', message: 'Starting up', lastEventAt: null, room: null },
  points: { start: config.startPoints, session: 0, total: config.startPoints, goal: config.goal, rank: config.rank, multiplier: config.multiplier },
  session: { coins: 0, festCoins: 0, gifts: 0, likes: 0, follows: 0, shares: 0, chats: 0, joins: 0, startedAt: new Date().toISOString() },
  room: { viewers: 0, peakViewers: 0, totalViewers: 0, totalLikes: 0 },
  battle: null,
  boost: null,
  powerups: [],
  league: null,
  recentChat: [],
  recentEvents: [],
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
  state.hostUserId = config.hostUserId || null;
  const ls = config.leagueSync;
  if (ls) {
    const earned = Math.max(0, state.session.coins - (Number(ls.baselineCoins) || 0));
    const toNext = Math.max(0, (Number(ls.toNext) || 0) - earned);
    state.leagueProgress = {
      tier: state.league || ls.tier || null,
      fragments: Number(ls.fragments) || 0,
      fragmentsTotal: Number(ls.fragmentsTotal) || 3,
      toNext,
      reached: (Number(ls.toNext) || 0) > 0 && toNext === 0,
      rank: ls.rank || null,
      nextUpdateAt: ls.nextUpdateAt || null,
      syncedAt: ls.syncedAt
    };
  } else {
    state.leagueProgress = state.league ? { tier: state.league } : null;
  }
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
const PRIVATE_FILES = new Set(['euler-key.txt', 'config.json', 'bridge-log.jsonl', 'bridge-status.json', 'tiktool-key.txt', 'probe-log.jsonl']);

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
    if (body.league && typeof body.league === 'object') {
      const L = body.league;
      const secs = (() => {
        const m = String(L.nextUpdate || '').trim().match(/^(?:(\d+):)?(\d{1,2}):(\d{2})$/);
        return m ? (Number(m[1] || 0) * 3600 + Number(m[2]) * 60 + Number(m[3])) : null;
      })();
      config.leagueSync = {
        tier: L.tier ? String(L.tier).toUpperCase().slice(0, 4) : (state.league || null),
        fragments: Math.max(0, Math.min(10, Number(L.fragments) || 0)),
        fragmentsTotal: Math.max(1, Math.min(10, Number(L.fragmentsTotal) || 3)),
        toNext: Math.max(0, Number(L.toNext) || 0),
        rank: L.rank ? String(L.rank).slice(0, 8) : null,
        nextUpdateAt: secs !== null ? new Date(Date.now() + secs * 1000).toISOString() : (config.leagueSync?.nextUpdateAt || null),
        baselineCoins: state.session.coins,
        syncedAt: new Date().toISOString()
      };
      if (config.leagueSync.tier && !state.league) state.league = config.leagueSync.tier;
    }
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
  if (!full.startsWith(ROOT + path.sep) || PRIVATE_FILES.has(path.basename(full)) || full.includes(`${path.sep}browser-profile`) || full.includes(`${path.sep}node_modules`) || full.includes(`${path.sep}sessions${path.sep}`)) {
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


// ---------------------------------------------------------------- session recording
// Every decoded message is saved to sessions/<date>.jsonl (private, ignored by git) so a stream
// can be replayed later to test overlays: node live-bridge.mjs --replay sessions/<file> [--speed 2]

let recorder = null;
function recordMessage(type, data, raw) {
  if (!config.record || REPLAY_FILE) return;
  try {
    if (!recorder) {
      const dir = path.join(ROOT, 'sessions');
      fs.mkdirSync(dir, { recursive: true });
      const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
      recorder = fs.createWriteStream(path.join(dir, `${stamp}.jsonl`), { flags: 'a' });
    }
    const rawPart = raw && raw.length ? `,"raw":"${Buffer.from(raw).toString('base64')}"` : '';
    recorder.write(`{"t":${Date.now()},"type":"${type}","data":${toJson(data)}${rawPart}}\n`);
  } catch { /* recording is best-effort */ }
}

async function replaySession(file, speed) {
  const full = path.isAbsolute(file) ? file : path.join(ROOT, file);
  const lines = fs.readFileSync(full, 'utf8').split('\n').filter(Boolean);
  setStatus('connected', `Replaying ${path.basename(full)} (${lines.length} messages, ${speed}x speed)`);
  let prev = null, n = 0;
  for (const line of lines) {
    let rec; try { rec = JSON.parse(line); } catch { continue; }
    if (prev !== null) await new Promise((r) => setTimeout(r, Math.min(10000, Math.max(0, (rec.t - prev) / speed))));
    prev = rec.t;
    if (rec.data?.undecoded) { if (rec.raw) handleUndecoded(rec.type, Buffer.from(rec.raw, 'base64')); continue; }
    handleMessages([{ method: rec.type, msgId: `replay-${n++}`, decodedData: { type: rec.type, data: rec.data } }], 'replay');
  }
  setStatus('offline', 'Replay finished');
}

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
const LOG_TYPE = /rank|banner|campaign|activity|fest|notice|toast|bottom|barrage|capsule|guide|goal|pin|hourly|panel|board|task|mission|league|battle|armies/i;
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
    if (m.decodedData?.data && source !== 'replay') {
      const d = m.decodedData.data;
      const sparse = Object.keys(d).filter((k) => k !== 'common' && d[k] !== undefined && d[k] !== null && d[k] !== '' && !(Array.isArray(d[k]) && !d[k].length)).length === 0;
      const keepRaw = sparse || /Banner|Rank|Activity|Campaign|Fest|Toast|Notice|Battle|LinkMic|Gameplay/i.test(type) && !/Armies/.test(type);
      recordMessage(type, d, keepRaw ? m.payload : null);
    }
    state.bridge.lastEventAt = new Date().toISOString();
    if (state.bridge.status !== 'connected') setStatus('connected', `Receiving live data (${source})`);

    const data = m.decodedData?.data;

    if (type === 'WebcastGiftMessage' && data) handleGift(data);
    else if (data) handleOther(type, data);

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


function who(user) {
  return { user: user?.uniqueId || user?.displayId || '', nickname: user?.nickname || user?.uniqueId || user?.displayId || 'Someone' };
}

function pushEvent(kind, extra) {
  const ev = { kind, at: new Date().toISOString(), ...extra };
  const t = new Date().toLocaleTimeString();
  if (kind === 'battle') {
    if (extra.phase === 'started') console.log(`  [${t}] BATTLE started vs ${(extra.opponents || []).join(', ') || 'opponent'}`);
    else if (extra.phase === 'ended') console.log(`  [${t}] BATTLE ${String(extra.outcome || '').toUpperCase()} ${Object.entries(extra.scores || {}).map(([n, v]) => `${n} ${v}`).join(' vs ')}`);
    else if (extra.phase === 'over') console.log(`  [${t}] Punishment round finished`);
  } else if (kind === 'firstGift') {
    console.log(`  [${t}] FIRST GIFT x${extra.multiplier ?? '?'} bonus in ${Math.max(0, Math.round((extra.startsAt - Date.now()) / 1000))}s`);
  } else if (kind === 'boost') {
    console.log(`  [${t}] BOOST x${extra.multiplier ?? '?'} ${extra.phase}${extra.side && extra.side !== 'mine' ? ` (${extra.side})` : ''}`);
  } else if (kind === 'powerup') {
    console.log(`  [${t}] POWER-UP ${extra.name}${extra.multiple ? ' x' + extra.multiple : ''} by ${extra.by}${extra.side === 'opponent' ? ' (THEIRS)' : ''}`);
  } else if (kind === 'powerupAwarded') {
    console.log(`  [${t}] POWER-UP earned by ${(extra.users || []).join(', ')}`);
  } else if (kind === 'crit') {
    console.log(`  [${t}] CRITICAL HIT${extra.nickname ? ' by ' + extra.nickname : ''}`);
  } else if (kind === 'follow' || kind === 'share') {
    console.log(`  [${t}] ${kind.toUpperCase()}: ${extra.nickname}`);
  }
  state.recentEvents.unshift(ev);
  if (state.recentEvents.length > 30) state.recentEvents.pop();
  broadcast('event', ev);
}

let stateDirty = false;
setInterval(() => { if (stateDirty) { stateDirty = false; broadcast('state', publicState()); } }, 1000);


// ---------------------------------------------------------------- battle boost (x2 / x3) detection
// Battle task messages: START announces the challenge (multiplier + duration), TASK_UPDATE reports
// progress, TASK_SETTLE says whether it succeeded and when the boost window starts, REWARD_SETTLE ends it.
// Which side earned it is a best guess from the message's room id (sideVerified stays false).

function toMs(v) {
  const n = Number(v);
  if (!n) return 0;
  return n < 1e12 ? n * 1000 : n;
}

function boostEvent(phase, extra = {}) {
  state.boost = { ...(state.boost || {}), phase, ...extra, updatedAt: new Date().toISOString() };
  pushEvent('boost', { phase, multiplier: state.boost.multiplier, side: state.boost.side, startsAt: state.boost.startsAt, endsAt: state.boost.endsAt });
  stateDirty = true;
}

function handleBattleTask(data) {
  const kind = Number(data.taskMessageType);
  const roomId = String(data.common?.roomId ?? '');
  const side = roomId && state.bridge.room ? (roomId === state.bridge.room ? 'mine' : 'opponent') : 'unknown';
  const battleId = String(data.battleId ?? '');
  if (kind === 0) {
    const cfg = data.start?.config?.rewardConfig || {};
    const preview = data.start?.config?.previewConfig || [];
    const elem = (field) => {
      for (const p of preview) for (const e of p?.prompt?.elems || []) if (e.promptField === field && Number(e.value)) return Number(e.value);
      return null;
    };
    const multiplier = Number(cfg.rewardMultiple) || elem('multi') || null;
    const durationSec = Number(cfg.duration) || elem('dur') || null;
    // The real boost window is announced up front; the later settle message often says 0.
    const plannedStart = toMs(cfg.rewardStartTimestamp) || null;
    state.boost = { battleId, side, sideVerified: false, challengeStartedAt: Date.now() };
    boostEvent('challenge', { multiplier, durationSec, progress: 0, plannedStart });
  } else if (kind === 1 && state.boost && state.boost.battleId === battleId && ['challenge', 'progress', 'waiting'].includes(state.boost.phase)) {
    boostEvent(state.boost.phase === 'waiting' ? 'waiting' : 'progress', { progress: Number(data.taskUpdate?.progress) || 0 });
  } else if (kind === 2 && state.boost && state.boost.battleId === battleId) {
    const result = Number(data.taskSettle?.result);
    if (result === 1) { boostEvent('failed'); return; }
    // result 0 = one side finished, still waiting on the other. Only a real start time (or result 2,
    // both sides done) means the boost is actually happening.
    if (result !== 2 && !toMs(data.taskSettle?.rewardStartTimestamp)) { boostEvent('waiting'); return; }
    const startsAt = toMs(data.taskSettle?.rewardStartTimestamp) || state.boost.plannedStart || Date.now();
    const endsAt = startsAt + (Number(state.boost.durationSec) || 0) * 1000;
    boostEvent(Date.now() >= startsAt ? 'active' : 'scheduled', { startsAt, endsAt, bothSucceeded: result === 2 });
  } else if (kind === 3 && state.boost && state.boost.battleId === battleId && state.boost.phase !== 'ended') {
    boostEvent('ended');
  }
}

setInterval(() => {
  const b = state.boost;
  if (!b) return;
  const now = Date.now();
  if (b.phase === 'scheduled' && now >= b.startsAt) boostEvent('active');
  // Safety net: a challenge nobody settles (opponent left, message lost) disappears after 2 minutes.
  else if (['challenge', 'progress', 'waiting'].includes(b.phase) && b.challengeStartedAt && now - b.challengeStartedAt > 120000) clearBattleExtras('timed out');
  else if (b.phase === 'active' && b.endsAt && now >= b.endsAt) boostEvent('ended');
}, 500);


// ---------------------------------------------------------------- battles
// LinkMicBattle action 4 = battle started (creators, leagues, LIVE Fest estimated scores),
// action 5 = finished (result per creator). LinkMicArmies = live score updates with top supporters.

function entries(mapOrList) {
  if (!mapOrList) return [];
  if (Array.isArray(mapOrList)) return mapOrList.map((e) => [String(e.key), e.value]);
  return Object.entries(mapOrList);
}

function isMe(user) {
  const me = String(config.username || '').toLowerCase();
  const handle = String(user?.displayId || user?.uniqueId || '').toLowerCase();
  const nick = String(user?.nickName || user?.nickname || '').toLowerCase().replace(/[^a-z0-9._]/g, '');
  return Boolean(me) && (handle === me || nick === me);
}

function sideOf(hostId) {
  if (!config.hostUserId) return 'unknown';
  return String(hostId) === String(config.hostUserId) ? 'mine' : 'opponent';
}

// Minimal protobuf reader for messages the decoder doesn't know. Returns { field: [values] },
// where length-delimited values are Buffers.
function readProto(buf) {
  const out = {};
  let i = 0;
  const varint = () => { let r = 0n, s = 0n; for (;;) { const c = buf[i++]; if (c === undefined) throw new Error('eof'); r |= BigInt(c & 0x7f) << s; s += 7n; if (c < 0x80) return r; } };
  while (i < buf.length) {
    const key = Number(varint()); const f = key >> 3, w = key & 7;
    let v;
    if (w === 0) v = varint();
    else if (w === 2) { const l = Number(varint()); v = buf.subarray(i, i + l); i += l; }
    else if (w === 1) { v = buf.subarray(i, i + 8); i += 8; }
    else if (w === 5) { v = buf.subarray(i, i + 4); i += 4; }
    else throw new Error('wire type ' + w);
    (out[f] = out[f] || []).push(v);
  }
  return out;
}

// WebcastBattleGameplayMessage arrives ~60s into a match announcing a 5s window ~10s later.
// Seen layout: 2 = battleId, 5 = { 1: value (2 so far), 2: window start ms, 3: window end ms }.
// Meaning not confirmed yet, so it is logged and kept in state.gameplay but not shown on screen.
function handleGameplay(payload) {
  try {
    const m = readProto(Buffer.from(payload));
    const battleId = String(m[2]?.[0] ?? '');
    const w = m[5]?.[0] ? readProto(m[5][0]) : {};
    const multiplier = Number(w[1]?.[0] ?? 0) || null;
    const startsAt = Number(w[2]?.[0] ?? 0) || null;
    const endsAt = Number(w[3]?.[0] ?? 0) || null;
    if (!startsAt) return;
    state.gameplay = { battleId, value: multiplier, announcedAt: Date.now(), startsAt, endsAt, type: Number(m[3]?.[0] ?? 0) };
    console.log(`  [${new Date().toLocaleTimeString()}] MATCH GAMEPLAY event (value ${multiplier}) in ${Math.max(0, Math.round((startsAt - Date.now()) / 1000))}s`);
    stateDirty = true;
  } catch (e) { console.log('  Could not read BattleGameplayMessage: ' + e.message); }
}

function handleUndecoded(method, payload) {
  if (method === 'WebcastBattleGameplayMessage') handleGameplay(payload);
}

const FIRST_GIFT_MS = Number(config.firstGiftSeconds || 55) * 1000;

function clearBattleExtras(reason) {
  if (state.boost && state.boost.phase !== 'ended') boostEvent('ended', { reason });
  state.boost = null;
  state.powerups = [];
  state.firstGift = null;
  stateDirty = true;
}

function handleBattle(data) {
  const action = Number(data.action);
  const id = String(data.battleId || '');
  if (action === 4) {
    const hosts = {};
    for (const [key, value] of entries(data.anchorsInfo)) {
      const u = value?.user || {};
      hosts[key] = { id: key, name: u.nickName || u.nickname || u.displayId || key, handle: u.displayId || '' , score: 0 };
      if (!config.hostUserId && isMe(u)) { config.hostUserId = key; saveConfig(); console.log(`  Learned your TikTok host id: ${key}`); }
    }
    for (const [key, value] of entries(data.leagueInfoMap)) {
      hosts[key] = hosts[key] || { id: key, score: 0 };
      hosts[key].league = value?.leagueInfo?.displayText?.content || null;
    }
    for (const [key, value] of entries(data.leagueScoreInfoMap)) {
      hosts[key] = hosts[key] || { id: key, score: 0 };
      hosts[key].festEstimate = Number(value?.estimatedScore) || 0;
    }
    const bs = data.battleSettings || {};
    const startMs = Number(bs.startTimeMs) || Date.now();
    const durationSec = (Number(bs.duration) || 0) + (Number(bs.extraDurationSecond) || 0);
    state.battle = { id, phase: 'live', startedAt: new Date(startMs).toISOString(), endsAt: durationSec ? startMs + durationSec * 1000 : null, durationSec, hosts, supporters: {}, winner: null };
    const me = hosts[config.hostUserId];
    if (me?.league) state.league = me.league;
    // First Gift bonus: some matches open with each viewer's first gift counting x2 or x3.
    // Measured from two matches: TikTok's countdown ends ~55s after startTimeMs. The multiplier
    // isn't in the decoded message, so it stays null until we find it in the raw bytes.
    // Not every match has it, so this stays off until we find TikTok's signal in the raw bytes.
    if (config.firstGiftAlways) state.firstGift = { battleId: id, multiplier: null, announcedAt: startMs, startsAt: startMs, endsAt: startMs + FIRST_GIFT_MS };
    state.battle.iceSetting = Number(bs.iceShowdownSetting ?? -1);
    console.log(`  First Gift code for this match: ${state.battle.iceSetting} (tell Claude if TikTok showed x2, x3 or nothing)`);
    pushEvent('battle', { phase: 'started', opponents: Object.values(hosts).filter((h) => sideOf(h.id) !== 'mine').map((h) => h.name) });
  } else if ((action === 5 || action === 6) && state.battle && state.battle.id === id) {
    if (action === 6) state.battle.endedEarly = true;
    for (const [key, value] of entries(data.battleResult)) {
      const h = state.battle.hosts[key] || (state.battle.hosts[key] = { id: key });
      h.score = Number(value?.score) || h.score || 0;
      h.result = Number(value?.result);
    }
    const mine = state.battle.hosts[config.hostUserId];
    state.battle.phase = 'punishment';
    state.battle.endedAt = new Date().toISOString();
    clearBattleExtras(action === 6 ? 'battle ended early' : 'battle ended');
    state.battle.outcome = mine ? (mine.result === 0 ? 'won' : mine.result === 1 ? 'lost' : 'draw') : 'unknown';
    pushEvent('battle', { phase: 'ended', early: action === 6, outcome: state.battle.outcome, scores: Object.fromEntries(Object.values(state.battle.hosts).map((h) => [h.name || h.id, h.score])) });
  } else if (action === 12 || action === 6) {
    clearBattleExtras('battle closed');
  }
  stateDirty = true;
}

function handleArmies(data) {
  const id = String(data.battleId || '');
  if (!state.battle || state.battle.id !== id) return;
  if (data.triggerCriticalStrike) {
    let name = '';
    for (const list of Object.values(state.battle.supporters || {})) for (const u of list) if (u && u.id === String(data.fromUserId)) name = u.name;
    pushEvent('crit', { user: String(data.fromUserId || ''), nickname: name, diamonds: Number(data.totalDiamondCount) || 0 });
  }
  for (const [key, value] of entries(data.armies)) {
    const h = state.battle.hosts[key] || (state.battle.hosts[key] = { id: key });
    h.score = Number(value?.hostscore ?? value?.hostScore) || 0;
    state.battle.supporters[key] = (value?.userArmies || []).slice(0, 3).map((u) => ({ id: String(u.userId || ''), name: u.nickname || u.nickName || '', score: Number(u.score) || 0 }));
  }
  stateDirty = true;
}


// ---------------------------------------------------------------- battle power-ups (item cards)
// LinkMicBattleItemCard carries a use<Name>Card object with cardInfo (who sent it, when it starts,
// how long it lasts, multiplier and crit chance) and toAnchorId (the creator it helps).

const CARD_NAMES = { pm_mt_boost_crit_name: 'Boosting Glove' };

function cardLabel(key, pattern, raw) {
  // Music Booster does the same job as the glove (activated by singing), so it may share the glove's key.
  // If TikTok's text or the card data mentions music anywhere, label it Music Booster.
  if (/music|sing/i.test(String(pattern || '') + String(key || '')) || /music/i.test(JSON.stringify(raw || {}))) return 'Music Booster';
  if (CARD_NAMES[key]) return CARD_NAMES[key];
  const fromPattern = String(pattern || '').match(/sent \d+ ([^{}]+)$/i);
  if (fromPattern) return fromPattern[1].replace(/\b\w/g, (c) => c.toUpperCase());
  return String(key || 'Power-up').replace(/^pm_mt_|_name$/g, '').replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

function handleItemCard(data) {
  // msgType 4: "Contributors got match power-ups." (who earned power-ups this battle)
  if (data.awardCardNotice) {
    const users = (data.awardCardNotice.awardedUsers || []).map((a) => a?.user?.nickName || a?.user?.nickname || a?.user?.displayId).filter(Boolean);
    if (users.length) pushEvent('powerupAwarded', { users, side: 'mine' });
  }
  for (const [field, value] of Object.entries(data)) {
    if (!/^use.*Card$/i.test(field) || !value || typeof value !== 'object') continue;
    const info = value.cardInfo || {};
    const v = { ...value, ...info }; // details sit inside cardInfo in the current schema
    const user = info.sendUser?.user || {};
    const startsAt = (Number(v.effectTimeSec) || Number(v.sendTimeSec) || Date.now() / 1000) * 1000;
    const duration = Number(v.effectLastDuration) || 0;
    const target = String(v.toAnchorIdStr || v.toAnchorId || data.anchorId || '');
    const p = {
      id: `${data.battleId}:${field}:${startsAt}`,
      type: field.replace(/^use|Card$/g, ''),
      name: cardLabel(info.cardNameKey, data.displayContent?.defaultPattern, v),
      multiple: Number(v.multiple) || null,
      critLow: Number(v.criticalStrikeRateLow) || null,
      critHigh: Number(v.criticalStrikeRateHigh) || null,
      side: sideOf(target),
      by: user.nickName || user.nickname || user.displayId || 'Someone',
      image: (info.cardImage?.urlList || info.cardImage?.url_list || [])[0] || null,
      startsAt, endsAt: duration ? startsAt + duration * 1000 : null
    };
    state.powerups = state.powerups.filter((x) => x.id !== p.id).concat(p);
    pushEvent('powerup', p);
    stateDirty = true;
  }
}

setInterval(() => {
  const now = Date.now();
  const before = state.powerups.length;
  state.powerups = state.powerups.filter((p) => !p.endsAt || p.endsAt > now);
  if (state.powerups.length !== before) stateDirty = true;
}, 1000);

function handleOther(type, data) {
  switch (type) {
    case 'WebcastLikeMessage': {
      const n = Number(data.count ?? data.likeCount) || 0;
      state.session.likes += n;
      if (Number(data.total)) state.room.totalLikes = Number(data.total);
      pushEvent('like', { ...who(data.user), count: n, total: state.room.totalLikes });
      stateDirty = true;
      break;
    }
    case 'WebcastSocialMessage': {
      const key = String(data.common?.displayText?.key || '').toLowerCase();
      const isShare = key.includes('share') || Number(data.shareCount) > 0 || Number(data.shareType) > 0;
      const isFollow = !isShare && (key.includes('follow') || Number(data.action) === 1);
      if (isShare) { state.session.shares++; pushEvent('share', who(data.user)); }
      else if (isFollow) { state.session.follows++; pushEvent('follow', who(data.user)); }
      stateDirty = true;
      break;
    }
    case 'WebcastChatMessage': {
      state.session.chats++;
      const c = { ...who(data.user), text: String(data.content || ''), at: new Date().toISOString() };
      state.recentChat.unshift(c);
      if (state.recentChat.length > 30) state.recentChat.pop();
      broadcast('chat', c);
      stateDirty = true;
      break;
    }
    case 'WebcastMemberMessage': {
      state.session.joins++;
      pushEvent('join', who(data.user));
      stateDirty = true;
      break;
    }
    case 'WebcastRoomUserSeqMessage': {
      const v = Number(data.total) || 0;
      if (v) { state.room.viewers = v; state.room.peakViewers = Math.max(state.room.peakViewers, v); }
      if (Number(data.totalUser)) state.room.totalViewers = Number(data.totalUser);
      stateDirty = true;
      break;
    }
    case 'WebcastLinkmicBattleTaskMessage': {
      handleBattleTask(data);
      break;
    }
    case 'WebcastLinkMicBattle': {
      handleBattle(data);
      break;
    }
    case 'WebcastLinkMicArmies': {
      handleArmies(data);
      break;
    }
    case 'WebcastLinkMicBattleItemCard': {
      handleItemCard(data);
      break;
    }
    case 'WebcastLinkMicBattlePunishFinish': {
      if (state.battle) { state.battle.phase = 'over'; stateDirty = true; pushEvent('battle', { phase: 'over' }); }
      clearBattleExtras('battle over');
      break;
    }
    default:
      break;
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

// ---------------------------------------------------------------- Euler Stream mode
// When an Euler Stream API key is set (config.json "eulerApiKey", or euler-key.txt), the bridge
// connects with tiktok-live-connector instead of opening a Chrome window.

function eulerKey() {
  if (config.eulerApiKey) return String(config.eulerApiKey).trim();
  try { return fs.readFileSync(path.join(ROOT, 'euler-key.txt'), 'utf8').trim(); } catch { return ''; }
}

async function startEuler(apiKey) {
  let attempt = 0;
  const eulerLog = [];
  const wsStats = { connects: 0, frames: 0, messages: 0, lastFrameAt: null };
  const note = (t) => { console.log(`  [euler] ${t}`); eulerLog.push(`${new Date().toISOString()} ${t}`); if (eulerLog.length > 40) eulerLog.shift(); };
  const STATUS_FILE = path.join(ROOT, 'bridge-status.json');
  setInterval(() => {
    try {
      fs.writeFileSync(STATUS_FILE, JSON.stringify({ at: new Date().toISOString(), mode: 'euler', ws: wsStats, bridge: state.bridge, points: state.points, session: state.session, room: state.room, battle: state.battle, boost: state.boost, powerups: state.powerups, league: state.league || null, leagueProgress: state.leagueProgress || null, lastGift: state.lastGift, messageTypes: state.messageTypes, rankCandidates: state.rankCandidates, rankHint: state.rankHint, debug: eulerLog }, null, 2));
    } catch { /* ignore */ }
  }, 10000);
  const connect = async () => {
    attempt++;
    const connection = new TikTokLiveConnection(config.username, { signApiKey: apiKey, enableExtendedGiftInfo: false });
    // Messages the decoder can't read are normally dropped. Record their raw bytes so they can be
    // examined later (LIVE Fest / league data may arrive in formats the decoder doesn't know yet).
    if (typeof connection.processProtoMessageFetchResult === 'function') {
      const original = connection.processProtoMessageFetchResult;
      connection.processProtoMessageFetchResult = async function (batch) {
        for (const message of batch?.messages || []) {
          if (!message.decodedData && message.payload) {
            const method = String(message.method || 'UnknownMessage');
            state.messageTypes[method] = (state.messageTypes[method] || 0) + 1;
            recordMessage(method, { undecoded: true }, message.payload);
            handleUndecoded(method, message.payload);
          }
        }
        return original.call(this, batch);
      };
    }
    // The library emits (method, { type, data }, payload).
    connection.on(ControlEvent.DECODED_DATA, (type, decoded, payload) => {
      const data = decoded && typeof decoded === 'object' && 'data' in decoded ? decoded.data : decoded;
      const id = data?.common?.msgId ?? data?.msgId;
      wsStats.messages++;
      handleMessages([{ method: type, msgId: id !== undefined && id !== null ? String(id) : null, payload, decodedData: { type, data } }], 'euler');
    });
    connection.on('websocketConnected', () => { wsStats.connects++; note('Live feed WebSocket connected'); });
    connection.on('websocketData', () => { wsStats.frames++; wsStats.lastFrameAt = new Date().toISOString(); });
    connection.on(ControlEvent.DISCONNECTED, (info) => {
      note(`Disconnected ${info?.code ?? ''} ${info?.reason ?? ''}`);
      setStatus('watching', 'Disconnected from the live. Reconnecting in 30 seconds');
      setTimeout(connect, 30000);
    });
    connection.on(ControlEvent.ERROR, (err) => {
      const t = String(err?.info || err?.message || err).slice(0, 200);
      console.log(`  [euler] ${t}`);
      eulerLog.push(`${new Date().toISOString()} ${t}`); if (eulerLog.length > 40) eulerLog.shift();
    });
    try {
      setStatus('watching', `Connecting to @${config.username} via Euler Stream`);
      const st = await connection.connect();
      attempt = 0;
      state.bridge.room = String(st.roomId || '');
      setStatus(state.bridge.lastEventAt ? 'connected' : 'watching', `Connected to room ${state.bridge.room}`);
    } catch (err) {
      const msg = String(err?.message || err);
      if (/Business plan|requires a .*plan|Premium/i.test(msg)) {
        setStatus('error', 'Euler says this needs a paid plan. The free key is not enough for signing.');
        return;
      }
      if (/offline|not live|UserOffline|isn't online|is not online/i.test(msg)) setStatus('offline', 'You are not live right now. Checking again every minute');
      else setStatus('error', `Euler connect failed: ${msg.slice(0, 160)}. Retrying in 60 seconds`);
      setTimeout(connect, Math.min(300000, 60000 * attempt));
    }
  };
  await connect();
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

  const stats = { sockets: 0, frames: 0, decoded: 0, messages: 0, errors: 0, other: 0 };
  let lastFrameAt = 0;
  const shownErrors = new Set();

  function unpack(payload, headers) {
    const buf = Buffer.from(payload);
    const compress = (headers || []).find((h) => /compress/i.test(h.key))?.value || '';
    if (buf.length > 2 && buf[0] === 0x1f && buf[1] === 0x8b) return zlib.gunzipSync(buf);
    if (/gzip/i.test(compress)) return zlib.gunzipSync(buf);
    if (/br|brotli/i.test(compress)) return zlib.brotliDecompressSync(buf);
    if (/deflate/i.test(compress)) return zlib.inflateSync(buf);
    return buf;
  }

  function decodeFrame(raw) {
    const frame = WebcastPushFrame.decode(raw);
    const enc = String(frame.payloadEncoding || '');
    const type = String(frame.payloadType || '');
    if (!frame.payload || !frame.payload.length) return { kind: 'empty', type };
    if (enc && enc !== 'pb') return { kind: 'encoding', enc, type };
    if (type && !/msg/i.test(type)) return { kind: 'non-msg', type };
    const body = unpack(frame.payload, frame.headers);
    return { kind: 'msg', result: deserializeMessage('ProtoMessageFetchResult', body) };
  }

  const debugLines = [];
  function debug(text) { console.log(`  [debug] ${text}`); debugLines.push(`${new Date().toISOString()} ${text}`); if (debugLines.length > 60) debugLines.shift(); }
  function reportError(key, text) {
    if (shownErrors.has(key) || shownErrors.size > 8) return;
    shownErrors.add(key);
    debug(text);
  }

  page.on('websocket', (ws) => {
    const url = safeUrl(ws.url());
    debug(`Socket opened: ${url}`);
    if (!/webcast|im\/push|\/ws\//i.test(url)) return;
    stats.sockets++;
    lastSocketAt = Date.now();
    setStatus('watching', 'Live connection opened, waiting for data');
    ws.on('framereceived', ({ payload }) => {
      lastFrameAt = Date.now();
      if (typeof payload === 'string') { stats.other++; reportError('text', `Text frame (${payload.length} chars): ${payload.slice(0, 120)}`); return; }
      stats.frames++;
      try {
        const out = decodeFrame(Buffer.from(payload));
        if (out.kind === 'msg') {
          stats.decoded++;
          const msgs = out.result.messages || [];
          stats.messages += msgs.length;
          const undecoded = msgs.filter((m) => !m.decodedData).map((m) => m.method);
          if (undecoded.length) reportError('undecoded:' + undecoded[0], `Message types without a decoder: ${[...new Set(undecoded)].slice(0, 6).join(', ')}`);
          handleMessages(msgs, 'websocket');
        } else if (out.kind === 'encoding') {
          reportError('enc:' + out.enc, `Frame payload encoding "${out.enc}" (type "${out.type}")`);
        } else if (out.kind !== 'empty') {
          reportError('kind:' + out.type, `Frame type "${out.type}" skipped`);
        }
      } catch (err) {
        stats.errors++;
        const head = Buffer.from(payload).subarray(0, 24).toString('hex');
        reportError('err:' + String(err.message).slice(0, 40), `Decode failed (${payload.length} bytes, starts ${head}): ${String(err.message).slice(0, 160)}`);
      }
    });
    ws.on('close', () => {
      debug(`Socket closed: ${url}`);
      setStatus('watching', 'Live connection closed, waiting for it to reopen');
      lastSocketAt = 0;
    });
  });

  const STATUS_FILE = path.join(ROOT, 'bridge-status.json');
  const writeStatus = () => {
    try {
      fs.writeFileSync(STATUS_FILE, JSON.stringify({ at: new Date().toISOString(), url: page.isClosed() ? null : safeUrl(page.url()), stats, bridge: state.bridge, points: state.points, messageTypes: state.messageTypes, rankCandidates: state.rankCandidates, debug: debugLines }, null, 2));
    } catch { /* ignore */ }
  };
  setInterval(() => {
    console.log(`  [stats] sockets ${stats.sockets} | frames ${stats.frames} | decoded ${stats.decoded} | messages ${stats.messages} | errors ${stats.errors} | text ${stats.other}`);
  }, 30000);
  setInterval(writeStatus, 10000);

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
    if (quiet && Date.now() - lastFrameAt > 90000 && !page.isClosed()) {
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
    if (REPLAY_FILE) { await replaySession(REPLAY_FILE, REPLAY_SPEED); return; }
    const key = eulerKey();
    if (key) await startEuler(key);
    else await startCapture();
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

export { handleMessages, recordGift, findRankCandidates, handleBattleTask, state };
