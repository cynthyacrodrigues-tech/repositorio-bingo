const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { randomUUID, randomInt } = require('node:crypto');
const QRCode = require('qrcode');

const PORT = Number(process.env.PORT || 3000);
const HTTPS_PORT = Number(process.env.HTTPS_PORT || 3443);
const TLS_KEY_PATH = path.join(__dirname, 'certs', 'localhost.key');
const TLS_CERT_PATH = path.join(__dirname, 'certs', 'localhost.crt');
const MAX_PLAYERS = 40;
const ITEMS = [
  'CAPACETE DE SEGURANÇA',
  'ÓCULOS INCOLOR',
  'ÓCULOS PRETO',
  'PROTETOR FACIAL',
  'MÁSCARA DE SOLDA',
  'PROTETOR AURICULAR TIPO PLUG',
  'PROTETOR AURICULAR TIPO CONCHA',
  'MÁSCARA PFF2',
  'LUVA DE RASPA',
  'LUVA DE VAQUETA',
  'LUVA NITRÍLICA',
  'LUVA DE LÁTEX',
  'BOTINA',
  'PERNEIRA',
  'BOTINA DE COMPOSITE',
  'AVENTAL BARBEIRO',
  'AVENTAL VINIL',
  'MACACÃO DE PROTEÇÃO QUÍMICA',
  'JALECO',
  'PROTETOR SOLAR (PROTEÇÃO CONTRA RAIOS UV)',
  'BONÉ CASQUETE',
  'CAPA DE CHUVA',
  'CAPUZ BALACLAVA',
  'CORRETOR POSTURAL',
  'CINTO ELETRICISTA',
  'JUGULAR PARA CAPACETE 3M',
  'TRAVA QUEDAS',
  'BOTA EMBORRACHADA',
  'BOTINA PVC',
  'BOTINA COMPOSITE'
];

const rooms = new Map();

function shuffle(values) {
  const result = [...values];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const swapIndex = randomInt(index + 1);
    [result[index], result[swapIndex]] = [result[swapIndex], result[index]];
  }
  return result;
}

function createRoomCode() {
  const alphabet = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
  let code;
  do {
    code = Array.from({ length: 6 }, () => alphabet[randomInt(alphabet.length)]).join('');
  } while (rooms.has(code));
  return code;
}

function getShareBaseUrl() {
  const addresses = [];
  const interfaces = os.networkInterfaces();
  Object.values(interfaces).forEach((items = []) => {
    items.forEach((entry) => {
      if (entry.family === 'IPv4' && !entry.internal) {
        addresses.push(entry.address);
      }
    });
  });

  const host = addresses[0] || '127.0.0.1';
  return `http://${host}:${PORT}`;
}

function getRoom(code) {
  const room = rooms.get(String(code || '').toUpperCase());
  if (!room) {
    throw Object.assign(new Error('Sala não encontrada. Confira o código.'), { statusCode: 404 });
  }
  return room;
}

function linePositions() {
  const lines = [];
  for (let row = 0; row < 4; row += 1) {
    lines.push([row * 4, row * 4 + 1, row * 4 + 2, row * 4 + 3]);
  }
  for (let column = 0; column < 4; column += 1) {
    lines.push([column, column + 4, column + 8, column + 12]);
  }
  lines.push([0, 5, 10, 15]);
  lines.push([3, 6, 9, 12]);
  return lines;
}

function isWinner(card, draws, rule) {
  const drawn = new Set(draws);
  const full = card.every((item) => drawn.has(item));
  if (rule === 'full') return full;
  const lines = linePositions();
  const lineWinner = lines.some((line) => line.every((position) => drawn.has(card[position])));
  return lineWinner || full;
}

function serializeRoom(room, clientId) {
  const me = room.players.find((player) => player.id === clientId);
  const players = room.players.map((player) => ({
    id: player.id,
    name: player.name,
    ready: player.ready,
    winner: room.winners.includes(player.id),
    card: me && (room.status !== 'lobby' || player.id === me.id) ? player.card : undefined
  }));

  return {
    roomCode: room.code,
    status: room.status,
    winRule: room.winRule,
    playerCount: room.players.length,
    players,
    draws: room.draws,
    winners: room.winners.map((id) => room.players.find((player) => player.id === id)?.name).filter(Boolean),
    myCard: me ? me.card : null,
    readyCount: room.players.filter((player) => player.ready).length,
    allReady: room.players.length > 0 && room.players.every((player) => player.ready)
  };
}

function broadcast(room) {
  const payload = Array.from(room.clients).map(({ response, clientId }) => {
    const message = `data: ${JSON.stringify(serializeRoom(room, clientId))}\n\n`;
    response.write(message);
    return clientId;
  });
  return payload;
}

function validateCard(card) {
  if (!Array.isArray(card)) {
    throw Object.assign(new Error('Cartela inválida.'), { statusCode: 400 });
  }
  if (card.length !== 16) {
    throw Object.assign(new Error('Cada cartela precisa conter exatamente 16 EPIs.'), { statusCode: 400 });
  }
  const unique = new Set(card);
  if (unique.size !== 16) {
    throw Object.assign(new Error('Não é permitido repetir EPIs na cartela.'), { statusCode: 400 });
  }
  const invalid = card.find((item) => !ITEMS.includes(item));
  if (invalid) {
    throw Object.assign(new Error(`EPI inválido: ${invalid}`), { statusCode: 400 });
  }
  return card;
}

async function readBody(request) {
  return new Promise((resolve, reject) => {
    let raw = '';
    request.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 16 * 1024) {
        reject(Object.assign(new Error('Payload muito grande.'), { statusCode: 413 }));
        request.destroy();
      }
    });
    request.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        reject(Object.assign(new Error('Corpo da requisição inválido.'), { statusCode: 400 }));
      }
    });
    request.on('error', reject);
  });
}

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(payload));
}

function requireHost(room, clientId) {
  if (room.host.id !== clientId) {
    throw Object.assign(new Error('Somente o organizador pode controlar a partida.'), { statusCode: 403 });
  }
}

function ensurePlayerMembership(room, clientId) {
  const player = room.players.find((entry) => entry.id === clientId);
  if (!player) {
    throw Object.assign(new Error('Participante não encontrado nesta sala.'), { statusCode: 404 });
  }
  return player;
}

function createIndexHtml() {
  return fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
}

async function handleRequest(request, response) {
  const url = new URL(request.url, 'http://localhost');

  try {
    if ((request.method === 'GET' || request.method === 'HEAD') && url.pathname === '/') {
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      if (request.method === 'HEAD') {
        response.end();
      } else {
        response.end(createIndexHtml());
      }
      return;
    }

    if (request.method === 'GET' && url.pathname === '/api/config') {
      sendJson(response, 200, { baseUrl: getShareBaseUrl() });
      return;
    }

    if (request.method === 'GET' && url.pathname === '/api/session') {
      const roomCode = url.searchParams.get('roomCode');
      const clientId = url.searchParams.get('clientId');
      const room = getRoom(roomCode);
      ensurePlayerMembership(room, clientId);
      sendJson(response, 200, {
        roomCode: room.code,
        clientId,
        role: room.host.id === clientId ? 'host' : 'player',
        state: serializeRoom(room, clientId)
      });
      return;
    }

    if (request.method === 'GET' && url.pathname === '/api/qr') {
      const text = url.searchParams.get('text') || 'http://localhost:3000';
      const image = await QRCode.toBuffer(text, {
        type: 'png',
        margin: 4,
        width: 900,
        errorCorrectionLevel: 'H',
        color: { dark: '#0F2D3A', light: '#FFFFFF' }
      });
      response.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' });
      response.end(image);
      return;
    }

    if (request.method === 'GET' && url.pathname === '/api/events') {
      const roomCode = url.searchParams.get('roomCode');
      const clientId = url.searchParams.get('clientId');
      const room = getRoom(roomCode);
      ensurePlayerMembership(room, clientId);
      response.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no'
      });
      response.write(`data: ${JSON.stringify(serializeRoom(room, clientId))}\n\n`);
      const client = { response, clientId };
      room.clients.add(client);
      const heartbeat = setInterval(() => response.write(': keep-alive\n\n'), 20000);
      request.on('close', () => {
        clearInterval(heartbeat);
        room.clients.delete(client);
      });
      return;
    }

    if (request.method !== 'POST') {
      sendJson(response, 404, { error: 'Rota não encontrada.' });
      return;
    }

    const body = await readBody(request);

    if (url.pathname === '/api/create') {
      const name = String(body.name || '').trim().slice(0, 30);
      if (!name) {
        throw Object.assign(new Error('Informe o nome do organizador.'), { statusCode: 400 });
      }
      const roomCode = createRoomCode();
      const host = { id: randomUUID(), name };
      const room = {
        code: roomCode,
        host,
        players: [{ id: host.id, name, card: [], ready: true }],
        draws: [],
        status: 'lobby',
        winRule: body.winRule === 'full' ? 'full' : 'line',
        winners: [],
        clients: new Set()
      };
      rooms.set(roomCode, room);
      sendJson(response, 201, {
        roomCode,
        clientId: host.id,
        role: 'host',
        state: serializeRoom(room, host.id)
      });
      return;
    }

    if (url.pathname === '/api/join') {
      const roomCode = String(body.roomCode || '').toUpperCase();
      const room = getRoom(roomCode);
      if (room.status !== 'lobby') {
        throw Object.assign(new Error('A partida já começou. Não é possível entrar agora.'), { statusCode: 409 });
      }
      if (room.players.length >= MAX_PLAYERS) {
        throw Object.assign(new Error('A sala atingiu o limite de 40 participantes.'), { statusCode: 409 });
      }
      const name = String(body.name || '').trim().slice(0, 30);
      if (!name) {
        throw Object.assign(new Error('Informe seu nome para entrar na sala.'), { statusCode: 400 });
      }
      const player = { id: randomUUID(), name, card: [], ready: false };
      room.players.push(player);
      broadcast(room);
      sendJson(response, 201, {
        roomCode: room.code,
        clientId: player.id,
        role: 'player',
        state: serializeRoom(room, player.id)
      });
      return;
    }

    if (url.pathname === '/api/select-card') {
      const room = getRoom(String(body.roomCode || '').toUpperCase());
      const player = ensurePlayerMembership(room, body.clientId);
      if (room.status !== 'lobby') {
        throw Object.assign(new Error('A cartela não pode ser alterada depois do início da partida.'), { statusCode: 409 });
      }
      const card = validateCard(body.card || []);
      player.card = card;
      player.ready = true;
      broadcast(room);
      sendJson(response, 200, { ok: true, state: serializeRoom(room, player.id) });
      return;
    }

    if (url.pathname === '/api/start') {
      const room = getRoom(String(body.roomCode || '').toUpperCase());
      requireHost(room, body.clientId);
      if (room.players.length === 0) {
        throw Object.assign(new Error('A sala precisa de pelo menos um participante.'), { statusCode: 400 });
      }
      const participants = room.players.filter((player) => player.id !== room.host.id);
      if (participants.length > 0) {
        const notReady = participants.filter((player) => !player.ready || player.card.length !== 16);
        if (notReady.length > 0) {
          throw Object.assign(new Error('Todos os participantes precisam escolher 16 EPIs antes de iniciar.'), { statusCode: 409 });
        }
      }
      room.status = 'playing';
      room.winners = [];
      room.draws = [];
      broadcast(room);
      sendJson(response, 200, { ok: true, state: serializeRoom(room, body.clientId) });
      return;
    }

    if (url.pathname === '/api/draw') {
      const room = getRoom(String(body.roomCode || '').toUpperCase());
      requireHost(room, body.clientId);
      if (room.status !== 'playing') {
        throw Object.assign(new Error('A partida ainda não começou.'), { statusCode: 409 });
      }
      const remaining = ITEMS.filter((item) => !room.draws.includes(item));
      if (remaining.length === 0) {
        throw Object.assign(new Error('Todos os EPIs já foram sorteados.'), { statusCode: 409 });
      }
      const next = remaining[randomInt(remaining.length)];
      room.draws.push(next);
      room.winners = room.players
        .filter((player) => player.card.length === 16 && isWinner(player.card, room.draws, room.winRule))
        .map((player) => player.id);
      if (room.winners.length > 0) {
        room.status = 'finished';
      }
      broadcast(room);
      sendJson(response, 200, { ok: true, draw: next, draws: room.draws, winners: room.winners });
      return;
    }

    sendJson(response, 404, { error: 'Rota não encontrada.' });
  } catch (error) {
    if (!response.headersSent) {
      sendJson(response, error.statusCode || 500, { error: error.message || 'Erro interno.' });
      return;
    }
    response.end();
  }
}

function createHandler() {
  return (request, response) => {
    handleRequest(request, response).catch((error) => {
      if (!response.headersSent) {
        sendJson(response, error.statusCode || 500, { error: error.message || 'Erro interno.' });
      }
    });
  };
}

function createServer() {
  return http.createServer(createHandler());
}

function createHttpsServer() {
  const hasTls = fs.existsSync(TLS_KEY_PATH) && fs.existsSync(TLS_CERT_PATH);
  if (!hasTls) return null;
  const options = {
    key: fs.readFileSync(TLS_KEY_PATH),
    cert: fs.readFileSync(TLS_CERT_PATH)
  };
  return https.createServer(options, createHandler());
}

if (require.main === module) {
  createServer().listen(PORT, '0.0.0.0', () => {
    console.log(`Servidor Bingo EPI rodando em http://localhost:${PORT}`);
  });

  const httpsServer = createHttpsServer();
  if (httpsServer) {
    httpsServer.listen(HTTPS_PORT, '0.0.0.0', () => {
      console.log(`HTTPS local disponível em https://localhost:${HTTPS_PORT}`);
    });
  }
}

module.exports = { createServer, createHttpsServer, ITEMS };
