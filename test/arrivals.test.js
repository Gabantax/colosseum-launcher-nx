'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Arrivals } = require('../src/arrivals');
const { arrivalLines, statsFor } = require('../src/arrival-show');
const { parseResult } = require('../src/shadowtrade');

const folder = () => fs.mkdtempSync(path.join(os.tmpdir(), 'arrivals-'));

const KADABRA = { game: 'colosseum', species: 64, nickname: 'KADABRA', level: 30, personality: 0x12345678, shiny: false, nature: 5, abilitySlot: 0,
  item: 0, heldKeyItem: false, hp: 60, stats: [60, 30, 30, 80, 50, 70], ivs: [18, 19, 17, 27, 2, 17], evs: [0, 0, 0, 0, 0, 0],
  otName: 'AAAAA', otId: 44245, moves: [{ id: 60, pp: 20, ppUps: 0 }, { id: 115, pp: 20, ppUps: 0 }] };
const NAMES = {
  species: id => ({ 64: { name: 'Kadabra', types: ['Psychic'], stats: [40, 35, 30, 120, 70, 105], gender: 63, abilities: [{ slot: 0, name: 'Synchronize' }] },
    65: { name: 'Alakazam', types: ['Psychic'], stats: [55, 50, 45, 135, 85, 120], gender: 63, abilities: [{ slot: 0, name: 'Synchronize' }] } })[id] || null,
  move: id => ({ 60: { name: 'Psybeam', type: 'Psychic', pp: 20 }, 115: { name: 'Reflect', type: 'Psychic', pp: 20 } })[id] || null,
  item: () => null
};

test('the card lines carry the Pokémon and what it becomes', () => {
  const lines = arrivalLines({ summary: KADABRA, names: NAMES, kind: 'trade', from: 'Abe', evolvesInto: 65 });
  const get = key => lines.find(line => line.startsWith(`show ${key} `))?.slice(key.length + 6);
  assert.equal(get('nickname'), 'KADABRA');
  assert.equal(get('from'), 'Abe');
  assert.equal(get('nature'), 'Bold');
  assert.equal(get('nature-effect'), '2 1');   // +Def −Atk
  assert.equal(get('ability'), 'Synchronize');
  assert.equal(get('evolved-species'), 'Alakazam');
  assert.deepEqual(lines.filter(line => line.startsWith('show move ')), ['show move Psybeam|Psychic|20|20', 'show move Reflect|Psychic|20|20']);
  const stats = get('evolved-stats').split(' ').map(Number);
  assert.deepEqual(stats, statsFor([55, 50, 45, 135, 85, 120], KADABRA));
  assert.ok(lines.every(line => !line.includes('\n')));
});

test('a value with a newline stays one line', () => {
  const lines = arrivalLines({ summary: { ...KADABRA, nickname: 'A\nB' }, names: NAMES, from: 'x\ny' });
  assert.ok(lines.includes('show nickname A B'));
  assert.ok(lines.includes('show from x y'));
});

test('the arrive result says where, whether it evolved, and the PC', () => {
  const r = parseResult('id 0123456789abcdef\nok party 0 2 shown evolved 65 pc\n');
  assert.deepEqual([r.ok, r.area, r.box, r.slot, r.evolved, r.pc], [true, 'party', 0, 2, 65, true]);
  const plain = parseResult('id 0123456789abcdef\nok box 3 7 shown\n');
  assert.deepEqual([plain.area, plain.box, plain.slot, plain.evolved, plain.pc], ['box', 3, 7, 0, false]);
});

test('arrivals wait for a running game, are shown one at a time, and are kept until shown', async () => {
  const dir = folder(), done = [];
  const make = () => new Arrivals({ folder: dir, describe: entry => ({ lines: [`show nickname ${entry.from}`], art: [] }), onDone: (entry, result) => done.push([entry.from, result.evolved]) });
  const arrivals = make();
  arrivals.add({ game: 'colosseum', kind: 'trade', from: 'Abe', identity: { species: 64, rnd: 1, trainer: 2 }, place: { area: 'party', box: 0, slot: 2 }, evolvesInto: 65, tradeId: 't1' });
  arrivals.add({ game: 'colosseum', kind: 'shadowtrade', from: 'Bea', identity: { species: 300, rnd: 3, trainer: 4 }, place: { area: 'box', box: 1, slot: 0 }, tradeId: 't2' });
  assert.equal(arrivals.add({ game: 'colosseum', kind: 'trade', from: 'again', tradeId: 't1' }), null, 'a trade is queued once');
  await arrivals.deliver('colosseum', { mode: 'card' });
  assert.equal(make().pending('colosseum').length, 2, 'a closed game keeps them, in the file');
  const sent = [];
  let answer = { ok: false, code: 'timeout' };
  const live = { mode: 'live', arrive: async (identity, place, options) => { sent.push([identity.species, place.area, options.evolve, options.lines[0]]); return answer; } };
  await arrivals.deliver('colosseum', live);
  assert.equal(sent.length, 1, 'stops at one the game couldn\'t show now');
  assert.equal(arrivals.pending().length, 2);
  answer = { ok: true, evolved: 65 };
  await arrivals.deliver('colosseum', live);
  assert.deepEqual(sent.slice(1), [[64, 'party', true, 'show nickname Abe'], [300, 'box', false, 'show nickname Bea']]);
  assert.deepEqual(done, [['Abe', 65], ['Bea', 65]]);
  assert.equal(make().pending().length, 0);
});

test('a game without arrive still gets its trade evolution', async () => {
  const dir = folder(), done = [];
  const arrivals = new Arrivals({ folder: dir, onDone: (entry, result) => done.push(result.evolved) });
  arrivals.add({ game: 'xd', kind: 'trade', from: 'Abe', identity: { species: 64, rnd: 1, trainer: 2 }, place: { area: 'party', box: 0, slot: 1 }, evolvesInto: 65, tradeId: 't' });
  arrivals.add({ game: 'xd', kind: 'shadowtrade', from: 'Bea', identity: { species: 300, rnd: 3, trainer: 4 }, place: null, tradeId: 'u' });
  const evolved = [];
  await arrivals.deliver('xd', { mode: 'live', evolve: async (identity, place) => { evolved.push(place.slot); return { ok: true, area: 'evolved' }; } });
  assert.deepEqual(evolved, [1]);
  assert.deepEqual(done, [65, 0]);
});
