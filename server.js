/**
 * ╔══════════════════════════════════════════════════════╗
 * ║          CIRCLE.IO — MULTIPLAYER SERVER              ║
 * ║          Node.js + Socket.io + Express               ║
 * ║                                                      ║
 * ║  Запуск:  node server.js                             ║
 * ║  Порт:    3000 (или PORT из env)                     ║
 * ╚══════════════════════════════════════════════════════╝
 *
 *  Установка зависимостей:
 *    npm install express socket.io
 *
 *  Структура папки:
 *    circle-io/
 *      server.js       ← этот файл
 *      index.html      ← игра (переименованный circle_io_v3.html)
 *      assets/         ← музыка, скины
 *      package.json    ← создаётся через npm init -y
 */

'use strict';

const express   = require('express');
const http      = require('http');
const fs        = require('fs');
const { Server } = require('socket.io');
const path      = require('path');

/* ============================================================
   SERVER SETUP
============================================================ */
const app    = express();
const server = http.createServer(app);
const io     = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST'],
  },
  // Railway proxy drops idle WebSocket connections
  // Use polling-only mode for stability, it works fine for a game at 20 ticks/sec
  transports:        ['polling'],
  pingTimeout:       60000,
  pingInterval:      25000,
  upgradeTimeout:    10000,
  allowUpgrades:     false,  // disable upgrade to websocket — Railway kills them
  allowEIO3:         true,
});

const PORT = process.env.PORT || 3000;

// Клиент socket.io: с same-origin (CSP / Яндекс). Статика из assets может не попасть в git —
// всегда отдаём из node_modules с правильным MIME (иначе 404 → HTML и "Refused to execute script").
const SOCKET_IO_CLIENT = path.join(__dirname, 'node_modules', 'socket.io', 'client-dist', 'socket.io.min.js');
app.get('/assets/socket.io.min.js', (req, res, next) => {
  if (!fs.existsSync(SOCKET_IO_CLIENT)) return next();
  res.type('application/javascript; charset=utf-8');
  res.setHeader('Cache-Control', 'public, max-age=86400');
  res.sendFile(SOCKET_IO_CLIENT);
});

// Serve static files (index.html + assets)
app.use(express.static(path.join(__dirname)));

// Auto-find the game HTML file
const gameFile = ['index.html', 'circle_io_v3.html', 'circle_io_v2.html']
  .find(f => fs.existsSync(path.join(__dirname, f))) || 'index.html';

console.log(`[Game] Serving: ${gameFile}`);
app.get('/', (req, res) => res.sendFile(path.join(__dirname, gameFile)));

/* ============================================================
   GAME CONSTANTS (должны совпадать с клиентом!)
============================================================ */
const CELL   = 20;
const COLS   = 100;
const ROWS   = 100;
const TOTAL  = COLS * ROWS;
const SPEED  = 5.5;           // клеток/сек
const TICK   = 1000 / 20;     // 20 тиков/сек = 50мс
const ROUND_DURATION = 60;    // секунд

const MAX_PLAYERS_PER_ROOM = 10;
const MIN_REAL_TO_START    = 2;   // минимум живых людей чтобы матч был "реальным"
const BOTS_TO_FILL         = 8;   // сколько ботов добавить если людей мало
const BOT_NAMES = [
  'Alex','MrSnake','Pro100','xXDarkXx','NightWolf','Shadow_7',
  'Speedy','Tornado','CoolBro','Legend_X','Noob228','Master99',
  'KillerD','Dragon7','EagleEye','bot67','sigma','pisun','nebot',
  'messi','ronaldo','destroyer','pigster','Blazer','Viper',
];
const BOT_COLORS = [
  { color:'#f87171', trail:'#991b1b' }, { color:'#fb923c', trail:'#7c2d12' },
  { color:'#fbbf24', trail:'#78350f' }, { color:'#a3e635', trail:'#365314' },
  { color:'#34d399', trail:'#064e3b' }, { color:'#22d3ee', trail:'#164e63' },
  { color:'#60a5fa', trail:'#1e3a8a' }, { color:'#a78bfa', trail:'#4c1d95' },
  { color:'#f472b6', trail:'#831843' }, { color:'#e879f9', trail:'#701a75' },
  { color:'#2dd4bf', trail:'#134e4a' }, { color:'#4ade80', trail:'#14532d' },
];

/* ============================================================
   ROOMS MAP: roomId → RoomState
============================================================ */
const rooms = new Map();

function generateRoomId() {
  return Math.random().toString(36).slice(2, 8).toUpperCase();
}

/* ============================================================
   ROOM STATE
============================================================ */
class RoomState {
  constructor(id) {
    this.id          = id;
    this.players     = new Map();   // socketId → PlayerState
    this.bots        = new Map();   // botId → BotState
    this.ownerGrid   = new Int16Array(TOTAL).fill(-1);
    this.trailGrid   = new Int16Array(TOTAL).fill(-1);
    this.particles   = [];
    this.roundTime   = ROUND_DURATION;
    this.started     = false;
    this.finished    = false;
    this.tickInterval= null;
    this._nextBotId  = 1000; // бот ids начинаются с 1000
    this._usedNames  = new Set();
  }

  allEntities() {
    return [...this.players.values(), ...this.bots.values()];
  }

  aliveCount() {
    return this.allEntities().filter(e => e.alive).length;
  }
}

/* ============================================================
   ENTITY FACTORY
============================================================ */
function makeEntity(id, gx, gy, name, color, trailColor, isBot, ownerGrid) {
  // Claim starting territory (5×5 square)
  const territory = new Set();
  const sz = 4;
  for (let dy = -sz; dy <= sz; dy++) {
    for (let dx = -sz; dx <= sz; dx++) {
      const tx = gx + dx, ty = gy + dy;
      if (tx >= 0 && tx < COLS && ty >= 0 && ty < ROWS) {
        const ci = ty * COLS + tx;
        if (ownerGrid[ci] < 0) {
          territory.add(ci);
          ownerGrid[ci] = id;
        }
      }
    }
  }
  return {
    id, gx, gy, name, color, trailColor, isBot,
    tgx: gx, tgy: gy, t: 0,
    dir: { x: [1,-1,0,0][id % 4] || 1, y: [0,0,1,-1][id % 4] || 0 },
    nextDir: null,
    trail: new Set(),
    territory,
    alive: true,
    kills: 0,
    px: gx * CELL + CELL / 2,
    py: gy * CELL + CELL / 2,
    // Bot AI state
    aiCooldown: Math.random() * 0.3,
    aiMode: 'EXPAND',
    aiSteps: 0,
    aiMaxSteps: 10 + Math.floor(Math.random() * 25),
    aggression: Math.random(),
  };
}

/* ============================================================
   BOT POSITIONS (расставляем по краям)
============================================================ */
const BOT_START_POSITIONS = [
  {x:50,y:50}, // center
  {x:15,y:15},{x:85,y:15},{x:15,y:85},{x:85,y:85}, // corners
  {x:50,y:12},{x:50,y:88},{x:12,y:50},{x:88,y:50}, // edges
  {x:33,y:33},{x:67,y:33},{x:33,y:67},{x:67,y:67}, // inner
];
const PLAYER_SPAWN_CANDIDATES = [
  {x:50,y:50},{x:15,y:15},{x:85,y:15},{x:15,y:85},{x:85,y:85},
  {x:50,y:12},{x:50,y:88},{x:12,y:50},{x:88,y:50},
  {x:33,y:33},{x:67,y:33},{x:33,y:67},{x:67,y:67},
];
const PLAYER_SPAWN_MIN_DIST = 26;

function randomSpawnPoint() {
  return {
    x: 8 + Math.floor(Math.random() * (COLS - 16)),
    y: 8 + Math.floor(Math.random() * (ROWS - 16)),
  };
}

function spawnDistance(a, b) {
  return Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
}

// Generate well-spaced spawn positions for real players
function getPlayerSpawnPositions(count) {
  const positions = [];
  function canPlace(c, minDist = PLAYER_SPAWN_MIN_DIST) {
    return positions.every(p => spawnDistance(p, c) >= minDist);
  }

  for (const c of PLAYER_SPAWN_CANDIDATES) {
    if (positions.length >= count) break;
    if (canPlace(c)) positions.push({ x: c.x, y: c.y });
  }

  let attempts = 0;
  while (positions.length < count && attempts < 2000) {
    const candidate = randomSpawnPoint();
    if (canPlace(candidate, PLAYER_SPAWN_MIN_DIST - 2)) {
      positions.push(candidate);
    }
    attempts++;
  }

  // Fallback: never block room creation even on very high player counts
  while (positions.length < count) {
    positions.push(randomSpawnPoint());
  }
  return positions;
}

function getFreshBotName(used) {
  const avail = BOT_NAMES.filter(n => !used.has(n));
  return avail.length
    ? avail[Math.floor(Math.random() * avail.length)]
    : BOT_NAMES[Math.floor(Math.random() * BOT_NAMES.length)];
}

/* ============================================================
   START ROOM (добавить ботов и запустить тик)
============================================================ */
function startRoom(room) {
  if (room.started) return;
  room.started = true;
  room.roundTime = ROUND_DURATION;

  // Add bots to fill the room
  const totalReal = room.players.size;
  // Party rooms can disable bots; normal rooms always fill
  const botsNeeded = room._partyWithBots === false
    ? 0
    : Math.max(0, BOTS_TO_FILL - totalReal);

  // Collect all taken positions (player positions)
  const takenPositions = [...room.players.values()].map(e => ({x: e.gx, y: e.gy}));

  function isTooClose(x, y, minDist=22) {
    return takenPositions.some(p => Math.abs(p.x-x)+Math.abs(p.y-y) < minDist);
  }

  for (let i = 0; i < botsNeeded; i++) {
    const botId = room._nextBotId++;
    const c     = BOT_COLORS[i % BOT_COLORS.length];
    const name  = getFreshBotName(room._usedNames);
    room._usedNames.add(name);

    // Find a position not too close to any existing entity
    let px, py, attempts = 0;
    do {
      const posIdx = (i + attempts) % BOT_START_POSITIONS.length;
      const base   = BOT_START_POSITIONS[posIdx];
      px = Math.max(6, Math.min(COLS-6, base.x + Math.floor((Math.random()-.5)*10)));
      py = Math.max(6, Math.min(ROWS-6, base.y + Math.floor((Math.random()-.5)*10)));
      attempts++;
    } while (isTooClose(px, py) && attempts < 20);

    takenPositions.push({x: px, y: py});
    room.bots.set(botId, makeEntity(botId, px, py, name, c.color, c.trail, true, room.ownerGrid));
  }

  // Send initial state to all players
  const initState = buildFullState(room);
  for (const [sid] of room.players) {
    io.to(sid).emit('game:start', initState);
  }

  // Start game tick
  room.tickInterval = setInterval(() => gameTick(room), TICK);
  console.log(`[Room ${room.id}] Started with ${totalReal} real + ${botsNeeded} bots`);
}

/* ============================================================
   GAME TICK (runs on server 20x/sec)
============================================================ */
function gameTick(room) {
  if (room.finished) {
    clearInterval(room.tickInterval);
    return;
  }

  const dt = TICK / 1000; // 0.05s

  const aliveEntities = room.allEntities().filter(e => e.alive);
  const aliveReal     = [...room.players.values()].filter(e => e.alive);

  // Сразу финиш: один оставшийся на карте (или все люди выбыли) — без ожидания таймера
  if (aliveEntities.length <= 1 || aliveReal.length === 0) {
    endRound(room);
    return;
  }

  // Countdown (только пока борьба за территорию продолжается)
  room.roundTime -= dt;
  if (room.roundTime <= 0) {
    room.roundTime = 0;
    endRound(room);
    return;
  }

  // Move all entities
  for (const e of room.allEntities()) {
    if (!e.alive) continue;
    if (e.isBot) runBotAI(e, room, dt);
    moveEntity(e, room, dt);
  }

  // Send delta to all clients (positions + trails + timer)
  const delta = buildDelta(room);
  for (const [sid] of room.players) {
    io.to(sid).emit('game:tick', delta);
  }
}

/* ============================================================
   MOVE ENTITY
============================================================ */
function moveEntity(e, room, dt) {
  e.t += SPEED * dt;
  if (e.t < 1) {
    e.px = (e.gx + (e.tgx - e.gx) * e.t) * CELL + CELL / 2;
    e.py = (e.gy + (e.tgy - e.gy) * e.t) * CELL + CELL / 2;
    return;
  }
  e.t -= 1; if (e.t > 1) e.t = 0;

  e.gx = e.tgx; e.gy = e.tgy;
  e.px = e.gx * CELL + CELL / 2;
  e.py = e.gy * CELL + CELL / 2;

  if (e.nextDir) {
    if (!(e.nextDir.x === -e.dir.x && e.nextDir.y === -e.dir.y)) e.dir = { ...e.nextDir };
    e.nextDir = null;
  }

  onCellEnter(e, room);
  if (!e.alive) return;

  const nx = e.gx + e.dir.x, ny = e.gy + e.dir.y;
  if (nx < 0 || nx >= COLS || ny < 0 || ny >= ROWS) {
    killEntity(e, null, room);
    return;
  }
  e.tgx = nx; e.tgy = ny;
}

/* ============================================================
   CELL ENTER (Paper.io rules: touching a trail kills the OWNER)
============================================================ */
function onCellEnter(e, room) {
  const ci = e.gy * COLS + e.gx;
  const trailOwner = room.trailGrid[ci];

  if (trailOwner >= 0) {
    if (trailOwner === e.id) {
      killEntity(e, null, room); // stepped on own trail → die
      return;
    }
    // Stepped on someone's trail → OWNER of trail dies; you keep moving and must paint this cell
    const owner = findEntityById(room, trailOwner);
    if (owner && owner.alive) killEntity(owner, e, room);
    else room.trailGrid[ci] = -1; // stale trail
    if (!e.alive) return;
    room.trailGrid[ci] = e.id;
    e.trail.add(ci);
    if (room.ownerGrid[ci] === e.id && e.trail.size > 0) {
      captureTerritory(e, room);
    }
    return;
  }

  if (room.ownerGrid[ci] === e.id && e.trail.size > 0) {
    captureTerritory(e, room);
    return;
  }
  if (room.ownerGrid[ci] === e.id) return;

  room.trailGrid[ci] = e.id;
  e.trail.add(ci);
}

/* ============================================================
   TERRITORY CAPTURE
============================================================ */
function captureTerritory(e, room) {
  const wall    = new Uint8Array(TOTAL);
  const outside = new Uint8Array(TOTAL);
  const queue   = [];

  for (const ci of e.territory) wall[ci] = 1;
  for (const ci of e.trail)     wall[ci] = 1;

  function flood(ci) {
    if (ci < 0 || ci >= TOTAL || wall[ci] || outside[ci]) return;
    outside[ci] = 1; queue.push(ci);
  }
  for (let x = 0; x < COLS; x++) { flood(x); flood((ROWS-1)*COLS+x); }
  for (let y = 1; y < ROWS-1; y++) { flood(y*COLS); flood(y*COLS+COLS-1); }

  let qi = 0;
  while (qi < queue.length) {
    const ci = queue[qi++], x = ci % COLS, y = (ci / COLS) | 0;
    if (x > 0)      flood(ci-1);
    if (x < COLS-1) flood(ci+1);
    if (y > 0)      flood(ci-COLS);
    if (y < ROWS-1) flood(ci+COLS);
  }

  for (let ci = 0; ci < TOTAL; ci++) {
    if (!outside[ci] && !e.territory.has(ci)) {
      const tOwner = room.trailGrid[ci];
      if (tOwner >= 0 && tOwner !== e.id) {
        const victim = findEntityById(room, tOwner);
        if (victim && victim.alive) killEntity(victim, e, room);
      }
      room.trailGrid[ci] = -1;
      const prev = room.ownerGrid[ci];
      if (prev >= 0 && prev !== e.id) {
        const prevE = findEntityById(room, prev);
        if (prevE) prevE.territory.delete(ci);
      }
      e.territory.add(ci); room.ownerGrid[ci] = e.id;
    }
  }

  for (const ci of e.trail) {
    room.trailGrid[ci] = -1;
    const prev = room.ownerGrid[ci];
    if (prev >= 0 && prev !== e.id) {
      const prevE = findEntityById(room, prev);
      if (prevE) prevE.territory.delete(ci);
    }
    e.territory.add(ci); room.ownerGrid[ci] = e.id;
  }
  e.trail.clear();
}

/* ============================================================
   KILL ENTITY
============================================================ */
function killEntity(e, killer, room) {
  if (!e || !e.alive) return;
  e.alive = false;

  for (const ci of e.trail) room.trailGrid[ci] = -1;
  e.trail.clear();
  for (const ci of e.territory) room.ownerGrid[ci] = -1;
  e.territory.clear();

  if (killer) {
    killer.kills++;
    // Notify killer's socket if it's a real player
    if (!killer.isBot) {
      const sid = killer.socketId;
      if (sid) io.to(sid).emit('game:kill', { victim: e.name });
    }
    // Notify victim's socket
    if (!e.isBot && e.socketId) {
      io.to(e.socketId).emit('game:death', { killer: killer.name });
    }
  } else {
    if (!e.isBot && e.socketId) {
      io.to(e.socketId).emit('game:death', { killer: 'border' });
    }
  }

  // Emit death event to all clients for explosion animation
  broadcastToRoom(room, 'game:entity_died', {
    id: e.id, px: e.px, py: e.py, color: e.color,
  });
}

/* ============================================================
   BOT AI
============================================================ */
function runBotAI(bot, room, dt) {
  bot.aiCooldown -= dt;
  if (bot.aiCooldown > 0) return;
  bot.aiCooldown = 0.2 + Math.random() * 0.5;

  const M = 4;
  if (bot.gx < M && bot.dir.x < 0)       { setDir(bot, 0, 1);  return; }
  if (bot.gx > COLS-M && bot.dir.x > 0)  { setDir(bot, 0, -1); return; }
  if (bot.gy < M && bot.dir.y < 0)       { setDir(bot, 1, 0);  return; }
  if (bot.gy > ROWS-M && bot.dir.y > 0)  { setDir(bot, -1, 0); return; }

  const fx = bot.gx + bot.dir.x * 2, fy = bot.gy + bot.dir.y * 2;
  if (fx >= 0 && fx < COLS && fy >= 0 && fy < ROWS) {
    if (room.trailGrid[fy*COLS+fx] === bot.id) {
      if (!tryBotTurn(bot, 1, room)) tryBotTurn(bot, -1, room);
      return;
    }
  }

  if (bot.aiMode === 'EXPAND') {
    bot.aiSteps++;
    const maxTrail = 14 + Math.floor(bot.aggression * 28);
    if (bot.trail.size > maxTrail || Math.random() < 0.03) {
      bot.aiMode = 'RETURN'; return;
    }
    if (bot.aiSteps > bot.aiMaxSteps || Math.random() < 0.14) {
      bot.aiSteps = 0;
      bot.aiMaxSteps = 8 + Math.floor(Math.random() * 24);
      const side = Math.random() < 0.5 ? 1 : -1;
      if (!tryBotTurn(bot, side, room)) tryBotTurn(bot, -side, room);
    }
  } else {
    if (bot.trail.size === 0) { bot.aiMode = 'EXPAND'; return; }
    botHeadHome(bot);
  }
}

function tryBotTurn(bot, side, room) {
  const d = bot.dir, nd = { x: -d.y*side, y: d.x*side };
  const nx = bot.gx+nd.x, ny = bot.gy+nd.y;
  if (nx<3||nx>=COLS-3||ny<3||ny>=ROWS-3) return false;
  if (room.trailGrid[ny*COLS+nx] === bot.id) return false;
  setDir(bot, nd.x, nd.y); return true;
}

function botHeadHome(bot) {
  if (!bot.territory.size) { bot.aiMode = 'EXPAND'; return; }
  let sx=0,sy=0,cnt=0;
  for (const ci of bot.territory) {
    if (++cnt > 50) break;
    sx += ci%COLS; sy += (ci/COLS)|0;
  }
  const tx=sx/cnt, ty=sy/cnt;
  const dx=tx-bot.gx, dy=ty-bot.gy;
  if (Math.abs(dx)>Math.abs(dy)) setDir(bot, Math.sign(dx)||1, 0);
  else                           setDir(bot, 0, Math.sign(dy)||1);
}

function setDir(e, dx, dy) {
  if (dx===-e.dir.x && dy===-e.dir.y) return;
  e.nextDir = { x: Math.sign(dx)||0, y: Math.sign(dy)||0 };
}

/* ============================================================
   HELPERS
============================================================ */
function findEntity(room, id) {
  if (room.players.has(id)) return room.players.get(id);
  return room.bots.get(id) || null;
}

// Also search by entity.id across bots (since bots use numeric ids)
function findEntityById(room, id) {
  for (const e of room.players.values()) if (e.id === id) return e;
  for (const e of room.bots.values()) if (e.id === id) return e;
  return null;
}

function broadcastToRoom(room, event, data) {
  for (const [sid] of room.players) io.to(sid).emit(event, data);
}

/* ============================================================
   BUILD STATE PAYLOADS
============================================================ */
function buildFullState(room) {
  const entities = [];
  for (const e of room.allEntities()) {
    entities.push(serializeEntity(e));
  }
  // Serialize grids as base64 for efficiency
  return {
    roomId:     room.id,
    roundTime:  room.roundTime,
    entities,
    ownerGrid:  Array.from(room.ownerGrid),   // send full grid on join
    trailGrid:  Array.from(room.trailGrid),
  };
}

function buildDelta(room) {
  const positions = {};
  const trails    = {};

  for (const e of room.allEntities()) {
    positions[e.id] = {
      px:    Math.round(e.px),
      py:    Math.round(e.py),
      alive: e.alive,
      gx:    e.gx,
      gy:    e.gy,
    };
    trails[e.id] = [...e.trail];
  }
  return {
    roundTime: Math.round(room.roundTime * 10) / 10,
    positions,
    trails,
    // Send full ownerGrid every tick — clients need it to draw territories
    // ~100*100*2 bytes = ~20KB, fine for 20 ticks/sec
    ownerGrid: Array.from(room.ownerGrid),
  };
}

function serializeEntity(e) {
  return {
    id:          e.id,
    name:        e.name,
    color:       e.color,
    trailColor:  e.trailColor,
    isBot:       e.isBot,
    gx:          e.gx, gy: e.gy,
    px:          e.px, py: e.py,
    dir:         e.dir,
    alive:       e.alive,
    kills:       e.kills,
    territory:   [...e.territory],
    trail:       [...e.trail],
  };
}

/* ============================================================
   END ROUND
============================================================ */
function endRound(room) {
  if (room.finished) return;
  room.finished = true;
  clearInterval(room.tickInterval);

  const all = room.allEntities().sort((a,b) => b.territory.size - a.territory.size);
  const results = all.map((e, i) => ({
    id:         e.id,
    name:       e.name,
    color:      e.color,
    socketId:   e.socketId || null,
    place:      i + 1,
    territory:  (e.territory.size / TOTAL * 100).toFixed(1),
    kills:      e.kills,
    isBot:      e.isBot,
  }));

  broadcastToRoom(room, 'game:over', { results });

  // Clean up room after 30s
  setTimeout(() => {
    rooms.delete(room.id);
    console.log(`[Room ${room.id}] Cleaned up`);
  }, 30000);
}

/* ============================================================
   MATCHMAKING QUEUE
============================================================ */
const matchmakingQueue = []; // { socketId, playerData }
let matchmakingTimer = null;

function tryMatchmaking() {
  if (matchmakingQueue.length < 1) return;

  // Create a room, add all queued players
  const room  = new RoomState(generateRoomId());
  const batch = matchmakingQueue.splice(0, MAX_PLAYERS_PER_ROOM);

  const playerPositions = getPlayerSpawnPositions(batch.length);

  batch.forEach((item, i) => {
    const socket = io.sockets.sockets.get(item.socketId);
    if (!socket) return;

    const pos = playerPositions[i] || playerPositions[0];
    const p   = item.playerData;
    const eid = i; // entity id = index (0 = first player)

    const entity = makeEntity(
      eid,
      Math.max(6, Math.min(COLS-6, pos.x)),
      Math.max(6, Math.min(ROWS-6, pos.y)),
      p.name || 'Player', p.color || '#60a5fa', p.trailColor || '#1d4ed8',
      false,
      room.ownerGrid
    );
    entity.socketId = item.socketId;
    room.players.set(item.socketId, entity);
    room._usedNames.add(entity.name);

    socket.join(room.id);
    socket.data.roomId    = room.id;
    socket.data.entityId  = eid;

    // Tell client they've been matched
    socket.emit('match:found', {
      roomId:      room.id,
      entityId:    eid,
      playerCount: batch.length,
      // Send all queued player names so client can show them
      players:     batch.map(b => b.playerData.name),
    });
  });

  rooms.set(room.id, room);

  // Countdown: 20s if 2+ real players, 5s if only 1
  const waitMs = batch.length >= 2 ? 20000 : 5000;
  let remaining = Math.ceil(waitMs / 1000);

  // Broadcast countdown every second
  const countdownInterval = setInterval(() => {
    remaining--;
    for (const [sid] of room.players) {
      io.to(sid).emit('match:countdown', { seconds: remaining, total: Math.ceil(waitMs/1000) });
    }
    if (remaining <= 0) clearInterval(countdownInterval);
  }, 1000);

  setTimeout(() => {
    clearInterval(countdownInterval);
    startRoom(room);
  }, waitMs);

  console.log(`[Room ${room.id}] Created with ${batch.length} players, starting in ${waitMs/1000}s`);
}

/* ============================================================
   SOCKET.IO EVENT HANDLERS
============================================================ */
io.on('connection', (socket) => {
  console.log(`[+] Socket connected: ${socket.id}`);
  setupPartyEvents(socket);

  /* ── MATCHMAKING ── */
  socket.on('match:join', (playerData) => {
    // playerData = { name, color, trailColor, uid }
    matchmakingQueue.push({ socketId: socket.id, playerData });
    socket.emit('match:queued', { position: matchmakingQueue.length });

    // Try to start a match immediately if enough players
    // OR start a timer to fill with bots
    clearTimeout(matchmakingTimer);
    if (matchmakingQueue.length >= MIN_REAL_TO_START) {
      tryMatchmaking();
    } else {
      // Wait up to 8 seconds for more players, then fill with bots
      matchmakingTimer = setTimeout(tryMatchmaking, 8000);
    }
  });

  socket.on('match:cancel', () => {
    const idx = matchmakingQueue.findIndex(x => x.socketId === socket.id);
    if (idx >= 0) matchmakingQueue.splice(idx, 1);
  });

  /* ── PLAYER INPUT ── */
  socket.on('input:dir', (dir) => {
    const roomId = socket.data.roomId;
    if (!roomId) return;
    const room   = rooms.get(roomId);
    if (!room || !room.started || room.finished) return;

    const entity = room.players.get(socket.id);
    if (!entity || !entity.alive) return;

    // Validate direction: only cardinal dirs, no 180 flip
    const dx = Math.sign(dir.x), dy = Math.sign(dir.y);
    if ((dx !== 0) === (dy !== 0)) return; // must be exactly one axis
    if (dx === -entity.dir.x && dy === -entity.dir.y) return; // no u-turn

    entity.nextDir = { x: dx, y: dy };
  });

  /* ── DISCONNECT ── */
  socket.on('disconnect', () => {
    console.log(`[-] Socket disconnected: ${socket.id}`);

    // Clean up party membership
    leaveAllParties(socket.id);

    // Remove from matchmaking queue
    const qi = matchmakingQueue.findIndex(x => x.socketId === socket.id);
    if (qi >= 0) matchmakingQueue.splice(qi, 1);

    // Kill entity in room
    const roomId = socket.data.roomId;
    if (!roomId) return;
    const room = rooms.get(roomId);
    if (!room) return;

    const entity = room.players.get(socket.id);
    if (entity && entity.alive) killEntity(entity, null, room);
    room.players.delete(socket.id);

    // If room is empty → clean up immediately
    if (room.players.size === 0) {
      clearInterval(room.tickInterval);
      rooms.delete(roomId);
      console.log(`[Room ${roomId}] Empty, removed`);
    }
  });

  /* ── PING/PONG for latency display ── */
  socket.on('ping', (cb) => { if (typeof cb === 'function') cb(); });
});

/* ============================================================
   STATUS ENDPOINT
============================================================ */

/* ============================================================
   PARTY ROOMS
============================================================ */
const partyRooms = new Map(); // code → { code, hostSocketId, players: [{socketId, name, isHost}] }

function generatePartyCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

function setupPartyEvents(socket) {
  socket.on('party:create', ({ name }) => {
    // Leave any existing party
    leaveAllParties(socket.id);
    let code;
    do { code = generatePartyCode(); } while (partyRooms.has(code));

    const room = {
      code,
      hostSocketId: socket.id,
      players: [{ socketId: socket.id, name: name || 'Host', isHost: true, isMe: false }],
    };
    partyRooms.set(code, room);
    socket.join('party_' + code);
    socket.data.partyCode = code;

    socket.emit('party:created', {
      code,
      players: room.players.map(p => ({ ...p, isMe: p.socketId === socket.id })),
    });
    console.log(`[Party] Created ${code} by ${name}`);
  });

  socket.on('party:join', ({ code, name }) => {
    const room = partyRooms.get(code?.toUpperCase());
    if (!room) { socket.emit('party:error', { msg: 'Room not found' }); return; }
    if (room.players.length >= 10) { socket.emit('party:error', { msg: 'Room is full' }); return; }

    leaveAllParties(socket.id);
    room.players.push({ socketId: socket.id, name: name || 'Player', isHost: false });
    socket.join('party_' + code);
    socket.data.partyCode = code;

    // Tell the joiner
    socket.emit('party:joined', {
      code,
      players: room.players.map(p => ({ ...p, isMe: p.socketId === socket.id })),
    });

    // Tell everyone else
    broadcastPartyUpdate(room, socket.id);
    console.log(`[Party] ${name} joined ${code}`);
  });

  socket.on('party:leave', ({ code }) => {
    leaveAllParties(socket.id);
  });

  socket.on('party:start', ({ code, withBots }) => {
    const codeKey = code ? String(code).toUpperCase() : '';
    const room = partyRooms.get(codeKey);
    if (!room) return;
    if (room.hostSocketId !== socket.id) return;

    const members = room.players.map(p => ({
      socketId: p.socketId,
      playerData: { name: p.name, color: '#60a5fa', trailColor: '#1d4ed8' },
    }));

    const gameRoom = new RoomState(generateRoomId());
    const positions = getPlayerSpawnPositions(members.length);

    members.forEach((item, i) => {
      const sock = io.sockets.sockets.get(item.socketId);
      if (!sock) return;
      const pos = positions[i];
      const eid = i;
      const entity = makeEntity(
        eid, Math.max(6,Math.min(COLS-6,pos.x)),
        Math.max(6,Math.min(ROWS-6,pos.y)),
        item.playerData.name, '#60a5fa', '#1d4ed8', false, gameRoom.ownerGrid
      );
      entity.socketId = item.socketId;
      gameRoom.players.set(item.socketId, entity);
      sock.join(gameRoom.id);
      sock.data.roomId   = gameRoom.id;
      sock.data.entityId = eid;
      sock.emit('match:found', {
        roomId: gameRoom.id, entityId: eid,
        playerCount: members.length,
        players: members.map(m => m.playerData.name),
      });
    });

    // Party bots setting: withBots=true fills remaining slots with bots
    gameRoom._partyWithBots = !!withBots;

    rooms.set(gameRoom.id, gameRoom);
    partyRooms.delete(codeKey);

    io.to('party_' + codeKey).emit('party:start_game', { roomId: gameRoom.id });

    setTimeout(() => startRoom(gameRoom), 5000);
    console.log(`[Party] ${codeKey} started → Room ${gameRoom.id} bots=${withBots}`);
  });
}

function leaveAllParties(socketId) {
  for (const [code, room] of partyRooms) {
    const idx = room.players.findIndex(p => p.socketId === socketId);
    if (idx < 0) continue;
    room.players.splice(idx, 1);
    if (room.players.length === 0) {
      partyRooms.delete(code);
    } else {
      // If host left, assign new host
      if (room.hostSocketId === socketId) {
        room.hostSocketId = room.players[0].socketId;
        room.players[0].isHost = true;
      }
      broadcastPartyUpdate(room, null);
    }
    const s = io.sockets.sockets.get(socketId);
    if (s) { s.leave('party_' + code); delete s.data.partyCode; }
  }
}

function broadcastPartyUpdate(room, exceptSocketId) {
  room.players.forEach(p => {
    const s = io.sockets.sockets.get(p.socketId);
    if (s && p.socketId !== exceptSocketId) {
      s.emit('party:updated', {
        players: room.players.map(x => ({ ...x, isMe: x.socketId === p.socketId })),
      });
    }
  });
}

app.get('/status', (req, res) => {
  res.json({
    rooms:       rooms.size,
    queue:       matchmakingQueue.length,
    connections: io.engine.clientsCount,
    uptime:      Math.floor(process.uptime()),
  });
});

/* ============================================================
   START SERVER
============================================================ */
server.listen(PORT, '0.0.0.0', () => {
  console.log(`
╔══════════════════════════════════╗
║   CIRCLE.IO Server running       ║
║   Port: ${PORT}                    ║
║   Status: /status                ║
╚══════════════════════════════════╝
  `);
});
