# Minecraft-Xiter Bot

A 24/7 Minecraft AFK bot designed to keep your FalixNodes server alive using Render.com's free tier.

## Features

- **Anti-AFK**: Performs random movements, jumps, sneaks, and chat messages to prevent AFK kicks
- **Auto-Reconnect**: Automatically reconnects if kicked or disconnected
- **Health Monitoring**: Built-in HTTP server for Render.com health checks
- **Chat Commands**: Responds to `!ping` and `!status` in-game

## Quick Deploy to Render.com

1. Fork this repository or push to your GitHub
2. Sign up at [render.com](https://render.com)
3. Click "New +" → "Blueprint"
4. Connect your GitHub repo
5. Set environment variables:
   - `BOT_HOST`: Your FalixNodes server address (e.g., `your-server.falixsrv.me`)
   - `BOT_USERNAME`: Bot username
   - Other vars are optional (see `.env.example`)
6. Deploy!

## Local Development

```bash
npm install
cp .env.example .env
# Edit .env with your server details
npm start
```

## Configuration

All settings are in environment variables. See `.env.example` for full list.

- `BOT_HOST`: Minecraft server address
- `BOT_PORT`: Server port (default 25565)
- `BOT_USERNAME`: Bot's Minecraft username
- `MC_VERSION`: Minecraft version (default 1.20.1)
- `RECONNECT_DELAY`: Milliseconds before reconnecting (default 10000)
- `AFK_INTERVAL`: Milliseconds between AFK actions (default 30000)

## License

MIT — Use freely for your own servers.
