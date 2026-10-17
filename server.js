#!/usr/bin/env node
/* Atoms! LAN server. Serves the game and hosts network games. No dependencies: run `node server.js`.
   Set PORT to change the port (default 8080). Games live in memory and disappear when the server stops. */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const Core = require('./atoms-core.js');

const PORT = Number(process.env.PORT) || 8080;
const STATIC = { '/': 'index.html', '/index.html': 'index.html', '/atoms-core.js': 'atoms-core.js' };
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };
const SEAT_TIMEOUT = 30000;   // a seat whose player has been offline this long goes back to the CPU
const ROOM_IDLE = 3 * 3600e3; // rooms nobody has looked at for this long are removed

const rooms = new Map();
const newId = () => crypto.randomBytes(4).toString('hex');
const cleanName = s => String(s || '').replace(/[\u0000-\u001f<>&"]/g, '').trim().slice(0, 16);
const validClient = s => typeof s === 'string' && /^[A-Za-z0-9_-]{16,64}$/.test(s);

function lanAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) if (a.family === 'IPv4' && !a.internal) out.push(a.address);
  }
  return out;
}

/* ---------- rooms ---------- */
function createRoom(host, hostName, slots, size, landscape, levels) {
  let [c, r] = Core.SIZES[size];
  if (landscape) [c, r] = [r, c];
  const room = {
    id: newId(), host, size, landscape, slots,
    names: {}, seats: [], clients: new Set(), cpuTimer: null, touched: Date.now(), offline: new Map(),
  };
  room.names[host] = cleanName(hostName) || 'Host';
  // seats[c] = { ctrl: 'off' | 'cpu' | 'human', owner: clientId }
  room.seats = slots.map(k => k === 'human' ? { ctrl: 'human', owner: host } : { ctrl: k });
  room.g = Core.makeGame(c, r, slots, levels);
  rooms.set(room.id, room);
  return room;
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
      ? { ctrl: 'human', mine: s.owner === viewer, name: room.names[s.owner] || 'Guest', online: online(room, s.owner), isHost: s.owner === room.host }
      : { ctrl: s.ctrl }),
    watchers: [...room.clients].filter(cl => !room.seats.some(s => s.owner === cl.id)).length,
  };
}

function send(cl, event, data) {
  cl.res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}
function broadcast(room, event, extra = {}) {
  for (const cl of room.clients) send(cl, event, { ...extra, ...publicState(room, cl.id) });
}

function scheduleCpu(room, delay) {
  clearTimeout(room.cpuTimer);
  const g = room.g;
  if (g.over) return;
  const p = g.players[g.turn];
  if (room.seats[p.c].ctrl !== 'cpu') return;
  room.cpuTimer = setTimeout(() => {
    if (room.g !== g || g.over || room.seats[g.players[g.turn].c].ctrl !== 'cpu') return;
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
  for (const [id, room] of rooms) if (!room.clients.size && now - room.touched > ROOM_IDLE) { clearTimeout(room.cpuTimer); rooms.delete(id); }
  for (const room of rooms.values()) for (const cl of room.clients) cl.res.write(': ping\n\n');
}, 20000).unref();

/* ---------- http ---------- */
function json(res, code, body) {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => { data += chunk; if (data.length > 4096) { reject(new Error('too large')); req.destroy(); } });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch { reject(new Error('bad json')); } });
    req.on('error', reject);
  });
}

async function api(req, res, url) {
  const parts = url.pathname.split('/').filter(Boolean); // ['api', 'rooms', id, action]
  if (parts[1] === 'ping') return json(res, 200, { ok: true, addresses: lanAddresses(), port: PORT });

  if (parts[1] !== 'rooms') return json(res, 404, { error: 'Not found' });

  if (req.method === 'POST' && parts.length === 2) {
    const b = await readBody(req);
    const slots = Array.isArray(b.slots) && b.slots.length === 4 && b.slots.every(s => ['off', 'human', 'cpu'].includes(s)) ? b.slots : null;
    if (!slots || slots.filter(s => s !== 'off').length < 2) return json(res, 400, { error: 'Pick at least two players.' });
    if (!Core.SIZES[b.size]) return json(res, 400, { error: 'Unknown grid size.' });
    if (!validClient(b.client)) return json(res, 400, { error: 'Missing client id.' });
    const levels = b.levels === undefined ? undefined : b.levels;
    if (levels !== undefined && !(Array.isArray(levels) && levels.length === 4 && levels.every(l => Core.LEVELS[l]))) return json(res, 400, { error: 'Unknown CPU level.' });
    const room = createRoom(b.client, b.name, slots, b.size, !!b.landscape, levels);
    return json(res, 200, { room: room.id });
  }

  const room = rooms.get(parts[2]);
  if (!room) return json(res, 404, { error: 'This game no longer exists. Ask the host for a new link.' });
  const action = parts[3];

  if (req.method === 'GET' && !action) return json(res, 200, { ok: true });

  if (req.method === 'GET' && action === 'events') {
    const id = url.searchParams.get('client');
    if (!validClient(id)) return json(res, 400, { error: 'Missing client id.' });
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.write('retry: 2000\n\n');
    const cl = { id, res };
    room.clients.add(cl); room.touched = Date.now();
    clearTimeout(room.offline.get(id)); room.offline.delete(id);
    broadcast(room, 'state');
    req.on('close', () => {
      room.clients.delete(cl);
      if (!online(room, id)) seatOffline(room, id);
      broadcast(room, 'state');
    });
    return;
  }

  if (req.method !== 'POST') return json(res, 405, { error: 'Method not allowed' });
  const b = await readBody(req);
  if (!validClient(b.client)) return json(res, 400, { error: 'Missing client id.' });
  const me = b.client;
  if (b.name !== undefined) room.names[me] = cleanName(b.name) || room.names[me] || 'Guest';

  if (action === 'join') {
    const c = Number(b.seat);
    const seat = room.seats[c];
    if (!seat || seat.ctrl === 'off') return json(res, 400, { error: 'That colour is not in this game.' });
    if (seat.ctrl === 'human' && seat.owner !== me) return json(res, 409, { error: `${room.names[seat.owner] || 'Someone'} already plays ${Core.NAMES[c]}.` });
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

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (url.pathname.startsWith('/api/')) return await api(req, res, url);
    const file = STATIC[url.pathname];
    if (req.method !== 'GET' || !file) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)], 'Cache-Control': 'no-cache' });
    fs.createReadStream(path.join(__dirname, file)).pipe(res);
  } catch (e) {
    if (!res.headersSent) json(res, 400, { error: e.message });
  }
});

server.listen(PORT, () => {
  console.log(`Atoms! is running.`);
  console.log(`  This computer:  http://localhost:${PORT}`);
  for (const a of lanAddresses()) console.log(`  Your network:   http://${a}:${PORT}`);
});
