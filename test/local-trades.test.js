'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const tc = require('../src/trade-convert');
const { LocalTrades } = require('../src/local-trades');
const { Arrivals } = require('../src/arrivals');

const folder = () => fs.mkdtempSync(path.join(os.tmpdir(), 'local-trades-'));
const name = (b, at, text) => [...text].forEach((c, i) => b.writeUInt16BE(c.charCodeAt(0), at + 2 * i));

// A Colosseum Pokémon as a save holds one (trade-convert.test.js)
function colosseum({ species = 64, rnd = 0x12345678, nickname = 'KADABRA', item = 0 } = {}) {
  const b = Buffer.alloc(0x138, 0);
  b.writeUInt16BE(species, 0); b.writeUInt32BE(rnd, 0x04); b.writeUInt32BE(0x0b030202, 0x08);
  b.writeUInt16BE(0x2a, 0x0c); b[0x0e] = 12; b[0x0f] = 4; b[0x10] = 0; b.writeUInt32BE(0xae3b618b, 0x14);
  name(b, 0x18, 'LEO'); name(b, 0x2e, nickname); name(b, 0x44, nickname);
  b.writeUInt32BE(27000, 0x5c); b[0x60] = 30;
  [93, 50].forEach((m, i) => { b.writeUInt16BE(m, 0x78 + 4 * i); b[0x78 + 4 * i + 2] = 10; });
  b.writeUInt16BE(item, 0x88); b.writeUInt16BE(70, 0x8a);
  [80, 40, 35, 100, 60, 95].forEach((v, i) => b.writeUInt16BE(v, 0x8c + 2 * i));
  [31, 2, 30, 31, 17, 31].forEach((v, i) => b.writeUInt16BE(v, 0xa4 + 2 * i));
  b.writeUInt16BE(140, 0xb0); b[0xb2] = 10; b[0xcc] = 1; b[0xcf] = 5;
  b.writeInt32BE(-100, 0xdc);
  return b;
}
const xd = options => tc.convert('colosseum', colosseum(options), { game: 'xd', laterPokemon: true, laterMoves: true, laterItems: true }).bytes;
const anyReceiver = game => ({ game, laterPokemon: true, laterMoves: true, laterItems: true });
const savePokemon = require('../src/save-pokemon');
const atOf = game => (game === 'xd' ? savePokemon.XD.at : savePokemon.COLOSSEUM.at);
const identityOf = (game, b) => ({ species: b.readUInt16BE(0), rnd: b.readUInt32BE(atOf(game).rnd), trainer: b.readUInt32BE(atOf(game).trainer) });

// A save as the trades reach it (shadowtrade.js cardAccess / liveAccess): its party, and how it answers.
function fakeSave(game, pokemon, { mode = 'card', answer = {} } = {}) {
  const party = [...pokemon, ...Array(6 - pokemon.length).fill(null)];
  const same = (b, identity) => { const own = identityOf(game, b); return own.species === identity.species && own.rnd === identity.rnd >>> 0 && own.trainer === identity.trainer >>> 0; };
  const save = {
    party, answer,
    access: {
      game, mode,
      read: () => ({ find: identity => party.find(b => b && same(b, identity)) || null,
        model: { game, trainer: game === 'xd' ? 'MICHAEL' : 'WES', party: party.map((b, slot) => b && { ...identityOf(game, b), key: `${slot}`, area: 'party', box: 0, slot, hp: 10, egg: false, shadow: false }), boxes: [] } }),
      async tradeTake(identity) {
        if (answer.take) return { ok: false, code: answer.take };
        const slot = party.findIndex(b => b && same(b, identity));
        if (slot < 0) return { ok: false, code: 'missing' };
        party.splice(slot, 1); party.push(null);
        return { ok: true, area: 'party', box: 0, slot };
      },
      async tradeGive(bytes) {
        if (answer.give) return { ok: false, code: answer.give };
        const slot = party.indexOf(null);
        party[slot] = Buffer.from(bytes);
        return { ok: true, area: 'party', box: 0, slot };
      },
      has: identity => party.some(b => b && same(b, identity))
    }
  };
  return save;
}

function make({ dir = folder(), saves, arrivals = null }) {
  return new LocalTrades({ folder: dir, accessFor: game => saves[game]?.access || null, receiverFor: anyReceiver, arrivals,
    find: (read, identity) => read.find(identity) });
}

test('a Pokémon of each save trades places, each made the other game\'s, and each game is told what came', async () => {
  const dir = folder();
  const saves = { colosseum: fakeSave('colosseum', [colosseum(), colosseum({ species: 197, rnd: 7, nickname: 'UMBREON' })]),
    xd: fakeSave('xd', [xd({ species: 25, rnd: 9, nickname: 'PIKACHU' }), xd({ species: 196, rnd: 11, nickname: 'ESPEON' })]) };
  const arrivals = new Arrivals({ folder: path.join(dir, 'arrivals') });
  const trades = make({ dir, saves, arrivals });
  trades.open();
  trades.pick('colosseum', { area: 'party', box: 0, slot: 0 });
  trades.pick('xd', { area: 'party', box: 0, slot: 0 });
  const before = trades.view('colosseum');
  assert.equal(before.canTrade, true);
  assert.equal(before.picks.colosseum.evolvesInto, 65, 'Kadabra evolves when it reaches XD');
  assert.equal(before.picks.xd.summary.nickname, 'PIKACHU');
  await trades.trade();
  assert.deepEqual(saves.colosseum.party.filter(Boolean).map(b => b.readUInt16BE(0)), [197, 25]);
  assert.deepEqual(saves.xd.party.filter(Boolean).map(b => b.readUInt16BE(0)), [196, 64]);
  assert.equal(saves.xd.party[1].length, 0xc4, 'XD\'s own layout');
  const waiting = arrivals.pending();
  assert.deepEqual(waiting.map(each => [each.game, each.kind, each.from, each.evolvesInto]).sort(),
    [['colosseum', 'local', 'your XD save', 0], ['xd', 'local', 'your Colosseum save', 65]]);
  const after = trades.view('colosseum');
  assert.equal(after.trade, null);
  assert.equal(after.last.sides.length, 2);
  assert.equal(new LocalTrades({ folder: dir }).state.journal.length, 0, 'nothing left in the journal');
  // XD shows it, evolved
  const xdSide = waiting.find(each => each.game === 'xd');
  trades.arrived(xdSide.tradeId, { ok: true, evolved: 65 });
  assert.equal(trades.view('xd').history[0].sides.find(side => side.game === 'xd').evolved, true);
});

test('a running game that can\'t trade now calls it off before anything moves', async () => {
  const saves = { colosseum: fakeSave('colosseum', [colosseum(), colosseum({ species: 197, rnd: 7 })], { mode: 'live', answer: { take: 'timeout' } }),
    xd: fakeSave('xd', [xd({ species: 25, rnd: 9 }), xd({ species: 196, rnd: 11 })]) };
  const trades = make({ saves });
  trades.open();
  trades.pick('colosseum', { area: 'party', box: 0, slot: 0 });
  trades.pick('xd', { area: 'party', box: 0, slot: 0 });
  await assert.rejects(trades.trade(), /didn't reach a moment/);
  assert.equal(saves.colosseum.party.filter(Boolean).length, 2);
  assert.equal(saves.xd.party.filter(Boolean).length, 2);
  assert.equal(trades.state.journal.length, 0);
  assert.equal(trades.view('colosseum').canTrade, true, 'the picks stay, to try again');
});

test('when the second save can\'t give its Pokémon, the first goes back where it was', async () => {
  const saves = { colosseum: fakeSave('colosseum', [colosseum(), colosseum({ species: 197, rnd: 7 })], { mode: 'live' }),
    xd: fakeSave('xd', [xd({ species: 25, rnd: 9 }), xd({ species: 196, rnd: 11 })], { answer: { take: 'save' } }) };
  const trades = make({ saves });
  trades.open();
  trades.pick('colosseum', { area: 'party', box: 0, slot: 0 });
  trades.pick('xd', { area: 'party', box: 0, slot: 0 });
  await trades.trade();
  assert.deepEqual(saves.colosseum.party.filter(Boolean).map(b => b.readUInt16BE(0)).sort((a, b) => a - b), [64, 197]);
  assert.equal(saves.xd.party.filter(Boolean).length, 2);
  assert.equal(trades.state.history[0].returned, true);
});

test('a trade cut short is finished from the journal the next time', async () => {
  const dir = folder();
  const saves = { colosseum: fakeSave('colosseum', [colosseum(), colosseum({ species: 197, rnd: 7 })]),
    xd: fakeSave('xd', [xd({ species: 25, rnd: 9 }), xd({ species: 196, rnd: 11 })], { mode: 'live' }) };
  const trades = make({ dir, saves });
  trades.open();
  trades.pick('colosseum', { area: 'party', box: 0, slot: 0 });
  trades.pick('xd', { area: 'party', box: 0, slot: 0 });
  saves.xd.answer.give = 'timeout';   // the running game went into a battle before it got its Pokémon
  await trades.trade();
  assert.equal(trades.state.journal.length, 1);
  assert.match(trades.view('xd').trade.message, /didn't reach a moment/);
  assert.equal(saves.colosseum.party.filter(Boolean).length, 2, 'Colosseum already has its Pokémon');
  // the launcher closed; the game is closed now, so the card takes it
  delete saves.xd.answer.give;
  saves.xd.access.mode = 'card';
  const again = make({ dir, saves });
  await again.sync();
  assert.equal(again.state.journal.length, 0);
  assert.deepEqual(saves.xd.party.filter(Boolean).map(b => b.readUInt16BE(0)), [196, 64]);
});

test('a pick the other game can\'t take says why, and can\'t be traded', async () => {
  const saves = { colosseum: fakeSave('colosseum', [colosseum({ species: 420, rnd: 3 }), colosseum({ species: 197, rnd: 7 })]),
    xd: fakeSave('xd', [xd({ species: 25, rnd: 9 }), xd({ species: 196, rnd: 11 })]) };
  const trades = new LocalTrades({ folder: folder(), accessFor: game => saves[game].access, find: (read, identity) => read.find(identity),
    receiverFor: game => ({ game, laterPokemon: false, laterMoves: false, laterItems: false }) });
  trades.open();
  trades.pick('colosseum', { area: 'party', box: 0, slot: 0 });
  trades.pick('xd', { area: 'party', box: 0, slot: 0 });
  const view = trades.view('colosseum');
  assert.ok(view.picks.colosseum.problems.length);
  assert.equal(view.canTrade, false);
  await assert.rejects(trades.trade(), /XD can't take it/);
});

test('the last Pokémon able to battle stays', () => {
  const saves = { colosseum: fakeSave('colosseum', [colosseum()]), xd: fakeSave('xd', [xd({ species: 25, rnd: 9 })]) };
  const trades = make({ saves });
  trades.open();
  assert.throws(() => trades.pick('colosseum', { area: 'party', box: 0, slot: 0 }), /last Pokémon/);
});

test('it opens only with both saves there', () => {
  const trades = new LocalTrades({ folder: folder(), accessFor: game => (game === 'xd' ? null : fakeSave('colosseum', [colosseum()]).access),
    unavailable: game => `Play ${game} once.` });
  assert.throws(() => trades.open(), /Play xd once/);
  assert.equal(trades.view('colosseum').saves.xd.notice, 'Play xd once.');
});
