// Party game server: static files + WebSocket rooms + minigame simulation.
const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

// ---------- static file server ----------
const server = http.createServer((req, res) => {
  const url = decodeURIComponent(req.url.split('?')[0]);
  let base, rel;
  if (url.startsWith('/vendor/three/')) {
    base = path.join(__dirname, 'node_modules', 'three', 'build');
    rel = url.slice('/vendor/three/'.length);
  } else {
    base = path.join(__dirname, 'public');
    rel = url === '/' ? 'index.html' : url.slice(1);
  }
  const file = path.normalize(path.join(base, rel));
  if (!file.startsWith(base)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
});

// ---------- game constants ----------
const N = 9;              // tiles per side
const S = 2;              // tile size
const HALF = (N * S) / 2; // arena half-size
const TICK = 1 / 30;
const SPEED = 6.5;
const RADIUS = 0.55;
const MAX_PLAYERS = 4;
const COLORS = ['#ff5a36', '#35c9ff', '#9be22e', '#ffd21f'];
const ROUND_PLAN = ['crumble', 'crusher', 'crusher', 'crumble'];
const GAME_NAMES = { crumble: 'Crumbling Floor', crusher: 'Crusher Zone' };

const rooms = new Map();

function makeCode() {
  const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  for (;;) {
    let c = '';
    for (let i = 0; i < 4; i++) c += letters[Math.floor(Math.random() * letters.length)];
    if (!rooms.has(c)) return c;
  }
}

const tileCenter = (i) => ({
  x: ((i % N) - (N - 1) / 2) * S,
  z: (Math.floor(i / N) - (N - 1) / 2) * S,
});
function tileAt(x, z) {
  const c = Math.floor(x / S + N / 2);
  const r = Math.floor(z / S + N / 2);
  if (c < 0 || c >= N || r < 0 || r >= N) return -1;
  return r * N + c;
}

// tile states: 0 ok, 1 cracking, 2 gone, 3 warning, 4 crushed
function newRoom(code) {
  return {
    code,
    clients: new Map(), // id -> {ws, p}
    hostId: null,
    phase: 'lobby',
    timer: 0,
    round: 0,
    game: null,
    elapsed: 0,
    tiles: [],
    deadCount: 0,
    winnerId: null,
    spawnTimer: 0,
    nextId: 1,
    pending: [],
    message: '',
  };
}

function resetTiles(room) {
  room.tiles = Array.from({ length: N * N }, () => ({ s: 0, t: 0, stand: 0 }));
}

function startRound(room) {
  room.game = ROUND_PLAN[room.round % ROUND_PLAN.length];
  room.phase = 'countdown';
  room.timer = 3.5;
  room.elapsed = 0;
  room.deadCount = 0;
  room.pending = [];
  room.winnerId = null;
  room.spawnTimer = 2;
  resetTiles(room);
  const list = [...room.clients.values()].map((c) => c.p);
  list.forEach((p, i) => {
    const a = (i / list.length) * Math.PI * 2 + 0.4;
    p.x = Math.cos(a) * 5; p.z = Math.sin(a) * 5; p.y = 0;
    p.vx = p.vz = p.kx = p.kz = p.vy = 0;
    p.ix = p.iz = 0;
    p.alive = true; p.falling = false; p.squished = false;
    p.shoveCd = 0; p.shoveFx = 0; p.rank = 0;
    p.ry = Math.atan2(-p.x, -p.z);
  });
}

function eliminate(room, p, squished) {
  if (!p.alive) return;
  p.alive = false;
  p.squished = !!squished;
  room.pending.push(p);
}
function settleDeaths(room) {
  if (!room.pending.length) return;
  const r = room.deadCount + 1;
  room.pending.forEach((p) => { p.rank = r; });
  room.deadCount += room.pending.length;
  room.pending = [];
}

function update(room) {
  const dt = TICK;
  const players = [...room.clients.values()].map((c) => c.p);

  if (room.phase === 'countdown') {
    room.timer -= dt;
    if (room.timer <= 0) { room.phase = 'play'; room.timer = 0; }
  }

  if (room.phase === 'play') {
    room.elapsed += dt;
    updateHazards(room, players, dt);
  }

  if (room.phase === 'play' || room.phase === 'countdown' || room.phase === 'roundEnd') {
    movePlayers(room, players, dt, room.phase === 'play');
  }

  if (room.phase === 'play') {
    settleDeaths(room);
    const alive = players.filter((p) => p.alive);
    const limit = players.length > 1 ? 1 : 0;
    if (alive.length <= limit || room.elapsed > 80) {
      // score
      const n = players.length;
      const survivors = alive;
      survivors.forEach((p) => { p.rank = n; });
      players.forEach((p) => { p.score += p.rank - 1; });
      if (survivors.length === 1 && n > 1) {
        survivors[0].score += 1;
        room.winnerId = survivors[0].id;
      }
      room.phase = 'roundEnd';
      room.timer = 4;
    }
  } else if (room.phase === 'roundEnd') {
    room.timer -= dt;
    if (room.timer <= 0) {
      room.round++;
      if (room.round >= ROUND_PLAN.length) { room.phase = 'final'; room.timer = 10; }
      else startRound(room);
    }
  } else if (room.phase === 'final') {
    room.timer -= dt;
    if (room.timer <= 0) toLobby(room);
  }
}

function toLobby(room) {
  room.phase = 'lobby';
  room.round = 0;
  room.game = null;
  room.clients.forEach((c) => { c.p.score = 0; c.p.alive = true; c.p.falling = false; c.p.squished = false; c.p.y = 0; });
  resetTiles(room);
}

function movePlayers(room, players, dt, active) {
  for (const p of players) {
    p.shoveCd = Math.max(0, p.shoveCd - dt);
    p.shoveFx = Math.max(0, p.shoveFx - dt);
    if (!p.alive && !p.falling) continue;
    if (p.falling) {
      p.vy -= 28 * dt;
      p.y += p.vy * dt;
      p.x += (p.vx + p.kx) * dt;
      p.z += (p.vz + p.kz) * dt;
      if (p.y < -7) { p.falling = false; p.y = -20; }
      continue;
    }
    let ix = p.ix, iz = p.iz;
    const len = Math.hypot(ix, iz);
    if (len > 1) { ix /= len; iz /= len; }
    if (!active) { ix = 0; iz = 0; }
    p.vx += (ix * SPEED - p.vx) * Math.min(1, dt * 12);
    p.vz += (iz * SPEED - p.vz) * Math.min(1, dt * 12);
    p.x += (p.vx + p.kx) * dt;
    p.z += (p.vz + p.kz) * dt;
    const decay = Math.exp(-4.5 * dt);
    p.kx *= decay; p.kz *= decay;
    if (Math.hypot(p.vx, p.vz) > 0.5) p.ry = Math.atan2(p.vx, p.vz);
  }
  // player-vs-player separation
  for (let i = 0; i < players.length; i++) {
    for (let j = i + 1; j < players.length; j++) {
      const a = players[i], b = players[j];
      if (!a.alive || !b.alive || a.falling || b.falling) continue;
      const dx = b.x - a.x, dz = b.z - a.z;
      const d = Math.hypot(dx, dz);
      if (d > 0 && d < RADIUS * 2) {
        const push = (RADIUS * 2 - d) / 2;
        a.x -= (dx / d) * push; a.z -= (dz / d) * push;
        b.x += (dx / d) * push; b.z += (dz / d) * push;
      }
    }
  }
  // floor check
  if (room.game && active) {
    for (const p of players) {
      if (!p.alive || p.falling) continue;
      const ti = tileAt(p.x, p.z);
      if (ti < 0 || room.tiles[ti].s === 2) { p.falling = true; p.vy = 0; eliminate(room, p, false); }
    }
  }
}

function updateHazards(room, players, dt) {
  const tiles = room.tiles;
  const live = players.filter((p) => p.alive && !p.falling);

  if (room.game === 'crumble') {
    // tiles crack when stood on
    for (const p of live) {
      const ti = tileAt(p.x, p.z);
      if (ti >= 0 && tiles[ti].s === 0) {
        tiles[ti].stand += dt;
        if (tiles[ti].stand > 0.45) { tiles[ti].s = 1; tiles[ti].t = 0.8; }
      }
    }
    // random cracking, accelerating
    room.spawnTimer -= dt;
    if (room.spawnTimer <= 0) {
      const ok = tiles.map((t, i) => (t.s === 0 ? i : -1)).filter((i) => i >= 0);
      if (ok.length) {
        const i = ok[Math.floor(Math.random() * ok.length)];
        tiles[i].s = 1; tiles[i].t = 0.9;
      }
      room.spawnTimer = Math.max(0.25, 1.3 - room.elapsed * 0.02);
    }
    tiles.forEach((t) => {
      if (t.s === 1) { t.t -= dt; if (t.t <= 0) t.s = 2; }
    });
  }

  if (room.game === 'crusher') {
    room.spawnTimer -= dt;
    if (room.spawnTimer <= 0) {
      const count = Math.min(7, 2 + Math.floor(room.elapsed / 8));
      const warn = Math.max(0.8, 1.5 - room.elapsed * 0.012);
      for (let k = 0; k < count; k++) {
        let i;
        if (live.length && Math.random() < 0.55) {
          const p = live[Math.floor(Math.random() * live.length)];
          i = tileAt(p.x, p.z);
        } else i = Math.floor(Math.random() * N * N);
        if (i >= 0 && tiles[i].s === 0) { tiles[i].s = 3; tiles[i].t = warn; }
      }
      room.spawnTimer = Math.max(0.9, 2.2 - room.elapsed * 0.02);
    }
    tiles.forEach((t, i) => {
      if (t.s === 3) {
        t.t -= dt;
        if (t.t <= 0) {
          t.s = 4; t.t = 0.7;
          const c = tileCenter(i);
          for (const p of players) {
            if (!p.alive || p.falling) continue;
            if (Math.abs(p.x - c.x) < S / 2 + 0.15 && Math.abs(p.z - c.z) < S / 2 + 0.15) eliminate(room, p, true);
          }
        }
      } else if (t.s === 4) {
        t.t -= dt;
        if (t.t <= 0) t.s = 0;
      }
    });
  }
}

function snapshot(room) {
  const players = [...room.clients.values()].map((c) => c.p);
  return {
    t: 'state',
    phase: room.phase,
    game: room.game,
    gameName: room.game ? GAME_NAMES[room.game] : '',
    timer: Math.round(room.timer * 10) / 10,
    round: room.round + 1,
    rounds: ROUND_PLAN.length,
    winnerId: room.winnerId,
    tiles: room.tiles.map((t) => t.s).join(''),
    players: players.map((p) => ({
      id: p.id, name: p.name, color: p.color, score: p.score,
      x: +p.x.toFixed(2), y: +p.y.toFixed(2), z: +p.z.toFixed(2), ry: +p.ry.toFixed(2),
      alive: p.alive, sq: p.squished, fx: p.shoveFx > 0,
    })),
  };
}

function lobbyInfo(room) {
  return {
    t: 'room',
    code: room.code,
    hostId: room.hostId,
    phase: room.phase,
    players: [...room.clients.values()].map((c) => ({ id: c.p.id, name: c.p.name, color: c.p.color })),
  };
}

function broadcast(room, msg) {
  const data = JSON.stringify(msg);
  room.clients.forEach((c) => { if (c.ws.readyState === 1) c.ws.send(data); });
}

function addPlayer(room, ws, name) {
  const used = new Set([...room.clients.values()].map((c) => c.p.color));
  const color = COLORS.find((c) => !used.has(c)) || COLORS[0];
  const id = room.nextId++;
  const p = {
    id, name: (name || 'Player').toString().slice(0, 12) || 'Player', color, score: 0,
    x: 0, y: 0, z: 0, vx: 0, vz: 0, kx: 0, kz: 0, vy: 0, ix: 0, iz: 0, ry: 0,
    alive: true, falling: false, squished: false, shoveCd: 0, shoveFx: 0, rank: 0,
  };
  room.clients.set(id, { ws, p });
  if (!room.hostId) room.hostId = id;
  ws.room = room; ws.pid = id;
  ws.send(JSON.stringify({ t: 'joined', id, code: room.code }));
  broadcast(room, lobbyInfo(room));
}

function removePlayer(ws) {
  const room = ws.room;
  if (!room) return;
  room.clients.delete(ws.pid);
  ws.room = null;
  if (room.clients.size === 0) { rooms.delete(room.code); return; }
  if (room.hostId === ws.pid) room.hostId = room.clients.keys().next().value;
  broadcast(room, lobbyInfo(room));
}

// ---------- websocket ----------
const wss = new WebSocketServer({ server, maxPayload: 2048 });
wss.on('connection', (ws) => {
  ws.on('message', (raw) => {
    let m;
    try { m = JSON.parse(raw); } catch { return; }
    if (!m || typeof m.t !== 'string') return;
    const room = ws.room;
    if (m.t === 'create' && !room) {
      const r = newRoom(makeCode());
      rooms.set(r.code, r);
      addPlayer(r, ws, m.name);
    } else if (m.t === 'join' && !room) {
      const r = rooms.get(String(m.code || '').toUpperCase().trim());
      if (!r) return ws.send(JSON.stringify({ t: 'error', msg: 'Room not found' }));
      if (r.phase !== 'lobby') return ws.send(JSON.stringify({ t: 'error', msg: 'Game already in progress' }));
      if (r.clients.size >= MAX_PLAYERS) return ws.send(JSON.stringify({ t: 'error', msg: 'Room is full (max 4)' }));
      addPlayer(r, ws, m.name);
    } else if (room) {
      const c = room.clients.get(ws.pid);
      if (!c) return;
      if (m.t === 'start' && ws.pid === room.hostId && room.phase === 'lobby') {
        room.clients.forEach((cl) => { cl.p.score = 0; });
        room.round = 0;
        startRound(room);
        broadcast(room, lobbyInfo(room));
      } else if (m.t === 'input') {
        c.p.ix = Math.max(-1, Math.min(1, +m.x || 0));
        c.p.iz = Math.max(-1, Math.min(1, +m.z || 0));
      } else if (m.t === 'shove' && room.phase === 'play') {
        const p = c.p;
        if (!p.alive || p.falling || p.shoveCd > 0) return;
        p.shoveCd = 1.2; p.shoveFx = 0.25;
        room.clients.forEach((o) => {
          const q = o.p;
          if (q === p || !q.alive || q.falling) return;
          const dx = q.x - p.x, dz = q.z - p.z, d = Math.hypot(dx, dz);
          if (d > 0 && d < 2.4) { q.kx += (dx / d) * 15; q.kz += (dz / d) * 15; }
        });
      }
    }
  });
  ws.on('close', () => removePlayer(ws));
  ws.on('error', () => {});
});

setInterval(() => {
  rooms.forEach((room) => {
    if (room.phase !== 'lobby') update(room);
    broadcast(room, snapshot(room));
  });
}, TICK * 1000);

server.listen(PORT, () => console.log('Game running on http://localhost:' + PORT));
