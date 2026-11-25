const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);

// Optimize Socket.IO for low latency real-time fighting game relay on Render
const io = new Server(server, {
  transports: ['websocket', 'polling'],
  cors: { origin: true, methods: ['GET', 'POST'] },
  pingInterval: 6000,
  pingTimeout: 14000,
  perMessageDeflate: false,
  httpCompression: false,
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
  return String(value || 'Player').replace(/[<>]/g, '').trim().slice(0, 16) || 'Player';
}

function safeCharacter(value) {
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 && n <= 16 ? n : 0;
}

function publicLobby(lobby) {
  return {
    code: lobby.code,
    hostName: lobby.players[0]?.name || 'Player',
    mapIndex: Number.isInteger(lobby.mapIndex) ? lobby.mapIndex : 7,
    players: lobby.players.map(p => ({
      name: p.name,
      character: p.character,
      ready: !!p.ready
    })),
    status: lobby.status
  };
}

function lobbyList() {
  return [...lobbies.values()]
    .filter(l => l.status === 'waiting' && l.players.length < 4)
    .map(l => ({
      code: l.code,
      hostName: l.players[0]?.name || 'Player',
      players: l.players.length,
      status: l.status,
      mapIndex: l.mapIndex ?? 7
    }))
    .sort((a, b) => a.code.localeCompare(b.code));
}

function emitLobby(lobby) {
  const view = publicLobby(lobby);
  lobby.players.forEach((p, playerIndex) => {
    io.to(p.id).emit('lobby-state', { ...view, playerIndex });
  });
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
    // Host disconnected or only player left
    lobbies.delete(code);
    lobby.players.forEach(p => {
      if (p.id !== socket.id) io.to(p.id).emit('lobby-closed');
    });
  } else {
    // Guest disconnected
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
  // Send initial lobby list
  socket.emit('lobby-list', lobbyList());

  socket.on('list-lobbies', () => {
    socket.emit('lobby-list', lobbyList());
  });

  socket.on('create-lobby', payload => {
    removeSocketFromLobby(socket);
    const code = makeCode();
    const lobby = {
      code,
      status: 'waiting',
      mapIndex: 7, // 7 = Random
      players: [{
        id: socket.id,
        name: safeName(payload?.name),
        character: safeCharacter(payload?.character),
        ready: true
      }]
    };
    lobbies.set(code, lobby);
    socketLobby.set(socket.id, code);
    socket.emit('lobby-joined', { playerIndex: 0, lobby: publicLobby(lobby) });
    io.emit('lobby-list', lobbyList());
  });

  socket.on('join-lobby', payload => {
    const code = String(payload?.code || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
    const lobby = lobbies.get(code);
    if (!lobby || lobby.status !== 'waiting') {
      return socket.emit('lobby-error', 'That lobby is unavailable or match in progress.');
    }
    if (lobby.players.length >= 4) {
      return socket.emit('lobby-error', 'That lobby is already full (max 4 players).');
    }
    removeSocketFromLobby(socket);
    const playerIndex = lobby.players.length;
    lobby.players.push({
      id: socket.id,
      name: safeName(payload?.name),
      character: safeCharacter(payload?.character),
      ready: true
    });
    socketLobby.set(socket.id, code);
    socket.emit('lobby-joined', { playerIndex, lobby: publicLobby(lobby) });
    emitLobby(lobby);
  });

  socket.on('quick-match', payload => {
    // Find an open waiting lobby with room (< 4 players)
    const openLobbies = [...lobbies.values()].filter(l => l.status === 'waiting' && l.players.length < 4);
    if (openLobbies.length > 0) {
      const target = openLobbies[0];
      removeSocketFromLobby(socket);
      const playerIndex = target.players.length;
      target.players.push({
        id: socket.id,
        name: safeName(payload?.name),
        character: safeCharacter(payload?.character),
        ready: true
      });
      socketLobby.set(socket.id, target.code);
      socket.emit('lobby-joined', { playerIndex, lobby: publicLobby(target) });
      emitLobby(target);
    } else {
      // Create a new lobby
      removeSocketFromLobby(socket);
      const code = makeCode();
      const lobby = {
        code,
        status: 'waiting',
        mapIndex: 7,
        players: [{
          id: socket.id,
          name: safeName(payload?.name),
          character: safeCharacter(payload?.character),
          ready: true
        }]
      };
      lobbies.set(code, lobby);
      socketLobby.set(socket.id, code);
      socket.emit('lobby-joined', { playerIndex: 0, lobby: publicLobby(lobby) });
      io.emit('lobby-list', lobbyList());
    }
  });

  // Character selection in lobby room
  socket.on('char-select', payload => {
    const code = socketLobby.get(socket.id);
    const lobby = code && lobbies.get(code);
    if (!lobby || lobby.status !== 'waiting') return;
    const player = lobby.players.find(p => p.id === socket.id);
    if (!player) return;
    player.character = safeCharacter(payload?.character);
    emitLobby(lobby);
  });

  // Stage selection in lobby room (Host only)
  socket.on('map-select', payload => {
    const code = socketLobby.get(socket.id);
    const lobby = code && lobbies.get(code);
    if (!lobby || lobby.players[0]?.id !== socket.id) return;
    const m = Number(payload?.mapIndex);
    lobby.mapIndex = (Number.isInteger(m) && m >= 0 && m <= 7) ? m : 7;
    emitLobby(lobby);
  });

  // Ready toggle in lobby room
  socket.on('ready-toggle', payload => {
    const code = socketLobby.get(socket.id);
    const lobby = code && lobbies.get(code);
    if (!lobby || lobby.status !== 'waiting') return;
    const player = lobby.players.find(p => p.id === socket.id);
    if (!player) return;
    player.ready = !!payload?.ready;
    emitLobby(lobby);
  });

  // Host starts the match
  socket.on('start-game', payload => {
    const code = String(payload?.code || socketLobby.get(socket.id) || '').toUpperCase();
    const lobby = lobbies.get(code);
    if (!lobby || lobby.players[0]?.id !== socket.id) {
      return socket.emit('lobby-error', 'Only the lobby host can start.');
    }
    if (lobby.players.length < 2) {
      return socket.emit('lobby-error', 'You need at least two players to start.');
    }
    if (lobby.status === 'playing') return;

    lobby.status = 'playing';
    const characters = lobby.players.map(p => p.character);
    const mapIndex = (lobby.mapIndex === 7 || lobby.mapIndex == null)
      ? crypto.randomInt(0, 7)
      : lobby.mapIndex;

    const seed = crypto.randomInt(1, 1000000);
    lobby.players.forEach((p, playerIndex) => {
      io.to(p.id).emit('game-start', {
        playerIndex,
        characters,
        mapIndex,
        seed
      });
    });
    emitLobby(lobby);
  });

  // Real-time input relay with minimal latency to all opponents in lobby
  socket.on('player-input', payload => {
    const code = socketLobby.get(socket.id);
    const lobby = code && lobbies.get(code);
    if (!lobby || lobby.status !== 'playing') return;
    const playerIndex = lobby.players.findIndex(p => p.id === socket.id);
    if (playerIndex < 0) return;

    const msg = {
      playerIndex,
      input: payload?.input || {},
      seq: payload?.seq || 0
    };
    lobby.players.forEach((p, idx) => {
      if (idx !== playerIndex) {
        io.to(p.id).emit('player-input', msg);
      }
    });
  });

  // State sync from host to all guests to prevent simulation drift
  socket.on('state-sync', payload => {
    const code = socketLobby.get(socket.id);
    const lobby = code && lobbies.get(code);
    if (!lobby || lobby.status !== 'playing') return;
    if (lobby.players[0]?.id !== socket.id) return; // Only host sends state sync

    for (let i = 1; i < lobby.players.length; i++) {
      io.to(lobby.players[i].id).emit('state-sync', payload);
    }
  });

  // Return to lobby after match
  socket.on('return-lobby', () => {
    const code = socketLobby.get(socket.id);
    const lobby = code && lobbies.get(code);
    if (!lobby) return;

    lobby.status = 'waiting';
    lobby.players.forEach(p => { p.ready = true; });
    lobby.players.forEach((p, playerIndex) => {
      io.to(p.id).emit('return-lobby', { ...publicLobby(lobby), playerIndex });
    });
    io.emit('lobby-list', lobbyList());
  });

  socket.on('leave-lobby', () => removeSocketFromLobby(socket));
  socket.on('disconnect', () => removeSocketFromLobby(socket));
});

const port = Number(process.env.PORT || 3000);
server.listen(port, '0.0.0.0', () => {
  console.log(`Cousin Clash online server listening on ${port}`);
});
