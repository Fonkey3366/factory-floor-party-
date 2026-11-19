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
};
const SPEEDS = { slow: 5.2, normal: 6.5, fast: 8.2 };
const SHOVES = { off: 0, normal: 15, strong: 26 };
const HAZ = { chill: 0.7, normal: 1, chaos: 1.6 };
const WEAPON_AMMO = { blaster: 6, hammer: 4, grenade: 2 };

function defaultSettings() {
  return {
    rounds: 5,
    modes: { crumble: true, crusher: true, armory: true, bomb: true },
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
    bomb: { holder: 0, fuse: 0, pause: 0 },
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

function startRound(room) {
  room.game = room.plan[room.round];
  room.phase = 'countdown';
  room.timer = 3.5;
  room.elapsed = 0;
  room.deadCount = 0;
  room.pending = [];
  room.winnerId = null;
  room.spawnTimer = 2;
  room.pickups = []; room.proj = []; room.bombs = []; room.fx = [];
  room.bomb = { holder: 0, fuse: 0, pause: 2.5 };
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
    p.rank = 0; p.kills = 0; p.gain = 0;
    p.hp = room.settings.hp; p.weapon = ''; p.ammo = 0;
    p.lastHitBy = 0; p.lastHitT = -99;
    p.ry = Math.atan2(-p.x, -p.z);
  });
  if (room.game === 'armory') {
    spawnPickup(room, 0, -3, 'blaster');
    spawnPickup(room, -4, 3, 'hammer');
    spawnPickup(room, 4, 3, 'grenade');
  }
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

function update(room) {
  const dt = TICK;
  const players = playersOf(room);

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
    const s = room.settings;
    const alive = players.filter((p) => p.alive);
    const limit = room.startCount > 1 ? 1 : 0;
    if (alive.length <= limit || room.elapsed > 90) {
      const n = players.length;
      const last = room.round === room.plan.length - 1;
      const mult = last ? s.finalMult : 1;
      alive.forEach((p) => { p.rank = n; });
      const winner = alive.length === 1 && n > 1 ? alive[0] : null;
      players.forEach((p) => {
        let g = 0;
        if (s.survivalPts) g += p.rank - 1;
        if (p === winner) g += s.winBonus;
        g += p.kills * s.killPts;
        g *= mult;
        p.gain = g;
        p.score += g;
      });
      room.winnerId = winner ? winner.id : null;
      room.phase = 'roundEnd';
      room.timer = 4;
    }
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
  room.pickups = []; room.proj = []; room.bombs = []; room.fx = [];
  room.clients.forEach((c) => {
    Object.assign(c.p, { score: 0, alive: true, falling: false, dm: 0, y: 0, gain: 0, weapon: '', ammo: 0 });
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
      if (ti < 0 || room.tiles[ti].s === 2) { p.falling = true; p.vy = 0; eliminate(room, p, 0); }
    }
  }
}

function updateHazards(room, players, dt) {
  const tiles = room.tiles;
  const rate = HAZ[room.settings.hazards];
  const live = players.filter((p) => p.alive && !p.falling);

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
}

function updateArmory(room, players, live, dt, rate) {
  // spawn pickups
  room.spawnTimer -= dt;
  if (room.spawnTimer <= 0) {
    if (room.pickups.length < 5) spawnPickup(room);
    room.spawnTimer = 2.8 / rate;
  }
  // collect
  for (const p of live) {
    if (p.weapon) continue;
    const idx = room.pickups.findIndex((k) => Math.hypot(k.x - p.x, k.z - p.z) < 1.0);
    if (idx >= 0) {
      const k = room.pickups.splice(idx, 1)[0];
      p.weapon = k.type; p.ammo = WEAPON_AMMO[k.type];
    }
  }
  // projectiles
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
  // grenades
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
  if (b.holder && !cur) { b.holder = 0; b.pause = 1.2; } // holder left or fell
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
  // pass on touch
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
  if (room.game === 'armory' && p.weapon) return; // weapon cooling down
  // shove
  const force = SHOVES[room.settings.shove];
  if (force <= 0 || p.shoveCd > 0) return;
  p.shoveCd = 1.2; p.actFx = 0.25;
  players.forEach((q) => {
    if (q === p || !q.alive || q.falling) return;
    const d = Math.hypot(q.x - p.x, q.z - p.z);
    if (d > 0 && d < 2.4) knock(room, q, p.x, p.z, force, p);
  });
}

function snapshot(room) {
  const players = playersOf(room);
  return {
    t: 'state',
    phase: room.phase,
    game: room.game,
    gameName: room.game ? GAMES[room.game] : '',
    timer: Math.round(room.timer * 10) / 10,
    round: room.round + 1,
    rounds: room.plan.length || room.settings.rounds,
    winnerId: room.winnerId,
    tiles: room.tiles.map((t) => t.s).join(''),
    holder: room.game === 'bomb' ? room.bomb.holder : 0,
    fuse: room.game === 'bomb' ? Math.max(0, Math.round(room.bomb.fuse * 10) / 10) : 0,
    pickups: room.pickups.map((k) => ({ id: k.id, ty: k.type, x: +k.x.toFixed(2), z: +k.z.toFixed(2) })),
    proj: room.proj.map((b) => ({ id: b.id, x: +b.x.toFixed(2), z: +b.z.toFixed(2) })),
    bombs: room.bombs.map((b) => ({ id: b.id, x: +b.x.toFixed(2), z: +b.z.toFixed(2), t: +b.t.toFixed(2) })),
    fx: room.fx.map((f) => ({ id: f.id, k: f.k, x: +f.x.toFixed(2), z: +f.z.toFixed(2) })),
    players: players.map((p) => ({
      id: p.id, name: p.name, color: p.color, score: p.score, gain: p.gain,
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
    players: playersOf(room).map((p) => ({ id: p.id, name: p.name, color: p.color })),
  };
}

function broadcast(room, msg) {
  const data = JSON.stringify(msg);
  room.clients.forEach((c) => { if (c.ws.readyState === 1) c.ws.send(data); });
}

function addPlayer(room, ws, name) {
  const used = new Set(playersOf(room).map((p) => p.color));
  const color = COLORS.find((c) => !used.has(c)) || COLORS[0];
  const id = room.nextId++;
  const p = {
    id, name: (name || 'Player').toString().slice(0, 12) || 'Player', color, score: 0, gain: 0,
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
