'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const gciSave = require('../src/gci-save');
const pcBoxes = require('../src/pc-boxes');
const xdSave = require('../src/xd-save');
const sp = require('../src/save-pokemon');

const utf16 = (bytes, offset, value) => Buffer.from(value, 'utf16le').swap16().copy(bytes, offset);
const OT = 0xae3b618b;

function colosseumPokemon({ species, rnd = 1, trainer = OT, nickname = 'MON', level = 30, hp = 50, egg = false, shadowId = 0, heart = -100 }) {
  const p = Buffer.alloc(0x138);
  p.writeUInt16BE(species, 0); p.writeUInt32BE(rnd, 4); p.writeUInt32BE(trainer, 0x14); utf16(p, 0x2e, nickname);
  p[0x60] = level; p.writeUInt16BE(hp, 0x8a); p.writeUInt16BE(hp, 0x8c); p[0xcb] = egg ? 1 : 0;
  p.writeUInt16BE(shadowId, 0xd8); p.writeInt32BE(heart, 0xdc);
  return p;
}

// A Colosseum card: copies (newest first) of { party, boxes: { 'box:slot': pokemon }, flags, count }, each a slot.
function colosseumCard(dir, copies, extra = null) {
  const data = Buffer.alloc(gciSave.SIZE);
  for (let index = 0; index < 3; index++) {
    const copy = copies[index];
    const plain = Buffer.alloc(gciSave.SLOT_SIZE);
    plain[0] = 1; plain[1] = 1;
    if (copy) {
      plain.writeInt32BE(copy.count ?? 3 - index, 4);
      utf16(plain, 0x78, 'WES');
      plain.writeUInt32BE(OT, 0xa4);
      (copy.party || []).forEach((p, i) => p.copy(plain, 0xa8 + i * 0x138));
      for (let box = 0; box < 3; box++) utf16(plain, 0xb90 + box * 0x24a4, `BOX${box + 1}`);
      for (const [where, p] of Object.entries(copy.boxes || {})) {
        const [box, slot] = where.split(':').map(Number);
        if (box < 3) p.copy(plain, 0xb90 + box * 0x24a4 + 0x14 + slot * 0x138);
      }
      for (let n = 1; n <= 0x43; n++) plain.writeUInt16BE(20, 0x1b4ac + 0x18 * n + 0x16);  // heart max 20 (x100)
      for (const [kind, ids] of Object.entries(copy.flags || {})) for (const n of ids) {
        const { at, mask } = sp.colosseumFlag(plain, kind, n);
        plain.writeUInt32BE((plain.readUInt32BE(at) | mask) >>> 0, at);
      }
      if (extra) pcBoxes.writeStamp(plain, pcBoxes.fnv64(extra));
    }
    gciSave.scramble(plain).copy(data, gciSave.SLOT_START + index * gciSave.SLOT_SIZE);
  }
  fs.writeFileSync(path.join(dir, 'pokemon_colosseum.dat'), data);
  if (extra) pcBoxes.writeEntries(dir, [{ hash: pcBoxes.fnv64(extra), data: extra }], []);
}

const folder = t => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'colo-savepokemon-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir; };

const UMBREON = colosseumPokemon({ species: 197, rnd: 0x372407cb, nickname: 'UMBREON' });
const ESPEON = colosseumPokemon({ species: 196, rnd: 0x11, nickname: 'ESPEON' });
const MAKUHITA = colosseumPokemon({ species: 296, rnd: 0x1234, nickname: 'MAKUHITA', shadowId: 1, heart: 1500 });
const BAYLEEF = colosseumPokemon({ species: 153, rnd: 0x99, nickname: 'BAYLEEF', shadowId: 2, heart: 2000, trainer: 0x5555 });

test('reads a Colosseum save: party, boxes, Shadow flags and gauges', t => {
  const dir = folder(t);
  colosseumCard(dir, [{ party: [UMBREON, MAKUHITA], boxes: { '1:4': ESPEON }, flags: { met: [1, 5], snagged: [1], purified: [5] } }]);
  const save = sp.readCard(dir, 'colosseum');
  assert.equal(save.trainer, 'WES');
  assert.equal(save.trainerId, OT);
  assert.deepEqual(save.party.filter(Boolean).map(p => p.nickname), ['UMBREON', 'MAKUHITA']);
  assert.equal(save.boxes.length, 3);
  assert.equal(save.boxes[1].name, 'BOX2');
  assert.equal(save.boxes[1].pokemon[4].nickname, 'ESPEON');
  const makuhita = save.party[1];
  assert.equal(makuhita.shadow, true);
  assert.equal(makuhita.shadowId, 1);
  assert.equal(makuhita.heartPercent, 75);
  assert.deepEqual(save.shadows[1], { met: true, snagged: true, purified: false, heartMax: 20 });
  assert.equal(save.shadows[5].purified, true);
  assert.equal(save.shadows[2].met, false);
});

test('only a Shadow Pokémon can go, never an egg, and never the last one that can battle', () => {
  const save = { game: 'colosseum', party: [], boxes: [], shadows: {} };
  const p = (over) => ({ key: Math.random(), area: 'party', egg: false, hp: 10, shadow: true, shadowId: 1, ...over });
  save.party = [p({ shadow: false, key: 'u' }), p({ key: 's' })];
  assert.equal(sp.offerProblem(save, save.party[0]), 'Only Shadow Pokémon can go to Shadowtrade.');
  assert.equal(sp.offerProblem(save, save.party[1]), null);
  save.party = [p({ key: 'a' })];
  assert.match(sp.offerProblem(save, save.party[0]), /last Pokémon/);
  save.party = [p({ key: 'a' }), p({ key: 'b', hp: 0, shadow: false }), p({ key: 'c', egg: true })];
  assert.match(sp.offerProblem(save, save.party[0]), /last Pokémon/, 'a fainted one or an egg doesn\'t count');
  assert.equal(sp.offerProblem(save, { ...save.party[0], area: 'box' }), null, 'from a box it can go');
  assert.match(sp.offerProblem(save, p({ shadowId: 0x30 })), /story/);
  assert.match(sp.offerProblem(save, p({ egg: true })), /Eggs/);
});

test('Colosseum: taking from the party closes the gap in every copy of the save', t => {
  const dir = folder(t);
  colosseumCard(dir, [{ party: [UMBREON, MAKUHITA, ESPEON] }, { party: [UMBREON, MAKUHITA] }]);
  const identity = { species: 296, rnd: 0x1234, trainer: OT };
  const done = sp.editCard(dir, 'colosseum', ctx => sp.takeFrom(ctx, identity, { area: 'party', box: 0, slot: 1 }));
  assert.equal(done.area, 'party');
  assert.equal(done.slot, 1);
  assert.equal(done.bytes.readUInt16BE(0), 296);
  const { copies } = sp.cardCopies(dir, 'colosseum');
  assert.equal(copies.length, 2);
  for (const copy of copies) assert.deepEqual(sp.model(copy.ctx).party.map(p => p?.nickname ?? null).filter(Boolean), copy.count === 3 ? ['UMBREON', 'ESPEON'] : ['UMBREON']);
  // the card still opens as the game opens it
  assert.equal(gciSave.newestPlain(fs.readFileSync(path.join(dir, 'pokemon_colosseum.dat'))).count, 3);
});

test('Colosseum: giving fills the party, then the boxes, marks the id snagged and keeps the gauge in range', t => {
  const dir = folder(t);
  colosseumCard(dir, [{ party: [UMBREON] }]);
  const big = Buffer.from(BAYLEEF); big.writeInt32BE(9000, 0xdc);
  const done = sp.editCard(dir, 'colosseum', ctx => sp.giveTo(ctx, big));
  assert.deepEqual([done.area, done.slot], ['party', 1]);
  let save = sp.readCard(dir, 'colosseum');
  assert.equal(save.party[1].nickname, 'BAYLEEF');
  assert.equal(save.party[1].trainer, 0x5555, 'the original trainer stays');
  assert.equal(save.party[1].heart, 2000, 'within this save\'s gauge for the id');
  assert.equal(save.shadows[2].snagged, true);
  assert.equal(save.shadows[2].purified, false);
  assert.equal(sp.editCard(dir, 'colosseum', ctx => sp.giveTo(ctx, big)).already, true, 'a repeat changes nothing');
  colosseumCard(dir, [{ party: [UMBREON, ESPEON, UMBREON, ESPEON, UMBREON, ESPEON].map((p, i) => { const c = Buffer.from(p); c.writeUInt32BE(i + 100, 4); return c; }) }]);
  assert.deepEqual(['box', 0, 0], Object.values(sp.editCard(dir, 'colosseum', ctx => sp.giveTo(ctx, BAYLEEF))).slice(0, 3));
  save = sp.readCard(dir, 'colosseum');
  assert.equal(save.boxes[0].pokemon[0].nickname, 'BAYLEEF');
});

test('Colosseum: boxes 4 to 10 are edited in the .boxes file, named by a new stamp', t => {
  const dir = folder(t);
  const extra = Buffer.alloc(7 * 0x24a4);
  MAKUHITA.copy(extra, 2 * 0x24a4 + 0x14 + 7 * 0x138);   // box 6, slot 8
  colosseumCard(dir, [{ party: [UMBREON] }], extra);
  let save = sp.readCard(dir, 'colosseum');
  assert.equal(save.boxes.length, 10);
  assert.equal(save.boxes[5].pokemon[7].nickname, 'MAKUHITA');
  const done = sp.editCard(dir, 'colosseum', ctx => sp.takeFrom(ctx, { species: 296, rnd: 0x1234, trainer: OT }, { area: 'box', box: 5, slot: 7 }));
  assert.deepEqual([done.area, done.box, done.slot], ['box', 5, 7]);
  save = sp.readCard(dir, 'colosseum');
  assert.equal(save.boxes.length, 10, 'the new stamp names boxes the file has');
  assert.equal(save.boxes[5].pokemon[7], null);
  assert.equal(pcBoxes.extraBoxPokemon(dir, gciSave.newestPlain(fs.readFileSync(path.join(dir, 'pokemon_colosseum.dat'))).plain), 0);
});

test('Colosseum: a save takes story ids it hasn\'t purified and doesn\'t hold', () => {
  const shadows = Object.fromEntries(sp.COLOSSEUM_STORY_IDS.map(n => [n, { purified: n === 3 }]));
  const save = { game: 'colosseum', party: [{ shadow: true, shadowId: 1 }, { shadow: false, shadowId: 2 }], boxes: [{ pokemon: [{ shadow: true, shadowId: 4 }] }], shadows };
  const accepts = sp.shadowAccepts(save);
  assert.ok(!accepts.includes(1) && !accepts.includes(4), 'held');
  assert.ok(!accepts.includes(3), 'purified');
  assert.ok(accepts.includes(2) && accepts.includes(0x43));
  assert.ok(!accepts.includes(0x30), 'e-Reader ids never');
});

// ---- XD ----

const XD_OT = 0xd183a6d5;
function xdPokemon({ species, rnd = 7, trainer = XD_OT, nickname = 'EEVEE', hp = 30, shadowId = 0 }) {
  const p = Buffer.alloc(0xc4);
  p.writeUInt16BE(species, 0); p.writeUInt16BE(hp, 4); p[0x11] = 10; p.writeUInt32BE(trainer, 0x24); p.writeUInt32BE(rnd, 0x28);
  utf16(p, 0x4e, nickname); p.writeUInt16BE(hp, 0x90); p.writeUInt16BE(shadowId, 0xba);
  return p;
}
const SECTIONS = { hero: 0x5000, pcBox: 0x6000, darkPokemon: 0x100, dayCare: 0x12000, chamber: 0x13000 };
function xdCard(dir, { party = [], boxes = {}, records = {} }) {
  const plain = Buffer.alloc(xdSave.PACK_SIZE);
  [0x1234, 0xbeef, 0x42, 0xf00d].forEach((key, i) => plain.writeUInt16BE(key, i * 2));
  const place = (table, at) => { plain.writeUInt16BE(at & 0xffff, table); plain.writeUInt16BE(at >>> 16, table + 2); };
  place(0x3c, SECTIONS.hero); place(0x40, SECTIONS.pcBox); place(0x54, SECTIONS.darkPokemon); place(0x48, SECTIONS.dayCare); place(0x70, SECTIONS.chamber);
  const at = s => xdSave.BODY + SECTIONS[s];
  utf16(plain, at('hero'), 'MICHAEL');
  plain.writeUInt32BE(XD_OT, at('hero') + 0x2c);
  plain.writeUInt32BE(5, at('hero') + 0x938);
  party.forEach((p, i) => p.copy(plain, at('hero') + 0x30 + i * 0xc4));
  for (let box = 0; box < 8; box++) utf16(plain, at('pcBox') + box * 0x170c, `BOX ${box + 1}`);
  for (const [where, p] of Object.entries(boxes)) { const [box, slot] = where.split(':').map(Number); p.copy(plain, at('pcBox') + box * 0x170c + 0x14 + slot * 0xc4); }
  for (const [n, r] of Object.entries(records)) {
    const rec = at('darkPokemon') + Number(n) * 0x48;
    plain.writeUInt32BE(((r.status << 29) | ((r.where || 0) << 15)) >>> 0, rec);
    plain.writeInt32BE(r.heart ?? 0, rec + 0x24);
    plain.writeUInt16BE(r.species ?? 0, rec + 0x1a);
    plain.writeUInt16BE(Number(n), rec + 0x3e);
    plain[rec + 0x13] = r.index ?? 0;
  }
  const card = Buffer.alloc(43 * 0x2000);
  for (const [i, start] of xdSave.SLOTS.entries()) {
    card[start] = 1; card[start + 1] = 1; card[start + 2] = 1;
    card.writeInt32BE(10 - i, start + 4);
    xdSave.encipher(plain).copy(card, start + xdSave.PACK);
  }
  fs.writeFileSync(path.join(dir, 'PokemonXD.dat'), card);
}

const EEVEE = xdPokemon({ species: 133 });
const TEDDIURSA = xdPokemon({ species: 216, rnd: 0x77, nickname: 'TEDDIURSA', shadowId: 1 });

test('reads an XD save, its Shadow records and the rule for what it takes', t => {
  const dir = folder(t);
  xdCard(dir, { party: [EEVEE, TEDDIURSA], boxes: { '2:3': xdPokemon({ species: 25, rnd: 3, nickname: 'PIKACHU' }) },
    records: { 1: { status: 3, where: 1, heart: 1200, species: 216 }, 2: { status: 2, species: 217 }, 3: { status: 3, where: 5 }, 4: { status: 4 }, 5: { status: 1 } } });
  const save = sp.readCard(dir, 'xd');
  assert.equal(save.trainer, 'MICHAEL');
  assert.equal(save.boxes.length, 8);
  assert.equal(save.boxes[2].pokemon[3].nickname, 'PIKACHU');
  assert.equal(save.party[1].shadow, true);
  assert.equal(save.party[1].heart, 1200);
  assert.equal(sp.offerProblem(save, save.party[1]), null);
  assert.deepEqual(sp.shadowAccepts(save), [2, 3], 'missed, or traded away with none left; not held, purified or only met');
});

test('XD: a trade out marks the record traded away; one in gets a merged record', t => {
  const dir = folder(t);
  xdCard(dir, { party: [EEVEE, TEDDIURSA], records: { 1: { status: 3, where: 1, heart: 1200, species: 216 }, 2: { status: 2, species: 217, index: 9 } } });
  const out = sp.editCard(dir, 'xd', ctx => sp.takeFrom(ctx, { species: 216, rnd: 0x77, trainer: XD_OT }, { area: 'party', box: 0, slot: 1 }));
  assert.equal(out.record.readInt32BE(0x24), 1200);
  let save = sp.readCard(dir, 'xd');
  assert.deepEqual(save.party.filter(Boolean).map(p => p.nickname), ['EEVEE']);
  assert.deepEqual(save.shadows[1], { status: 3, where: 5, species: 216 });
  // another player's Ursaring (id 2) arrives, with their record
  const theirs = xdPokemon({ species: 217, rnd: 0x88, trainer: 0x4444, nickname: 'URSARING', shadowId: 2 });
  const record = Buffer.alloc(0x48); record.writeUInt32BE((3 << 29 | 1 << 22 | 4 << 15) >>> 0, 0); record.writeInt32BE(777, 0x24); record[0x40] = 3;
  const into = sp.editCard(dir, 'xd', ctx => sp.giveTo(ctx, theirs, record));
  assert.deepEqual([into.area, into.slot], ['party', 1]);
  save = sp.readCard(dir, 'xd');
  assert.equal(save.party[1].nickname, 'URSARING');
  assert.equal(save.party[1].shadow, true);
  assert.equal(save.party[1].heart, 777, 'their heart gauge');
  assert.deepEqual(save.shadows[2], { status: 3, where: 1, species: 217 });
  const { copies } = sp.cardCopies(dir, 'xd');
  const rec = copies[0].ctx.plain.subarray(xdSave.BODY + SECTIONS.darkPokemon + 2 * 0x48);
  assert.equal(rec[0x40], 3, 'Hyper chance pattern');
  assert.ok(rec.readUInt32BE(0) & (1 << 22), 'Hyper Mode kept');
  assert.equal((rec.readUInt32BE(0) >>> 23) & 3, 2, 'marked as traded in');
  assert.equal(rec[0x13], 9, 'met before: its order kept');
  assert.equal(copies.length, 2, 'both copies changed and valid');
});

test('the real saves, when they are here, read and edit back cleanly', t => {
  const fixture = '/mnt/10tbhdd/colosseum-port/xd-port-work/fixtures/story-7';
  if (!fs.existsSync(path.join(fixture, 'PokemonXD.dat'))) return t.skip('no fixture');
  const dir = folder(t);
  fs.copyFileSync(path.join(fixture, 'PokemonXD.dat'), path.join(dir, 'PokemonXD.dat'));
  const before = sp.readCard(dir, 'xd');
  const teddiursa = before.party.find(p => p?.shadow);
  assert.ok(teddiursa);
  const out = sp.editCard(dir, 'xd', ctx => sp.takeFrom(ctx, teddiursa, teddiursa));
  sp.editCard(dir, 'xd', ctx => sp.giveTo(ctx, out.bytes, out.record));
  const after = sp.readCard(dir, 'xd');
  assert.deepEqual(after.party.map(p => p?.key ?? null), before.party.map(p => p?.key ?? null));
  assert.equal(after.party.find(p => p?.shadow).heart, teddiursa.heart);
});

test('what a save takes counts the Pokémon it is sending as gone', () => {
  const teddiursa = { key: 't', area: 'party', box: 0, slot: 1, shadow: true, shadowId: 1 };
  const xd = { game: 'xd', party: [{ key: 'e', shadowId: 0 }, teddiursa], boxes: [], shadows: { 1: { status: 3, where: 1 }, 2: { status: 1 } } };
  assert.deepEqual(sp.shadowAccepts(xd), []);
  assert.deepEqual(sp.acceptsAfterTaking(xd, null, teddiursa), [1], 'traded away: one can come back');
  const shadows = Object.fromEntries(sp.COLOSSEUM_STORY_IDS.map(n => [n, { purified: false }]));
  const colosseum = { game: 'colosseum', party: [{ key: 'u', shadowId: 0 }, { ...teddiursa }], boxes: [], shadows };
  assert.ok(!sp.shadowAccepts(colosseum).includes(1));
  assert.ok(sp.acceptsAfterTaking(colosseum, null, teddiursa).includes(1));
});
