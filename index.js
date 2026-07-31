require('dotenv').config();
const mineflayer = require('mineflayer');
const express    = require('express');
const path       = require('path');

// ─── Config ───────────────────────────────────────────────────────────────────
const CONFIG = {
  host:     process.env.BOT_HOST     || 'villainsmpknowledge.falixsrv.me',
  port:     parseInt(process.env.BOT_PORT || '25565'),
  username: process.env.BOT_USERNAME || 'XiterBot',
  version:  process.env.MC_VERSION   || '1.20.1',
  auth:     process.env.BOT_AUTH     || 'offline', // 'offline' | 'microsoft'
};

const RECONNECT_DELAY_MS = parseInt(process.env.RECONNECT_DELAY || '10000');
const AFK_INTERVAL_MS    = parseInt(process.env.AFK_INTERVAL    || '30000');
const OWNER_USERNAME     = process.env.OWNER_USERNAME || '';   // In-game name for admin commands
const CHAT_PREFIX        = process.env.CHAT_PREFIX    || '!';  // Command prefix

// ─── State ────────────────────────────────────────────────────────────────────
let botStatus     = 'starting';
let botStartTime  = Date.now();
let reconnectCount = 0;
let currentServer = CONFIG.host + ':' + CONFIG.port;
let chatLog       = [];            // last 50 messages
let deviceAuthPending = null;      // { userCode, verificationUri, expiresAt }
let afkTimer      = null;
let reconnectTimer = null;

function addChatLog(source, username, message) {
  const entry = { ts: Date.now(), source, username, message };
  chatLog.push(entry);
  if (chatLog.length > 50) chatLog.shift();
  return entry;
}

// Intercept console to catch prismarine-auth device code output
const _origLog = console.log.bind(console);
console.log = (...args) => {
  const msg = args.join(' ');
  // Detect Microsoft device auth prompt
  const codeMatch  = msg.match(/code[:\s]+([A-Z0-9]{8,})/i);
  const uriMatch   = msg.match(/https:\/\/\S+/);
  if (codeMatch && uriMatch) {
    deviceAuthPending = {
      userCode:        codeMatch[1],
      verificationUri: uriMatch[0].replace(/[,.]$/, ''),
      expiresAt:       Date.now() + 15 * 60 * 1000,
    };
    _origLog('[Auth] Device code ready:', deviceAuthPending.userCode);
    return;
  }
  _origLog(...args);
};

// ─── Web dashboard ────────────────────────────────────────────────────────────
const app  = express();
const PORT = process.env.PORT || 3000;
app.use(express.json());

// Serve the dashboard HTML
app.get('/', (_req, res) => res.send(dashboardHTML()));

// JSON API for status polling
app.get('/api/status', (_req, res) => {
  res.json({
    status:        botStatus,
    server:        currentServer,
    username:      CONFIG.username,
    auth:          CONFIG.auth,
    uptime_sec:    Math.floor((Date.now() - botStartTime) / 1000),
    reconnects:    reconnectCount,
    deviceAuth:    deviceAuthPending && Date.now() < deviceAuthPending.expiresAt
                     ? deviceAuthPending : null,
    chatLog:       chatLog.slice(-20),
  });
});

// Simple health check
app.get('/health', (_req, res) => res.send('OK'));

app.listen(PORT, () => _origLog('[Web] Dashboard at http://localhost:' + PORT));

// ─── Anti-AFK actions ─────────────────────────────────────────────────────────
const afkActions = [
  bot => { bot.setControlState('jump',    true);  setTimeout(() => bot.setControlState('jump',    false), 500); },
  bot => { bot.setControlState('sneak',   true);  setTimeout(() => bot.setControlState('sneak',   false), 800); },
  bot => { bot.setControlState('forward', true);  setTimeout(() => bot.setControlState('forward', false), 600); },
  bot => { bot.setControlState('back',    true);  setTimeout(() => bot.setControlState('back',    false), 600); },
  bot => { bot.setControlState('left',    true);  setTimeout(() => bot.setControlState('left',    false), 600); },
  bot => { bot.setControlState('right',   true);  setTimeout(() => bot.setControlState('right',   false), 600); },
  bot => { const yaw = (Math.random() * 2 - 1) * Math.PI; bot.look(yaw, bot.entity.pitch || 0, false); },
  bot => { bot.swingArm('right'); },
  bot => { bot.swingArm('left');  },
  // Spin 360°
  bot => {
    let steps = 0;
    const spin = setInterval(() => {
      try { bot.look(bot.entity.yaw + Math.PI / 8, 0, false); }
      catch (_) { clearInterval(spin); }
      if (++steps >= 16) clearInterval(spin);
    }, 60);
  },
];

const afkChatMessages = ['.', 'AFK', 'I am here', 'Still online', '👋'];
let chatIndex = 0;

function doAntiAfk(bot) {
  const action = afkActions[Math.floor(Math.random() * afkActions.length)];
  try { action(bot); } catch (_) {}
  // Occasionally send a harmless chat message
  if (Math.random() < 0.08) {
    const msg = afkChatMessages[chatIndex % afkChatMessages.length];
    chatIndex++;
    try { bot.chat(msg); } catch (_) {}
  }
}

// ─── Command handler ──────────────────────────────────────────────────────────
function handleCommand(bot, sender, message) {
  const pfx = CHAT_PREFIX;
  const isOwner = !OWNER_USERNAME || sender === OWNER_USERNAME;

  if (message === pfx + 'ping') {
    bot.chat('Pong! I\'m alive. 🏓');
  } else if (message === pfx + 'status') {
    const uptime = Math.floor((Date.now() - botStartTime) / 1000);
    const h = Math.floor(uptime / 3600), m = Math.floor((uptime % 3600) / 60), s = uptime % 60;
    bot.chat(`Online ${h}h ${m}m ${s}s | Reconnects: ${reconnectCount} | Server: ${currentServer}`);
  } else if (message === pfx + 'pos') {
    const p = bot.entity.position;
    bot.chat(`Position: ${Math.floor(p.x)}, ${Math.floor(p.y)}, ${Math.floor(p.z)}`);
  } else if (message === pfx + 'health') {
    bot.chat(`Health: ${bot.health?.toFixed(1) ?? '?'}/20 | Food: ${bot.food ?? '?'}/20`);
  } else if (message === pfx + 'players') {
    const names = Object.keys(bot.players).filter(n => n !== bot.username);
    if (names.length === 0) bot.chat('No other players online.');
    else bot.chat('Online: ' + names.slice(0, 10).join(', '));
  } else if (message === pfx + 'stop' && isOwner) {
    bot.chat('Stopping. Goodbye!');
    setTimeout(() => process.exit(0), 1000);
  } else if (message === pfx + 'reconnect' && isOwner) {
    bot.chat('Reconnecting...');
    setTimeout(() => { try { bot.quit(); } catch (_) {} }, 500);
  } else if (message === pfx + 'help') {
    bot.chat(`Commands: ${pfx}ping ${pfx}status ${pfx}pos ${pfx}health ${pfx}players${isOwner ? ` ${pfx}stop ${pfx}reconnect` : ''}`);
  }
}

// ─── Bot factory ──────────────────────────────────────────────────────────────
function createBot() {
  _origLog('[Bot] Connecting to ' + CONFIG.host + ':' + CONFIG.port + ' as ' + CONFIG.username + ' (' + CONFIG.auth + ' auth)...');
  botStatus = 'connecting';
  deviceAuthPending = null;

  const botOptions = {
    host:     CONFIG.host,
    port:     CONFIG.port,
    username: CONFIG.username,
    version:  CONFIG.version,
    auth:     CONFIG.auth,
  };

  let bot;
  try {
    bot = mineflayer.createBot(botOptions);
  } catch (err) {
    _origLog('[Bot] Failed to create bot:', err.message);
    scheduleReconnect();
    return;
  }

  bot.once('spawn', () => {
    _origLog('[Bot] Spawned! Anti-AFK active. Server: ' + currentServer);
    botStatus = 'online';
    deviceAuthPending = null;
    afkTimer = setInterval(() => doAntiAfk(bot), AFK_INTERVAL_MS);
    addChatLog('system', 'Bot', 'Connected to ' + currentServer);
  });

  bot.on('chat', (username, message) => {
    if (username === bot.username) return;
    _origLog('[Chat] <' + username + '> ' + message);
    addChatLog('chat', username, message);
    if (message.startsWith(CHAT_PREFIX)) {
      try { handleCommand(bot, username, message); } catch (_) {}
    }
  });

  bot.on('whisper', (username, message) => {
    _origLog('[Whisper] ' + username + ' -> ' + message);
    addChatLog('whisper', username, message);
    if (message.startsWith(CHAT_PREFIX)) {
      try { handleCommand(bot, username, message); } catch (_) {}
    }
  });

  bot.on('message', (jsonMsg) => {
    const txt = jsonMsg.toString();
    if (txt && !chatLog.find(e => e.message === txt && Date.now() - e.ts < 1000)) {
      addChatLog('server', 'Server', txt);
    }
  });

  bot.on('kicked', reason => {
    _origLog('[Bot] Kicked:', typeof reason === 'string' ? reason : JSON.stringify(reason));
    botStatus = 'kicked';
    addChatLog('system', 'Bot', 'Kicked from server');
    cleanup(); scheduleReconnect();
  });

  bot.on('error', err => {
    _origLog('[Bot] Error:', err.message);
    botStatus = 'error';
    cleanup(); scheduleReconnect();
  });

  bot.on('end', reason => {
    _origLog('[Bot] Ended:', reason);
    botStatus = 'disconnected';
    addChatLog('system', 'Bot', 'Disconnected: ' + reason);
    cleanup(); scheduleReconnect();
  });

  function cleanup() {
    if (afkTimer) { clearInterval(afkTimer); afkTimer = null; }
    try { bot.removeAllListeners(); } catch (_) {}
  }
}

function scheduleReconnect() {
  if (reconnectTimer) return; // already scheduled
  reconnectCount++;
  _origLog('[Bot] Reconnecting in ' + (RECONNECT_DELAY_MS / 1000) + 's... (attempt #' + reconnectCount + ')');
  botStatus = 'waiting_to_reconnect';
  reconnectTimer = setTimeout(() => { reconnectTimer = null; createBot(); }, RECONNECT_DELAY_MS);
}

createBot();

// ─── Dashboard HTML ───────────────────────────────────────────────────────────
function dashboardHTML() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Minecraft-Xiter Bot Dashboard</title>
  <style>
    :root {
      --bg: #0f1117; --card: #1a1d27; --border: #2a2d3e;
      --green: #4ade80; --yellow: #facc15; --red: #f87171; --blue: #60a5fa;
      --text: #e2e8f0; --muted: #64748b;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { background: var(--bg); color: var(--text); font-family: 'Segoe UI', system-ui, sans-serif; min-height: 100vh; }
    header {
      background: var(--card); border-bottom: 1px solid var(--border);
      padding: 16px 24px; display: flex; align-items: center; gap: 12px;
    }
    header img { width: 36px; height: 36px; image-rendering: pixelated; }
    header h1 { font-size: 1.3rem; font-weight: 700; }
    header span { font-size: 0.8rem; color: var(--muted); margin-left: auto; }
    .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; padding: 20px 24px; max-width: 1100px; margin: 0 auto; }
    @media (max-width: 700px) { .grid { grid-template-columns: 1fr; } }
    .card { background: var(--card); border: 1px solid var(--border); border-radius: 12px; padding: 18px 20px; }
    .card h2 { font-size: 0.75rem; text-transform: uppercase; letter-spacing: .08em; color: var(--muted); margin-bottom: 12px; }
    .status-badge {
      display: inline-flex; align-items: center; gap: 6px;
      padding: 4px 12px; border-radius: 999px; font-size: 0.85rem; font-weight: 600;
    }
    .dot { width: 8px; height: 8px; border-radius: 50%; }
    .online   { background: rgba(74,222,128,.15); color: var(--green); }
    .online .dot { background: var(--green); box-shadow: 0 0 6px var(--green); animation: pulse 1.5s infinite; }
    .error, .kicked { background: rgba(248,113,113,.15); color: var(--red); }
    .error .dot, .kicked .dot { background: var(--red); }
    .connecting, .waiting_to_reconnect, .starting {
      background: rgba(250,204,21,.12); color: var(--yellow);
    }
    .connecting .dot, .waiting_to_reconnect .dot, .starting .dot { background: var(--yellow); animation: pulse 1s infinite; }
    .disconnected { background: rgba(100,116,139,.15); color: var(--muted); }
    .disconnected .dot { background: var(--muted); }
    @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:.4} }
    .stat-row { display: flex; justify-content: space-between; padding: 6px 0; border-bottom: 1px solid var(--border); font-size: 0.88rem; }
    .stat-row:last-child { border-bottom: none; }
    .stat-row .label { color: var(--muted); }
    .stat-row .value { font-weight: 500; }
    .auth-box {
      background: rgba(250,204,21,.08); border: 1px solid rgba(250,204,21,.3);
      border-radius: 10px; padding: 14px; margin-top: 8px;
    }
    .auth-box h3 { color: var(--yellow); font-size: 0.9rem; margin-bottom: 8px; }
    .code { font-family: monospace; font-size: 1.5rem; letter-spacing: .2em; color: var(--yellow); font-weight: 700; }
    .auth-box a { color: var(--blue); font-size: 0.85rem; }
    .auth-box p { font-size: 0.8rem; color: var(--muted); margin-top: 6px; }
    .chat-log { height: 260px; overflow-y: auto; display: flex; flex-direction: column; gap: 4px; }
    .chat-entry { font-size: 0.82rem; line-height: 1.4; padding: 2px 0; }
    .chat-entry .time { color: var(--muted); margin-right: 6px; font-size: 0.75rem; }
    .chat-entry .user { font-weight: 600; }
    .chat-entry.chat  .user { color: var(--green); }
    .chat-entry.whisper .user { color: var(--blue); }
    .chat-entry.system .user { color: var(--muted); font-style: italic; }
    .chat-entry.server .user { color: var(--yellow); }
    .chat-log::-webkit-scrollbar { width: 4px; }
    .chat-log::-webkit-scrollbar-track { background: var(--border); border-radius: 2px; }
    .chat-log::-webkit-scrollbar-thumb { background: var(--muted); border-radius: 2px; }
    .wide { grid-column: 1 / -1; }
    .uptime { font-size: 1.6rem; font-weight: 700; color: var(--green); }
    .commands code {
      display: inline-block; background: rgba(96,165,250,.1); color: var(--blue);
      border: 1px solid rgba(96,165,250,.2); border-radius: 6px;
      padding: 2px 8px; font-size: 0.8rem; margin: 2px;
    }
    footer { text-align: center; color: var(--muted); font-size: 0.75rem; padding: 24px; }
  </style>
</head>
<body>
  <header>
    <svg width="36" height="36" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
      <rect width="16" height="16" rx="3" fill="#1a1d27"/>
      <rect x="5" y="2" width="6" height="6" rx="1" fill="#c6a878"/>
      <rect x="6" y="3" width="1" height="1" fill="#3a2a1a"/>
      <rect x="9" y="3" width="1" height="1" fill="#3a2a1a"/>
      <rect x="6" y="5" width="4" height="1" fill="#3a2a1a"/>
      <rect x="4" y="8" width="8" height="6" rx="1" fill="#4ade80"/>
      <rect x="2" y="9" width="3" height="4" rx="1" fill="#4ade80"/>
      <rect x="11" y="9" width="3" height="4" rx="1" fill="#4ade80"/>
      <rect x="5" y="11" width="3" height="3" rx="0.5" fill="#1a1d27"/>
      <rect x="8" y="11" width="3" height="3" rx="0.5" fill="#1a1d27"/>
    </svg>
    <h1>Minecraft-Xiter Dashboard</h1>
    <span id="updated">Updating…</span>
  </header>

  <div class="grid">
    <!-- Status -->
    <div class="card">
      <h2>Bot Status</h2>
      <div id="status-badge" class="status-badge starting"><span class="dot"></span> <span id="status-text">Starting…</span></div>
      <div id="auth-box" style="display:none" class="auth-box">
        <h3>🔑 Microsoft Login Required</h3>
        <p>Open the link below and enter this code:</p>
        <div class="code" id="device-code">——</div>
        <a id="device-uri" href="#" target="_blank" rel="noopener">Open microsoft.com/devicelogin ↗</a>
        <p id="device-expires"></p>
      </div>
    </div>

    <!-- Stats -->
    <div class="card">
      <h2>Stats</h2>
      <div id="uptime" class="uptime">—</div>
      <div style="margin-top:10px">
        <div class="stat-row"><span class="label">Server</span><span class="value" id="server">—</span></div>
        <div class="stat-row"><span class="label">Username</span><span class="value" id="username">—</span></div>
        <div class="stat-row"><span class="label">Auth mode</span><span class="value" id="auth-mode">—</span></div>
        <div class="stat-row"><span class="label">Reconnects</span><span class="value" id="reconnects">0</span></div>
      </div>
    </div>

    <!-- Chat log -->
    <div class="card wide">
      <h2>Chat Log (last 20 messages)</h2>
      <div class="chat-log" id="chat-log"><span style="color:var(--muted);font-size:.82rem">Waiting for messages…</span></div>
    </div>

    <!-- Commands -->
    <div class="card wide">
      <h2>In-game Commands (type in Minecraft chat)</h2>
      <div class="commands" id="commands-list">
        <code>!ping</code>
        <code>!status</code>
        <code>!pos</code>
        <code>!health</code>
        <code>!players</code>
        <code>!help</code>
        <code>!reconnect</code> (owner only)
        <code>!stop</code> (owner only)
      </div>
      <p style="font-size:.78rem;color:var(--muted);margin-top:10px">
        Set <code>CHAT_PREFIX</code> env var to change the prefix. Set <code>OWNER_USERNAME</code> to restrict admin commands.
      </p>
    </div>
  </div>

  <footer>Minecraft-Xiter &nbsp;|&nbsp; AFK bot for FalixNodes / Render.com</footer>

  <script>
    function fmt(sec) {
      const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
      return (h ? h + 'h ' : '') + (m ? m + 'm ' : '') + s + 's';
    }
    function fmtTime(ts) {
      const d = new Date(ts);
      return d.getHours().toString().padStart(2,'0') + ':' + d.getMinutes().toString().padStart(2,'0') + ':' + d.getSeconds().toString().padStart(2,'0');
    }

    let lastChatLen = 0;

    async function poll() {
      try {
        const r = await fetch('/api/status');
        const d = await r.json();

        // Status badge
        const badge = document.getElementById('status-badge');
        badge.className = 'status-badge ' + d.status;
        document.getElementById('status-text').textContent = d.status.replace(/_/g, ' ');

        // Stats
        document.getElementById('uptime').textContent = fmt(d.uptime_sec);
        document.getElementById('server').textContent = d.server;
        document.getElementById('username').textContent = d.username;
        document.getElementById('auth-mode').textContent = d.auth;
        document.getElementById('reconnects').textContent = d.reconnects;

        // Device auth
        const authBox = document.getElementById('auth-box');
        if (d.deviceAuth) {
          authBox.style.display = 'block';
          document.getElementById('device-code').textContent = d.deviceAuth.userCode;
          const uri = document.getElementById('device-uri');
          uri.href = d.deviceAuth.verificationUri;
          uri.textContent = 'Open ' + d.deviceAuth.verificationUri + ' ↗';
          const remaining = Math.max(0, Math.floor((d.deviceAuth.expiresAt - Date.now()) / 1000));
          document.getElementById('device-expires').textContent = 'Code expires in ' + fmt(remaining);
        } else {
          authBox.style.display = 'none';
        }

        // Chat log
        if (d.chatLog && d.chatLog.length !== lastChatLen) {
          lastChatLen = d.chatLog.length;
          const log = document.getElementById('chat-log');
          log.innerHTML = d.chatLog.map(e =>
            '<div class="chat-entry ' + e.source + '">' +
            '<span class="time">' + fmtTime(e.ts) + '</span>' +
            '<span class="user">' + escHtml(e.username) + '</span>: ' +
            escHtml(e.message) +
            '</div>'
          ).join('');
          log.scrollTop = log.scrollHeight;
        }

        document.getElementById('updated').textContent = 'Updated ' + fmtTime(Date.now());
      } catch(_) {}
    }

    function escHtml(s) {
      return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    }

    poll();
    setInterval(poll, 3000);
  </script>
</body>
</html>`;
}
