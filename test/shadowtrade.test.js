'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const gciSave = require('../src/gci-save');
const sp = require('../src/save-pokemon');
const { Shadowtrade, cardAccess, liveAccess, parseResult, checkReceived } = require('../src/shadowtrade');

const utf16 = (bytes, offset, value) => Buffer.from(value, 'utf16le').swap16().copy(bytes, offset);
function pokemon({ species, rnd, trainer, nickname, shadowId = 0, heart = -100 }) {
  const p = Buffer.alloc(0x138);
  p.writeUInt16BE(species, 0); p.writeUInt32BE(rnd, 4); p.writeUInt32BE(trainer, 0x14); utf16(p, 0x2e, nickname);
  p[0x60] = 30; p.writeUInt16BE(40, 0x8a); p.writeUInt16BE(40, 0x8c); p.writeUInt16BE(shadowId, 0xd8); p.writeInt32BE(heart, 0xdc);
  return p;
}
function plainSave(trainerId, party) {
  const plain = Buffer.alloc(gciSave.SLOT_SIZE);
  plain[0] = 1; plain[1] = 1; plain.writeInt32BE(4, 4);
  utf16(plain, 0x78, 'WES'); plain.writeUInt32BE(trainerId, 0xa4);
  party.forEach((p, i) => p.copy(plain, 0xa8 + i * 0x138));
  for (let n = 1; n <= 0x43; n++) plain.writeUInt16BE(20, 0x1b4ac + 0x18 * n + 0x16);
  return plain;
}
function card(dir, trainerId, party) {
  const data = Buffer.alloc(gciSave.SIZE);
  for (let i = 0; i < 3; i++) {
    const plain = i === 0 ? plainSave(trainerId, party) : Buffer.alloc(gciSave.SLOT_SIZE);
    if (i) { plain[0] = 1; plain[1] = 1; }
    gciSave.scramble(plain).copy(data, gciSave.SLOT_START + i * gciSave.SLOT_SIZE);
  }
  fs.writeFileSync(path.join(dir, 'pokemon_colosseum.dat'), data);
}
const folder = t => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'colo-shadowtrade-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir; };

// The server, pairing as colosseum-server-api's pool does (oldest accepted first), in memory.
function fakeServer() {
  const trades = new Map();
  let order = 0, failNext = null;
  const server = {
    trades,
    failNext(kind) { failNext = kind; },
    async fetch(url, init) {
      const action = url.split('/').pop(), body = JSON.parse(init.body);
      const reply = (value, status = 200) => ({ ok: status < 400, status, json: async () => value });
      if (failNext === 'down') { failNext = null; throw new Error('fetch failed'); }
      const view = t => ({ tradeId: t.id, status: t.status, received: t.got ? { pokemon: t.got.pokemon, from: t.got.trainer, ...t.got.summary } : undefined,
        returned: t.status === 'cancelled' ? { pokemon: t.pokemon } : undefined });
      if (action === 'offer') {
        let t = trades.get(body.tradeId);
        if (!t) {
          const data = Buffer.from(body.pokemon.data, 'base64');
          t = { id: body.tradeId, owner: body.key, trainer: body.trainerName, pokemon: body.pokemon, shadowId: data.readUInt16BE(0xd8), accepts: body.accepts,
            inPool: true, status: 'waiting', order: order++, summary: { species: data.readUInt16BE(0), shadowId: data.readUInt16BE(0xd8), level: 30, nickname: 'X' } };
          trades.set(t.id, t);
          const got = [...trades.values()].filter(o => o.inPool && o.owner !== t.owner && t.accepts.includes(o.shadowId)).sort((a, b) => a.order - b.order)[0];
          if (got) { got.inPool = false; t.got = got; t.status = 'received'; }
          const taker = [...trades.values()].filter(o => o.status === 'waiting' && o.owner !== t.owner && o.accepts.includes(t.shadowId)).sort((a, b) => a.order - b.order)[0];
          if (taker) { t.inPool = false; taker.got = t; taker.status = 'received'; }
        }
        if (failNext === 'lost') { failNext = null; throw new Error('the answer was lost'); }
        return reply({ trade: view(t) });
      }
      if (action === 'status') return reply({ trades: [...trades.values()].filter(t => t.owner === body.key && ['waiting', 'received', 'cancelled'].includes(t.status)).map(view) });
      if (action === 'ack') { const t = trades.get(body.tradeId); if (t && t.owner === body.key) t.status = 'done'; return reply({ ok: true }); }
      if (action === 'cancel') {
        const t = trades.get(body.tradeId);
        if (!t || t.owner !== body.key) return reply({ error: 'No such trade.' }, 404);
        if (t.status === 'waiting' && t.inPool) { t.status = 'cancelled'; t.inPool = false; }
        return reply({ trade: view(t) });
      }
      return reply({ error: 'Not found' }, 404);
    }
  };
  return server;
}

function player(t, server, { trainerId, party }) {
  const dir = folder(t);
  card(dir, trainerId, party);
  const trade = new Shadowtrade({ folder: path.join(dir, 'launcher'), url: 'https://server', fetch: server.fetch });
  const access = cardAccess({ game: 'colosseum', saveDir: dir });
  return { dir, trade, access, accessFor: () => access, party: () => sp.readCard(dir, 'colosseum').party.filter(Boolean).map(p => p.nickname) };
}

const A_ID = 0x1111, B_ID = 0x2222;
const UMBREON = pokemon({ species: 197, rnd: 1, trainer: A_ID, nickname: 'UMBREON' });
const MAKUHITA = pokemon({ species: 296, rnd: 2, trainer: A_ID, nickname: 'MAKUHITA', shadowId: 1, heart: 1500 });
const ESPEON = pokemon({ species: 196, rnd: 3, trainer: B_ID, nickname: 'ESPEON' });
const BAYLEEF = pokemon({ species: 153, rnd: 4, trainer: B_ID, nickname: 'BAYLEEF', shadowId: 2, heart: 2000 });

test('two players trade: the first waits, the second receives at once, the first on their next sync', async t => {
  const server = fakeServer();
  const a = player(t, server, { trainerId: A_ID, party: [UMBREON, MAKUHITA] });
  const b = player(t, server, { trainerId: B_ID, party: [ESPEON, BAYLEEF] });
  let view = await a.trade.offer(a.access, { area: 'party', box: 0, slot: 1 });
  assert.equal(view.trades[0].stage, 'waiting');
  assert.deepEqual(a.party(), ['UMBREON'], 'it left A\'s save before it was sent');
  view = await b.trade.offer(b.access, { area: 'party', box: 0, slot: 1 });
  assert.equal(view.trades.length, 0);
  assert.equal(view.history[0].received.species, 296);
  assert.equal(view.history[0].from, 'WES');
  assert.deepEqual(b.party(), ['ESPEON', 'MAKUHITA']);
  view = await a.trade.sync(a.accessFor);
  assert.equal(view.trades.length, 0);
  assert.deepEqual(a.party(), ['UMBREON', 'BAYLEEF']);
  const save = sp.readCard(a.dir, 'colosseum');
  assert.equal(save.party[1].trainer, B_ID, 'B stays its original trainer');
  assert.equal(save.shadows[2].snagged, true);
  assert.equal([...server.trades.values()].every(each => each.status === 'done'), true);
});

test('a refused Pokémon never leaves the save', async t => {
  const server = fakeServer();
  const a = player(t, server, { trainerId: A_ID, party: [MAKUHITA] });
  await assert.rejects(a.trade.offer(a.access, { area: 'party', box: 0, slot: 0 }), /last Pokémon/);
  await assert.rejects(a.trade.offer(a.access, { area: 'party', box: 0, slot: 3 }), /no Pokémon/);
  assert.deepEqual(a.party(), ['MAKUHITA']);
  assert.equal(a.trade.view().trades.length, 0);
});

test('with the server down, a taken Pokémon is kept and sent at the next sync', async t => {
  const server = fakeServer();
  const a = player(t, server, { trainerId: A_ID, party: [UMBREON, MAKUHITA] });
  server.failNext('down');
  const view = await a.trade.offer(a.access, { area: 'party', box: 0, slot: 1 });
  assert.equal(view.trades[0].stage, 'taken');
  assert.match(view.trades[0].message, /kept safe/);
  assert.equal(server.trades.size, 0);
  await a.trade.sync(a.accessFor);
  assert.equal(a.trade.view().trades[0].stage, 'waiting');
  assert.equal(server.trades.size, 1);
});

test('a lost answer is asked again, and the Pokémon is in the pool once', async t => {
  const server = fakeServer();
  const a = player(t, server, { trainerId: A_ID, party: [UMBREON, MAKUHITA] });
  server.failNext('lost');
  await a.trade.offer(a.access, { area: 'party', box: 0, slot: 1 });
  assert.equal(a.trade.view().trades[0].stage, 'taken');
  await a.trade.sync(a.accessFor);
  assert.equal(a.trade.view().trades[0].stage, 'waiting');
  assert.equal(server.trades.size, 1);
});

test('a launcher that stopped mid-take settles it by looking at the save', async t => {
  const server = fakeServer();
  const a = player(t, server, { trainerId: A_ID, party: [UMBREON, MAKUHITA] });
  // stopped before the save changed: the trade is dropped, the Pokémon stays
  a.trade.state.journal.push({ tradeId: 'f'.repeat(32), game: 'colosseum', pool: 'colosseum', stage: 'taking', trainerName: 'WES', accepts: [],
    sent: { data: MAKUHITA.toString('base64'), record: null, identity: { species: 296, rnd: 2, trainer: A_ID }, place: { area: 'party', box: 0, slot: 1 }, summary: {} } });
  await a.trade.sync(a.accessFor);
  assert.equal(a.trade.view().trades.length, 0);
  assert.deepEqual(a.party(), ['UMBREON', 'MAKUHITA']);
  // stopped after: it is sent
  sp.editCard(a.dir, 'colosseum', ctx => sp.takeFrom(ctx, { species: 296, rnd: 2, trainer: A_ID }));
  a.trade.state.journal.push({ tradeId: 'e'.repeat(32), game: 'colosseum', pool: 'colosseum', stage: 'taking', trainerName: 'WES', accepts: [],
    sent: { data: MAKUHITA.toString('base64'), record: null, identity: { species: 296, rnd: 2, trainer: A_ID }, place: { area: 'party', box: 0, slot: 1 }, summary: {} } });
  await a.trade.sync(a.accessFor);
  assert.equal(a.trade.view().trades[0].stage, 'waiting');
});

test('cancel brings a waiting Pokémon back; one already gone can\'t be', async t => {
  const server = fakeServer();
  const a = player(t, server, { trainerId: A_ID, party: [UMBREON, MAKUHITA] });
  await a.trade.offer(a.access, { area: 'party', box: 0, slot: 1 });
  const id = a.trade.view().trades[0].tradeId;
  const view = await a.trade.cancel(id, a.accessFor);
  assert.equal(view.trades.length, 0);
  assert.equal(view.history[0].returned, true);
  assert.deepEqual(a.party(), ['UMBREON', 'MAKUHITA']);
  // never reached the server (down when sent): comes straight back after the server says it never saw it
  server.failNext('down');
  await a.trade.offer(a.access, { area: 'party', box: 0, slot: 1 });
  await a.trade.cancel(a.trade.view().trades[0].tradeId, a.accessFor);
  assert.deepEqual(a.party(), ['UMBREON', 'MAKUHITA']);
});

test('a received Pokémon waits while its save can\'t be reached, and lands when it can', async t => {
  const server = fakeServer();
  const a = player(t, server, { trainerId: A_ID, party: [UMBREON, MAKUHITA] });
  const b = player(t, server, { trainerId: B_ID, party: [ESPEON, BAYLEEF] });
  await a.trade.offer(a.access, { area: 'party', box: 0, slot: 1 });
  await b.trade.offer(b.access, { area: 'party', box: 0, slot: 1 });
  await a.trade.sync(() => null);
  assert.equal(a.trade.view().trades[0].stage, 'received');
  assert.deepEqual(a.party(), ['UMBREON']);
  await a.trade.sync(a.accessFor);
  assert.deepEqual(a.party(), ['UMBREON', 'BAYLEEF']);
});

test('received Pokémon are checked before they go into a save', () => {
  const ok = { pokemon: { data: BAYLEEF.toString('base64') } };
  assert.equal(checkReceived('colosseum', ok).data.readUInt16BE(0), 153);
  assert.throws(() => checkReceived('colosseum', { pokemon: { data: UMBREON.toString('base64') } }), /isn't a Shadow/);
  assert.throws(() => checkReceived('xd', ok), /damaged/);
  const odd = Buffer.from(BAYLEEF); odd.writeUInt16BE(260, 0);
  assert.throws(() => checkReceived('colosseum', { pokemon: { data: odd.toString('base64') } }), /isn't one this game has/);
});

test('the running game: commands go to it, and only for the card\'s own save', async t => {
  const dir = folder(t), liveDir = path.join(dir, 'live');
  fs.mkdirSync(liveDir);
  const plain = plainSave(A_ID, [UMBREON, MAKUHITA]);
  const writeLive = () => {
    const body = plain.subarray(8), head = Buffer.alloc(0x40);
    head.writeUInt32BE(0x4353544c, 0); head.writeUInt32BE(1, 4); head.writeUInt32BE(0, 8); head.writeUInt32BE(1, 0x0c);
    head.writeUInt32BE(7, 0x10); head.writeUInt32BE(A_ID, 0x14); head.writeUInt32BE(4, 0x18); head.writeUInt32BE(body.length, 0x20);
    fs.writeFileSync(path.join(liveDir, 'live.bin'), Buffer.concat([head, body]));
  };
  writeLive();
  // the game: takes the command at its next frame
  const game = setInterval(() => {
    const file = path.join(liveDir, 'command.txt');
    if (!fs.existsSync(file)) return;
    const [idLine, line] = fs.readFileSync(file, 'utf8').trim().split('\n');
    const words = line.split(' ');
    const ctx = { game: 'colosseum', plain, extra: null };
    let result;
    if (words[0] === 'take') {
      const done = sp.takeFrom(ctx, { species: parseInt(words[4], 16), rnd: parseInt(words[5], 16), trainer: parseInt(words[6], 16) }, { area: words[1], box: Number(words[2]), slot: Number(words[3]) });
      result = done ? `ok ${done.area} ${done.box} ${done.slot}` : 'error missing';
    } else {
      const done = sp.giveTo(ctx, Buffer.from(words[1], 'hex'));
      result = done ? `ok ${done.already ? 'already ' : ''}${done.area} ${done.box} ${done.slot}` : 'error full';
    }
    fs.rmSync(file);
    writeLive();
    fs.writeFileSync(path.join(liveDir, 'result.txt'), `${idLine}\n${result}\n`);
  }, 20);
  t.after(() => clearInterval(game));
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const access = liveAccess({ game: 'colosseum', liveDir, cardTrainerId: A_ID, wait });
  assert.deepEqual(access.read().model.party.filter(Boolean).map(p => p.nickname), ['UMBREON', 'MAKUHITA']);
  const taken = await access.take({ species: 296, rnd: 2, trainer: A_ID }, { area: 'party', box: 0, slot: 1 });
  assert.deepEqual([taken.ok, taken.area, taken.slot], [true, 'party', 1]);
  assert.equal(access.has({ species: 296, rnd: 2, trainer: A_ID }), false);
  const given = await access.give(MAKUHITA);
  assert.deepEqual([given.ok, given.slot], [true, 1]);
  assert.equal((await access.give(MAKUHITA)).already, true);
  // a game playing a new, unsaved game (another trainer) gets no commands
  const other = liveAccess({ game: 'colosseum', liveDir, cardTrainerId: 0x9999, wait });
  await assert.rejects(other.take({ species: 296, rnd: 2, trainer: A_ID }, { area: 'party', box: 0, slot: 1 }), /isn't saved yet/);
  assert.deepEqual(parseResult('id 0123456789abcdef\nerror last-pokemon\n'), { id: '0123456789abcdef', ok: false, code: 'last-pokemon', message: '' });
});
