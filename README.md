# Minecraft-Xiter Bot

A 24/7 Minecraft AFK bot with a live web dashboard, Microsoft account support, auto-reconnect, and in-game commands. Designed to run free on [Render.com](https://render.com).

## Features

| Feature | Details |
|---|---|
| **Web Dashboard** | Live status panel, chat log, uptime stats — open it in any browser |
| **Auth modes** | `offline` (cracked servers) or `microsoft` (premium Java Edition) |
| **Microsoft Login** | Device-code flow — code shown on the dashboard, no password stored |
| **Anti-AFK** | Random jumps, sneaks, movement, arm swings, and 360° spins |
| **Auto-reconnect** | Reconnects automatically on kick, error, or disconnect |
| **In-game commands** | `!ping`, `!status`, `!pos`, `!health`, `!players`, `!help`, `!stop`, `!reconnect` |
| **Chat log** | Last 20 chat messages shown on the dashboard |
| **Configurable** | Everything via environment variables — no code changes needed |

---

## Quick Deploy to Render.com

1. **Fork this repo** (or push to your own GitHub account)
2. Sign up at [render.com](https://render.com)
3. Click **New +** → **Blueprint** → connect your GitHub repo
4. Set the required environment variables (see table below)
5. Deploy — the dashboard will be live at your Render URL

### Required Environment Variables

| Variable | Description | Example |
|---|---|---|
| `BOT_HOST` | Your Minecraft server address | `my-server.falixsrv.me` |
| `BOT_USERNAME` | Bot's display name (for offline servers) | `XiterBot` |
| `BOT_AUTH` | `offline` or `microsoft` | `offline` |
| `OWNER_USERNAME` | Your in-game name (unlocks admin commands) | `Steve` |

### Optional Variables

| Variable | Default | Description |
|---|---|---|
| `BOT_PORT` | `25565` | Server port |
| `MC_VERSION` | `1.20.1` | Minecraft version |
| `RECONNECT_DELAY` | `10000` | Ms before reconnecting |
| `AFK_INTERVAL` | `30000` | Ms between AFK actions |
| `CHAT_PREFIX` | `!` | In-game command prefix |

---

## Microsoft Account (Premium Servers)

1. Set `BOT_AUTH=microsoft` in your environment variables
2. Deploy / start the bot
3. Open the **dashboard** — a device code will appear
4. Go to **https://microsoft.com/devicelogin** and enter the code
5. Sign in with your Microsoft account
6. The bot connects and the token is cached automatically

The token is cached by `prismarine-auth` — you only need to do this once (or when the token expires after ~90 days).

---

## In-game Commands

| Command | Who | Description |
|---|---|---|
| `!ping` | Anyone | Bot replies "Pong!" |
| `!status` | Anyone | Uptime + reconnect count |
| `!pos` | Anyone | Bot's current coordinates |
| `!health` | Anyone | Bot's health and food |
| `!players` | Anyone | Lists online players |
| `!help` | Anyone | Lists all commands |
| `!reconnect` | Owner only | Forces a reconnect |
| `!stop` | Owner only | Shuts down the bot |

Set `OWNER_USERNAME` to your Minecraft username to unlock owner commands.

---

## Local Development

```bash
git clone https://github.com/YOUR_USERNAME/Minecraft-Xiter
cd Minecraft-Xiter
npm install
cp .env.example .env
# Edit .env with your server details
npm start
```

Dashboard: [http://localhost:3000](http://localhost:3000)

---

## License

MIT — use freely for your own servers.
