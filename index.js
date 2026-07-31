require('dotenv').config();
const mineflayer = require('mineflayer');
const express = require('express');

// ─── Config ──────────────────────────────────────────────────────────────────
const CONFIG = {
  host:     process.env.BOT_HOST     || 'your-server.falixsrv.me',
  port:     parseInt(process.env.BOT_PORT || '25565'),
  username: process.env.BOT_USERNAME || 'XiterBot',
  version:  process.env.MC_VERSION   || '1.20.1',
  auth:     process.env.BOT_AUTH     || 'offline',
  password: process.env.BOT_PASSWORD || '',
};

const RECONNECT_DELAY_MS = parseInt(process.env.RECONNECT_DELAY || '10000');
const AFK_INTERVAL_MS   = parseInt(process.env.AFK_INTERVAL    || '30000');

// ─── Health-check server (keeps Render.com free tier alive) ──────────────────
const app = express();
const PORT = process.env.PORT || 3000;

let botStatus = 'starting';
let botStartTime = Date.now();
let reconnectCount = 0;

app.get('/', (req, res) => {
  res.json({
    status:     botStatus,
    server:     CONFIG.host + ':' + CONFIG.port,
    username:   CONFIG.username,
    uptime_sec: Math.floor((Date.now() - botStartTime) / 1000),
    reconnects: reconnectCount,
  });
});
app.get('/health', (req, res) => res.send('OK'));
app.listen(PORT, () => console.log('[Health] Server listening on port ' + PORT));

// ─── Anti-AFK Actions ────────────────────────────────────────────────────────
const afkActions = [
  (bot) => { bot.setControlState('jump',    true);  setTimeout(() => bot.setControlState('jump',    false), 500); },
  (bot) => { bot.setControlState('sneak',   true);  setTimeout(() => bot.setControlState('sneak',   false), 800); },
  (bot) => { bot.setControlState('forward', true);  setTimeout(() => bot.setControlState('forward', false), 600); },
  (bot) => { bot.setControlState('back',    true);  setTimeout(() => bot.setControlState('back',    false), 600); },
  (bot) => { bot.setControlState('left',    true);  setTimeout(() => bot.setControlState('left',    false), 600); },
  (bot) => { bot.setControlState('right',   true);  setTimeout(() => bot.setControlState('right',   false), 600); },
  (bot) => { const yaw = (Math.random() * 2 - 1) * Math.PI; bot.look(yaw, 0, false); },
  (bot) => { bot.swingArm('right'); },
];

const chatMessages = ['.', 'AFK', 'I am here', 'Still online'];
let chatIndex = 0;

function doAntiAfk(bot) {
  const action = afkActions[Math.floor(Math.random() * afkActions.length)];
  try { action(bot); } catch (_) {}
  if (Math.random() < 0.1) {
    try { bot.chat(chatMessages[chatIndex % chatMessages.length]); chatIndex++; } catch (_) {}
  }
}

// ─── Bot Factory ─────────────────────────────────────────────────────────────
let afkTimer = null;

function createBot() {
  console.log('[Bot] Connecting to ' + CONFIG.host + ':' + CONFIG.port + ' as ' + CONFIG.username + '...');
  botStatus = 'connecting';
  const botOptions = { host: CONFIG.host, port: CONFIG.port, username: CONFIG.username, version: CONFIG.version, auth: CONFIG.auth };
  if (CONFIG.auth === 'microsoft' && CONFIG.password) botOptions.password = CONFIG.password;
  const bot = mineflayer.createBot(botOptions);

  bot.once('spawn', () => {
    console.log('[Bot] Spawned! Anti-AFK active.');
    botStatus = 'online';
    afkTimer = setInterval(() => doAntiAfk(bot), AFK_INTERVAL_MS);
  });

  bot.on('chat', (username, message) => {
    if (username === bot.username) return;
    console.log('[Chat] <' + username + '> ' + message);
    if (message === '!ping') bot.chat('Pong! I am alive and running.');
    if (message === '!status') {
      const uptime = Math.floor((Date.now() - botStartTime) / 1000);
      bot.chat('Online for ' + uptime + 's | Reconnects: ' + reconnectCount);
    }
  });

  bot.on('kicked', (reason) => { console.warn('[Bot] Kicked:', reason); botStatus = 'kicked'; cleanup(); scheduleReconnect(); });
  bot.on('error', (err) => { console.warn('[Bot] Error:', err.message); botStatus = 'error'; cleanup(); scheduleReconnect(); });
  bot.on('end',   (reason) => { console.warn('[Bot] Ended:', reason);   botStatus = 'disconnected'; cleanup(); scheduleReconnect(); });

  function cleanup() { if (afkTimer) { clearInterval(afkTimer); afkTimer = null; } try { bot.removeAllListeners(); } catch (_) {} }
}

function scheduleReconnect() {
  reconnectCount++;
  console.log('[Bot] Reconnecting in ' + (RECONNECT_DELAY_MS/1000) + 's... (attempt #' + reconnectCount + ')');
  botStatus = 'waiting_to_reconnect';
  setTimeout(createBot, RECONNECT_DELAY_MS);
}

createBot();