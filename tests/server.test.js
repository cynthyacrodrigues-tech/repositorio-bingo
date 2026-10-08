const test = require('node:test');
const assert = require('node:assert/strict');
const { createServer } = require('../server.js');

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

async function request(base, path, options = {}) {
  const response = await fetch(`${base}${path}`, {
    method: options.method || 'GET',
    headers: options.body ? { 'Content-Type': 'application/json' } : undefined,
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  const text = await response.text();
  const payload = text ? JSON.parse(text) : {};
  return { status: response.status, payload };
}

test('returns a share base URL for room links', async () => {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;

  try {
    const configRes = await request(base, '/api/config');
    assert.equal(configRes.status, 200, JSON.stringify(configRes.payload));
    assert.match(configRes.payload.baseUrl, /^http:\/\//, 'deve retornar uma URL de compartilhamento');
  } finally {
    server.close();
  }
});

test('create room, select card, start and draw', async () => {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;

  try {
    const hostRes = await request(base, '/api/create', { method: 'POST', body: { name: 'Ana', winRule: 'line' } });
    assert.equal(hostRes.status, 201, JSON.stringify(hostRes.payload));
    const roomCode = hostRes.payload.roomCode;
    const hostId = hostRes.payload.clientId;

    const join1 = await request(base, '/api/join', { method: 'POST', body: { roomCode, name: 'Beto' } });
    assert.equal(join1.status, 201, JSON.stringify(join1.payload));
    const p1 = join1.payload.clientId;

    const join2 = await request(base, '/api/join', { method: 'POST', body: { roomCode, name: 'Cida' } });
    assert.equal(join2.status, 201, JSON.stringify(join2.payload));
    const p2 = join2.payload.clientId;

    const card1 = ITEMS.slice(0, 16);
    const card2 = ITEMS.slice(5, 21);

    const select1 = await request(base, '/api/select-card', { method: 'POST', body: { roomCode, clientId: p1, card: card1 } });
    assert.equal(select1.status, 200, JSON.stringify(select1.payload));
    const select2 = await request(base, '/api/select-card', { method: 'POST', body: { roomCode, clientId: p2, card: card2 } });
    assert.equal(select2.status, 200, JSON.stringify(select2.payload));

    const start = await request(base, '/api/start', { method: 'POST', body: { roomCode, clientId: hostId } });
    assert.equal(start.status, 200, JSON.stringify(start.payload));

    const draw = await request(base, '/api/draw', { method: 'POST', body: { roomCode, clientId: hostId } });
    assert.equal(draw.status, 200, JSON.stringify(draw.payload));
    assert.ok(Array.isArray(draw.payload.draws), 'deve retornar os sorteios da sala');
    assert.ok(draw.payload.draws.length >= 1, 'deve haver pelo menos um item sorteado');
  } finally {
    server.close();
  }
});
