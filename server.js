#!/usr/bin/env node
/* Atoms! LAN server. Serves the game and hosts network games. No dependencies: run `node server.js`.
   Games live in memory and disappear when the server stops.

   Settings (environment variables):
     PORT      port to listen on (default 8080)
     HOST      address to listen on, e.g. 192.168.1.20 to accept only that network (default: all networks)
     TLS_CERT  path to a certificate (PEM) and
     TLS_KEY   path to its private key, to serve over https instead of http */
'use strict';
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const Core = require('./atoms-core.js');

const PORT = Number(process.env.PORT) || 8080;
const HOST = process.env.HOST || undefined;
const TLS = process.env.TLS_CERT && process.env.TLS_KEY
  ? { cert: fs.readFileSync(process.env.TLS_CERT), key: fs.readFileSync(process.env.TLS_KEY) }
  : null;

const STATIC = new Map([['/', 'index.html'], ['/index.html', 'index.html'], ['/atoms-core.js', 'atoms-core.js']]);
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };
const SEAT_TIMEOUT = 30000;      // a seat whose player has been offline this long goes back to the CPU
const ROOM_IDLE = 30 * 60e3;     // games nobody has had open for this long are removed

// Limits that keep one misbehaving computer from tying up the server.
const MAX_ROOMS = 200;           // games kept at once
const ROOMS_PER_IP = 20;         // new games one address may start per hour
const POSTS_PER_IP = 120;        // actions one address may send per minute
const STREAMS_PER_IP = 20;       // open game connections per address
const STREAMS_PER_ROOM = 40;     // players and watchers per game

const rooms = new Map();
const newId = () => crypto.randomBytes(12).toString('hex');   // 96 random bits: links can't be guessed
const validRoom = s => typeof s === 'string' && /^[a-f0-9]{24}$/.test(s);
const cleanName = s => String(s || '').replace(/[\u0000-\u001f<>&"]/g, '').trim().slice(0, 16);
const validClient = s => typeof s === 'string' && /^[A-Za-z0-9_-]{16,64}$/.test(s);

function lanAddresses() {
  if (HOST && HOST !== '0.0.0.0' && HOST !== '::') return [HOST];
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) if (a.family === 'IPv4' && !a.internal) out.push(a.address);
  }
  return out;
}

/* ---------- per-address limits ---------- */
const buckets = new Map();   // `${kind}:${ip}` -> { n, reset }
function allow(kind, ip, max, windowMs) {
  const key = kind + ':' + ip, now = Date.now();
  let b = buckets.get(key);
  if (!b || now > b.reset) { b = { n: 0, reset: now + windowMs }; buckets.set(key, b); }
  return ++b.n <= max;
}
const streams = new Map();   // ip -> open event streams
const clientIp = req => req.socket.remoteAddress || '?';

/* ---------- rooms ---------- */
function createRoom(host, hostName, slots, size, landscape, levels) {
  let [c, r] = Core.SIZES[size];
  if (landscape) [c, r] = [r, c];
  const room = {
    id: newId(), host, size, landscape,
    names: new Map(), seats: [], clients: new Set(), cpuTimer: null, touched: Date.now(), offline: new Map(),
  };
  room.names.set(host, cleanName(hostName) || 'Host');
  // seats[c] = { ctrl: 'off' | 'cpu' | 'human', owner: clientId }
  room.seats = slots.map(k => k === 'human' ? { ctrl: 'human', owner: host } : { ctrl: k });
  room.g = Core.makeGame(c, r, slots, levels);
  rooms.set(room.id, room);
  scheduleCpu(room, 900);   // a CPU may have the first move; it starts once someone has the game open
  return room;
}

function removeRoom(room) {
  clearTimeout(room.cpuTimer);
  for (const t of room.offline.values()) clearTimeout(t);
  rooms.delete(room.id);
}

function syncKinds(room) {
  for (const p of room.g.players) p.kind = room.seats[p.c].ctrl === 'human' ? 'human' : 'cpu';
}

function online(room, id) {
  for (const cl of room.clients) if (cl.id === id) return true;
  return false;
}

function publicState(room, viewer) {
  return {
    room: room.id, size: room.size,
    host: room.host === viewer,
    g: room.g,
    seats: room.seats.map(s => s.ctrl === 'human'
      ? { ctrl: 'human', mine: s.owner === viewer, name: room.names.get(s.owner) || 'Guest', online: online(room, s.owner), isHost: s.owner === room.host }
      : { ctrl: s.ctrl }),
    watchers: [...room.clients].filter(cl => !room.seats.some(s => s.owner === cl.id)).length,
  };
}

function send(cl, event, data) {
  if (!cl.res.writableEnded) cl.res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}
function broadcast(room, event, extra = {}) {
  for (const cl of room.clients) send(cl, event, { ...extra, ...publicState(room, cl.id) });
}

// CPUs only play while someone has the game open, so games nobody watches don't use the processor.
function scheduleCpu(room, delay) {
  clearTimeout(room.cpuTimer);
  const g = room.g;
  if (g.over || !room.clients.size) return;
  const p = g.players[g.turn];
  if (room.seats[p.c].ctrl !== 'cpu') return;
  room.cpuTimer = setTimeout(() => {
    if (room.g !== g || g.over || !room.clients.size || room.seats[g.players[g.turn].c].ctrl !== 'cpu') return;
    move(room, Core.cpuMove(g));
  }, delay);
}

function move(room, cell) {
  const g = room.g, player = g.players[g.turn].c;
  const { waves } = Core.applyMove(g, cell);
  room.touched = Date.now();
  broadcast(room, 'move', { cell, player });
  // give every page time to animate the chain before the CPU answers
  let anim = 300;
  for (let w = 0; w < waves; w++) anim += Core.waveDuration(w);
  scheduleCpu(room, anim + 450);
}

function seatOffline(room, id) {
  // a player dropped: their seats go to the CPU unless they come back in time
  if (!room.seats.some(s => s.owner === id)) return;
  clearTimeout(room.offline.get(id));
  room.offline.set(id, setTimeout(() => {
    room.offline.delete(id);
    if (online(room, id)) return;
    let changed = false;
    for (const s of room.seats) if (s.owner === id) { s.ctrl = 'cpu'; delete s.owner; changed = true; }
    if (changed) { syncKinds(room); broadcast(room, 'state'); scheduleCpu(room, 600); }
  }, SEAT_TIMEOUT));
}

setInterval(() => {
  const now = Date.now();
  for (const room of rooms.values()) if (!room.clients.size && now - room.touched > ROOM_IDLE) removeRoom(room);
  for (const room of rooms.values()) for (const cl of room.clients) if (!cl.res.writableEnded) cl.res.write(': ping\n\n');
  for (const [k, b] of buckets) if (now > b.reset) buckets.delete(k);
}, 20000).unref();

/* ---------- http ---------- */
const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
};

function json(res, code, body) {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...SECURITY_HEADERS });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.setEncoding('utf8');
    req.on('data', chunk => { data += chunk; if (data.length > 4096) { reject(new Error('Request too large.')); req.destroy(); } });
    req.on('end', () => {
      try {
        const b = data ? JSON.parse(data) : {};
        if (!b || typeof b !== 'object' || Array.isArray(b)) throw new Error();
        resolve(b);
      } catch { reject(new Error('Bad request.')); }
    });
    req.on('error', reject);
  });
}

// Requests from other websites are refused. Browsers send Origin with every cross-site POST, and
// requiring a JSON content type means a page elsewhere can't send one without asking first.
function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try { return new URL(origin).host === req.headers.host; } catch { return false; }
}

async function api(req, res, url) {
  const ip = clientIp(req);
  const parts = url.pathname.split('/').filter(Boolean); // ['api', 'rooms', id, action]
  if (parts[1] === 'ping' && parts.length === 2) return json(res, 200, { ok: true, addresses: lanAddresses(), port: PORT });
  if (parts[1] !== 'rooms' || parts.length > 4) return json(res, 404, { error: 'Not found' });

  if (req.method === 'POST') {
    if (!sameOrigin(req)) return json(res, 403, { error: 'Requests from other websites are not accepted.' });
    if (!/^application\/json\b/i.test(req.headers['content-type'] || '')) return json(res, 415, { error: 'Send JSON.' });
    if (!allow('post', ip, POSTS_PER_IP, 60e3)) return json(res, 429, { error: 'Too many requests. Wait a moment and try again.' });
  }

  if (req.method === 'POST' && parts.length === 2) {
    const b = await readBody(req);
    const slots = Array.isArray(b.slots) && b.slots.length === 4 && b.slots.every(s => ['off', 'human', 'cpu'].includes(s)) ? b.slots : null;
    if (!slots || slots.filter(s => s !== 'off').length < 2) return json(res, 400, { error: 'Pick at least two players.' });
    if (!Core.isSize(b.size)) return json(res, 400, { error: 'Unknown grid size.' });
    if (!validClient(b.client)) return json(res, 400, { error: 'Missing client id.' });
    const levels = b.levels;
    if (levels !== undefined && !(Array.isArray(levels) && levels.length === 4 && levels.every(Core.isLevel))) return json(res, 400, { error: 'Unknown CPU level.' });
    if (rooms.size >= MAX_ROOMS) return json(res, 503, { error: 'The server is hosting too many games. Try again later.' });
    if (!allow('room', ip, ROOMS_PER_IP, 3600e3)) return json(res, 429, { error: 'You have started a lot of games. Wait a while before starting another.' });
    const room = createRoom(b.client, b.name, slots, b.size, !!b.landscape, levels);
    return json(res, 200, { room: room.id });
  }

  const room = validRoom(parts[2]) ? rooms.get(parts[2]) : undefined;
  if (!room) return json(res, 404, { error: 'This game no longer exists. Ask the host for a new link.' });
  const action = parts[3];

  if (req.method === 'GET' && !action) return json(res, 200, { ok: true });

  if (req.method === 'GET' && action === 'events') {
    const id = url.searchParams.get('client');
    if (!validClient(id)) return json(res, 400, { error: 'Missing client id.' });
    if ((streams.get(ip) || 0) >= STREAMS_PER_IP) return json(res, 429, { error: 'Too many open games from this computer.' });
    if (room.clients.size >= STREAMS_PER_ROOM) return json(res, 503, { error: 'This game is full.' });
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no', ...SECURITY_HEADERS });
    res.write('retry: 2000\n\n');
    const cl = { id, res };
    streams.set(ip, (streams.get(ip) || 0) + 1);
    room.clients.add(cl); room.touched = Date.now();
    clearTimeout(room.offline.get(id)); room.offline.delete(id);
    broadcast(room, 'state');
    if (room.clients.size === 1) scheduleCpu(room, 900);   // resume CPUs that waited for someone to watch
    req.on('close', () => {
      const left = (streams.get(ip) || 1) - 1;
      if (left > 0) streams.set(ip, left); else streams.delete(ip);
      room.clients.delete(cl);
      room.touched = Date.now();
      if (!online(room, id)) seatOffline(room, id);
      broadcast(room, 'state');
    });
    return;
  }

  if (req.method !== 'POST') return json(res, 405, { error: 'Method not allowed' });
  const b = await readBody(req);
  if (!validClient(b.client)) return json(res, 400, { error: 'Missing client id.' });
  const me = b.client;
  // only people who have the game open get a name entry, so names can't pile up
  if (b.name !== undefined && online(room, me)) room.names.set(me, cleanName(b.name) || room.names.get(me) || 'Guest');

  if (action === 'join') {
    const c = Number(b.seat);
    const seat = Number.isInteger(c) ? room.seats[c] : undefined;
    if (!seat || seat.ctrl === 'off') return json(res, 400, { error: 'That colour is not in this game.' });
    if (!online(room, me)) return json(res, 409, { error: 'Open the game before taking a seat.' });
    if (seat.ctrl === 'human' && seat.owner !== me) return json(res, 409, { error: `${room.names.get(seat.owner) || 'Someone'} already plays ${Core.NAMES[c]}.` });
    seat.ctrl = 'human'; seat.owner = me;
    syncKinds(room);
    broadcast(room, 'state');
    scheduleCpu(room, 900); // cancels the CPU's pending move if this seat was about to play, keeps others going
    return json(res, 200, { ok: true });
  }

  if (action === 'leave') {
    for (const s of room.seats) if (s.owner === me) { s.ctrl = 'cpu'; delete s.owner; }
    syncKinds(room); broadcast(room, 'state'); scheduleCpu(room, 600);
    return json(res, 200, { ok: true });
  }

  if (action === 'name') { broadcast(room, 'state'); return json(res, 200, { ok: true }); }

  if (action === 'move') {
    const g = room.g, cell = Number(b.cell);
    if (g.over) return json(res, 409, { error: 'The game is over.' });
    if (b.seq !== g.seq) return json(res, 409, { error: 'The board changed. Try again.' });
    const p = g.players[g.turn], seat = room.seats[p.c];
    if (seat.ctrl !== 'human' || seat.owner !== me) return json(res, 403, { error: "It's not your turn." });
    if (!Number.isInteger(cell) || cell < 0 || cell >= g.o.length || !Core.legal(g, cell, p.c)) return json(res, 400, { error: 'That square belongs to another player.' });
    move(room, cell);
    return json(res, 200, { ok: true });
  }

  if (action === 'rematch') {
    if (me !== room.host) return json(res, 403, { error: 'Only the host can start a rematch.' });
    let [c, r] = Core.SIZES[room.size];
    if (room.landscape) [c, r] = [r, c];
    const seq = room.g.seq + 1;
    const levels = room.seats.map((s, i) => (room.g.players.find(p => p.c === i) || {}).level);
    room.g = Core.makeGame(c, r, room.seats.map(s => s.ctrl), levels);
    room.g.seq = seq;
    syncKinds(room); broadcast(room, 'state', { fresh: true }); scheduleCpu(room, 900);
    return json(res, 200, { ok: true });
  }

  return json(res, 404, { error: 'Not found' });
}

async function handle(req, res) {
  let url;
  try { url = new URL(req.url, 'http://x'); } catch { res.writeHead(400); return res.end(); }
  try {
    if (url.pathname.startsWith('/api/')) return await api(req, res, url);
    const file = STATIC.get(url.pathname);
    if (req.method !== 'GET' || !file) { res.writeHead(404, { 'Content-Type': 'text/plain', ...SECURITY_HEADERS }); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)], 'Cache-Control': 'no-cache', ...SECURITY_HEADERS });
    fs.createReadStream(path.join(__dirname, file)).on('error', () => res.destroy()).pipe(res);
  } catch (e) {
    if (!res.headersSent) json(res, 400, { error: e.message || 'Bad request.' });
  }
}

const server = TLS ? https.createServer(TLS, handle) : http.createServer(handle);
server.requestTimeout = 30000;   // slow or stalled uploads are dropped (event streams are long GETs and unaffected)
server.headersTimeout = 15000;

server.listen(PORT, HOST, () => {
  const scheme = TLS ? 'https' : 'http';
  console.log('Atoms! is running.');
  if (!HOST || HOST === '0.0.0.0' || HOST === '::') console.log(`  This computer:  ${scheme}://localhost:${PORT}`);
  for (const a of lanAddresses()) console.log(`  Your network:   ${scheme}://${a}:${PORT}`);
  console.log('Anyone who can reach these addresses can open the game. Only run it on networks you trust.');
});
