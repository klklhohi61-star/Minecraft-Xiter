require('dotenv').config();
const mineflayer = require('mineflayer');
const express    = require('express');
const net        = require('net');

// ─── Server list ──────────────────────────────────────────────────────────────
// Priority order — bot tries each in turn, stops as soon as one works.
// Override with BOT_SERVERS env var: "host1:port1,host2:port2"
function parseServers() {
  if (process.env.BOT_SERVERS) {
    return process.env.BOT_SERVERS.split(',').map(s => {
      const [host, port] = s.trim().split(':');
      return { host: host.trim(), port: parseInt(port) || 25565 };
    }).filter(s => s.host);
  }
  // Default list — add / remove lines here
  return [
    { host: process.env.BOT_HOST || 'villainsmpknowledge.falixsrv.me', port: parseInt(process.env.BOT_PORT || '20013') },
    { host: '162.55.28.90', port: 20008 },
  ];
}
const SERVERS = parseServers();

// ─── Bot config ───────────────────────────────────────────────────────────────
const USERNAME     = process.env.BOT_USERNAME || 'XiterBot';
const VERSION      = process.env.MC_VERSION   || '1.20.1';
const AUTH         = process.env.BOT_AUTH     || 'offline';
const OWNER        = process.env.OWNER_USERNAME || '';
const PREFIX       = process.env.CHAT_PREFIX    || '!';

const RECONNECT_BASE_MS = parseInt(process.env.RECONNECT_DELAY || '15000');
const AFK_INTERVAL_MS   = parseInt(process.env.AFK_INTERVAL    || '30000');
const TCP_TIMEOUT_MS    = 8000;

// ─── State ────────────────────────────────────────────────────────────────────
let botStatus      = 'starting';
let botStartTime   = Date.now();
let reconnectCount = 0;
let reconnectDelay = RECONNECT_BASE_MS;
let lastError      = '';
let activeServer   = SERVERS[0];        // which server we're currently on/trying
let lockedIn       = false;             // true once bot has spawned — stay on this server
let chatLog        = [];
let deviceAuth     = null;
let afkTimer       = null;
let reconnectTimer = null;

function addLog(source, username, message) {
  chatLog.push({ ts: Date.now(), source, username, message });
  if (chatLog.length > 50) chatLog.shift();
}

// Capture prismarine-auth device-code output
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

// ─── TCP ping ─────────────────────────────────────────────────────────────────
function tcpPing(host, port, ms) {
  return new Promise(resolve => {
    const sock = new net.Socket();
    let done = false;
    const finish = (ok, reason) => { if (done) return; done = true; sock.destroy(); resolve({ ok, reason }); };
    sock.setTimeout(ms);
    sock.connect(port, host, () => finish(true, 'open'));
    sock.on('error',   e => finish(false, e.message));
    sock.on('timeout', () => finish(false, 'Timed out — server may be offline'));
  });
}

// ─── Find a reachable server ──────────────────────────────────────────────────
// If locked in (already spawned once), only check the active server.
// Otherwise walk the full list and return the first one that responds.
async function findServer() {
  const list = lockedIn ? [activeServer] : SERVERS;
  for (const srv of list) {
    _log(`[Net] Pinging ${srv.host}:${srv.port}…`);
    const { ok, reason } = await tcpPing(srv.host, srv.port, TCP_TIMEOUT_MS);
    if (ok) return { server: srv, error: null };
    _log(`[Net] ${srv.host}:${srv.port} — ${reason}`);
  }
  return { server: null, error: 'All servers unreachable' };
}

// ─── Web dashboard ────────────────────────────────────────────────────────────
const app     = express();
const WEB_PORT = process.env.PORT || 3000;
app.use(express.json());

app.get('/',           (_req, res) => res.send(dashboardHTML()));
app.get('/health',     (_req, res) => res.send('OK'));
app.get('/api/status', (_req, res) => res.json({
  status:      botStatus,
  server:      activeServer.host + ':' + activeServer.port,
  lockedIn,
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
  b => { b.setControlState('jump',    true); setTimeout(() => b.setControlState('jump',    false), 500); },
  b => { b.setControlState('sneak',   true); setTimeout(() => b.setControlState('sneak',   false), 800); },
  b => { b.setControlState('forward', true); setTimeout(() => b.setControlState('forward', false), 600); },
  b => { b.setControlState('back',    true); setTimeout(() => b.setControlState('back',    false), 600); },
  b => { b.setControlState('left',    true); setTimeout(() => b.setControlState('left',    false), 600); },
  b => { b.setControlState('right',   true); setTimeout(() => b.setControlState('right',   false), 600); },
  b => { b.look((Math.random() * 2 - 1) * Math.PI, 0, false); },
  b => { b.swingArm('right'); },
  b => { b.swingArm('left');  },
  b => { let n = 0; const id = setInterval(() => { try { b.look(b.entity.yaw + Math.PI / 8, 0, false); } catch(_) { clearInterval(id); } if (++n >= 16) clearInterval(id); }, 60); },
];
const afkChat = ['.', 'AFK', 'I am here', 'Still online'];
let chatIdx = 0;
function doAFK(bot) {
  try { afkActions[Math.floor(Math.random() * afkActions.length)](bot); } catch(_) {}
  if (Math.random() < 0.08) try { bot.chat(afkChat[chatIdx++ % afkChat.length]); } catch(_) {}
}

// ─── Commands ─────────────────────────────────────────────────────────────────
function handleCmd(bot, sender, msg) {
  const p = PREFIX, owner = !OWNER || sender === OWNER;
  if      (msg === p+'ping')   bot.chat('Pong! 🏓');
  else if (msg === p+'status') { const u=Math.floor((Date.now()-botStartTime)/1000); bot.chat(`Up ${Math.floor(u/3600)}h${Math.floor((u%3600)/60)}m${u%60}s | Reconnects: ${reconnectCount} | Server: ${activeServer.host}:${activeServer.port}`); }
  else if (msg === p+'pos')    { const p2=bot.entity.position; bot.chat(`Pos: ${Math.floor(p2.x)}, ${Math.floor(p2.y)}, ${Math.floor(p2.z)}`); }
  else if (msg === p+'health') bot.chat(`HP: ${bot.health?.toFixed(1)??'?'}/20  Food: ${bot.food??'?'}/20`);
  else if (msg === p+'players') { const n=Object.keys(bot.players).filter(x=>x!==bot.username); bot.chat(n.length?'Online: '+n.slice(0,10).join(', '):'No other players.'); }
  else if (msg === p+'servers') bot.chat('Servers: '+SERVERS.map(s=>s.host+':'+s.port).join(' | '));
  else if (msg === p+'help')   bot.chat(`Commands: ${p}ping ${p}status ${p}pos ${p}health ${p}players ${p}servers${owner?` ${p}stop ${p}reconnect`:''}`);
  else if (msg === p+'reconnect' && owner) { bot.chat('Reconnecting…'); lockedIn = false; setTimeout(() => { try { bot.quit(); } catch(_){} }, 500); }
  else if (msg === p+'stop'      && owner) { bot.chat('Stopping. Goodbye!'); setTimeout(() => process.exit(0), 1000); }
}

// ─── Bot factory ──────────────────────────────────────────────────────────────
async function connectBot() {
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }

  // 1. Find a reachable server
  botStatus = 'checking_servers';
  lastError = '';
  const { server, error } = await findServer();

  if (!server) {
    lastError = error || 'All servers unreachable';
    _log('[Bot]', lastError);
    botStatus = 'server_offline';
    addLog('system', 'Bot', lastError);
    scheduleReconnect();
    return;
  }

  activeServer = server;
  _log(`[Bot] Connecting to ${server.host}:${server.port} as ${USERNAME} (${AUTH})…`);
  botStatus  = 'connecting';
  deviceAuth = null;

  // 2. Create mineflayer bot
  let bot;
  try {
    bot = mineflayer.createBot({ host: server.host, port: server.port, username: USERNAME, version: VERSION, auth: AUTH });
  } catch (err) {
    lastError = err.message;
    _log('[Bot] createBot error:', err.message);
    scheduleReconnect();
    return;
  }

  // 3. Spawned — lock in, start AFK
  bot.once('spawn', () => {
    _log(`[Bot] Spawned on ${server.host}:${server.port}! Locked in. Anti-AFK active.`);
    botStatus      = 'online';
    lastError      = '';
    lockedIn       = true;          // ← stay on this server from now on
    reconnectDelay = RECONNECT_BASE_MS;  // reset backoff
    deviceAuth     = null;
    afkTimer = setInterval(() => doAFK(bot), AFK_INTERVAL_MS);
    addLog('system', 'Bot', `Connected to ${server.host}:${server.port}`);
  });

  // 4. Chat / whisper
  const onChat = (u, m) => {
    if (u === bot.username) return;
    _log(`[Chat] <${u}> ${m}`);
    addLog('chat', u, m);
    if (m.startsWith(PREFIX)) try { handleCmd(bot, u, m); } catch(_) {}
  };
  const onWhisper = (u, m) => {
    _log(`[Whisper] ${u}: ${m}`);
    addLog('whisper', u, m);
    if (m.startsWith(PREFIX)) try { handleCmd(bot, u, m); } catch(_) {}
  };
  bot.on('chat',    onChat);
  bot.on('whisper', onWhisper);

  // 5. Disconnect events
  bot.on('kicked', reason => {
    const r = typeof reason === 'string' ? reason : JSON.stringify(reason);
    lastError = 'Kicked: ' + r;
    _log('[Bot] Kicked:', r);
    botStatus = 'kicked';
    addLog('system', 'Bot', 'Kicked: ' + r);
    cleanup(); scheduleReconnect();
  });
  bot.on('error', err => {
    lastError = err.message;
    _log('[Bot] Error:', err.message);
    botStatus = 'error';
    cleanup(); scheduleReconnect();
  });
  bot.on('end', reason => {
    _log('[Bot] Ended:', reason);
    lastError = reason || '';
    botStatus = 'disconnected';
    addLog('system', 'Bot', 'Disconnected: ' + reason);
    cleanup(); scheduleReconnect();
  });

  function cleanup() {
    if (afkTimer) { clearInterval(afkTimer); afkTimer = null; }
    try { bot.removeAllListeners(); } catch(_) {}
  }
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectCount++;
  _log(`[Bot] Retry #${reconnectCount} in ${reconnectDelay / 1000}s (locked=${lockedIn})…`);
  botStatus = 'waiting_to_reconnect';
  reconnectTimer = setTimeout(() => { reconnectTimer = null; connectBot(); }, reconnectDelay);
  // Exponential backoff: 15 → 30 → 60 → 120s cap
  reconnectDelay = Math.min(reconnectDelay * 2, 120_000);
}

connectBot();

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
header span{font-size:.76rem;color:var(--muted);margin-left:auto}
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
.error-box{background:rgba(248,113,113,.08);border:1px solid rgba(248,113,113,.25);border-radius:8px;padding:10px 12px;margin-top:10px;font-size:.81rem;color:var(--red);word-break:break-all}
.offline-box{background:rgba(251,146,60,.08);border:1px solid rgba(251,146,60,.25);border-radius:8px;padding:10px 12px;margin-top:10px;font-size:.81rem;color:var(--orange)}
.offline-box ul{margin-left:16px;margin-top:4px;line-height:1.8}
.lock-badge{display:inline-flex;align-items:center;gap:5px;font-size:.75rem;padding:2px 8px;border-radius:999px;margin-left:8px}
.locked{background:rgba(167,139,250,.15);color:var(--purple)}
.unlocked{background:rgba(100,116,139,.12);color:var(--muted)}
.stat-row{display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid var(--border);font-size:.86rem}
.stat-row:last-child{border-bottom:none}.stat-row .label{color:var(--muted)}
.server-list{margin-top:8px;display:flex;flex-direction:column;gap:4px}
.server-item{font-size:.8rem;padding:5px 10px;border-radius:6px;border:1px solid var(--border);display:flex;align-items:center;gap:8px}
.server-item.active{border-color:var(--green);background:rgba(74,222,128,.06)}
.server-item.active .sdot{background:var(--green);box-shadow:0 0 4px var(--green)}
.sdot{width:6px;height:6px;border-radius:50%;background:var(--muted);flex-shrink:0}
.auth-box{background:rgba(250,204,21,.08);border:1px solid rgba(250,204,21,.3);border-radius:10px;padding:14px;margin-top:8px}
.auth-box h3{color:var(--yellow);font-size:.9rem;margin-bottom:8px}
.code{font-family:monospace;font-size:1.4rem;letter-spacing:.2em;color:var(--yellow);font-weight:700}
.auth-box a{color:var(--blue);font-size:.84rem}
.chat-log{height:230px;overflow-y:auto;display:flex;flex-direction:column;gap:3px}
.chat-entry{font-size:.8rem;line-height:1.4;padding:2px 0}
.chat-entry .time{color:var(--muted);margin-right:5px;font-size:.72rem}
.chat-entry .user{font-weight:600}
.chat-entry.chat .user{color:var(--green)}.chat-entry.whisper .user{color:var(--blue)}.chat-entry.system .user{color:var(--muted);font-style:italic}
.chat-log::-webkit-scrollbar{width:4px}.chat-log::-webkit-scrollbar-thumb{background:var(--muted);border-radius:2px}
.wide{grid-column:1/-1}
.uptime{font-size:1.45rem;font-weight:700;color:var(--green)}
.commands code{display:inline-block;background:rgba(96,165,250,.1);color:var(--blue);border:1px solid rgba(96,165,250,.2);border-radius:6px;padding:2px 8px;font-size:.77rem;margin:2px}
footer{text-align:center;color:var(--muted);font-size:.72rem;padding:24px}
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
  <!-- Status -->
  <div class="card">
    <h2>Bot Status</h2>
    <div style="display:flex;align-items:center;flex-wrap:wrap;gap:6px">
      <div id="badge" class="badge starting"><span class="dot"></span><span id="status-text">Starting…</span></div>
      <span id="lock-badge" class="lock-badge unlocked">🔓 scanning</span>
    </div>
    <div id="error-box" style="display:none" class="error-box"></div>
    <div id="offline-box" style="display:none" class="offline-box">
      <strong>All servers unreachable.</strong>
      <ul>
        <li>Start your server on <a href="https://client.falixnodes.net" target="_blank" style="color:var(--orange)">FalixNodes</a></li>
        <li>Bot will keep retrying all addresses automatically</li>
      </ul>
    </div>
    <div id="auth-box" style="display:none" class="auth-box">
      <h3>🔑 Microsoft Login Required</h3>
      <p>Open the link and enter this code:</p>
      <div class="code" id="device-code">——</div>
      <a id="device-uri" href="#" target="_blank">Open microsoft.com/devicelogin ↗</a>
      <p id="device-expires" style="font-size:.78rem;color:var(--muted);margin-top:5px"></p>
    </div>
  </div>

  <!-- Server list -->
  <div class="card">
    <h2>Server Pool</h2>
    <div class="server-list" id="server-list">Loading…</div>
    <p style="font-size:.74rem;color:var(--muted);margin-top:10px">
      Once the bot spawns it locks onto that server. Use <code style="background:rgba(255,255,255,.06);padding:1px 5px;border-radius:4px">!reconnect</code> to scan again.
    </p>
  </div>

  <!-- Stats -->
  <div class="card">
    <h2>Stats</h2>
    <div id="uptime" class="uptime">—</div>
    <div style="margin-top:10px">
      <div class="stat-row"><span class="label">Username</span><span class="value" id="s-user">—</span></div>
      <div class="stat-row"><span class="label">Auth</span><span class="value" id="s-auth">—</span></div>
      <div class="stat-row"><span class="label">Version</span><span class="value" id="s-ver">—</span></div>
      <div class="stat-row"><span class="label">Reconnects</span><span class="value" id="s-rc">0</span></div>
      <div class="stat-row"><span class="label">Next retry in</span><span class="value" id="s-retry">—</span></div>
    </div>
  </div>

  <!-- Chat log -->
  <div class="card">
    <h2>Chat Log</h2>
    <div class="chat-log" id="chat-log"><span style="color:var(--muted);font-size:.8rem">Waiting for messages…</span></div>
  </div>

  <!-- Commands -->
  <div class="card wide">
    <h2>In-game Commands</h2>
    <div class="commands">
      <code>!ping</code><code>!status</code><code>!pos</code><code>!health</code>
      <code>!players</code><code>!servers</code><code>!help</code>
      <code>!reconnect</code> (owner)<code>!stop</code> (owner)
    </div>
    <p style="font-size:.75rem;color:var(--muted);margin-top:8px">
      Set <code>OWNER_USERNAME</code> to your in-game name to unlock admin commands. <code>!servers</code> lists the full fallback pool.
    </p>
  </div>
</div>

<footer>Minecraft-Xiter — multi-server AFK bot for FalixNodes / Render.com</footer>

<script>
const fmt = s => (Math.floor(s/3600)?Math.floor(s/3600)+'h ':'')+(Math.floor((s%3600)/60)?Math.floor((s%3600)/60)+'m ':'')+(s%60)+'s';
const fmtT = ts => { const d=new Date(ts); return [d.getHours(),d.getMinutes(),d.getSeconds()].map(n=>String(n).padStart(2,'0')).join(':'); };
const esc = s => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
let lastLen = 0;

async function poll() {
  try {
    const d = await fetch('/api/status').then(r => r.json());

    // Badge
    document.getElementById('badge').className = 'badge ' + d.status;
    document.getElementById('status-text').textContent = d.status.replace(/_/g,' ');

    // Lock badge
    const lb = document.getElementById('lock-badge');
    lb.className = 'lock-badge ' + (d.lockedIn ? 'locked' : 'unlocked');
    lb.textContent = d.lockedIn ? '🔒 locked: ' + d.server : '🔓 scanning servers';

    // Error / offline boxes
    const eb = document.getElementById('error-box');
    const ob = document.getElementById('offline-box');
    if (d.status === 'server_offline') { ob.style.display='block'; eb.style.display='none'; }
    else if (d.lastError && d.status !== 'online') { eb.textContent=d.lastError; eb.style.display='block'; ob.style.display='none'; }
    else { eb.style.display='none'; ob.style.display='none'; }

    // Server pool
    const sl = document.getElementById('server-list');
    if (d.servers) sl.innerHTML = d.servers.map(s =>
      '<div class="server-item'+(s===d.server&&d.status==='online'?' active':'')+'"><span class="sdot"></span>'+esc(s)+(s===d.server&&d.status==='online'?' <span style="color:var(--green);font-size:.72rem;margin-left:auto">● active</span>':'')+'</div>'
    ).join('');

    // Stats
    document.getElementById('uptime').textContent = fmt(d.uptime_sec);
    document.getElementById('s-user').textContent  = d.username;
    document.getElementById('s-auth').textContent  = d.auth;
    document.getElementById('s-ver').textContent   = d.version;
    document.getElementById('s-rc').textContent    = d.reconnects;
    document.getElementById('s-retry').textContent = d.status==='waiting_to_reconnect' ? fmt(Math.round(d.nextRetry/1000)) : '—';

    // Device auth
    const ab = document.getElementById('auth-box');
    if (d.deviceAuth) {
      ab.style.display='block';
      document.getElementById('device-code').textContent=d.deviceAuth.userCode;
      const uri=document.getElementById('device-uri'); uri.href=d.deviceAuth.verificationUri; uri.textContent='Open '+d.deviceAuth.verificationUri+' ↗';
      document.getElementById('device-expires').textContent='Expires in '+fmt(Math.max(0,Math.floor((d.deviceAuth.expiresAt-Date.now())/1000)));
    } else ab.style.display='none';

    // Chat log
    if (d.chatLog && d.chatLog.length!==lastLen) {
      lastLen=d.chatLog.length;
      const el=document.getElementById('chat-log');
      el.innerHTML=d.chatLog.map(e=>'<div class="chat-entry '+e.source+'"><span class="time">'+fmtT(e.ts)+'</span><span class="user">'+esc(e.username)+'</span>: '+esc(e.message)+'</div>').join('');
      el.scrollTop=el.scrollHeight;
    }

    document.getElementById('updated').textContent='Updated '+fmtT(Date.now());
  } catch(_){}
}
poll(); setInterval(poll, 3000);
</script>
</body>
</html>`;
}
