# Cousin Clash — Online Edition

This package adds public online lobbies, invite codes, a two-player online match flow, and a randomized arena selection to the supplied Cousin Clash HTML game.

## What is included

- `public/index.html` — the modified game and online menu.
- `server.js` — Node/Express + Socket.IO lobby and input relay server.
- `render.yaml` — Render Blueprint deployment definition.
- `package.json` — server dependencies and start script.

## Deploy to Render (no player needs to host)

1. Create a new **GitHub repository** and upload the contents of this folder (keep `public/index.html` inside the `public` folder).
2. In Render, choose **New → Blueprint** and connect that GitHub repository.
3. Render reads `render.yaml`, installs dependencies, and starts the server. Wait for the service to become **Live**.
4. Open the Render URL (for example `https://your-service.onrender.com`). Both players use that same URL.
5. Select **ONLINE** on the title screen. Create a lobby, then have the other player join from the public list or with the six-character code. The lobby creator starts the match.

## Local testing

Requires Node.js 20+.

```bash
npm install
npm start
```

Open `http://localhost:3000` in two separate browser windows.

## Networking and performance notes

Render hosts the lobby and relays compact player-input messages; neither player has to run a server or act as the host. The existing Canvas game simulation remains client-side on both browsers, with each browser applying the same two-player input stream. The relay uses WebSocket transport when available and polling as a fallback.

The game uses its existing fixed-step animation loop. Input packets are small and sent at a capped interval to keep traffic low. Online smoothness still depends on both players' network latency, browser performance, and Render service availability. No internet game can be guaranteed to have zero lag. Render's free service may spin down when idle, which can make the first connection after inactivity take longer; use an always-on paid instance if instant availability is important.

This is a lightweight peer-simulation relay, not a server-authoritative anti-cheat system. Both clients simulate the same match locally. For ranked/competitive play, a server-authoritative simulation and periodic state reconciliation would be a separate larger change.

## Lobby behavior

- Public lobbies with up to two players.
- Six-character join codes.
- Host-only start button, enabled once two players are connected.
- Server chooses a random arena when the match starts.
- If a player disconnects, the lobby is removed or returned to waiting state.

## GitHub / Render access

This ZIP is ready to upload as a repository. It does not create a GitHub repository or deploy a Render service automatically; those actions require signing into your GitHub and Render accounts and granting access.
