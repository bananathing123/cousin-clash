const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  transports: ['websocket', 'polling'],
  cors: { origin: true, methods: ['GET', 'POST'] },
  pingInterval: 10000,
  pingTimeout: 20000,
  maxHttpBufferSize: 1e5
});

app.use(express.static('public', { etag: true, maxAge: '1h' }));
app.get('/health', (_req, res) => res.json({ ok: true, service: 'cousin-clash-online' }));

const lobbies = new Map();
const socketLobby = new Map();
const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function makeCode() {
  let code;
  do {
    code = Array.from({ length: 6 }, () => alphabet[crypto.randomInt(alphabet.length)]).join('');
  } while (lobbies.has(code));
  return code;
}
function safeName(value) {
  return String(value || 'Player').replace(/[<>]/g, '').trim().slice(0, 18) || 'Player';
}
function safeCharacter(value) {
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 && n <= 16 ? n : 0;
}
function publicLobby(lobby) {
  return {
    code: lobby.code,
    hostName: lobby.players[0]?.name || 'Player',
    players: lobby.players.map(p => ({ name: p.name, character: p.character })),
    status: lobby.status
  };
}
function lobbyList() {
  return [...lobbies.values()]
    .filter(l => l.status === 'waiting' && l.players.length < 2)
    .map(l => ({ code: l.code, hostName: l.players[0]?.name || 'Player', players: l.players.length, status: l.status }))
    .sort((a, b) => a.code.localeCompare(b.code));
}
function emitLobby(lobby) {
  const view = publicLobby(lobby);
  lobby.players.forEach((p, playerIndex) => io.to(p.id).emit('lobby-state', { ...view, playerIndex }));
  io.emit('lobby-list', lobbyList());
}
function removeSocketFromLobby(socket, notify = true) {
  const code = socketLobby.get(socket.id);
  if (!code) return;
  socketLobby.delete(socket.id);
  const lobby = lobbies.get(code);
  if (!lobby) return;
  const index = lobby.players.findIndex(p => p.id === socket.id);
  if (index < 0) return;
  if (index === 0 || lobby.players.length === 1) {
    lobbies.delete(code);
    lobby.players.forEach(p => io.to(p.id).emit('lobby-closed'));
  } else {
    const wasPlaying = lobby.status === 'playing';
    lobby.players.splice(index, 1);
    lobby.status = 'waiting';
    if (wasPlaying) {
      lobby.players.forEach((p, playerIndex) => {
        io.to(p.id).emit('return-lobby', { ...publicLobby(lobby), playerIndex });
      });
    }
    if (notify) emitLobby(lobby);
  }
  io.emit('lobby-list', lobbyList());
}

io.on('connection', socket => {
  socket.emit('lobby-list', lobbyList());

  socket.on('list-lobbies', () => socket.emit('lobby-list', lobbyList()));

  socket.on('create-lobby', payload => {
    removeSocketFromLobby(socket);
    const code = makeCode();
    const lobby = {
      code,
      status: 'waiting',
      players: [{ id: socket.id, name: safeName(payload?.name), character: safeCharacter(payload?.character) }]
    };
    lobbies.set(code, lobby);
    socketLobby.set(socket.id, code);
    socket.emit('lobby-joined', { playerIndex: 0, lobby: publicLobby(lobby) });
    io.emit('lobby-list', lobbyList());
  });

  socket.on('join-lobby', payload => {
    const code = String(payload?.code || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
    const lobby = lobbies.get(code);
    if (!lobby || lobby.status !== 'waiting') return socket.emit('lobby-error', 'That lobby is unavailable.');
    if (lobby.players.length >= 2) return socket.emit('lobby-error', 'That lobby is already full.');
    removeSocketFromLobby(socket);
    lobby.players.push({ id: socket.id, name: safeName(payload?.name), character: safeCharacter(payload?.character) });
    socketLobby.set(socket.id, code);
    socket.emit('lobby-joined', { playerIndex: 1, lobby: publicLobby(lobby) });
    emitLobby(lobby);
  });

  socket.on('start-game', payload => {
    const code = String(payload?.code || '').toUpperCase();
    const lobby = lobbies.get(code);
    if (!lobby || lobby.players[0]?.id !== socket.id) return socket.emit('lobby-error', 'Only the lobby creator can start.');
    if (lobby.players.length !== 2) return socket.emit('lobby-error', 'You need two players to start.');
    if (lobby.status === 'playing') return;
    lobby.status = 'playing';
    const characters = lobby.players.map(p => p.character);
    const mapIndex = crypto.randomInt(0, 7);
    lobby.players.forEach((p, playerIndex) => {
      io.to(p.id).emit('game-start', { playerIndex, characters, mapIndex });
    });
    emitLobby(lobby);
  });

  socket.on('player-input', payload => {
    const code = socketLobby.get(socket.id);
    const lobby = code && lobbies.get(code);
    if (!lobby || lobby.status !== 'playing') return;
    const playerIndex = lobby.players.findIndex(p => p.id === socket.id);
    if (playerIndex < 0) return;
    const raw = payload?.input || {};
    const input = {
      l: !!raw.l, r: !!raw.r, u: !!raw.u,
      p: !!raw.p, k: !!raw.k, b: !!raw.b
    };
    const opponent = lobby.players[1 - playerIndex];
    if (opponent) io.to(opponent.id).emit('player-input', { playerIndex, input });
  });

  socket.on('return-lobby', payload => {
    const code = String(payload?.code || '').toUpperCase();
    const lobby = lobbies.get(code);
    if (!lobby || !lobby.players.some(p => p.id === socket.id)) return;
    lobby.status = 'waiting';
    lobby.players.forEach((p, playerIndex) => {
      io.to(p.id).emit('return-lobby', { ...publicLobby(lobby), playerIndex });
    });
    io.emit('lobby-list', lobbyList());
  });

  socket.on('leave-lobby', () => removeSocketFromLobby(socket));
  socket.on('disconnect', () => removeSocketFromLobby(socket));
});

const port = Number(process.env.PORT || 3000);
server.listen(port, '0.0.0.0', () => console.log(`Cousin Clash online server listening on ${port}`));
