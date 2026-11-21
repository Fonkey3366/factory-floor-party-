// Party game server: static files + server list + WebSocket rooms + minigame simulation.
const http = require('http');
const crypto = require('crypto');
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
const MAX_PLAYERS = 8;
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
  conveyor_roulette: 'Conveyor Roulette',
  express_train: 'Express Train',
  press_memory: 'Press Memory',
  scrap_workbench: 'Scrap Workbench',
  boss_takedown: 'Boss Takedown',
  shape_dash: 'Color / Shape Dash',
  red_light: 'Red Light, Green Light',
};
const CHAOS = ['low_gravity', 'slippery_oil', 'double_hazard', 'sudden_death', 'tiny_arena', 'heavy_bots'];
const DURATIONS = [60, 90, 120, 180];
const PRIVACY = ['public', 'code', 'password'];
// per-mode tunables: allowed values and defaults
const MODE_OPTS = {
  conveyor_roulette: { beltSpeed: { o: ['slow', 'normal', 'fast'], d: 'normal' }, reverseEvery: { o: [4, 6, 8], d: 6 }, ramp: { o: [true, false], d: true } },
  express_train: { warning: { o: [2, 3, 4], d: 3 }, safeRatio: { o: ['tight', 'normal', 'loose'], d: 'normal' }, trainSpeed: { o: ['slow', 'normal', 'fast'], d: 'normal' }, bothAxes: { o: [true, false], d: true } },
  scrap_workbench: { partCap: { o: [6, 10, 14], d: 10 }, craftTime: { o: [2, 3, 4], d: 3 }, charges: { o: [1, 2, 3, 4], d: 2 }, stealing: { o: [true, false], d: true } },
  boss_takedown: { scoring: { o: ['coop', 'damage_race'], d: 'coop' }, bossHp: { o: ['low', 'normal', 'high'], d: 'normal' }, attackSpeed: { o: ['slow', 'normal', 'fast'], d: 'normal' }, lives: { o: [1, 2, 3, 4, 5], d: 3 } },
  shape_dash: { zones: { o: [4, 6], d: 4 }, pace: { o: ['slow', 'normal', 'fast'], d: 'normal' } },
  red_light: { penalty: { o: ['blast', 'eliminate'], d: 'blast' }, pace: { o: ['slow', 'normal', 'fast'], d: 'normal' } },
  press_memory: { startLength: { o: [1, 2, 3, 4, 5], d: 2 }, showSpeed: { o: ['slow', 'normal', 'fast'], d: 'normal' }, symbols: { o: [4, 6], d: 4 } },
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
const COS = {
  paint: ['hazard_stripes', 'rusted_scrap', 'cardboard_box', 'chrome_prototype', 'gold_plated'],
  head: ['hardhat', 'traffic_cone', 'propeller', 'siren_light', 'crt_head', 'tophat', 'horns', 'halo', 'crown'],
  trail: ['black_smoke', 'weld_sparks', 'oil_drip', 'neon_coolant', 'sparks', 'bubbles', 'hearts'],
  emote: ['gear_flex', 'short_circuit', 'confetti_bolt', 'boot_up_dance'],
};
const EMOTE_TIME = 2.4;

const cleanText = (v, max, d) => {
  const t = String(v == null ? '' : v).replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, max);
  return t || d;
};
function cleanCos(c) {
  const o = { paint: '', head: '', trail: '', emote: 'gear_flex' };
  if (c && typeof c === 'object') for (const k of Object.keys(COS)) if (COS[k].includes(c[k])) o[k] = c[k];
  return o;
}

function defaultSettings() {
  return {
    roomName: 'Party room',
    privacy: 'public',
    maxPlayers: 8,
    matchType: 'rounds',
    rounds: 5,
    roundsToWin: 3,
    roundDuration: 90,
    modes: Object.fromEntries(Object.keys(GAMES).map((g) => [g, true])),
    chaos: [],
    chaosRandom: 'off',
    botFill: false,
    botTarget: 4,
    botLevel: 'normal',
    modeOpts: Object.fromEntries(Object.entries(MODE_OPTS).map(([m, t]) => [m, Object.fromEntries(Object.entries(t).map(([k, v]) => [k, v.d]))])),
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
  if (typeof inc.isPublic === 'boolean') s.privacy = inc.isPublic ? 'public' : 'code';
  if (PRIVACY.includes(inc.privacy)) s.privacy = inc.privacy;
  s.maxPlayers = int(inc.maxPlayers, 2, MAX_PLAYERS, s.maxPlayers);
  s.roundsToWin = int(inc.roundsToWin, 1, 7, s.roundsToWin);
  if (DURATIONS.includes(+inc.roundDuration)) s.roundDuration = +inc.roundDuration;
  if (inc.matchType === 'rounds' || inc.matchType === 'firstTo') s.matchType = inc.matchType;
  if (typeof inc.botFill === 'boolean') s.botFill = inc.botFill;
  s.botTarget = int(inc.botTarget, 2, MAX_PLAYERS, s.botTarget);
  if (['easy', 'normal', 'hard'].includes(inc.botLevel)) s.botLevel = inc.botLevel;
  if (inc.chaosRandom === 'off' || inc.chaosRandom === 'one_per_round') s.chaosRandom = inc.chaosRandom;
  if (Array.isArray(inc.chaos)) s.chaos = CHAOS.filter((c) => inc.chaos.includes(c));
  if (inc.modeOpts && typeof inc.modeOpts === 'object') {
    for (const [m, tbl] of Object.entries(MODE_OPTS)) {
      const src = inc.modeOpts[m];
      if (!src || typeof src !== 'object') continue;
      for (const [k, def] of Object.entries(tbl)) if (def.o.includes(src[k])) s.modeOpts[m][k] = src[k];
    }
  }
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
  const total = s.matchType === 'firstTo' ? 40 : s.rounds;
  if (s.order === 'fixed') {
    for (let i = 0; i < total; i++) plan.push(enabled[i % enabled.length]);
    return plan;
  }
  let bag = [];
  while (plan.length < total) {
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
    const list = [...rooms.values()].filter((r) => r.settings.privacy === 'public').map((r) => {
      const host = r.clients.get(r.hostId);
      return {
        code: r.code, name: r.settings.roomName, host: host ? host.p.name : '',
        players: r.clients.size, max: r.settings.maxPlayers, phase: r.phase,
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

const hashPw = (room, pw) => crypto.createHash('sha256').update(room.code + ':' + String(pw).slice(0, 16)).digest('hex');

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

// ---- hitbox helpers ----
// A little leniency past the edge, so a tiny overhang does not drop you.
function tileUnder(x, z) {
  if (Math.abs(x) > HALF + 0.3 || Math.abs(z) > HALF + 0.3) return -1;
  const cl = (v) => Math.max(-HALF + 0.01, Math.min(HALF - 0.01, v));
  return tileAt(cl(x), cl(z));
}
// Does a circle (a player's body) overlap a tile at all?
function circleHitsTile(px, pz, c, r) {
  const dx = Math.max(Math.abs(px - c.x) - S / 2, 0), dz = Math.max(Math.abs(pz - c.z) - S / 2, 0);
  return dx * dx + dz * dz < r * r;
}
// Shortest distance from a point to the path a fast projectile travelled this tick.
function segDist(px, pz, ax, az, bx, bz) {
  const abx = bx - ax, abz = bz - az;
  const l2 = abx * abx + abz * abz || 1;
  const t = Math.max(0, Math.min(1, ((px - ax) * abx + (pz - az) * abz) / l2));
  return Math.hypot(px - (ax + abx * t), pz - (az + abz * t));
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
    cv: null, tr: null, pm: null, wb: null, boss: null, rl: null, forced: null, bossDead: false, chaos: new Set(), sd: null, pw: '',
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

const RECIPES = [{ p: ['barrel', 'battery'], w: 'blaster' }, { p: ['blade', 'spring'], w: 'hammer' }, { p: ['barrel', 'spring'], w: 'grenade' }, { p: ['battery', 'blade'], w: 'arc' }];
const PART_TYPES = ['barrel', 'battery', 'blade', 'spring'];
const recipeFor = (a) => { const r = RECIPES.find((q) => a[0] !== a[1] && q.p.includes(a[0]) && q.p.includes(a[1])); return r ? r.w : ''; };
function spawnPart(room, x, z, ty) {
  if (x === undefined) { const a = Math.random() * Math.PI * 2, r = Math.sqrt(Math.random()) * 6.2; x = Math.cos(a) * r; z = Math.sin(a) * r; }
  room.wb.parts.push({ id: room.eid++, ty: ty || PART_TYPES[Math.floor(Math.random() * 4)], x, z });
}
function dropCarry(room, p) {
  if (p.carry && room.wb && room.game === 'scrap_workbench') { spawnPart(room, Math.max(-HALF + 1, Math.min(HALF - 1, p.x)), Math.max(-HALF + 1, Math.min(HALF - 1, p.z)), p.carry); }
  p.carry = '';
}
const cz = (room, id) => room.chaos && room.chaos.has(id);
const ringOf = (i) => Math.max(Math.abs((i % N) - 4), Math.abs(Math.floor(i / N) - 4));
const timedLen = (room) => (TIMED[room.game] ? Math.round((TIMED[room.game] * room.settings.roundDuration) / 90) : room.settings.roundDuration);

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
  const st = room.settings;
  room.chaos = new Set(st.chaos);
  if (st.chaosRandom === 'one_per_round') {
    const pool = CHAOS.filter((c) => !room.chaos.has(c));
    if (pool.length) room.chaos.add(pool[Math.floor(Math.random() * pool.length)]);
  }
  const tiny = cz(room, 'tiny_arena') && !['hill', 'zombies', 'chairs'].includes(room.game);
  if (tiny) room.tiles.forEach((t, i) => { if (ringOf(i) >= 3) t.s = 2; });
  room.sd = cz(room, 'sudden_death') ? { at: 20 + Math.random() * 25, ring: 4, t: 0 } : null;
  const co = st.modeOpts.conveyor_roulette;
  room.cv = { rows: Array.from({ length: N }, (_, i) => (i % 2 ? 1 : -1)), cols: Array.from({ length: N }, (_, i) => (i % 2 ? -1 : 1)), w: null, t: co.reverseEvery, spd: 0 };
  room.tr = { ph: 'idle', t: 2, wave: 0, pads: [], ax: 'x', dir: 1, u: 0, dur: 1.4, w0: 3 };
  room.pm = { ph: 'start', t: 1.5, wave: 0, seq: [], i: 0, on: false, cur: -1, ask: 0, ans: 0, hit: [] };
  room.wb = { parts: [], benches: [], t: 1 };
  room.boss = { mhp: 0, hp: 0, ph: 1, st: 'idle', t: 2.5, atk: '', rings: [], arms: [], hitT: 0, pt: 1, hitSet: new Set(), dur: 1 };
  room.rl = { ph: 'green', t: 1.6, age: 0 };
  room.forced = null; room.bossDead = false;
  const list = playersOf(room);
  room.startCount = list.length;
  const spawnR = tiny ? 3 : 5;
  list.forEach((p, i) => {
    const a = (i / list.length) * Math.PI * 2 + 0.4;
    p.x = Math.cos(a) * spawnR; p.z = Math.sin(a) * spawnR; p.y = 0;
    p.vx = p.vz = p.kx = p.kz = p.vy = 0;
    p.ix = p.iz = 0;
    p.alive = true; p.falling = false; p.dm = 0;
    p.shoveCd = 0; p.actFx = 0; p.useCd = 0; p.passCd = 0; p.hitFx = 0;
    p.em = ''; p.emT = 0; p.emCd = 0; p.carry = ''; p.rlCd = 0;
    p.rank = 0; p.kills = 0; p.gain = 0; p.coins = 0; p.ht = 0; p.respawn = 0;
    p.hp = room.settings.hp; p.weapon = ''; p.ammo = 0;
    p.lastHitBy = 0; p.lastHitT = -99;
    p.ry = Math.atan2(-p.x, -p.z);
  });
  if (room.game === 'red_light') {
    list.forEach((p, i) => { p.x = list.length > 1 ? -7 + (i * 14) / (list.length - 1) : 0; p.z = 5.5; p.ry = Math.PI; });
  }
  if (room.game === 'scrap_workbench') {
    list.forEach((p, i) => {
      const a = (i / list.length) * Math.PI * 2 + 0.4;
      p.hp = 1;
      room.wb.benches.push({ o: p.id, x: Math.cos(a) * 6.8, z: Math.sin(a) * 6.8, s: [], c: 0, cm: 3, w: '' });
    });
    const cap = room.settings.modeOpts.scrap_workbench.partCap;
    for (let i = 0; i < Math.floor(cap / 2); i++) spawnPart(room);
  }
  if (room.game === 'boss_takedown') list.forEach((p) => { p.hp = room.settings.modeOpts.boss_takedown.lives; });
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
  if (p.god) { if (dm === 0) { p.x = 0; p.z = 0; p.y = 0; p.vy = 0; p.falling = false; } return; }
  p.alive = false;
  p.dm = dm;
  dropCarry(room, p);
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
  force *= (cz(room, 'heavy_bots') ? 0.5 : 1) * (cz(room, 'low_gravity') ? 1.6 : 1);
  victim.kx += dx * force; victim.kz += dz * force;
  if (attacker) { victim.lastHitBy = attacker.id; victim.lastHitT = room.elapsed; }
}

function damage(room, victim, dmg, attacker) {
  if (victim.god) return;
  if (!victim.alive || victim.falling) return;
  victim.hp -= dmg;
  victim.hitFx = 0.25;
  dropCarry(room, victim);
  if (attacker) { victim.lastHitBy = attacker.id; victim.lastHitT = room.elapsed; }
  if (victim.hp <= 0) eliminate(room, victim, 2);
}

function finishRound(room, players) {
  const s = room.settings;
  const n = players.length;
  let winner = null;
  const bossRace = room.game === 'boss_takedown' && s.modeOpts.boss_takedown.scoring === 'damage_race';
  let coopWin = false;
  if (room.game === 'boss_takedown' && !bossRace) {
    const alive = players.filter((q) => q.alive);
    alive.forEach((p) => { p.rank = n; });
    coopWin = room.bossDead && alive.length > 0;
    if (coopWin) winner = alive.slice().sort((a, b) => b.ht - a.ht)[0];
  } else if (room.game === 'hill' || bossRace) {
    players.forEach((p) => { p.rank = 1 + players.filter((q) => q.ht < p.ht).length; });
    const top = Math.max(...players.map((p) => p.ht));
    const tops = players.filter((p) => p.ht === top);
    if (n > 1 && tops.length === 1 && top > 0) winner = tops[0];
  } else if (room.forced) {
    winner = room.forced;
    players.forEach((p) => { if (p.alive) p.rank = p === winner ? n : Math.max(1, n - 1); });
  } else {
    const alive = players.filter((p) => p.alive);
    alive.forEach((p) => { p.rank = n; });
    if (alive.length === 1 && n > 1) winner = alive[0];
  }
  if (winner) winner.wins++;
  const last = s.matchType === 'firstTo' ? players.some((q) => q.wins >= s.roundsToWin) : room.round === room.plan.length - 1;
  const mult = last ? s.finalMult : 1;
  players.forEach((p) => {
    let g = 0;
    if (s.survivalPts) g += p.rank - 1;
    if (p === winner || (coopWin && p.alive)) g += s.winBonus;
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
  if (winner) { winner.em = winner.cos.emote || 'gear_flex'; winner.emT = EMOTE_TIME; }
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

  if (room.phase === 'play') players.forEach((p) => { if (p.bot) botThink(room, p); });
  if (room.phase === 'play' || room.phase === 'countdown' || room.phase === 'roundEnd') {
    movePlayers(room, players, dt, room.phase === 'play');
  }
  room.fx = room.fx.filter((f) => (f.t -= dt) > 0);

  if (room.phase === 'play') {
    settleDeaths(room);
    const alive = players.filter((p) => p.alive);
    const limit = room.startCount > 1 ? 1 : 0;
    let over;
    const cap = timedLen(room);
    if (room.game === 'hill') over = room.elapsed >= cap;
    else if (room.game === 'boss_takedown') over = room.bossDead || alive.length === 0 || room.elapsed > cap;
    else if (room.game === 'red_light') over = !!room.forced || alive.length <= limit || room.elapsed > cap;
    else over = alive.length <= limit || room.elapsed > cap;
    if (over) finishRound(room, players);
  } else if (room.phase === 'roundEnd') {
    room.timer -= dt;
    if (room.timer <= 0) {
      room.round++;
      const st = room.settings;
      const done = st.matchType === 'firstTo' ? players.some((q) => q.wins >= st.roundsToWin) : false;
      if (done || room.round >= room.plan.length) { room.phase = 'final'; room.timer = 10; }
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
    Object.assign(c.p, { score: 0, wins: 0, em: '', emT: 0, alive: true, falling: false, dm: 0, y: 0, gain: 0, coins: 0, ht: 0, weapon: '', ammo: 0, respawn: 0 });
  });
  resetTiles(room);
  broadcast(room, lobbyInfo(room));
}

function movePlayers(room, players, dt, active) {
  const baseSpeed = SPEEDS[room.settings.speed] * (cz(room, 'heavy_bots') ? 0.85 : 1);
  const slip = cz(room, 'slippery_oil'), lowg = cz(room, 'low_gravity');
  for (const p of players) {
    p.shoveCd = Math.max(0, p.shoveCd - dt);
    p.actFx = Math.max(0, p.actFx - dt);
    p.useCd = Math.max(0, p.useCd - dt);
    p.passCd = Math.max(0, p.passCd - dt);
    p.hitFx = Math.max(0, p.hitFx - dt);
    p.emT = Math.max(0, p.emT - dt); p.emCd = Math.max(0, p.emCd - dt);
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
      p.vy -= 28 * dt * (lowg ? 0.5 : 1);
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
    if (p.carry) speed *= 0.85;
    if (room.game === 'red_light') speed *= 0.55;
    const accel = slip ? 3 : 12;
    p.vx += (ix * speed - p.vx) * Math.min(1, dt * accel);
    p.vz += (iz * speed - p.vz) * Math.min(1, dt * accel);
    p.x += (p.vx + p.kx) * dt;
    p.z += (p.vz + p.kz) * dt;
    const decay = Math.exp(-(slip ? 1.8 : lowg ? 2.8 : 4.5) * dt);
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
      const ti = tileUnder(p.x, p.z);
      if (ti < 0 || room.tiles[ti].s === 2) {
        p.falling = true; p.vy = 0;
        if (room.game !== 'hill') eliminate(room, p, 0);
      }
    }
  }
}

function updateHazards(room, players, dt) {
  const tiles = room.tiles;
  const rate = HAZ[room.settings.hazards] * (cz(room, 'double_hazard') ? 2 : 1);
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
            if (circleHitsTile(p.x, p.z, c, 0.3)) eliminate(room, p, 1);
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
  if (room.game === 'conveyor_roulette') updateConveyor(room, players, live, dt, rate);
  if (room.game === 'express_train') updateTrain(room, players, live, dt, rate);
  if (room.game === 'press_memory') updateMemory(room, players, live, dt);
  if (room.game === 'shape_dash') updateDash(room, players, live, dt);
  if (room.game === 'scrap_workbench') updateWorkbench(room, players, live, dt, rate);
  if (room.game === 'boss_takedown') updateBoss(room, players, live, dt, rate);
  if (room.game === 'red_light') updateRedLight(room, players, live, dt);

  if (room.sd && room.elapsed >= room.sd.at) {
    room.sd.t -= dt;
    if (room.sd.t <= 0 && room.sd.ring >= 1) {
      tiles.forEach((t, i) => { if (ringOf(i) === room.sd.ring && t.s === 0) { t.s = 1; t.t = 0.8; } });
      room.sd.ring--; room.sd.t = 6 / Math.sqrt(rate);
    }
    if (!room.info) room.info = 'SUDDEN DEATH - the edges are crumbling!';
  }
}

// Conveyor Roulette: every row and column is a belt that periodically reverses
function updateConveyor(room, players, live, dt, rate) {
  const o = room.settings.modeOpts.conveyor_roulette, cv = room.cv, tiles = room.tiles;
  const base = { slow: 1.5, normal: 2.4, fast: 3.6 }[o.beltSpeed];
  cv.spd = base * (o.ramp ? 1 + 0.1 * Math.floor(room.elapsed / 20) : 1) * Math.sqrt(rate);
  for (const p of live) {
    const ti = tileUnder(p.x, p.z);
    if (ti < 0 || tiles[ti].s === 2) continue;
    p.x += cv.rows[Math.floor(ti / N)] * cv.spd * dt;
    p.z += cv.cols[ti % N] * cv.spd * dt;
  }
  cv.t -= dt;
  if (!cv.w && cv.t <= 0) cv.w = { a: Math.random() < 0.5 ? 'r' : 'c', i: Math.floor(Math.random() * N), t: 1.0 };
  if (cv.w) {
    room.info = 'A belt is about to reverse!';
    cv.w.t -= dt;
    if (cv.w.t <= 0) {
      const arr = cv.w.a === 'r' ? cv.rows : cv.cols;
      arr[cv.w.i] *= -1;
      cv.w = null; cv.t = o.reverseEvery;
    }
  }
}

// Express Train: lit pads are the only safe spots when the train sweeps the arena
function updateTrain(room, players, live, dt, rate) {
  const o = room.settings.modeOpts.express_train, tr = room.tr, tiles = room.tiles;
  tr.t -= dt;
  if (tr.ph === 'idle') {
    room.info = 'Train incoming...';
    if (tr.t <= 0) {
      const k = { tight: -2, normal: -1, loose: 0 }[o.safeRatio];
      const count = Math.max(1, Math.min(live.length + k, 12));
      const cand = shuffle(tiles.map((t, i) => (t.s === 0 ? i : -1)).filter((i) => i >= 0));
      tr.pads = cand.slice(0, count);
      tr.pads.forEach((i) => { tiles[i].s = 9; });
      tr.ax = o.bothAxes && Math.random() < 0.5 ? 'z' : 'x';
      tr.dir = Math.random() < 0.5 ? 1 : -1;
      tr.ph = 'warn'; tr.t = Math.max(1.6, o.warning - tr.wave * 0.12); tr.w0 = tr.t;
    }
  } else if (tr.ph === 'warn') {
    room.info = `TRAIN IN ${Math.max(1, Math.ceil(tr.t))}s - get on a green pad!`;
    if (tr.t <= 0) {
      tr.ph = 'pass';
      tr.dur = { slow: 1.9, normal: 1.4, fast: 1.0 }[o.trainSpeed] / Math.min(rate, 1.5);
      tr.t = tr.dur;
    }
  } else if (tr.ph === 'pass') {
    const prog = 1 - Math.max(0, tr.t) / tr.dur;
    tr.u = tr.dir * (-HALF - 3 + prog * (2 * HALF + 6));
    const pads = tr.pads.map(tileCenter);
    for (const p of live) {
      if (!p.alive || p.falling) continue;
      const a = tr.ax === 'x' ? p.x : p.z;
      if (Math.abs(a - tr.u) > 1.3) continue;
      if (pads.some((c) => Math.hypot(p.x - c.x, p.z - c.z) < 0.6)) continue;
      eliminate(room, p, 1);
    }
    if (tr.t <= 0) {
      tr.pads.forEach((i) => { if (tiles[i].s === 9) tiles[i].s = 0; });
      tr.pads = []; tr.ph = 'idle'; tr.t = 1.3; tr.wave++;
    }
  }
}

// Press Memory: watch the sequence, remember a position in it, stand on that zone
const zoneOf = (i, n) => {
  const tx = i % N, tz = Math.floor(i / N);
  if (n === 4) return (tx <= 4 ? 0 : 1) + (tz <= 4 ? 0 : 2);
  return (tx < 3 ? 0 : tx < 6 ? 1 : 2) + (tz <= 4 ? 0 : 3);
};
const ORD = ['1st', '2nd', '3rd', '4th', '5th', '6th', '7th', '8th'];
function updateMemory(room, players, live, dt) {
  const o = room.settings.modeOpts.press_memory, pm = room.pm, tiles = room.tiles, n = o.symbols;
  pm.t -= dt;
  const on = { slow: 1.0, normal: 0.7, fast: 0.45 }[o.showSpeed];
  if (pm.ph === 'start') {
    room.info = 'Get ready...';
    if (pm.t <= 0) {
      const len = Math.min(8, o.startLength + pm.wave);
      pm.seq = Array.from({ length: len }, () => Math.floor(Math.random() * n));
      pm.i = 0; pm.on = true; pm.cur = pm.seq[0]; pm.ph = 'show'; pm.t = on;
    }
  } else if (pm.ph === 'show') {
    room.info = `Memorise the symbols! (${pm.i + 1}/${pm.seq.length})`;
    if (pm.t <= 0) {
      if (pm.on) { pm.on = false; pm.cur = -1; pm.t = 0.25; }
      else if (pm.i + 1 < pm.seq.length) { pm.i++; pm.on = true; pm.cur = pm.seq[pm.i]; pm.t = on; }
      else {
        pm.ask = Math.floor(Math.random() * pm.seq.length);
        pm.ans = pm.seq[pm.ask];
        pm.ph = 'go'; pm.t = Math.max(2.8, 3.0 + pm.seq.length * 0.2 - pm.wave * 0.1);
      }
    }
  } else if (pm.ph === 'go') {
    const k = pm.seq.length;
    const which = k === 1 ? 'the symbol' : pm.ask === k - 1 ? 'the LAST symbol' : `the ${ORD[pm.ask]} symbol`;
    room.info = `Stand on ${which}!  ${Math.max(1, Math.ceil(pm.t))}s`;
    if (pm.t <= 0) {
      pm.hit = [];
      tiles.forEach((t, i) => { if (t.s === 0 && zoneOf(i, n) !== pm.ans) { t.s = 3; pm.hit.push(i); } });
      pm.ph = 'warn'; pm.t = 0.45;
    }
  } else if (pm.ph === 'warn') {
    if (pm.t <= 0) {
      pm.hit.forEach((i) => { tiles[i].s = 4; });
      for (const p of live) {
        const ti = tileAt(p.x, p.z);
        if (ti >= 0 && tiles[ti].s === 4) eliminate(room, p, 1);
      }
      pm.ph = 'slam'; pm.t = 0.8;
    }
  } else if (pm.ph === 'slam') {
    if (pm.t <= 0) {
      pm.hit.forEach((i) => { if (tiles[i].s === 4) tiles[i].s = 0; });
      pm.hit = []; pm.ph = 'rest'; pm.t = 1.2;
    }
  } else if (pm.ph === 'rest') {
    room.info = 'Nice! Next round...';
    if (pm.t <= 0) { pm.wave++; pm.ph = 'start'; pm.t = 0.8; }
  }
}


// Color / Shape Dash: a zone is called, every other zone drops away, then the floor comes back
const SYMNAME = ['triangle', 'square', 'circle', 'diamond', 'star', 'cross'];
const COLNAME = ['RED', 'BLUE', 'GREEN', 'YELLOW', 'PURPLE', 'PINK'];
function updateDash(room, players, live, dt) {
  const o = room.settings.modeOpts.shape_dash, pm = room.pm, tiles = room.tiles, n = o.zones;
  pm.t -= dt;
  const pace = { slow: 1.25, normal: 1, fast: 0.8 }[o.pace];
  if (pm.ph === 'start') {
    room.info = 'Get ready...';
    if (pm.t <= 0) { pm.cur = Math.floor(Math.random() * n); pm.ans = pm.cur; pm.ph = 'show'; pm.t = Math.max(1.0, 2.6 - pm.wave * 0.18) * pace; }
  } else if (pm.ph === 'show') {
    room.info = `STAND ON THE ${COLNAME[pm.ans]} ${SYMNAME[pm.ans].toUpperCase()}!`;
    if (pm.t <= 0) {
      pm.hit = []; pm.cur = -1;
      tiles.forEach((t, i) => { if (t.s === 0 && zoneOf(i, n) !== pm.ans) { t.s = 1; t.t = 0.35; pm.hit.push(i); } });
      pm.ph = 'drop'; pm.t = 1.6;
    }
  } else if (pm.ph === 'drop') {
    if (pm.t <= 0) { pm.hit.forEach((i) => { if (tiles[i].s === 2) tiles[i].s = 0; }); pm.hit = []; pm.ph = 'rest'; pm.t = 0.9; }
  } else if (pm.ph === 'rest') {
    if (pm.t <= 0) { pm.wave++; pm.ph = 'start'; pm.t = 0.7; }
  }
}

// Scrap-to-Weapon Workbench
function updateWorkbench(room, players, live, dt, rate) {
  const o = room.settings.modeOpts.scrap_workbench, wb = room.wb;
  wb.t -= dt;
  if (wb.t <= 0) { wb.t = 2.4 / Math.sqrt(rate); if (wb.parts.length < o.partCap) spawnPart(room); }
  for (const p of live) {
    if (p.carry) continue;
    const i = wb.parts.findIndex((k) => Math.hypot(k.x - p.x, k.z - p.z) < 0.95);
    if (i >= 0) p.carry = wb.parts.splice(i, 1)[0].ty;
  }
  for (const b of wb.benches) {
    const owner = players.find((q) => q.id === b.o);
    if (!owner || !owner.alive || owner.falling) continue;
    const near = Math.hypot(owner.x - b.x, owner.z - b.z) < 1.7;
    if (b.c <= 0 && b.s.length < 2 && owner.carry && near) {
      b.s.push(owner.carry); owner.carry = '';
      if (b.s.length === 2) {
        const w = recipeFor(b.s);
        if (w) { b.c = b.cm = o.craftTime; b.w = w; }
        else { b.s.forEach((ty) => spawnPart(room, b.x - Math.sign(b.x) * 1.2, b.z - Math.sign(b.z) * 1.2, ty)); b.s = []; }
      }
    }
    if (b.c > 0 && near) {
      b.c -= dt;
      if (b.c <= 0) { b.c = 0; owner.weapon = b.w; owner.ammo = o.charges; b.s = []; b.w = ''; room.fx.push({ id: room.eid++, k: 'spark', x: b.x, z: b.z, t: 0.4 }); }
    }
  }
  updateShots(room, players, live, dt);
}

// Boss Takedown
function updateBoss(room, players, live, dt, rate) {
  const o = room.settings.modeOpts.boss_takedown, b = room.boss;
  if (!b.mhp) { b.mhp = { low: 28, normal: 40, high: 60 }[o.bossHp] * Math.max(2, room.startCount); b.hp = b.mhp; }
  const frac = Math.max(0, b.hp) / b.mhp;
  b.ph = frac > 0.66 ? 1 : frac > 0.33 ? 2 : 3;
  b.hitT = Math.max(0, b.hitT - dt);
  if (b.hp <= 0 && !room.bossDead) room.bossDead = true;
  if (room.bossDead) { b.st = 'dead'; b.rings = []; b.arms = []; room.info = 'BOSS DEFEATED!'; return; }
  const sp = { slow: 1.4, normal: 1.1, fast: 0.8 }[o.attackSpeed] / Math.sqrt(Math.min(rate, 1.6));
  for (const p of live) { // the boss body is solid
    const d = Math.hypot(p.x, p.z);
    if (d < 2.7) { if (d > 0.01) { p.x *= 2.7 / d; p.z *= 2.7 / d; } else p.x = 2.7; }
  }
  b.pt -= dt;
  if (b.pt <= 0) {
    b.pt = 4.5;
    if (room.pickups.filter((k) => k.type === 'wrench').length < 4) { const a = Math.random() * Math.PI * 2, r = 6.2 + Math.random() * 1.8; spawnPickup(room, Math.cos(a) * r, Math.sin(a) * r, 'wrench'); }
  }
  for (const p of live) {
    if (p.weapon) continue;
    const i = room.pickups.findIndex((k) => Math.hypot(k.x - p.x, k.z - p.z) < 1.0);
    if (i >= 0) { room.pickups.splice(i, 1); p.weapon = 'wrench'; p.ammo = 4; }
  }
  b.t -= dt;
  if (b.st === 'idle') {
    room.info = 'The boss is winding up...';
    if (b.t <= 0 && live.length) {
      b.atk = Math.random() < 0.5 ? 'slam' : 'sweep';
      b.st = 'tele'; b.t = b.dur = sp;
      if (b.atk === 'slam') {
        const k = Math.min(live.length, b.ph + (live.length > 3 ? 1 : 0));
        b.rings = shuffle(live.slice()).slice(0, k).map((p) => ({ x: p.x, z: p.z, r: 2.4 }));
      } else {
        const a0 = Math.random() * Math.PI * 2, dir = Math.random() < 0.5 ? 1 : -1;
        b.arms = Array.from({ length: b.ph >= 2 ? 2 : 1 }, (_, i) => ({ a: a0 + i * Math.PI, v: dir * 1.9 }));
      }
    }
  } else if (b.st === 'tele') {
    room.info = b.atk === 'slam' ? 'SLAM incoming - leave the red rings!' : 'SWEEP incoming - jump the beam!';
    if (b.t <= 0) {
      if (b.atk === 'slam') {
        for (const r of b.rings) {
          room.fx.push({ id: room.eid++, k: 'boom', x: r.x, z: r.z, t: 0.6 });
          for (const p of live) { if (p.alive && Math.hypot(p.x - r.x, p.z - r.z) < r.r) { damage(room, p, 1, null); knock(room, p, r.x, r.z, 16, null); } }
        }
        b.rings = []; b.st = 'weak'; b.t = 3;
      } else { b.st = 'act'; b.t = 1.7; b.hitSet = new Set(); }
    }
  } else if (b.st === 'act') {
    room.info = 'SWEEP!';
    for (const arm of b.arms) {
      arm.a += arm.v * dt;
      const dx = Math.cos(arm.a), dz = Math.sin(arm.a);
      for (const p of live) {
        if (!p.alive || b.hitSet.has(p.id)) continue;
        const along = p.x * dx + p.z * dz, perp = Math.abs(p.x * dz - p.z * dx);
        if (along > 2.4 && along < 11.5 && perp < 0.95) { damage(room, p, 1, null); knock(room, p, 0, 0, 16, null); b.hitSet.add(p.id); }
      }
    }
    if (b.t <= 0) { b.arms = []; b.st = 'weak'; b.t = 3; }
  } else if (b.st === 'weak') {
    room.info = 'WEAK POINT EXPOSED - smash the core with a wrench!';
    if (b.t <= 0) { b.st = 'idle'; b.t = Math.max(0.8, 1.8 - (b.ph - 1) * 0.3) * (sp / 1.1); }
  }
}

// Red Light, Green Light (Factory Edition)
function updateRedLight(room, players, live, dt) {
  const o = room.settings.modeOpts.red_light, rl = room.rl;
  rl.t -= dt;
  const [lo, hi] = { slow: [3, 5.5], normal: [2.2, 4.5], fast: [1.4, 3.2] }[o.pace];
  for (const p of players) p.rlCd = Math.max(0, p.rlCd - dt);
  if (rl.ph === 'green') {
    room.info = 'GREEN LIGHT - RUN to the scanner!';
    if (rl.t <= 0) { rl.ph = 'warn'; rl.t = 0.7; }
  } else if (rl.ph === 'warn') {
    room.info = 'Scanner charging...';
    if (rl.t <= 0) { rl.ph = 'red'; rl.t = 1.2 + Math.random() * 1.6; rl.age = 0; }
  } else {
    rl.age += dt;
    room.info = 'RED LIGHT - FREEZE!';
    if (rl.age > 0.4) {
      for (const p of live) {
        if (!p.alive || p.rlCd > 0 || p.falling) continue;
        if (Math.hypot(p.vx, p.vz) > 1.6) {
          if (o.penalty === 'eliminate') eliminate(room, p, 2, false);
          else { knock(room, p, p.x, p.z - 1, 12, null); p.vx = p.vz = 0; p.hitFx = 0.3; p.rlCd = 1.0; room.fx.push({ id: room.eid++, k: 'boom', x: p.x, z: p.z, t: 0.4 }); }
        }
      }
    }
    if (rl.t <= 0) { rl.ph = 'green'; rl.t = lo + Math.random() * (hi - lo); }
  }
  for (const p of live) if (p.alive && !p.falling && p.z < -(HALF - 1.4)) room.forced = room.forced || p;
}

// ---------- bots ----------
const BOT_NAMES = ['Bolt', 'Gizmo', 'Sprocket', 'Rivet', 'Widget', 'Cog', 'Dynamo', 'Flux'];
function addBot(room) {
  const used = new Set(playersOf(room).map((q) => q.color));
  const color = COLORS.find((c) => !used.has(c)) || COLORS[0];
  const id = room.nextId++;
  const name = BOT_NAMES.find((n) => !playersOf(room).some((q) => q.name === n)) || 'Bot';
  const pickC = (a) => (Math.random() < 0.5 ? a[Math.floor(Math.random() * a.length)] : '');
  const p = {
    id, bot: true, name, color, cos: cleanCos({ paint: pickC(COS.paint), head: pickC(COS.head), trail: '', emote: COS.emote[Math.floor(Math.random() * 4)] }),
    score: 0, wins: 0, em: '', emT: 0, emCd: 0, gain: 0, coins: 0, ht: 0, respawn: 0, x: 0, y: 0, z: 0, vx: 0, vz: 0, kx: 0, kz: 0, vy: 0, ix: 0, iz: 0, ry: 0,
    alive: true, falling: false, dm: 0, shoveCd: 0, actFx: 0, useCd: 0, passCd: 0, hitFx: 0, rank: 0, kills: 0, hp: 3, weapon: '', ammo: 0, lastHitBy: 0, lastHitT: -99, carry: '', rlCd: 0,
    wt: 0, wx: 0, wz: 0, bkWave: -1, bkKnow: false, bkZone: 0,
  };
  room.clients.set(id, { ws: { readyState: 0, send() {}, close() {} }, p });
}
function fillBots(room) {
  const st = room.settings;
  if (!st.botFill) { [...room.clients.entries()].forEach(([id, c]) => { if (c.p.bot) room.clients.delete(id); }); return; }
  while (room.clients.size < Math.min(st.botTarget, st.maxPlayers)) addBot(room);
}
function botThink(room, p) {
  p.ix = 0; p.iz = 0;
  if (room.phase !== 'play' || !p.alive || p.falling) return;
  const lvl = { easy: 0.45, normal: 0.8, hard: 1 }[room.settings.botLevel] || 0.8;
  const g = room.game, tiles = room.tiles;
  const go = (x, z) => { const dx = x - p.x, dz = z - p.z, d = Math.hypot(dx, dz); if (d > 0.3) { p.ix = dx / d; p.iz = dz / d; } };
  const flee = (x, z) => { const dx = p.x - x, dz = p.z - z, d = Math.hypot(dx, dz) || 1; p.ix = dx / d; p.iz = dz / d; };
  const dist = (o) => Math.hypot(o.x - p.x, o.z - p.z);
  const nearest = (list) => list.reduce((b, q) => (!b || dist(q) < dist(b) ? q : b), null);
  const others = playersOf(room).filter((q) => q !== p && q.alive && !q.falling);
  const zoneCenter = (zone, n) => { let sx = 0, sz = 0, c = 0; for (let i = 0; i < N * N; i++) if (zoneOf(i, n) === zone) { const t = tileCenter(i); sx += t.x; sz += t.z; c++; } return { x: sx / c, z: sz / c }; };
  const ti = tileAt(p.x, p.z);
  const unsafe = ti < 0 || [1, 2, 3, 4, 5, 8].includes(tiles[ti].s);
  const attack = (target, reach) => { if (target && dist(target) < reach && Math.random() < 0.5 * lvl) { go(target.x, target.z); doAct(room, p); } };
  let done = false;
  if (g === 'red_light') {
    const rl = room.rl;
    if (rl.ph === 'green') { p.bkStop = Math.random() < lvl; go(p.x * 0.9, -HALF); }
    else if (rl.ph === 'warn') { if (p.bkStop === undefined || p.bkStop) { p.ix = 0; p.iz = 0; } else go(p.x, -HALF); }
    return;
  }
  if (g === 'express_train' && room.tr.ph !== 'idle') {
    const pad = nearest(room.tr.pads.map(tileCenter));
    if (pad) go(pad.x, pad.z); return;
  }
  if (g === 'press_memory' && room.pm.ph === 'go') {
    if (p.bkWave !== room.pm.wave) { p.bkWave = room.pm.wave; p.bkKnow = Math.random() < lvl; p.bkZone = Math.floor(Math.random() * room.settings.modeOpts.press_memory.symbols); }
    const z = zoneCenter(p.bkKnow ? room.pm.ans : p.bkZone, room.settings.modeOpts.press_memory.symbols); go(z.x, z.z); return;
  }
  if (g === 'shape_dash' && room.pm.ph === 'show') { const z = zoneCenter(room.pm.ans, room.settings.modeOpts.shape_dash.zones); go(z.x, z.z); return; }
  if (g === 'chairs') {
    const ch = room.tiles.map((t, i) => (t.s === 7 ? tileCenter(i) : null)).filter(Boolean);
    if (ch.length) { const c = nearest(ch); go(c.x, c.z); return; }
  }
  if (g === 'hill') { go(room.hill.x, room.hill.z); attack(nearest(others), 1.8); return; }
  if (g === 'meteors') for (const m of room.meteors) if (Math.hypot(m.x - p.x, m.z - p.z) < 3.0) { flee(m.x, m.z); return; }
  if (g === 'zombies') { const z = nearest(room.zombies); if (z && dist(z) < 3.8) { flee(z.x, z.z); if (dist(z) < 2.0) doAct(room, p); return; } }
  if (g === 'bomb') {
    const h = room.bomb.holder;
    if (h === p.id) { const t = nearest(others); if (t) go(t.x, t.z); return; }
    const hp = others.find((q) => q.id === h); if (hp && dist(hp) < 4.5) { flee(hp.x, hp.z); return; }
  }
  if (g === 'boss_takedown') {
    const b = room.boss;
    for (const r of b.rings) if (Math.hypot(r.x - p.x, r.z - p.z) < r.r + 0.8) { flee(r.x, r.z); return; }
    if (p.weapon === 'wrench') {
      const d = Math.hypot(p.x, p.z) || 1;
      go((p.x / d) * 3.6, (p.z / d) * 3.6);
      if (b.st === 'weak' && d < 4.4 && Math.random() < 0.4 * lvl) doAct(room, p);
      return;
    }
    const w = nearest(room.pickups.filter((k) => k.type === 'wrench'));
    if (w) { go(w.x, w.z); return; }
    const d = Math.hypot(p.x, p.z) || 1; go((p.x / d) * 7, (p.z / d) * 7); return;
  }
  if (g === 'scrap_workbench') {
    const wb = room.wb;
    if (p.weapon) {
      const t = nearest(others);
      if (t) { go(t.x, t.z); if (dist(t) < (p.weapon === 'blaster' ? 7 : 2.2) && Math.random() < 0.5 * lvl) doAct(room, p); }
      return;
    }
    const bench = wb.benches.find((q) => q.o === p.id);
    if (p.carry && bench) { go(bench.x, bench.z); return; }
    const part = nearest(wb.parts);
    if (part) { go(part.x, part.z); return; }
  }
  if (unsafe && ti !== -2) {
    const safe = nearest(tiles.map((t, i) => (t.s === 0 ? { i, ...tileCenter(i) } : null)).filter(Boolean));
    if (safe) { go(safe.x, safe.z); return; }
  }
  if (g === 'armory') {
    if (p.weapon) { const t = nearest(others); if (t) { go(t.x, t.z); if (dist(t) < (p.weapon === 'blaster' ? 7 : 2.4) && Math.random() < 0.4 * lvl) doAct(room, p); } return; }
    const pk = nearest(room.pickups); if (pk) { go(pk.x, pk.z); return; }
  }
  // default: wander around the middle and shove neighbours
  p.wt -= TICK;
  if (p.wt <= 0 || dist({ x: p.wx, z: p.wz }) < 0.6) { p.wt = 0.8 + Math.random(); const a = Math.random() * Math.PI * 2, r = Math.random() * 5.5; p.wx = Math.cos(a) * r; p.wz = Math.sin(a) * r; }
  go(p.wx, p.wz);
  if (!done && room.settings.shove !== 'off') { const t = nearest(others); if (t && dist(t) < 1.8 && Math.random() < 0.06 * lvl) doAct(room, p); }
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
  updateShots(room, players, live, dt);
}

function updateShots(room, players, live, dt) {
  room.proj = room.proj.filter((b) => {
    const ox = b.x, oz = b.z;
    b.x += b.dx * 20 * dt; b.z += b.dz * 20 * dt; b.life -= dt;
    if (b.life <= 0 || Math.abs(b.x) > HALF + 4 || Math.abs(b.z) > HALF + 4) return false;
    for (const p of live) {
      if (p.id === b.owner || !p.alive) continue;
      if (segDist(p.x, p.z, ox, oz, b.x, b.z) < 0.75) { // swept check: fast shots cannot skip over a player
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
          if (circleHitsTile(p.x, p.z, c, 0.3)) eliminate(room, p, 2, false);
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
      if (Math.hypot(p.x - z.x, p.z - z.z) < 0.85) eliminate(room, p, 2, false);
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
  const weaponMode = room.game === 'armory' || room.game === 'scrap_workbench';
  if (room.game === 'boss_takedown' && p.weapon === 'wrench') {
    if (p.useCd > 0) return;
    p.useCd = 0.45; p.actFx = 0.25;
    const b = room.boss;
    if (Math.hypot(p.x, p.z) < 4.6 && b.st === 'weak') { b.hp -= 8; p.ht += 8; b.hitT = 0.25; room.fx.push({ id: room.eid++, k: 'spark', x: p.x * 0.4, z: p.z * 0.4, t: 0.5 }); }
    p.ammo--;
    if (p.ammo <= 0) { p.weapon = ''; p.ammo = 0; }
    return;
  }
  if (weaponMode && p.weapon && p.useCd <= 0) {
    p.actFx = 0.25;
    if (p.weapon === 'blaster') {
      room.proj.push({ id: room.eid++, x: p.x + dirx * 0.9, z: p.z + dirz * 0.9, dx: dirx, dz: dirz, owner: p.id, life: 1.6 });
      p.useCd = 0.35;
    } else if (p.weapon === 'hammer') {
      for (const q of players) {
        if (q === p || !q.alive || q.falling) continue;
        const dx = q.x - p.x, dz = q.z - p.z, d = Math.hypot(dx, dz);
        if (d > 0 && d < 2.7 && (dx * dirx + dz * dirz) / d > 0.25) {
          knock(room, q, p.x, p.z, 24, p);
          damage(room, q, 2, p);
        }
      }
      p.useCd = 0.7;
    } else if (p.weapon === 'arc') {
      for (const q of players) {
        if (q === p || !q.alive || q.falling) continue;
        const d = Math.hypot(q.x - p.x, q.z - p.z);
        if (d > 0 && d < 2.5) { knock(room, q, p.x, p.z, 22, p); damage(room, q, 2, p); }
      }
      p.useCd = 0.8;
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
  if (weaponMode && p.weapon) return;
  if (room.game === 'scrap_workbench' && !p.carry && room.settings.modeOpts.scrap_workbench.stealing && p.shoveCd <= 0) {
    const b = room.wb.benches.find((q) => q.o !== p.id && q.s.length > 0 && Math.hypot(q.x - p.x, q.z - p.z) < 1.9);
    if (b) { p.carry = b.s.pop(); b.c = 0; b.w = ''; p.shoveCd = 1.0; p.actFx = 0.25; return; }
  }
  const force = SHOVES[room.settings.shove];
  if (force <= 0 || p.shoveCd > 0) return;
  p.shoveCd = 1.2; p.actFx = 0.25;
  players.forEach((q) => {
    if (q === p || !q.alive || q.falling) return;
    const d = Math.hypot(q.x - p.x, q.z - p.z);
    if (d > 0 && d < 2.4) { knock(room, q, p.x, p.z, force, p); if (q.carry) dropCarry(room, q); }
  });
  room.zombies.forEach((z) => {
    const dx = z.x - p.x, dz = z.z - p.z, d = Math.hypot(dx, dz);
    if (d > 0 && d < 2.6) { z.kx += (dx / d) * force * 1.2; z.kz += (dz / d) * force * 1.2; }
  });
}

function snapshot(room) {
  const players = playersOf(room);
  const g = room.game;
  return {
    t: 'state',
    phase: room.phase,
    game: g,
    gameName: g ? GAMES[g] : '',
    timer: Math.round(room.timer * 10) / 10,
    round: room.round + 1,
    rounds: room.settings.matchType === 'firstTo' ? 0 : (room.plan.length || room.settings.rounds),
    ft: room.settings.matchType === 'firstTo' ? room.settings.roundsToWin : 0,
    chaos: [...room.chaos],
    winnerId: room.winnerId,
    info: room.info,
    left: room.phase === 'play' ? Math.max(0, Math.round(timedLen(room) - room.elapsed)) : 0,
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
    cv: g === 'conveyor_roulette' ? { r: room.cv.rows, c: room.cv.cols, spd: +room.cv.spd.toFixed(2), w: room.cv.w ? { a: room.cv.w.a, i: room.cv.w.i, t: +room.cv.w.t.toFixed(2) } : null } : null,
    tr: g === 'express_train' ? { ph: room.tr.ph, ax: room.tr.ax, dir: room.tr.dir, u: +room.tr.u.toFixed(2), pads: room.tr.pads, t: +room.tr.t.toFixed(2) } : null,
    pm: g === 'shape_dash' ? { ph: room.pm.ph, cur: room.pm.cur, k: 1, z: room.settings.modeOpts.shape_dash.zones, ask: 0 } : g === 'press_memory' ? { ph: room.pm.ph, cur: room.pm.cur, k: room.pm.seq.length, z: room.settings.modeOpts.press_memory.symbols, ask: ['go', 'warn', 'slam'].includes(room.pm.ph) ? room.pm.ask + 1 : 0 } : null,
    parts: g === 'scrap_workbench' ? room.wb.parts.map((k) => ({ id: k.id, ty: k.ty, x: +k.x.toFixed(2), z: +k.z.toFixed(2) })) : [],
    benches: g === 'scrap_workbench' ? room.wb.benches.map((b) => ({ o: b.o, x: +b.x.toFixed(2), z: +b.z.toFixed(2), s: b.s, c: b.c > 0 ? +(1 - b.c / b.cm).toFixed(2) : 0 })) : [],
    boss: g === 'boss_takedown' ? { hp: Math.max(0, Math.round(room.boss.hp)), mhp: room.boss.mhp, ph: room.boss.ph, st: room.boss.st, atk: room.boss.atk, p: room.boss.st === 'tele' ? +(1 - room.boss.t / room.boss.dur).toFixed(2) : 0, hit: room.boss.hitT > 0, rings: room.boss.rings.map((r) => ({ x: +r.x.toFixed(2), z: +r.z.toFixed(2), r: r.r })), arms: room.boss.arms.map((a) => +a.a.toFixed(3)) } : null,
    rl: g === 'red_light' ? { ph: room.rl.ph } : null,
    music: g === 'chairs' && room.phase === 'play' && room.mc.phase === 'music',
    players: players.map((p) => ({
      id: p.id, name: p.name, color: p.color, score: p.score, gain: p.gain, cg: p.coins, ht: Math.round(p.ht * 10) / 10,
      x: +p.x.toFixed(2), y: +p.y.toFixed(2), z: +p.z.toFixed(2), ry: +p.ry.toFixed(2),
      alive: p.alive, dm: p.dm, act: p.actFx > 0, hit: p.hitFx > 0,
      hp: p.hp, mhp: room.settings.hp, w: p.weapon, ammo: p.ammo, wins: p.wins, em: p.emT > 0 ? p.em : '', carry: p.carry, bot: !!p.bot,
    })),
  };
}

function lobbyInfo(room) {
  return {
    t: 'room',
    code: room.code,
    hostId: room.hostId,
    phase: room.phase,
    settings: { ...room.settings, hasPassword: !!room.pw },
    palette: COLORS,
    players: playersOf(room).map((p) => ({ id: p.id, name: p.name, color: p.color, cos: p.cos, bot: !!p.bot })),
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
    id, name: cleanText(name, 12, 'Player'), color, cos: cleanCos(cos), score: 0, wins: 0, em: '', emT: 0, emCd: 0, carry: '', rlCd: 0, gain: 0, coins: 0, ht: 0, respawn: 0,
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

function startGame(room) {
  fillBots(room);
  room.clients.forEach((cl) => { cl.p.score = 0; cl.p.wins = 0; });
  room.round = 0;
  room.plan = buildPlan(room.settings);
  startRound(room);
  broadcast(room, lobbyInfo(room));
}

function removePlayer(ws) {
  const room = ws.room;
  if (!room) return;
  room.clients.delete(ws.pid);
  ws.room = null;
  const humans = [...room.clients.values()].filter((c) => !c.p.bot);
  if (humans.length === 0) { rooms.delete(room.code); return; }
  if (room.hostId === ws.pid) room.hostId = humans[0].p.id;
  broadcast(room, lobbyInfo(room));
}

// ---------- admin ----------
const ADMIN_CODE = process.env.ADMIN_CODE || 'Fonkey36';
const ADMIN_HELP = 'Commands: help | host | skip | next <mode> | lobby | kill <name|all> | revive <name|all> | kick <name> | god | coins <n> | give <name> <n> | say <text> | bots <n> | modes | players';
function findP(room, q) {
  q = String(q || '').toLowerCase(); if (!q) return null;
  const ps = playersOf(room);
  return ps.find((p) => String(p.id) === q) || ps.find((p) => p.name.toLowerCase() === q) || ps.find((p) => p.name.toLowerCase().startsWith(q)) || null;
}
function adminCmd(ws, room, line) {
  const say = (msg) => { try { ws.send(JSON.stringify({ t: 'adminlog', msg })); } catch (e) { /* ignore */ } };
  const [cmd, ...rest] = String(line || '').trim().slice(0, 200).split(/\s+/);
  const arg = rest.join(' ');
  const me = room.clients.get(ws.pid);
  const targets = (q) => (q.toLowerCase() === 'all' ? playersOf(room) : [findP(room, q)].filter(Boolean));
  switch ((cmd || '').toLowerCase().replace(/^\//, '')) {
    case 'help': return say(ADMIN_HELP);
    case 'players': return say(playersOf(room).map((p) => `${p.id}:${p.name}${p.bot ? '(bot)' : ''}${p.god ? '(god)' : ''}`).join(', '));
    case 'modes': return say(Object.keys(GAMES).join(', '));
    case 'host': room.hostId = ws.pid; broadcast(room, lobbyInfo(room)); return say('You are now the host.');
    case 'skip':
      if (room.phase !== 'play') return say('No round is being played.');
      room.forced = room.forced || null; room.bossDead = room.game === 'boss_takedown' ? true : room.bossDead; room.elapsed = 1e6; return say('Round skipped.');
    case 'next': {
      if (!GAMES[rest[0]]) return say('Unknown mode. Try: modes');
      if (room.phase === 'lobby') return say('Start a game first.');
      if (room.round + 1 >= room.plan.length) room.plan.push(rest[0]); else room.plan[room.round + 1] = rest[0];
      if (room.phase === 'play') room.elapsed = 1e6;
      return say('Next mode: ' + rest[0]);
    }
    case 'lobby': if (room.phase !== 'lobby') toLobby(room); return say('Back to lobby.');
    case 'kill': { const t = targets(arg); if (!t.length) return say('No such player.'); for (const p of t) if (p.alive && room.phase === 'play') { const g = p.god; p.god = false; eliminate(room, p, 0, false); p.god = g; } return say(`Eliminated ${t.length}.`); }
    case 'revive': { const t = targets(arg); if (!t.length) return say('No such player.'); for (const p of t) { p.alive = true; p.falling = false; p.x = (Math.random() - 0.5) * 2; p.z = (Math.random() - 0.5) * 2; p.y = 0; p.vy = 0; p.hp = Math.max(p.hp, 3); } return say(`Revived ${t.length}.`); }
    case 'kick': { const p = findP(room, arg); if (!p || p.id === ws.pid) return say('No such player.'); const c = room.clients.get(p.id); if (p.bot) { room.clients.delete(p.id); broadcast(room, lobbyInfo(room)); } else { c.ws.send(JSON.stringify({ t: 'kicked' })); c.ws.close(); } return say('Kicked ' + p.name); }
    case 'god': me.p.god = !me.p.god; return say('God mode ' + (me.p.god ? 'ON' : 'OFF'));
    case 'coins': { const n = Math.max(-1e6, Math.min(1e6, Math.floor(+rest[0]) || 0)); ws.send(JSON.stringify({ t: 'coins', n })); return say(`Gave yourself ${n} coins.`); }
    case 'give': { const p = findP(room, rest[0]); const n = Math.max(-1e6, Math.min(1e6, Math.floor(+rest[1]) || 0)); if (!p || p.bot) return say('No such player.'); room.clients.get(p.id).ws.send(JSON.stringify({ t: 'coins', n })); return say(`Gave ${p.name} ${n} coins.`); }
    case 'say': broadcast(room, { t: 'announce', msg: cleanText(arg, 80, '') }); return say('Sent.');
    case 'bots': {
      if (room.phase !== 'lobby') return say('Only in the lobby.');
      const n = Math.max(0, Math.min(8, Math.floor(+rest[0]) || 0));
      for (const c of [...room.clients.values()]) if (c.p.bot) room.clients.delete(c.p.id);
      for (let i = 0; i < n && room.clients.size < MAX_PLAYERS; i++) addBot(room);
      broadcast(room, lobbyInfo(room)); return say(`Bots: ${n}`);
    }
    default: return say('Unknown command. Type help');
  }
}

// ---------- websocket ----------
const wss = new WebSocketServer({ server, maxPayload: 4096 });
wss.on('connection', (ws) => {
  ws.on('message', (raw) => {
    let m;
    try { m = JSON.parse(raw); } catch { return; }
    if (!m || typeof m.t !== 'string') return;
    const room = ws.room;
    if (m.t === 'admin') { // admin unlock + console
      if (typeof m.code === 'string') {
        if ((ws.adminFails || 0) >= 5) return;
        if (m.code === ADMIN_CODE) { ws.admin = true; ws.send(JSON.stringify({ t: 'adminok' })); }
        else { ws.adminFails = (ws.adminFails || 0) + 1; ws.send(JSON.stringify({ t: 'adminlog', msg: 'Wrong admin code.' })); }
      } else if (ws.admin && room && typeof m.cmd === 'string') adminCmd(ws, room, m.cmd);
      return;
    }
    if (m.t === 'create' && !room) {
      const r = newRoom(makeCode());
      const nm = cleanText(m.name, 12, 'Player');
      applySettings(r.settings, { roomName: cleanText(m.roomName, 24, nm + "'s room"), isPublic: m.isPublic !== false, privacy: m.privacy });
      if (typeof m.password === 'string' && m.password) r.pw = hashPw(r, m.password);
      if (r.settings.privacy === 'password' && !r.pw) r.settings.privacy = 'code';
      rooms.set(r.code, r);
      addPlayer(r, ws, nm, m.cos);
      if (m.quick) { // instant start against bots (also used by the daily challenge)
        const pre = m.preset && typeof m.preset === 'object' ? m.preset : {};
        const modes = Array.isArray(pre.modes) ? Object.fromEntries(Object.keys(GAMES).map((g) => [g, pre.modes.includes(g)])) : undefined;
        applySettings(r.settings, { privacy: 'code', botFill: true, botTarget: 4, botLevel: ['easy', 'normal', 'hard'].includes(pre.level) ? pre.level : 'normal', rounds: pre.rounds || 5, order: pre.modes ? 'fixed' : 'random', modes, chaos: pre.chaos });
        r.settings.roomName = pre.daily ? 'Daily challenge' : 'Practice vs bots';
        startGame(r);
      }
    } else if (m.t === 'join' && !room) {
      const r = rooms.get(String(m.code || '').toUpperCase().trim());
      if (!r) return ws.send(JSON.stringify({ t: 'error', msg: 'Room not found' }));
      if (r.phase !== 'lobby') return ws.send(JSON.stringify({ t: 'error', msg: 'Game already in progress' }));
      if (r.clients.size >= r.settings.maxPlayers) return ws.send(JSON.stringify({ t: 'error', msg: `Room is full (max ${r.settings.maxPlayers})` }));
      if (r.settings.privacy === 'password' && r.pw && hashPw(r, m.password) !== r.pw) return ws.send(JSON.stringify({ t: 'error', msg: m.password ? 'Wrong password' : 'This room needs a password' }));
      addPlayer(r, ws, m.name, m.cos);
    } else if (room) {
      const c = room.clients.get(ws.pid);
      if (!c) return;
      const isHost = ws.pid === room.hostId;
      if (m.t === 'settings' && isHost && room.phase === 'lobby') {
        applySettings(room.settings, m.s);
        if (m.s && typeof m.s.password === 'string') room.pw = m.s.password ? hashPw(room, m.s.password) : '';
        if (room.settings.privacy === 'password' && !room.pw) room.settings.privacy = 'code';
        room.settings.maxPlayers = Math.max(room.settings.maxPlayers, room.clients.size);
        broadcast(room, lobbyInfo(room));
      } else if (m.t === 'start' && isHost && room.phase === 'lobby') {
        startGame(room);
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
        if (target && target.p.bot) { room.clients.delete(+m.id); broadcast(room, lobbyInfo(room)); }
        else if (target && +m.id !== ws.pid) {
          target.ws.send(JSON.stringify({ t: 'kicked' }));
          target.ws.close();
        }
      } else if (m.t === 'end' && isHost && room.phase !== 'lobby') {
        toLobby(room);
      } else if (m.t === 'input') {
        c.p.ix = Math.max(-1, Math.min(1, +m.x || 0));
        c.p.iz = Math.max(-1, Math.min(1, +m.z || 0));
      } else if (m.t === 'emote') {
        if (room.phase !== 'lobby' && c.p.emCd <= 0 && c.p.alive && !c.p.falling) { c.p.em = c.p.cos.emote || 'gear_flex'; c.p.emT = EMOTE_TIME; c.p.emCd = 8; }
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
