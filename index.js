require('dotenv').config();
const mineflayer = require('mineflayer');
const express    = require('express');
const net        = require('net');

// ─── Process-level crash guard ────────────────────────────────────────────────
// Keeps Render's free-tier process alive even on unexpected errors.
process.on('uncaughtException',  err  => _log('[CRASH] Uncaught exception:', err.message, err.stack));
process.on('unhandledRejection', (r)  => _log('[CRASH] Unhandled rejection:', r));

// ─── Server pool ──────────────────────────────────────────────────────────────
// Tried in order. Bot locks onto whichever it spawns on.
// Override via BOT_SERVERS="host1:port1,host2:port2"
function parseServers() {
  if (process.env.BOT_SERVERS) {
    return process.env.BOT_SERVERS.split(',')
      .map(s => { const [h, p] = s.trim().split(':'); return { host: h.trim(), port: parseInt(p) || 25565 }; })
      .filter(s => s.host);
  }
  return [
    { host: process.env.BOT_HOST || 'villainsmpknowledge.falixsrv.me', port: parseInt(process.env.BOT_PORT || '20013') },
    { host: '162.55.28.90', port: 20008 },
  ];
}
const SERVERS = parseServers();

// ─── Config ───────────────────────────────────────────────────────────────────
const USERNAME          = process.env.BOT_USERNAME      || 'XiterBot';
const VERSION           = process.env.MC_VERSION        || '1.20.1';
const AUTH              = process.env.BOT_AUTH          || 'offline';
const OWNER             = process.env.OWNER_USERNAME    || '';
const PREFIX            = process.env.CHAT_PREFIX       || '!';
const RECONNECT_BASE_MS = parseInt(process.env.RECONNECT_DELAY || '15000');
const AFK_INTERVAL_MS   = parseInt(process.env.AFK_INTERVAL    || '30000');
const TCP_TIMEOUT_MS    = 8000;
const SPAWN_TIMEOUT_MS  = 30000;   // give up if spawn doesn't fire within 30s
const MAX_LOCK_FAILS    = 5;       // unlock after this many consecutive failures on locked server

// ─── State ────────────────────────────────────────────────────────────────────
let botStatus       = 'starting';
let botStartTime    = Date.now();
let reconnectCount  = 0;
let reconnectDelay  = RECONNECT_BASE_MS;
let lockFailCount   = 0;           // consecutive failures while locked in
let lastError       = '';
let activeServer    = SERVERS[0];
let lockedIn        = false;
let chatLog         = [];
let deviceAuth      = null;
let afkTimer        = null;
let spawnTimeout    = null;
let reconnectTimer  = null;
let currentBotId    = 0;           // incremented each time we create a bot — lets old event handlers self-invalidate

// ─── Logging — intercept for prismarine-auth device-code ─────────────────────
const _log = console.log.bind(console);
console.log = (...args) => {
  const msg = args.join(' ');
  const code = msg.match(/code[:\s]+([A-Z0-9]{8,})/i);
  const uri  = msg.match(/https:\/\/\S+/);
  if (code && uri) {
    deviceAuth = { userCode: code[1], verificationUri: uri[0].replace(/[,.]$/, ''), expiresAt: Date.now() + 15 * 60 * 1000 };
    _log('[Auth] Device code:', deviceAuth.userCode, '→', deviceAuth.verificationUri);
    return;
  }
  _log(...args);
};

function addLog(source, username, message) {
  chatLog.push({ ts: Date.now(), source, username, message });
  if (chatLog.length > 50) chatLog.shift();
}

// ─── TCP ping ─────────────────────────────────────────────────────────────────
function tcpPing(host, port, ms) {
  return new Promise(resolve => {
    const sock = new net.Socket();
    let done = false;
    const finish = (ok, reason) => { if (done) return; done = true; sock.destroy(); resolve({ ok, reason }); };
    sock.setTimeout(ms);
    sock.connect(port, host, () => finish(true, 'open'));
    sock.on('error',   e => finish(false, e.code === 'ECONNREFUSED' ? 'Connection refused — server offline?' : e.message));
    sock.on('timeout', () => finish(false, 'Timed out — server not responding'));
  });
}

// ─── Find a reachable server ──────────────────────────────────────────────────
async function findServer() {
  // If locked and not over the fail threshold, only check the active server
  const list = (lockedIn && lockFailCount < MAX_LOCK_FAILS) ? [activeServer] : SERVERS;
  if (lockedIn && lockFailCount >= MAX_LOCK_FAILS) {
    _log(`[Bot] ${MAX_LOCK_FAILS} consecutive lock failures — unlocking and scanning all servers`);
    lockedIn      = false;
    lockFailCount = 0;
    reconnectDelay = RECONNECT_BASE_MS;
  }
  for (const srv of list) {
    _log(`[Net] Pinging ${srv.host}:${srv.port}…`);
    const { ok, reason } = await tcpPing(srv.host, srv.port, TCP_TIMEOUT_MS);
    if (ok) return { server: srv, error: null };
    _log(`[Net] ${srv.host}:${srv.port} unreachable — ${reason}`);
  }
  return { server: null, error: 'All servers unreachable' };
}

// ─── Web dashboard ────────────────────────────────────────────────────────────
const app      = express();
const WEB_PORT = process.env.PORT || 3000;
app.use(express.json());
app.get('/',           (_req, res) => res.send(dashboardHTML()));
app.get('/health',     (_req, res) => res.send('OK'));
app.get('/api/status', (_req, res) => res.json({
  status:      botStatus,
  server:      activeServer.host + ':' + activeServer.port,
  lockedIn,
  lockFailCount,
  servers:     SERVERS.map(s => s.host + ':' + s.port),
  username:    USERNAME,
  auth:        AUTH,
  version:     VERSION,
  uptime_sec:  Math.floor((Date.now() - botStartTime) / 1000),
  reconnects:  reconnectCount,
  nextRetry:   reconnectDelay,
  lastError,
  deviceAuth:  deviceAuth && Date.now() < deviceAuth.expiresAt ? deviceAuth : null,
  chatLog:     chatLog.slice(-20),
}));
app.listen(WEB_PORT, () => _log('[Web] Dashboard → http://localhost:' + WEB_PORT));

// ─── Anti-AFK ─────────────────────────────────────────────────────────────────
const afkActions = [
  b => { b.setControlState('jump',    true); setTimeout(() => { try { b.setControlState('jump',    false); } catch(_){} }, 500); },
  b => { b.setControlState('sneak',   true); setTimeout(() => { try { b.setControlState('sneak',   false); } catch(_){} }, 800); },
  b => { b.setControlState('forward', true); setTimeout(() => { try { b.setControlState('forward', false); } catch(_){} }, 600); },
  b => { b.setControlState('back',    true); setTimeout(() => { try { b.setControlState('back',    false); } catch(_){} }, 600); },
  b => { b.setControlState('left',    true); setTimeout(() => { try { b.setControlState('left',    false); } catch(_){} }, 600); },
  b => { b.setControlState('right',   true); setTimeout(() => { try { b.setControlState('right',   false); } catch(_){} }, 600); },
  b => { if (b.entity) b.look((Math.random() * 2 - 1) * Math.PI, 0, false); },
  b => { b.swingArm('right'); },
  b => { b.swingArm('left');  },
  b => {
    if (!b.entity) return;
    let n = 0;
    const id = setInterval(() => {
      try { if (b.entity) b.look(b.entity.yaw + Math.PI / 8, 0, false); else clearInterval(id); }
      catch(_) { clearInterval(id); }
      if (++n >= 16) clearInterval(id);
    }, 60);
  },
];
const afkChat = ['.', 'AFK', 'I am here', 'Still online'];
let chatIdx = 0;

function doAFK(bot) {
  // Safety: skip if bot entity isn't ready
  if (!bot || !bot.entity) return;
  const action = afkActions[Math.floor(Math.random() * afkActions.length)];
  try { action(bot); } catch(_) {}
  if (Math.random() < 0.08) {
    try { bot.chat(afkChat[chatIdx++ % afkChat.length]); } catch(_) {}
  }
}

function clearAllControlStates(bot) {
  // Ensure no movement keys are stuck when the bot disconnects
  const states = ['forward', 'back', 'left', 'right', 'jump', 'sneak', 'sprint'];
  for (const s of states) try { bot.setControlState(s, false); } catch(_) {}
}

// ─── Commands ─────────────────────────────────────────────────────────────────
function handleCmd(bot, sender, msg) {
  const p = PREFIX;
  const isOwner = !OWNER || sender === OWNER;
  try {
    if (msg === p + 'ping') {
      bot.chat('Pong! 🏓');
    } else if (msg === p + 'status') {
      const u = Math.floor((Date.now() - botStartTime) / 1000);
      bot.chat(`Up ${Math.floor(u/3600)}h${Math.floor((u%3600)/60)}m${u%60}s | Reconnects: ${reconnectCount} | ${activeServer.host}:${activeServer.port}`);
    } else if (msg === p + 'pos') {
      const p2 = bot.entity?.position;
      bot.chat(p2 ? `Pos: ${Math.floor(p2.x)}, ${Math.floor(p2.y)}, ${Math.floor(p2.z)}` : 'Position unknown');
    } else if (msg === p + 'health') {
      bot.chat(`HP: ${bot.health?.toFixed(1) ?? '?'}/20  Food: ${bot.food ?? '?'}/20`);
    } else if (msg === p + 'players') {
      const names = Object.keys(bot.players || {}).filter(n => n !== bot.username);
      bot.chat(names.length ? 'Online: ' + names.slice(0, 10).join(', ') : 'No other players.');
    } else if (msg === p + 'servers') {
      bot.chat('Pool: ' + SERVERS.map(s => s.host + ':' + s.port).join(' | '));
    } else if (msg === p + 'help') {
      bot.chat(`Commands: ${p}ping ${p}status ${p}pos ${p}health ${p}players ${p}servers${isOwner ? ` ${p}stop ${p}reconnect` : ''}`);
    } else if (msg === p + 'reconnect' && isOwner) {
      bot.chat('Reconnecting and scanning all servers…');
      lockedIn      = false;
      lockFailCount = 0;
      reconnectDelay = RECONNECT_BASE_MS;
      setTimeout(() => { try { bot.quit(); } catch(_) {} }, 500);
    } else if (msg === p + 'stop' && isOwner) {
      bot.chat('Stopping. Goodbye!');
      setTimeout(() => process.exit(0), 1000);
    }
  } catch(_) {}
}

// ─── Bot factory ──────────────────────────────────────────────────────────────
async function connectBot() {
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }

  // Give each bot instance a unique ID so stale event handlers can self-invalidate
  const myId = ++currentBotId;

  // 1. TCP-check servers
  botStatus = 'checking_servers';
  lastError = '';
  const { server, error } = await findServer();

  if (myId !== currentBotId) return; // superseded by a newer call

  if (!server) {
    lastError = error || 'All servers unreachable';
    _log('[Bot]', lastError);
    botStatus = 'server_offline';
    lockFailCount++;
    addLog('system', 'Bot', lastError);
    scheduleReconnect();
    return;
  }

  activeServer = server;
  _log(`[Bot] Connecting to ${server.host}:${server.port} as ${USERNAME} (${AUTH})…`);
  botStatus  = 'connecting';
  deviceAuth = null;

  // 2. Create bot
  let bot;
  try {
    bot = mineflayer.createBot({
      host:     server.host,
      port:     server.port,
      username: USERNAME,
      version:  VERSION,
      auth:     AUTH,
      hideErrors: false,
    });
  } catch (err) {
    if (myId !== currentBotId) return;
    lastError = err.message;
    _log('[Bot] createBot error:', err.message);
    lockFailCount++;
    scheduleReconnect();
    return;
  }

  // 3. Spawn timeout — if server accepts TCP but login hangs, give up after 30s
  spawnTimeout = setTimeout(() => {
    if (myId !== currentBotId) return;
    _log('[Bot] Spawn timeout — login hung, reconnecting…');
    lastError = 'Spawn timeout — server accepted connection but did not complete login';
    lockFailCount++;
    cleanup('timed out');
    scheduleReconnect();
  }, SPAWN_TIMEOUT_MS);

  // 4. Spawned successfully
  bot.once('spawn', () => {
    if (myId !== currentBotId) { try { bot.quit(); } catch(_) {} return; }
    if (spawnTimeout) { clearTimeout(spawnTimeout); spawnTimeout = null; }
    _log(`[Bot] Spawned on ${server.host}:${server.port}! Locked in. Anti-AFK active.`);
    botStatus      = 'online';
    lastError      = '';
    lockedIn       = true;
    lockFailCount  = 0;
    reconnectDelay = RECONNECT_BASE_MS;
    deviceAuth     = null;
    afkTimer = setInterval(() => { if (myId === currentBotId) doAFK(bot); }, AFK_INTERVAL_MS);
    addLog('system', 'Bot', `Connected to ${server.host}:${server.port}`);
  });

  // 5. Chat
  bot.on('chat', (u, m) => {
    if (myId !== currentBotId || u === bot.username) return;
    _log(`[Chat] <${u}> ${m}`);
    addLog('chat', u, m);
    if (m.startsWith(PREFIX)) handleCmd(bot, u, m);
  });
  bot.on('whisper', (u, m) => {
    if (myId !== currentBotId) return;
    _log(`[Whisper] ${u}: ${m}`);
    addLog('whisper', u, m);
    if (m.startsWith(PREFIX)) handleCmd(bot, u, m);
  });

  // 6. Disconnect — use a single `dead` flag to prevent double-handling
  let dead = false;
  function onDisconnect(status, reason) {
    if (dead || myId !== currentBotId) return;
    dead = true;
    if (spawnTimeout) { clearTimeout(spawnTimeout); spawnTimeout = null; }
    lastError = reason || '';
    botStatus  = status;
    _log(`[Bot] ${status}: ${reason}`);
    if (reason) addLog('system', 'Bot', `${status}: ${reason}`);
    if (status !== 'online') lockFailCount++;
    cleanup(reason);
    scheduleReconnect();
  }

  bot.on('kicked', reason => {
    const r = typeof reason === 'string' ? reason : JSON.stringify(reason);
    onDisconnect('kicked', r);
  });
  bot.on('error', err => onDisconnect('error', err.message));
  bot.on('end',   reason => onDisconnect('disconnected', reason || 'Connection ended'));

  // 7. Cleanup for this bot instance
  function cleanup(reason) {
    // Clear AFK timer first so no more AFK actions fire on a dead bot
    if (afkTimer) { clearInterval(afkTimer); afkTimer = null; }
    // Try to clear control states to prevent stuck keys
    try { clearAllControlStates(bot); } catch(_) {}
    // Gracefully end the bot; don't removeAllListeners (breaks mineflayer internals)
    try { bot.end(reason || 'cleanup'); } catch(_) {}
  }
}

function scheduleReconnect() {
  if (reconnectTimer) return; // already scheduled — don't stack
  reconnectCount++;
  const delaySec = Math.round(reconnectDelay / 1000);
  _log(`[Bot] Retry #${reconnectCount} in ${delaySec}s (locked=${lockedIn}, lockFails=${lockFailCount})…`);
  botStatus = 'waiting_to_reconnect';
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectBot().catch(err => {
      _log('[Bot] connectBot threw:', err.message);
      scheduleReconnect();
    });
  }, reconnectDelay);
  // Exponential backoff: 15 → 30 → 60 → 120s cap
  reconnectDelay = Math.min(reconnectDelay * 2, 120_000);
}

// ─── Start ────────────────────────────────────────────────────────────────────
connectBot().catch(err => {
  _log('[Bot] Initial connect failed:', err.message);
  scheduleReconnect();
});

// ─── Dashboard HTML ───────────────────────────────────────────────────────────
function dashboardHTML() {
return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1.0"/>
<title>Minecraft-Xiter Dashboard</title>
<style>
:root{--bg:#0f1117;--card:#1a1d27;--border:#2a2d3e;--green:#4ade80;--yellow:#facc15;--red:#f87171;--blue:#60a5fa;--orange:#fb923c;--purple:#a78bfa;--text:#e2e8f0;--muted:#64748b}
*{box-sizing:border-box;margin:0;padding:0}
body{background:var(--bg);color:var(--text);font-family:'Segoe UI',system-ui,sans-serif;min-height:100vh}
header{background:var(--card);border-bottom:1px solid var(--border);padding:16px 24px;display:flex;align-items:center;gap:12px}
header h1{font-size:1.2rem;font-weight:700}
header span{font-size:.75rem;color:var(--muted);margin-left:auto}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:16px;padding:20px 24px;max-width:1100px;margin:0 auto}
@media(max-width:680px){.grid{grid-template-columns:1fr}}
.card{background:var(--card);border:1px solid var(--border);border-radius:12px;padding:18px 20px}
.card h2{font-size:.7rem;text-transform:uppercase;letter-spacing:.08em;color:var(--muted);margin-bottom:12px}
.badge{display:inline-flex;align-items:center;gap:6px;padding:4px 12px;border-radius:999px;font-size:.84rem;font-weight:600}
.dot{width:8px;height:8px;border-radius:50%}
.online{background:rgba(74,222,128,.15);color:var(--green)}.online .dot{background:var(--green);box-shadow:0 0 6px var(--green);animation:p 1.5s infinite}
.error,.kicked{background:rgba(248,113,113,.15);color:var(--red)}.error .dot,.kicked .dot{background:var(--red)}
.connecting,.waiting_to_reconnect,.starting,.checking_servers{background:rgba(250,204,21,.12);color:var(--yellow)}.connecting .dot,.waiting_to_reconnect .dot,.starting .dot,.checking_servers .dot{background:var(--yellow);animation:p 1s infinite}
.server_offline{background:rgba(251,146,60,.12);color:var(--orange)}.server_offline .dot{background:var(--orange)}
.disconnected{background:rgba(100,116,139,.15);color:var(--muted)}.disconnected .dot{background:var(--muted)}
@keyframes p{0%,100%{opacity:1}50%{opacity:.35}}
.err-box{background:rgba(248,113,113,.08);border:1px solid rgba(248,113,113,.25);border-radius:8px;padding:10px 12px;margin-top:10px;font-size:.8rem;color:var(--red);word-break:break-all}
.off-box{background:rgba(251,146,60,.08);border:1px solid rgba(251,146,60,.25);border-radius:8px;padding:10px 12px;margin-top:10px;font-size:.8rem;color:var(--orange)}
.off-box ul{margin-left:16px;margin-top:4px;line-height:1.8}
.lock-badge{display:inline-flex;align-items:center;gap:5px;font-size:.74rem;padding:2px 8px;border-radius:999px;margin-left:8px}
.locked{background:rgba(167,139,250,.15);color:var(--purple)}.unlocked{background:rgba(100,116,139,.12);color:var(--muted)}
.stat-row{display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid var(--border);font-size:.85rem}
.stat-row:last-child{border-bottom:none}.stat-row .label{color:var(--muted)}
.srv-list{margin-top:8px;display:flex;flex-direction:column;gap:4px}
.srv-item{font-size:.79rem;padding:5px 10px;border-radius:6px;border:1px solid var(--border);display:flex;align-items:center;gap:8px}
.srv-item.active{border-color:var(--green);background:rgba(74,222,128,.06)}
.srv-item.active .sdot{background:var(--green);box-shadow:0 0 4px var(--green);animation:p 2s infinite}
.sdot{width:6px;height:6px;border-radius:50%;background:var(--muted);flex-shrink:0}
.auth-box{background:rgba(250,204,21,.08);border:1px solid rgba(250,204,21,.3);border-radius:10px;padding:14px;margin-top:8px}
.auth-box h3{color:var(--yellow);font-size:.9rem;margin-bottom:8px}
.code{font-family:monospace;font-size:1.4rem;letter-spacing:.2em;color:var(--yellow);font-weight:700}
.auth-box a{color:var(--blue);font-size:.84rem}
.chat-log{height:230px;overflow-y:auto;display:flex;flex-direction:column;gap:3px}
.chat-entry{font-size:.79rem;line-height:1.4;padding:2px 0}
.chat-entry .time{color:var(--muted);margin-right:5px;font-size:.71rem}
.chat-entry .user{font-weight:600}
.chat-entry.chat .user{color:var(--green)}.chat-entry.whisper .user{color:var(--blue)}.chat-entry.system .user{color:var(--muted);font-style:italic}
.chat-log::-webkit-scrollbar{width:4px}.chat-log::-webkit-scrollbar-thumb{background:var(--muted);border-radius:2px}
.wide{grid-column:1/-1}
.uptime{font-size:1.4rem;font-weight:700;color:var(--green)}
.cmds code{display:inline-block;background:rgba(96,165,250,.1);color:var(--blue);border:1px solid rgba(96,165,250,.2);border-radius:6px;padding:2px 8px;font-size:.76rem;margin:2px}
footer{text-align:center;color:var(--muted);font-size:.71rem;padding:24px}
</style>
</head>
<body>
<header>
  <svg width="30" height="30" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg">
    <rect width="16" height="16" rx="3" fill="#1a1d27"/>
    <rect x="5" y="2" width="6" height="6" rx="1" fill="#c6a878"/>
    <rect x="6" y="3" width="1" height="1" fill="#3a2a1a"/><rect x="9" y="3" width="1" height="1" fill="#3a2a1a"/>
    <rect x="6" y="5" width="4" height="1" fill="#3a2a1a"/>
    <rect x="4" y="8" width="8" height="6" rx="1" fill="#4ade80"/>
    <rect x="2" y="9" width="3" height="4" rx="1" fill="#4ade80"/>
    <rect x="11" y="9" width="3" height="4" rx="1" fill="#4ade80"/>
    <rect x="5" y="11" width="3" height="3" rx=".5" fill="#1a1d27"/>
    <rect x="8" y="11" width="3" height="3" rx=".5" fill="#1a1d27"/>
  </svg>
  <h1>Minecraft-Xiter Dashboard</h1>
  <span id="updated">Loading…</span>
</header>

<div class="grid">
  <div class="card">
    <h2>Bot Status</h2>
    <div style="display:flex;align-items:center;flex-wrap:wrap;gap:6px;margin-bottom:4px">
      <div id="badge" class="badge starting"><span class="dot"></span><span id="status-text">Starting…</span></div>
      <span id="lock-badge" class="lock-badge unlocked">🔓 scanning</span>
    </div>
    <div id="err-box"  style="display:none" class="err-box"></div>
    <div id="off-box"  style="display:none" class="off-box">
      <strong>All servers unreachable.</strong>
      <ul>
        <li>Start your server at <a href="https://client.falixnodes.net" target="_blank" style="color:var(--orange)">FalixNodes</a></li>
        <li>Bot retries automatically every retry cycle</li>
      </ul>
    </div>
    <div id="auth-box" style="display:none" class="auth-box">
      <h3>🔑 Microsoft Login Required</h3>
      <p>Enter this code at the link below:</p>
      <div class="code" id="device-code">——</div>
      <a id="device-uri" href="#" target="_blank">Open microsoft.com/devicelogin ↗</a>
      <p id="device-exp" style="font-size:.77rem;color:var(--muted);margin-top:5px"></p>
    </div>
  </div>

  <div class="card">
    <h2>Server Pool</h2>
    <div class="srv-list" id="srv-list">Loading…</div>
    <p style="font-size:.73rem;color:var(--muted);margin-top:10px">Locks onto first server that responds. After <strong>5 consecutive failures</strong> it unlocks and scans all again.</p>
  </div>

  <div class="card">
    <h2>Stats</h2>
    <div id="uptime" class="uptime">—</div>
    <div style="margin-top:10px">
      <div class="stat-row"><span class="label">Username</span><span class="value" id="s-user">—</span></div>
      <div class="stat-row"><span class="label">Auth</span><span class="value" id="s-auth">—</span></div>
      <div class="stat-row"><span class="label">Version</span><span class="value" id="s-ver">—</span></div>
      <div class="stat-row"><span class="label">Reconnects</span><span class="value" id="s-rc">0</span></div>
      <div class="stat-row"><span class="label">Lock failures</span><span class="value" id="s-lf">0 / 5</span></div>
      <div class="stat-row"><span class="label">Next retry in</span><span class="value" id="s-retry">—</span></div>
    </div>
  </div>

  <div class="card">
    <h2>Chat Log</h2>
    <div class="chat-log" id="chat-log"><span style="color:var(--muted);font-size:.8rem">Waiting for messages…</span></div>
  </div>

  <div class="card wide">
    <h2>In-game Commands</h2>
    <div class="cmds">
      <code>!ping</code><code>!status</code><code>!pos</code><code>!health</code>
      <code>!players</code><code>!servers</code><code>!help</code>
      <code>!reconnect</code><span style="color:var(--muted);font-size:.76rem"> owner</span>
      <code>!stop</code><span style="color:var(--muted);font-size:.76rem"> owner</span>
    </div>
    <p style="font-size:.74rem;color:var(--muted);margin-top:8px">Set <code style="background:rgba(255,255,255,.06);padding:1px 5px;border-radius:4px">OWNER_USERNAME</code> env var to your IGN to unlock admin commands.</p>
  </div>
</div>

<footer>Minecraft-Xiter — optimized AFK bot · FalixNodes / Render.com</footer>

<script>
const fmt = s => (Math.floor(s/3600)?Math.floor(s/3600)+'h ':'')+(Math.floor((s%3600)/60)?Math.floor((s%3600)/60)+'m ':'')+(s%60)+'s';
const fmtT = ts => new Date(ts).toTimeString().slice(0,8);
const esc = s => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
let lastLen = 0;

async function poll() {
  try {
    const d = await fetch('/api/status').then(r => r.json());
    document.getElementById('badge').className = 'badge ' + d.status;
    document.getElementById('status-text').textContent = d.status.replace(/_/g,' ');

    const lb = document.getElementById('lock-badge');
    lb.className = 'lock-badge ' + (d.lockedIn?'locked':'unlocked');
    lb.textContent = d.lockedIn ? '🔒 locked: '+d.server : '🔓 scanning all servers';

    const eb = document.getElementById('err-box'), ob = document.getElementById('off-box');
    if (d.status==='server_offline') { ob.style.display='block'; eb.style.display='none'; }
    else if (d.lastError && d.status!=='online') { eb.textContent=d.lastError; eb.style.display='block'; ob.style.display='none'; }
    else { eb.style.display='none'; ob.style.display='none'; }

    const sl = document.getElementById('srv-list');
    if (d.servers) sl.innerHTML = d.servers.map(s =>
      '<div class="srv-item'+(s===d.server&&d.status==='online'?' active':'')+'"><span class="sdot"></span>'+esc(s)+(s===d.server&&d.status==='online'?'<span style="color:var(--green);font-size:.71rem;margin-left:auto">● active</span>':'')+'</div>'
    ).join('');

    document.getElementById('uptime').textContent = fmt(d.uptime_sec);
    document.getElementById('s-user').textContent  = d.username;
    document.getElementById('s-auth').textContent  = d.auth;
    document.getElementById('s-ver').textContent   = d.version;
    document.getElementById('s-rc').textContent    = d.reconnects;
    document.getElementById('s-lf').textContent    = d.lockFailCount + ' / 5';
    document.getElementById('s-retry').textContent = d.status==='waiting_to_reconnect'?fmt(Math.round(d.nextRetry/1000)):'—';

    const ab = document.getElementById('auth-box');
    if (d.deviceAuth) {
      ab.style.display='block';
      document.getElementById('device-code').textContent=d.deviceAuth.userCode;
      const u=document.getElementById('device-uri'); u.href=d.deviceAuth.verificationUri; u.textContent='Open '+d.deviceAuth.verificationUri+' ↗';
      document.getElementById('device-exp').textContent='Expires in '+fmt(Math.max(0,Math.floor((d.deviceAuth.expiresAt-Date.now())/1000)));
    } else ab.style.display='none';

    if (d.chatLog && d.chatLog.length!==lastLen) {
      lastLen=d.chatLog.length;
      const el=document.getElementById('chat-log');
      el.innerHTML=d.chatLog.map(e=>'<div class="chat-entry '+e.source+'"><span class="time">'+fmtT(e.ts)+'</span><span class="user">'+esc(e.username)+'</span>: '+esc(e.message)+'</div>').join('');
      el.scrollTop=el.scrollHeight;
    }
    document.getElementById('updated').textContent='Updated '+fmtT(Date.now());
  } catch(_){}
}
poll(); setInterval(poll,3000);
</script>
</body>
</html>`;
}
