// Party game server: static files + server list + WebSocket rooms + minigame simulation.
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

// ---------- constants ----------
const N = 9;              // tiles per side
const S = 2;              // tile size
const HALF = (N * S) / 2; // arena half-size
const TICK = 1 / 30;
const RADIUS = 0.55;
const MAX_PLAYERS = 4;
const COLORS = ['#ff5a36', '#35c9ff', '#9be22e', '#ffd21f', '#c06bff', '#ff6bb5', '#ffffff', '#2fe0b0'];
const GAMES = {
  crumble: 'Crumbling Floor',
  crusher: 'Crusher Zone',
  armory: 'Armory Brawl',
  bomb: 'Hot Bomb',
  meteors: 'Falling Meteors',
  disasters: 'Natural Disasters',
  hill: 'King of the Hill',
  zombies: 'Zombie Survival',
  chairs: 'Musical Chairs',
};
const TIMED = { hill: 45, zombies: 40 }; // seconds, these modes end on a timer
const HILL_R = 2.6;
const SPEEDS = { slow: 5.2, normal: 6.5, fast: 8.2 };
const SHOVES = { off: 0, normal: 15, strong: 26 };
const HAZ = { chill: 0.7, normal: 1, chaos: 1.6 };
const WEAPON_AMMO = { blaster: 6, hammer: 4, grenade: 2 };
const DISASTERS = ['earthquake', 'flood', 'tornado', 'lightning'];
const DIS_DUR = { earthquake: 6, flood: 8, tornado: 8, lightning: 7 };
const DIS_NAMES = { earthquake: 'EARTHQUAKE!', flood: 'FLOOD! The edges are going under', tornado: 'TORNADO! Stay away from the vortex', lightning: 'LIGHTNING STORM!' };
// cosmetics: the server only checks that ids exist (ownership is stored in each player's browser)
const HATS = ['cone', 'horns', 'prop', 'tophat', 'halo', 'crown'];
const VISORS = ['cyan', 'pink', 'gold', 'rainbow'];
const TRAILS = ['sparks', 'bubbles', 'hearts'];

const cleanText = (v, max, d) => {
  const t = String(v == null ? '' : v).replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, max);
  return t || d;
};
function cleanCos(c) {
  const o = { hat: '', visor: '', trail: '' };
  if (c && typeof c === 'object') {
    if (HATS.includes(c.hat)) o.hat = c.hat;
    if (VISORS.includes(c.visor)) o.visor = c.visor;
    if (TRAILS.includes(c.trail)) o.trail = c.trail;
  }
  return o;
}

function defaultSettings() {
  return {
    roomName: 'Party room',
    isPublic: true,
    rounds: 5,
    modes: Object.fromEntries(Object.keys(GAMES).map((g) => [g, true])),
    order: 'random',
    hp: 3,
    speed: 'normal',
    shove: 'normal',
    hazards: 'normal',
    winBonus: 1,
    survivalPts: true,
    killPts: 1,
    finalMult: 1,
  };
}

function applySettings(s, inc) {
  if (!inc || typeof inc !== 'object') return;
  const int = (v, lo, hi, d) => { v = Math.round(+v); return Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : d; };
  const pick = (v, table, d) => (typeof v === 'string' && Object.hasOwn(table, v) ? v : d);
  if (typeof inc.roomName === 'string') s.roomName = cleanText(inc.roomName, 24, s.roomName);
  if (typeof inc.isPublic === 'boolean') s.isPublic = inc.isPublic;
  s.rounds = int(inc.rounds, 1, 12, s.rounds);
  s.hp = int(inc.hp, 1, 5, s.hp);
  s.winBonus = int(inc.winBonus, 0, 5, s.winBonus);
  s.killPts = int(inc.killPts, 0, 5, s.killPts);
  s.finalMult = int(inc.finalMult, 1, 3, s.finalMult);
  s.speed = pick(inc.speed, SPEEDS, s.speed);
  s.shove = pick(inc.shove, SHOVES, s.shove);
  s.hazards = pick(inc.hazards, HAZ, s.hazards);
  if (inc.order === 'random' || inc.order === 'fixed') s.order = inc.order;
  if (typeof inc.survivalPts === 'boolean') s.survivalPts = inc.survivalPts;
  if (inc.modes && typeof inc.modes === 'object') {
    for (const g of Object.keys(GAMES)) if (typeof inc.modes[g] === 'boolean') s.modes[g] = inc.modes[g];
    if (!Object.values(s.modes).some(Boolean)) s.modes.crumble = true;
  }
}

function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

function buildPlan(s) {
  const enabled = Object.keys(GAMES).filter((g) => s.modes[g]);
  const plan = [];
  if (s.order === 'fixed') {
    for (let i = 0; i < s.rounds; i++) plan.push(enabled[i % enabled.length]);
    return plan;
  }
  let bag = [];
  while (plan.length < s.rounds) {
    if (!bag.length) {
      bag = shuffle(enabled.slice());
      if (plan.length && bag.length > 1 && bag[0] === plan[plan.length - 1]) bag.push(bag.shift());
    }
    plan.push(bag.shift());
  }
  return plan;
}

const rooms = new Map();

// ---------- http: static files + server list ----------
const server = http.createServer((req, res) => {
  const url = decodeURIComponent(req.url.split('?')[0]);
  if (url === '/api/rooms') {
    const list = [...rooms.values()].filter((r) => r.settings.isPublic).map((r) => {
      const host = r.clients.get(r.hostId);
      return {
        code: r.code, name: r.settings.roomName, host: host ? host.p.name : '',
        players: r.clients.size, max: MAX_PLAYERS, phase: r.phase,
        round: r.round + 1, rounds: r.plan.length || r.settings.rounds,
      };
    });
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify(list));
  }
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

// tile states: 0 ok, 1 cracking, 2 gone, 3 crusher warning, 4 crushed,
// 5 lightning warning, 6 lightning strike, 7 chair, 8 "no chair" warning
function newRoom(code) {
  return {
    code,
    clients: new Map(),
    hostId: null,
    settings: defaultSettings(),
    plan: [],
    phase: 'lobby',
    timer: 0,
    round: 0,
    game: null,
    elapsed: 0,
    tiles: [],
    deadCount: 0,
    pending: [],
    winnerId: null,
    spawnTimer: 0,
    nextId: 1,
    eid: 1,
    pickups: [],
    proj: [],
    bombs: [],
    fx: [],
    meteors: [],
    zombies: [],
    bomb: { holder: 0, fuse: 0, pause: 0 },
    dis: { kind: '', t: 0, dur: 0, calm: 2.5, last: '', acc: 0, q: 0, vx: 0, vz: 0 },
    floodRing: 0,
    hill: { x: 0, z: 0, t: 12, owner: 0, contested: false },
    mc: { phase: 'music', t: 5, chairs: [], wave: 0 },
    info: '',
    startCount: 0,
  };
}

function resetTiles(room) {
  room.tiles = Array.from({ length: N * N }, () => ({ s: 0, t: 0, stand: 0 }));
}

const playersOf = (room) => [...room.clients.values()].map((c) => c.p);

function spawnPickup(room, x, z, type) {
  if (x === undefined) {
    x = (Math.random() * 2 - 1) * (HALF - 2);
    z = (Math.random() * 2 - 1) * (HALF - 2);
  }
  if (!type) {
    const r = Math.random();
    type = r < 0.4 ? 'blaster' : r < 0.7 ? 'hammer' : 'grenade';
  }
  room.pickups.push({ id: room.eid++, type, x, z });
}

function spawnZombie(room) {
  const side = Math.floor(Math.random() * 4);
  const u = (Math.random() * 2 - 1) * (HALF - 1);
  let x, z;
  if (side === 0) { x = u; z = -HALF + 0.3; } else if (side === 1) { x = u; z = HALF - 0.3; }
  else if (side === 2) { x = -HALF + 0.3; z = u; } else { x = HALF - 0.3; z = u; }
  room.zombies.push({ id: room.eid++, x, z, kx: 0, kz: 0, ry: 0 });
}

function startRound(room) {
  room.game = room.plan[room.round];
  room.phase = 'countdown';
  room.timer = 3.5;
  room.elapsed = 0;
  room.deadCount = 0;
  room.pending = [];
  room.winnerId = null;
  room.spawnTimer = 2;
  room.info = '';
  room.pickups = []; room.proj = []; room.bombs = []; room.fx = []; room.meteors = []; room.zombies = [];
  room.bomb = { holder: 0, fuse: 0, pause: 2.5 };
  room.dis = { kind: '', t: 0, dur: 0, calm: 2.5, last: '', acc: 0, q: 0, vx: 0, vz: 0 };
  room.floodRing = 0;
  room.hill = { x: 0, z: 0, t: 12, owner: 0, contested: false };
  room.mc = { phase: 'music', t: 4 + Math.random() * 3, chairs: [], wave: 0 };
  resetTiles(room);
  const list = playersOf(room);
  room.startCount = list.length;
  list.forEach((p, i) => {
    const a = (i / list.length) * Math.PI * 2 + 0.4;
    p.x = Math.cos(a) * 5; p.z = Math.sin(a) * 5; p.y = 0;
    p.vx = p.vz = p.kx = p.kz = p.vy = 0;
    p.ix = p.iz = 0;
    p.alive = true; p.falling = false; p.dm = 0;
    p.shoveCd = 0; p.actFx = 0; p.useCd = 0; p.passCd = 0; p.hitFx = 0;
    p.rank = 0; p.kills = 0; p.gain = 0; p.coins = 0; p.ht = 0; p.respawn = 0;
    p.hp = room.settings.hp; p.weapon = ''; p.ammo = 0;
    p.lastHitBy = 0; p.lastHitT = -99;
    p.ry = Math.atan2(-p.x, -p.z);
  });
  if (room.game === 'armory') {
    spawnPickup(room, 0, -3, 'blaster');
    spawnPickup(room, -4, 3, 'hammer');
    spawnPickup(room, 4, 3, 'grenade');
  }
  if (room.game === 'zombies') { spawnZombie(room); spawnZombie(room); spawnZombie(room); }
}

// dm: 0 fell, 1 squished, 2 zapped
function eliminate(room, p, dm, credit = true) {
  if (!p.alive) return;
  p.alive = false;
  p.dm = dm;
  if (credit && p.lastHitBy && p.lastHitBy !== p.id && room.elapsed - p.lastHitT < 3.5) {
    const a = playersOf(room).find((q) => q.id === p.lastHitBy);
    if (a) a.kills++;
  }
  room.pending.push(p);
}
function settleDeaths(room) {
  if (!room.pending.length) return;
  const r = room.deadCount + 1;
  room.pending.forEach((p) => { p.rank = r; });
  room.deadCount += room.pending.length;
  room.pending = [];
}

function knock(room, victim, fromX, fromZ, force, attacker) {
  let dx = victim.x - fromX, dz = victim.z - fromZ;
  const d = Math.hypot(dx, dz) || 1;
  dx /= d; dz /= d;
  victim.kx += dx * force; victim.kz += dz * force;
  if (attacker) { victim.lastHitBy = attacker.id; victim.lastHitT = room.elapsed; }
}

function damage(room, victim, dmg, attacker) {
  if (!victim.alive || victim.falling) return;
  victim.hp -= dmg;
  victim.hitFx = 0.25;
  if (attacker) { victim.lastHitBy = attacker.id; victim.lastHitT = room.elapsed; }
  if (victim.hp <= 0) eliminate(room, victim, 2);
}

function finishRound(room, players) {
  const s = room.settings;
  const n = players.length;
  let winner = null;
  if (room.game === 'hill') {
    players.forEach((p) => { p.rank = 1 + players.filter((q) => q.ht < p.ht).length; });
    const top = Math.max(...players.map((p) => p.ht));
    const tops = players.filter((p) => p.ht === top);
    if (n > 1 && tops.length === 1 && top > 0) winner = tops[0];
  } else {
    const alive = players.filter((p) => p.alive);
    alive.forEach((p) => { p.rank = n; });
    if (alive.length === 1 && n > 1) winner = alive[0];
  }
  const last = room.round === room.plan.length - 1;
  const mult = last ? s.finalMult : 1;
  players.forEach((p) => {
    let g = 0;
    if (s.survivalPts) g += p.rank - 1;
    if (p === winner) g += s.winBonus;
    g += p.kills * s.killPts;
    g *= mult;
    p.gain = g;
    p.score += g;
    // coins for playing (a flat small amount when playing alone so it cannot be farmed)
    p.coins = n < 2 ? 2 : (5 + (p.rank - 1) * 3 + (p === winner ? 10 : 0) + p.kills * 2) * (last ? 2 : 1);
  });
  room.clients.forEach((c) => {
    if (c.ws.readyState === 1) c.ws.send(JSON.stringify({ t: 'coins', n: c.p.coins }));
  });
  room.winnerId = winner ? winner.id : null;
  room.phase = 'roundEnd';
  room.timer = 4;
}

function update(room) {
  const dt = TICK;
  const players = playersOf(room);
  room.info = '';

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
  room.fx = room.fx.filter((f) => (f.t -= dt) > 0);

  if (room.phase === 'play') {
    settleDeaths(room);
    const alive = players.filter((p) => p.alive);
    const limit = room.startCount > 1 ? 1 : 0;
    let over;
    if (room.game === 'hill') over = room.elapsed >= TIMED.hill;
    else over = alive.length <= limit || room.elapsed > (TIMED[room.game] || 90);
    if (over) finishRound(room, players);
  } else if (room.phase === 'roundEnd') {
    room.timer -= dt;
    if (room.timer <= 0) {
      room.round++;
      if (room.round >= room.plan.length) { room.phase = 'final'; room.timer = 10; }
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
  room.pickups = []; room.proj = []; room.bombs = []; room.fx = []; room.meteors = []; room.zombies = [];
  room.clients.forEach((c) => {
    Object.assign(c.p, { score: 0, alive: true, falling: false, dm: 0, y: 0, gain: 0, coins: 0, ht: 0, weapon: '', ammo: 0, respawn: 0 });
  });
  resetTiles(room);
  broadcast(room, lobbyInfo(room));
}

function movePlayers(room, players, dt, active) {
  const baseSpeed = SPEEDS[room.settings.speed];
  for (const p of players) {
    p.shoveCd = Math.max(0, p.shoveCd - dt);
    p.actFx = Math.max(0, p.actFx - dt);
    p.useCd = Math.max(0, p.useCd - dt);
    p.passCd = Math.max(0, p.passCd - dt);
    p.hitFx = Math.max(0, p.hitFx - dt);
    if (!p.alive && !p.falling) continue;
    if (p.falling) {
      if (p.respawn > 0) { // King of the Hill: come back after a short wait
        p.respawn -= dt;
        if (p.respawn <= 0) {
          const a = Math.random() * Math.PI * 2;
          p.x = Math.cos(a) * 7; p.z = Math.sin(a) * 7; p.y = 0;
          p.vx = p.vz = p.kx = p.kz = p.vy = 0; p.falling = false; p.hitFx = 0;
        }
        continue;
      }
      p.vy -= 28 * dt;
      p.y += p.vy * dt;
      p.x += (p.vx + p.kx) * dt;
      p.z += (p.vz + p.kz) * dt;
      if (p.y < -7) {
        if (room.game === 'hill' && active) { p.respawn = 1.8; p.y = -20; } else { p.falling = false; p.y = -20; }
      }
      continue;
    }
    let ix = p.ix, iz = p.iz;
    const len = Math.hypot(ix, iz);
    if (len > 1) { ix /= len; iz /= len; }
    if (!active) { ix = 0; iz = 0; }
    let speed = baseSpeed;
    if (room.game === 'bomb' && room.bomb.holder === p.id) speed *= 1.12;
    p.vx += (ix * speed - p.vx) * Math.min(1, dt * 12);
    p.vz += (iz * speed - p.vz) * Math.min(1, dt * 12);
    p.x += (p.vx + p.kx) * dt;
    p.z += (p.vz + p.kz) * dt;
    const decay = Math.exp(-4.5 * dt);
    p.kx *= decay; p.kz *= decay;
    if (Math.hypot(ix, iz) > 0.2) p.ry = Math.atan2(ix, iz);
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
      if (ti < 0 || room.tiles[ti].s === 2) {
        p.falling = true; p.vy = 0;
        if (room.game !== 'hill') eliminate(room, p, 0);
      }
    }
  }
}

function updateHazards(room, players, dt) {
  const tiles = room.tiles;
  const rate = HAZ[room.settings.hazards];
  const live = players.filter((p) => p.alive && !p.falling);

  // cracking tiles fall away (every mode except Crumbling Floor, which has its own handling)
  if (room.game !== 'crumble') tiles.forEach((t) => { if (t.s === 1) { t.t -= dt; if (t.t <= 0) t.s = 2; } });

  if (room.game === 'crumble') {
    for (const p of live) {
      const ti = tileAt(p.x, p.z);
      if (ti >= 0 && tiles[ti].s === 0) {
        tiles[ti].stand += dt;
        if (tiles[ti].stand > 0.45 / rate) { tiles[ti].s = 1; tiles[ti].t = 0.8 / Math.sqrt(rate); }
      }
    }
    room.spawnTimer -= dt;
    if (room.spawnTimer <= 0) {
      const ok = tiles.map((t, i) => (t.s === 0 ? i : -1)).filter((i) => i >= 0);
      if (ok.length) {
        const i = ok[Math.floor(Math.random() * ok.length)];
        tiles[i].s = 1; tiles[i].t = 0.9 / Math.sqrt(rate);
      }
      room.spawnTimer = Math.max(0.2, (1.3 - room.elapsed * 0.02) / rate);
    }
    tiles.forEach((t) => { if (t.s === 1) { t.t -= dt; if (t.t <= 0) t.s = 2; } });
  }

  if (room.game === 'crusher') {
    room.spawnTimer -= dt;
    if (room.spawnTimer <= 0) {
      const count = Math.max(1, Math.min(9, Math.round((2 + Math.floor(room.elapsed / 8)) * rate)));
      const warn = Math.max(0.7, 1.5 - room.elapsed * 0.012) / Math.sqrt(rate);
      for (let k = 0; k < count; k++) {
        let i;
        if (live.length && Math.random() < 0.55) {
          const p = live[Math.floor(Math.random() * live.length)];
          i = tileAt(p.x, p.z);
        } else i = Math.floor(Math.random() * N * N);
        if (i >= 0 && tiles[i].s === 0) { tiles[i].s = 3; tiles[i].t = warn; }
      }
      room.spawnTimer = Math.max(0.8, 2.2 - room.elapsed * 0.02) / rate;
    }
    tiles.forEach((t, i) => {
      if (t.s === 3) {
        t.t -= dt;
        if (t.t <= 0) {
          t.s = 4; t.t = 0.7;
          const c = tileCenter(i);
          for (const p of players) {
            if (!p.alive || p.falling) continue;
            if (Math.abs(p.x - c.x) < S / 2 + 0.15 && Math.abs(p.z - c.z) < S / 2 + 0.15) eliminate(room, p, 1);
          }
        }
      } else if (t.s === 4) {
        t.t -= dt;
        if (t.t <= 0) t.s = 0;
      }
    });
  }

  if (room.game === 'armory') updateArmory(room, players, live, dt, rate);
  if (room.game === 'bomb') updateBomb(room, players, live, dt, rate);
  if (room.game === 'meteors') updateMeteors(room, players, live, dt, rate);
  if (room.game === 'disasters') updateDisasters(room, players, live, dt, rate);
  if (room.game === 'hill') updateHill(room, players, live, dt);
  if (room.game === 'zombies') updateZombies(room, players, live, dt, rate);
  if (room.game === 'chairs') updateChairs(room, players, live, dt);
}

function updateArmory(room, players, live, dt, rate) {
  room.spawnTimer -= dt;
  if (room.spawnTimer <= 0) {
    if (room.pickups.length < 5) spawnPickup(room);
    room.spawnTimer = 2.8 / rate;
  }
  for (const p of live) {
    if (p.weapon) continue;
    const idx = room.pickups.findIndex((k) => Math.hypot(k.x - p.x, k.z - p.z) < 1.0);
    if (idx >= 0) {
      const k = room.pickups.splice(idx, 1)[0];
      p.weapon = k.type; p.ammo = WEAPON_AMMO[k.type];
    }
  }
  room.proj = room.proj.filter((b) => {
    b.x += b.dx * 20 * dt; b.z += b.dz * 20 * dt; b.life -= dt;
    if (b.life <= 0 || Math.abs(b.x) > HALF + 4 || Math.abs(b.z) > HALF + 4) return false;
    for (const p of live) {
      if (p.id === b.owner || !p.alive) continue;
      if (Math.hypot(p.x - b.x, p.z - b.z) < 0.85) {
        const owner = players.find((q) => q.id === b.owner);
        damage(room, p, 1, owner);
        knock(room, p, b.x - b.dx, b.z - b.dz, 9, owner);
        return false;
      }
    }
    return true;
  });
  room.bombs = room.bombs.filter((b) => {
    b.t -= dt;
    if (b.t > 0) return true;
    const owner = players.find((q) => q.id === b.owner);
    room.fx.push({ id: room.eid++, k: 'boom', x: b.x, z: b.z, t: 0.6 });
    for (const p of players) {
      if (!p.alive || p.falling) continue;
      const d = Math.hypot(p.x - b.x, p.z - b.z);
      if (d < 3.4) {
        knock(room, p, b.x, b.z, 20 * (1 - d / 3.4 * 0.5), owner);
        damage(room, p, 2, owner);
      }
    }
    return false;
  });
}

function updateBomb(room, players, live, dt, rate) {
  const b = room.bomb;
  const cur = live.find((p) => p.id === b.holder);
  if (b.holder && !cur) { b.holder = 0; b.pause = 1.2; }
  if (!b.holder) {
    b.pause -= dt;
    if (b.pause <= 0 && live.length) {
      const h = live[Math.floor(Math.random() * live.length)];
      b.holder = h.id;
      b.fuse = Math.min(14, 6 + live.length * 2) / rate;
      h.passCd = 1;
    }
    return;
  }
  b.fuse -= dt;
  if (cur.passCd <= 0) {
    for (const q of live) {
      if (q === cur) continue;
      if (Math.hypot(q.x - cur.x, q.z - cur.z) < 1.3) {
        b.holder = q.id; q.passCd = 0.9; cur.passCd = 0.9; q.hitFx = 0.2;
        break;
      }
    }
  }
  if (b.fuse <= 0) {
    const h = players.find((p) => p.id === b.holder);
    room.fx.push({ id: room.eid++, k: 'boom', x: h.x, z: h.z, t: 0.6 });
    eliminate(room, h, 2, false);
    b.holder = 0; b.pause = 2;
  }
}

// ----- Falling Meteors: glowing rocks drop on marked circles -----
function updateMeteors(room, players, live, dt, rate) {
  room.spawnTimer -= dt;
  if (room.spawnTimer <= 0) {
    const count = Math.max(1, Math.min(6, Math.round((1 + Math.floor(room.elapsed / 10)) * rate)));
    for (let k = 0; k < count; k++) {
      let x, z;
      if (live.length && Math.random() < 0.5) {
        const p = live[Math.floor(Math.random() * live.length)];
        x = p.x + (Math.random() - 0.5) * 1.6; z = p.z + (Math.random() - 0.5) * 1.6;
      } else { x = (Math.random() * 2 - 1) * (HALF - 1); z = (Math.random() * 2 - 1) * (HALF - 1); }
      room.meteors.push({ id: room.eid++, x, z, t: 0, dur: Math.max(1.1, 1.8 - room.elapsed * 0.01) / Math.sqrt(rate) });
    }
    room.spawnTimer = Math.max(0.9, 2.4 - room.elapsed * 0.025) / rate;
  }
  room.meteors = room.meteors.filter((m) => {
    m.t += dt;
    if (m.t < m.dur) return true;
    room.fx.push({ id: room.eid++, k: 'boom', x: m.x, z: m.z, t: 0.6 });
    for (const p of players) {
      if (!p.alive || p.falling) continue;
      const d = Math.hypot(p.x - m.x, p.z - m.z);
      if (d < 1.9) eliminate(room, p, 2, false);
      else if (d < 3.6) knock(room, p, m.x, m.z, 16 * (1 - (d - 1.9) / 1.7), null);
    }
    const ti = tileAt(m.x, m.z);
    if (ti >= 0 && room.tiles[ti].s === 0 && Math.random() < 0.35) { room.tiles[ti].s = 1; room.tiles[ti].t = 0.5; }
    return false;
  });
}

// ----- Natural Disasters: a random disaster every few seconds -----
function updateDisasters(room, players, live, dt, rate) {
  const d = room.dis, tiles = room.tiles;
  tiles.forEach((t, i) => {
    if (t.s === 5) {
      t.t -= dt;
      if (t.t <= 0) {
        t.s = 6; t.t = 0.4;
        const c = tileCenter(i);
        for (const p of players) {
          if (!p.alive || p.falling) continue;
          if (Math.abs(p.x - c.x) < S / 2 + 0.2 && Math.abs(p.z - c.z) < S / 2 + 0.2) eliminate(room, p, 2, false);
        }
      }
    } else if (t.s === 6) { t.t -= dt; if (t.t <= 0) t.s = 0; }
  });
  if (!d.kind) {
    d.calm -= dt;
    room.info = `Next disaster in ${Math.max(1, Math.ceil(d.calm))}s...`;
    if (d.calm <= 0) {
      const opts = DISASTERS.filter((k) => k !== d.last);
      d.kind = opts[Math.floor(Math.random() * opts.length)];
      d.last = d.kind; d.t = 0; d.dur = DIS_DUR[d.kind]; d.acc = 0; d.q = 0;
    }
    return;
  }
  d.t += dt; d.acc -= dt; d.q -= dt;
  room.info = `${DIS_NAMES[d.kind]} ${Math.ceil(Math.max(0, d.dur - d.t))}s`;
  if (d.kind === 'earthquake') {
    if (d.acc <= 0) {
      for (let k = 0; k < 3; k++) {
        const ok = tiles.map((t, i) => (t.s === 0 ? i : -1)).filter((i) => i >= 0);
        if (ok.length) { const i = ok[Math.floor(Math.random() * ok.length)]; tiles[i].s = 1; tiles[i].t = 0.7; }
      }
      d.acc = 0.5 / rate;
    }
    if (d.q <= 0) {
      live.forEach((p) => { const a = Math.random() * Math.PI * 2; knock(room, p, p.x - Math.cos(a), p.z - Math.sin(a), 6, null); });
      d.q = 0.35;
    }
  } else if (d.kind === 'flood') {
    if (d.acc <= 0 && room.floodRing < 3) {
      const ringMax = 4 - room.floodRing;
      tiles.forEach((t, i) => {
        const c = i % N, r = Math.floor(i / N);
        if (Math.max(Math.abs(c - 4), Math.abs(r - 4)) === ringMax && t.s === 0) { t.s = 1; t.t = 0.6; }
      });
      room.floodRing++;
      d.acc = 2.4 / rate;
    }
  } else if (d.kind === 'tornado') {
    d.vx = 6 * Math.sin(d.t * 0.55 + 1); d.vz = 5 * Math.sin(d.t * 0.85);
    for (const p of live) {
      const dx = d.vx - p.x, dz = d.vz - p.z, dist = Math.hypot(dx, dz) || 1;
      if (dist < 5) {
        const f = 1 - dist / 5;
        p.kx += ((dx / dist) * 36 + (-dz / dist) * 18) * f * dt;
        p.kz += ((dz / dist) * 36 + (dx / dist) * 18) * f * dt;
        if (dist < 1.0) eliminate(room, p, 2, false);
      }
    }
  } else if (d.kind === 'lightning') {
    if (d.acc <= 0) {
      for (let k = 0; k < 2; k++) {
        let i;
        if (live.length && Math.random() < 0.6) { const p = live[Math.floor(Math.random() * live.length)]; i = tileAt(p.x, p.z); }
        else i = Math.floor(Math.random() * N * N);
        if (i >= 0 && tiles[i].s === 0) { tiles[i].s = 5; tiles[i].t = 0.9; }
      }
      d.acc = 0.55 / rate;
    }
  }
  if (d.t >= d.dur) { d.kind = ''; d.calm = 3; }
}

// ----- King of the Hill: stand alone in the zone to score -----
function updateHill(room, players, live, dt) {
  const h = room.hill;
  h.t -= dt;
  if (h.t <= 0) {
    const spots = [-6, -3, 0, 3, 6];
    let nx, nz, tries = 0;
    do { nx = spots[Math.floor(Math.random() * 5)]; nz = spots[Math.floor(Math.random() * 5)]; tries++; }
    while (Math.hypot(nx - h.x, nz - h.z) < 4 && tries < 20);
    h.x = nx; h.z = nz; h.t = 12;
  }
  const inside = live.filter((p) => Math.hypot(p.x - h.x, p.z - h.z) < HILL_R);
  h.contested = inside.length > 1;
  h.owner = inside.length === 1 ? inside[0].id : 0;
  if (inside.length === 1) inside[0].ht += dt;
  room.info = `Hold the hill alone to score! ${Math.ceil(Math.max(0, TIMED.hill - room.elapsed))}s left`;
}

// ----- Zombie Survival: everyone against the horde -----
function updateZombies(room, players, live, dt, rate) {
  room.spawnTimer -= dt;
  if (room.spawnTimer <= 0) {
    if (room.zombies.length < 20) spawnZombie(room);
    room.spawnTimer = Math.max(0.7, 2.4 - room.elapsed * 0.04) / rate;
  }
  const speed = Math.min(4.6, 2.6 + room.elapsed * 0.04) * Math.sqrt(rate);
  const zs = room.zombies;
  for (const z of zs) {
    let best = null, bd = 1e9;
    for (const p of live) { const d = Math.hypot(p.x - z.x, p.z - z.z); if (d < bd) { bd = d; best = p; } }
    let vx = 0, vz = 0;
    if (best && bd > 0.01) { vx = ((best.x - z.x) / bd) * speed; vz = ((best.z - z.z) / bd) * speed; z.ry = Math.atan2(vx, vz); }
    z.x += (vx + z.kx) * dt; z.z += (vz + z.kz) * dt;
    const dec = Math.exp(-4.5 * dt);
    z.kx *= dec; z.kz *= dec;
  }
  for (let i = 0; i < zs.length; i++) {
    for (let j = i + 1; j < zs.length; j++) {
      const dx = zs[j].x - zs[i].x, dz = zs[j].z - zs[i].z, d = Math.hypot(dx, dz);
      if (d > 0 && d < 0.8) {
        const push = (0.8 - d) / 2;
        zs[i].x -= (dx / d) * push; zs[i].z -= (dz / d) * push;
        zs[j].x += (dx / d) * push; zs[j].z += (dz / d) * push;
      }
    }
  }
  for (const z of zs) {
    for (const p of live) {
      if (!p.alive || p.falling) continue;
      if (Math.hypot(p.x - z.x, p.z - z.z) < 0.95) eliminate(room, p, 2, false);
    }
  }
  room.zombies = zs.filter((z) => Math.abs(z.x) < HALF + 0.6 && Math.abs(z.z) < HALF + 0.6);
  room.info = `Survive! ${Math.ceil(Math.max(0, TIMED.zombies - room.elapsed))}s left. Shove zombies away!`;
}

// ----- Musical Chairs: when the music stops, grab a chair -----
function updateChairs(room, players, live, dt) {
  const mc = room.mc, tiles = room.tiles;
  mc.t -= dt;
  if (mc.phase === 'music') {
    room.info = 'Music is playing... get ready!';
    if (mc.t <= 0) {
      const k = Math.max(1, live.length - 1);
      const idx = shuffle(tiles.map((_, i) => i)).slice(0, k);
      mc.chairs = idx;
      tiles.forEach((t, i) => { t.s = idx.includes(i) ? 7 : 8; });
      mc.phase = 'stop'; mc.t = Math.max(2.2, 3.4 - mc.wave * 0.25); mc.wave++;
    }
  } else if (mc.phase === 'stop') {
    room.info = `FIND A CHAIR! ${Math.max(1, Math.ceil(mc.t))}s`;
    if (mc.t <= 0) {
      tiles.forEach((t) => { if (t.s === 8) t.s = 2; });
      for (const i of mc.chairs) {
        const c = tileCenter(i);
        const on = players.filter((p) => p.alive && !p.falling && Math.abs(p.x - c.x) < S / 2 && Math.abs(p.z - c.z) < S / 2)
          .sort((a, b) => Math.hypot(a.x - c.x, a.z - c.z) - Math.hypot(b.x - c.x, b.z - c.z));
        on.slice(1).forEach((p) => eliminate(room, p, 2, false)); // only one player per chair
      }
      mc.phase = 'reset'; mc.t = 2.2;
    }
  } else if (mc.phase === 'reset') {
    room.info = 'Chairs reset...';
    if (mc.t <= 0) {
      tiles.forEach((t) => { t.s = 0; t.stand = 0; });
      mc.chairs = []; mc.phase = 'music'; mc.t = 4 + Math.random() * 3.5;
    }
  }
}

function doAct(room, p) {
  if (room.phase !== 'play' || !p.alive || p.falling) return;
  const dirx = Math.sin(p.ry), dirz = Math.cos(p.ry);
  const players = playersOf(room);
  if (room.game === 'armory' && p.weapon && p.useCd <= 0) {
    p.actFx = 0.25;
    if (p.weapon === 'blaster') {
      room.proj.push({ id: room.eid++, x: p.x + dirx * 0.9, z: p.z + dirz * 0.9, dx: dirx, dz: dirz, owner: p.id, life: 1.6 });
      p.useCd = 0.35;
    } else if (p.weapon === 'hammer') {
      for (const q of players) {
        if (q === p || !q.alive || q.falling) continue;
        const dx = q.x - p.x, dz = q.z - p.z, d = Math.hypot(dx, dz);
        if (d > 0 && d < 2.5 && (dx * dirx + dz * dirz) / d > 0.3) {
          knock(room, q, p.x, p.z, 24, p);
          damage(room, q, 2, p);
        }
      }
      p.useCd = 0.7;
    } else if (p.weapon === 'grenade') {
      const gx = Math.max(-HALF + 0.5, Math.min(HALF - 0.5, p.x + dirx * 2.4));
      const gz = Math.max(-HALF + 0.5, Math.min(HALF - 0.5, p.z + dirz * 2.4));
      room.bombs.push({ id: room.eid++, x: gx, z: gz, t: 1.3, owner: p.id });
      p.useCd = 0.5;
    }
    p.ammo--;
    if (p.ammo <= 0) { p.weapon = ''; p.ammo = 0; }
    return;
  }
  if (room.game === 'armory' && p.weapon) return;
  const force = SHOVES[room.settings.shove];
  if (force <= 0 || p.shoveCd > 0) return;
  p.shoveCd = 1.2; p.actFx = 0.25;
  players.forEach((q) => {
    if (q === p || !q.alive || q.falling) return;
    const d = Math.hypot(q.x - p.x, q.z - p.z);
    if (d > 0 && d < 2.4) knock(room, q, p.x, p.z, force, p);
  });
  room.zombies.forEach((z) => {
    const dx = z.x - p.x, dz = z.z - p.z, d = Math.hypot(dx, dz);
    if (d > 0 && d < 2.6) { z.kx += (dx / d) * force * 1.2; z.kz += (dz / d) * force * 1.2; }
  });
}

function snapshot(room) {
  const players = playersOf(room);
  const g = room.game;
  const timed = TIMED[g];
  return {
    t: 'state',
    phase: room.phase,
    game: g,
    gameName: g ? GAMES[g] : '',
    timer: Math.round(room.timer * 10) / 10,
    round: room.round + 1,
    rounds: room.plan.length || room.settings.rounds,
    winnerId: room.winnerId,
    info: room.info,
    left: timed && room.phase === 'play' ? Math.max(0, Math.round((timed - room.elapsed) * 10) / 10) : 0,
    tiles: room.tiles.map((t) => t.s).join(''),
    holder: g === 'bomb' ? room.bomb.holder : 0,
    fuse: g === 'bomb' ? Math.max(0, Math.round(room.bomb.fuse * 10) / 10) : 0,
    pickups: room.pickups.map((k) => ({ id: k.id, ty: k.type, x: +k.x.toFixed(2), z: +k.z.toFixed(2) })),
    proj: room.proj.map((b) => ({ id: b.id, x: +b.x.toFixed(2), z: +b.z.toFixed(2) })),
    bombs: room.bombs.map((b) => ({ id: b.id, x: +b.x.toFixed(2), z: +b.z.toFixed(2), t: +b.t.toFixed(2) })),
    fx: room.fx.map((f) => ({ id: f.id, k: f.k, x: +f.x.toFixed(2), z: +f.z.toFixed(2) })),
    meteors: room.meteors.map((m) => ({ id: m.id, x: +m.x.toFixed(2), z: +m.z.toFixed(2), p: +(m.t / m.dur).toFixed(2) })),
    zombies: room.zombies.map((z) => ({ id: z.id, x: +z.x.toFixed(2), z: +z.z.toFixed(2), ry: +z.ry.toFixed(2) })),
    hill: g === 'hill' ? { x: room.hill.x, z: room.hill.z, r: HILL_R, own: room.hill.owner, con: room.hill.contested } : null,
    vortex: g === 'disasters' && room.dis.kind === 'tornado' ? { x: +room.dis.vx.toFixed(2), z: +room.dis.vz.toFixed(2) } : null,
    dis: g === 'disasters' ? room.dis.kind : '',
    music: g === 'chairs' && room.phase === 'play' && room.mc.phase === 'music',
    players: players.map((p) => ({
      id: p.id, name: p.name, color: p.color, score: p.score, gain: p.gain, cg: p.coins, ht: Math.round(p.ht * 10) / 10,
      x: +p.x.toFixed(2), y: +p.y.toFixed(2), z: +p.z.toFixed(2), ry: +p.ry.toFixed(2),
      alive: p.alive, dm: p.dm, act: p.actFx > 0, hit: p.hitFx > 0,
      hp: p.hp, mhp: room.settings.hp, w: p.weapon, ammo: p.ammo,
    })),
  };
}

function lobbyInfo(room) {
  return {
    t: 'room',
    code: room.code,
    hostId: room.hostId,
    phase: room.phase,
    settings: room.settings,
    palette: COLORS,
    players: playersOf(room).map((p) => ({ id: p.id, name: p.name, color: p.color, cos: p.cos })),
  };
}

function broadcast(room, msg) {
  const data = JSON.stringify(msg);
  room.clients.forEach((c) => { if (c.ws.readyState === 1) c.ws.send(data); });
}

function addPlayer(room, ws, name, cos) {
  const used = new Set(playersOf(room).map((p) => p.color));
  const color = COLORS.find((c) => !used.has(c)) || COLORS[0];
  const id = room.nextId++;
  const p = {
    id, name: cleanText(name, 12, 'Player'), color, cos: cleanCos(cos), score: 0, gain: 0, coins: 0, ht: 0, respawn: 0,
    x: 0, y: 0, z: 0, vx: 0, vz: 0, kx: 0, kz: 0, vy: 0, ix: 0, iz: 0, ry: 0,
    alive: true, falling: false, dm: 0, shoveCd: 0, actFx: 0, useCd: 0, passCd: 0, hitFx: 0, rank: 0,
    kills: 0, hp: 3, weapon: '', ammo: 0, lastHitBy: 0, lastHitT: -99,
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
const wss = new WebSocketServer({ server, maxPayload: 4096 });
wss.on('connection', (ws) => {
  ws.on('message', (raw) => {
    let m;
    try { m = JSON.parse(raw); } catch { return; }
    if (!m || typeof m.t !== 'string') return;
    const room = ws.room;
    if (m.t === 'create' && !room) {
      const r = newRoom(makeCode());
      const nm = cleanText(m.name, 12, 'Player');
      applySettings(r.settings, { roomName: cleanText(m.roomName, 24, nm + "'s room"), isPublic: m.isPublic !== false });
      rooms.set(r.code, r);
      addPlayer(r, ws, nm, m.cos);
    } else if (m.t === 'join' && !room) {
      const r = rooms.get(String(m.code || '').toUpperCase().trim());
      if (!r) return ws.send(JSON.stringify({ t: 'error', msg: 'Room not found' }));
      if (r.phase !== 'lobby') return ws.send(JSON.stringify({ t: 'error', msg: 'Game already in progress' }));
      if (r.clients.size >= MAX_PLAYERS) return ws.send(JSON.stringify({ t: 'error', msg: 'Room is full (max 4)' }));
      addPlayer(r, ws, m.name, m.cos);
    } else if (room) {
      const c = room.clients.get(ws.pid);
      if (!c) return;
      const isHost = ws.pid === room.hostId;
      if (m.t === 'settings' && isHost && room.phase === 'lobby') {
        applySettings(room.settings, m.s);
        broadcast(room, lobbyInfo(room));
      } else if (m.t === 'start' && isHost && room.phase === 'lobby') {
        room.clients.forEach((cl) => { cl.p.score = 0; });
        room.round = 0;
        room.plan = buildPlan(room.settings);
        startRound(room);
        broadcast(room, lobbyInfo(room));
      } else if (m.t === 'color' && room.phase === 'lobby') {
        const taken = playersOf(room).some((q) => q !== c.p && q.color === m.c);
        if (COLORS.includes(m.c) && !taken) {
          c.p.color = m.c;
          broadcast(room, lobbyInfo(room));
        }
      } else if (m.t === 'cos' && room.phase === 'lobby') {
        c.p.cos = cleanCos(m.cos);
        broadcast(room, lobbyInfo(room));
      } else if (m.t === 'kick' && isHost && room.phase === 'lobby') {
        const target = room.clients.get(+m.id);
        if (target && +m.id !== ws.pid) {
          target.ws.send(JSON.stringify({ t: 'kicked' }));
          target.ws.close();
        }
      } else if (m.t === 'end' && isHost && room.phase !== 'lobby') {
        toLobby(room);
      } else if (m.t === 'input') {
        c.p.ix = Math.max(-1, Math.min(1, +m.x || 0));
        c.p.iz = Math.max(-1, Math.min(1, +m.z || 0));
      } else if (m.t === 'act' || m.t === 'shove') {
        doAct(room, c.p);
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
