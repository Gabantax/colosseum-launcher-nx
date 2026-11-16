'use strict';

// The Pokémon in a save, Colosseum's or XD's: the party and every PC box, as the Pokémon page shows them, and the two
// changes Shadowtrade makes (src/shadowtrade.js): taking a Shadow Pokémon out, and putting the one received in.
//
// A save is read either from its card file (the game closed) or from the game's own live copy (live.bin, written by
// the running game in COLO_SHADOWTRADE_DIR: host/shadowtrade.c). Both give the same model. Only the card file is ever
// edited here, and only with the game closed: while it runs, the game makes the change itself (a command) and saves.
//
// Colosseum's save (gci-save.js): three scrambled copies, each a slot whose plain bytes hold the trainer at 0x78, its
// id at 0xA4, the party at 0xA8 (6 Pokémon of 0x138 bytes) and boxes 1 to 3 at 0xB90 (0x24A4 each: a 0x14-byte name,
// then 30 Pokémon). Boxes 4 to 10 are in pokemon_colosseum.boxes beside it (pc-boxes.js). A Shadow Pokémon keeps its
// Shadow id at +0xD8 and its heart gauge (x100) at +0xDC, -100 once purified; the save keeps three flags for each id
// (met in battle, snagged, purified) and the heart gauge's size (research: the decomp's darkPokemon functions).
//
// XD's save (xd-save.js): two enciphered copies of a pack of shuffled sections. A Pokémon is 0xC4 bytes and keeps only
// its Shadow id (+0xBA); the heart gauge, Hyper Mode and the Shadow's story state (not met, met, missed, snagged,
// purified, and where it is) are the save's record for that id (128 of 0x48 bytes), shared by every copy of that id.

const fs = require('node:fs');
const path = require('node:path');
const gciSave = require('./gci-save');
const pcBoxes = require('./pc-boxes');
const xdSave = require('./xd-save');

const COLOSSEUM = {
  file: 'pokemon_colosseum.dat', size: 0x138, trainerName: 0x78, trainerId: 0xa4, party: 0xa8, boxes: 0xb90, boxSize: 0x24a4,
  retailBoxes: 3, extraBoxes: 7, boxName: 0x14, perBox: 30,
  at: { species: 0x00, rnd: 0x04, ball: 0x0f, trainer: 0x14, nickname: 0x2e, level: 0x60, moves: 0x78, item: 0x88, hp: 0x8a,
    maxHp: 0x8c, egg: 0xcb, shadow: 0xd8, heart: 0xdc }
};
// The flags the save keeps for each Shadow id: flag (first id's word in the slot, its bit), each next id the next bit.
const COLOSSEUM_FLAGS = { met: [0x1befc, 20], snagged: [0x1c07c, 20], purified: [0x1bef0, 20] };
// The day care's Pokémon (save kind 11, proven against the game in a run).
const COLOSSEUM_DAYCARE_POKEMON = 0x8178;
const COLOSSEUM_HEART_MAX = n => 0x1b4ac + 0x18 * n + 0x16;
// The story's Shadow Pokémon: the others are e-Reader slots, which this game has no data for.
const COLOSSEUM_STORY_IDS = [...Array.from({ length: 44 }, (_, i) => i + 1), 0x37, 0x38, 0x39, 0x43];

const XD = {
  file: 'PokemonXD.dat', size: 0xc4, boxes: 8, boxSize: 0x170c, boxName: 0x14, perBox: 30, partyAt: 0x30, heroId: 0x2c,
  meetCount: 0x938, recordSize: 0x48, records: 128,
  at: { species: 0x00, item: 0x02, hp: 0x04, ball: 0x0f, level: 0x11, flags: 0x1d, trainer: 0x24, rnd: 0x28, nickname: 0x4e,
    moves: 0x80, maxHp: 0x90, shadow: 0xba },
  // where each section is in the game's memory (live.bin), as the pack's table gives it for a card copy
  ram: { hero: 0x140, pcBox: 0xad0, dayCare: 0xc790, darkPokemon: 0xe380, chamber: 0x1d690 }
};
// XD's record: status in the top 3 bits (0 not met, 1 met, 2 missed, 3 snagged, 4 purified); where it is in bits
// 17-15 of the first word (1 party, 2 box, 3 Purify Chamber, 4 day care, 5 traded away, 6 released), with a sub-id at
// 0x11; the "new" mark at bit 21, snatchFromWho at bits 24-23, its order met at 0x13, its own id at 0x3E.
const XD_STATUS = { notMet: 0, met: 1, missed: 2, snagged: 3, purified: 4 };
const XD_WHERE = { party: 1, box: 2, chamber: 3, dayCare: 4, traded: 5, released: 6 };
const XD_LAST_ID = 0x53, XD_LUGIA = 73;
// The day care's Pokémon (SaveSodateya) and the Purify Chamber's 9 chambers of 5 Pokémon (4 around + the Shadow one).
const XD_DAYCARE_POKEMON = 0x08, XD_CHAMBER = { count: 9, size: 0x3d8, pokemon: 5 };

const PARTY_SIZE = 6;

function units(buffer, at, length = 10) {
  const out = [];
  for (let i = 0; i < length; i++) {
    const unit = buffer.readUInt16BE(at + i * 2);
    if (!unit) break;
    out.push(unit);
  }
  return String.fromCharCode(...out);
}

const isShiny = (trainer, rnd) => ((trainer >>> 16) ^ (trainer & 0xffff) ^ (rnd >>> 16) ^ (rnd & 0xffff)) < 8;
const keyOf = (species, rnd, trainer) => `${species}:${rnd >>> 0}:${trainer >>> 0}`;

// ---- Colosseum ----

function colosseumFlag(plain, kind, n) {
  const [word, first] = COLOSSEUM_FLAGS[kind], bit = first + n - 1;
  const at = word + 4 * (bit >> 5), mask = (1 << (bit & 31)) >>> 0;
  return { at, mask, set: ((plain.readUInt32BE(at) & mask) >>> 0) !== 0 };
}

function setColosseumFlag(plain, kind, n) {
  const { at, mask } = colosseumFlag(plain, kind, n);
  plain.writeUInt32BE((plain.readUInt32BE(at) | mask) >>> 0, at);
}

function colosseumPokemon(bytes, extra = {}) {
  const at = COLOSSEUM.at, species = bytes.readUInt16BE(at.species);
  if (!species) return null;
  const rnd = bytes.readUInt32BE(at.rnd), trainer = bytes.readUInt32BE(at.trainer);
  const shadowId = bytes.readUInt16BE(at.shadow), heart = bytes.readInt32BE(at.heart);
  return {
    species, rnd, trainer, key: keyOf(species, rnd, trainer),
    nickname: units(bytes, at.nickname), level: bytes[at.level], item: bytes.readUInt16BE(at.item),
    hp: bytes.readUInt16BE(at.hp), maxHp: bytes.readUInt16BE(at.maxHp), ball: bytes[at.ball],
    moves: Array.from({ length: 4 }, (_, i) => bytes.readUInt16BE(at.moves + i * 4)).filter(Boolean),
    egg: bytes[at.egg] !== 0, shiny: isShiny(trainer, rnd),
    shadowId, shadow: shadowId !== 0 && heart >= 0, heart: shadowId !== 0 && heart >= 0 ? heart : null, ...extra
  };
}

// Where each Pokémon of a Colosseum save is: { bytes, area, box, slot } for every slot, empty or not.
function colosseumSlots(ctx) {
  const { plain, extra } = ctx, out = [];
  for (let slot = 0; slot < PARTY_SIZE; slot++) {
    const at = COLOSSEUM.party + slot * COLOSSEUM.size;
    out.push({ area: 'party', box: 0, slot, buffer: plain, at });
  }
  const boxes = COLOSSEUM.retailBoxes + (extra ? COLOSSEUM.extraBoxes : 0);
  for (let box = 0; box < boxes; box++) {
    const [buffer, start] = box < COLOSSEUM.retailBoxes ? [plain, COLOSSEUM.boxes + box * COLOSSEUM.boxSize]
      : [extra, (box - COLOSSEUM.retailBoxes) * COLOSSEUM.boxSize];
    for (let slot = 0; slot < COLOSSEUM.perBox; slot++)
      out.push({ area: 'box', box, slot, buffer, at: start + COLOSSEUM.boxName + slot * COLOSSEUM.size, boxStart: start });
  }
  return out;
}

function colosseumModel(ctx) {
  const { plain } = ctx;
  const slots = colosseumSlots(ctx).map(place => ({ place, pokemon: colosseumPokemon(place.buffer.subarray(place.at, place.at + COLOSSEUM.size)) }));
  const party = slots.filter(item => item.place.area === 'party').map(({ place, pokemon }) => pokemon && { ...pokemon, area: 'party', box: 0, slot: place.slot });
  const boxes = [];
  for (const { place, pokemon } of slots.filter(item => item.place.area === 'box')) {
    if (!boxes[place.box]) boxes[place.box] = { name: units(place.buffer, place.boxStart, 10) || `BOX ${place.box + 1}`, pokemon: [] };
    boxes[place.box].pokemon.push(pokemon && { ...pokemon, area: 'box', box: place.box, slot: place.slot });
  }
  const shadows = {};
  for (const n of COLOSSEUM_STORY_IDS)
    shadows[n] = { met: colosseumFlag(plain, 'met', n).set, snagged: colosseumFlag(plain, 'snagged', n).set,
      purified: colosseumFlag(plain, 'purified', n).set, heartMax: plain.readUInt16BE(COLOSSEUM_HEART_MAX(n)) };
  for (const item of [...party, ...boxes.flatMap(box => box.pokemon)])
    if (item?.shadow && shadows[item.shadowId]?.heartMax) item.heartPercent = Math.max(0, Math.min(100, Math.round(item.heart / shadows[item.shadowId].heartMax)));
  return { game: 'colosseum', trainer: units(plain, COLOSSEUM.trainerName), trainerId: plain.readUInt32BE(COLOSSEUM.trainerId),
    party, boxes, shadows, boxesBeyondThree: Boolean(ctx.extra) };
}

// ---- XD ----

function xdRecord(ctx, n) {
  const at = ctx.sections.darkPokemon + n * XD.recordSize;
  return at + XD.recordSize <= ctx.plain.length ? ctx.plain.subarray(at, at + XD.recordSize) : null;
}
const xdStatus = record => record[0] >> 5;
const xdWhere = record => (record.readUInt32BE(0) >>> 15) & 7;

function xdPokemon(ctx, bytes, extra = {}) {
  const at = XD.at, species = bytes.readUInt16BE(at.species);
  if (!species) return null;
  const rnd = bytes.readUInt32BE(at.rnd), trainer = bytes.readUInt32BE(at.trainer), shadowId = bytes.readUInt16BE(at.shadow);
  const record = shadowId ? xdRecord(ctx, shadowId) : null;
  const shadow = Boolean(record) && xdStatus(record) !== XD_STATUS.purified;
  return {
    species, rnd, trainer, key: keyOf(species, rnd, trainer),
    nickname: units(bytes, at.nickname), level: bytes[at.level], item: bytes.readUInt16BE(at.item),
    hp: bytes.readUInt16BE(at.hp), maxHp: bytes.readUInt16BE(at.maxHp), ball: bytes[at.ball],
    moves: Array.from({ length: 4 }, (_, i) => bytes.readUInt16BE(at.moves + i * 4)).filter(Boolean),
    egg: Boolean(bytes[at.flags] & 0x80), shiny: isShiny(trainer, rnd),
    shadowId, shadow, heart: shadow ? record.readInt32BE(0x24) : null, ...extra
  };
}

function xdSlots(ctx) {
  const { plain, sections } = ctx, out = [];
  for (let slot = 0; slot < PARTY_SIZE; slot++)
    out.push({ area: 'party', box: 0, slot, buffer: plain, at: sections.hero + XD.partyAt + slot * XD.size });
  for (let box = 0; box < XD.boxes; box++) {
    const start = sections.pcBox + box * XD.boxSize;
    for (let slot = 0; slot < XD.perBox; slot++)
      out.push({ area: 'box', box, slot, buffer: plain, at: start + XD.boxName + slot * XD.size, boxStart: start });
  }
  return out;
}

// Every other place a Pokémon of XD's save can be: the day care and the Purify Chamber.
function xdElsewhere(ctx) {
  const { plain, sections } = ctx, out = [];
  if (sections.dayCare !== undefined) out.push(sections.dayCare + XD_DAYCARE_POKEMON);
  if (sections.chamber !== undefined)
    for (let chamber = 0; chamber < XD_CHAMBER.count; chamber++)
      for (let i = 0; i < XD_CHAMBER.pokemon; i++) out.push(sections.chamber + chamber * XD_CHAMBER.size + i * XD.size);
  return out.filter(at => at + XD.size <= plain.length).map(at => plain.subarray(at, at + XD.size));
}

function xdModel(ctx) {
  const { plain, sections } = ctx;
  const slots = xdSlots(ctx).map(place => ({ place, pokemon: xdPokemon(ctx, place.buffer.subarray(place.at, place.at + XD.size)) }));
  const party = slots.filter(item => item.place.area === 'party').map(({ place, pokemon }) => pokemon && { ...pokemon, area: 'party', box: 0, slot: place.slot });
  const boxes = [];
  for (const { place, pokemon } of slots.filter(item => item.place.area === 'box')) {
    if (!boxes[place.box]) boxes[place.box] = { name: units(plain, place.boxStart, 9) || `BOX ${place.box + 1}`, pokemon: [] };
    boxes[place.box].pokemon.push(pokemon && { ...pokemon, area: 'box', box: place.box, slot: place.slot });
  }
  const shadows = {};
  for (let n = 1; n <= XD_LAST_ID; n++) {
    const record = xdRecord(ctx, n);
    if (record) shadows[n] = { status: xdStatus(record), where: xdWhere(record), species: record.readUInt16BE(0x1a) };
  }
  return { game: 'xd', trainer: units(plain, sections.hero), trainerId: plain.readUInt32BE(sections.hero + XD.heroId), party, boxes, shadows };
}

function xdCardContext(plain) {
  return { game: 'xd', plain, sections: { hero: xdSave.sectionAt(plain, 'hero'), pcBox: xdSave.sectionAt(plain, 'pcBox'),
    darkPokemon: xdSave.sectionAt(plain, 'darkPokemon'), dayCare: xdSave.BODY + sectionPlace(plain, 0x48), chamber: xdSave.BODY + sectionPlace(plain, 0x70) } };
}
function sectionPlace(plain, table) { return ((plain.readUInt16BE(table + 2) << 16) | plain.readUInt16BE(table)) >>> 0; }

// ---- reading ----

// The model of either game's save context.
function model(ctx) { return ctx.game === 'xd' ? xdModel(ctx) : colosseumModel(ctx); }

// Every copy of a card save the game could load, newest first: [{ index, count, ctx }]. Colosseum's context carries
// boxes 4 to 10 when the save names them (and the file has them).
function cardCopies(saveDir, gameId) {
  if (gameId === 'xd') {
    const data = fs.readFileSync(path.join(saveDir, XD.file)), copies = [];
    xdSave.SLOTS.forEach((start, index) => {
      if (data.length < start + xdSave.SLOT_SIZE || data[start] !== 1 || data[start + 1] !== 1 || data[start + 2] !== 1) return;
      const { plain, valid } = xdSave.decipher(data.subarray(start + xdSave.PACK, start + xdSave.SLOT_SIZE));
      if (valid) copies.push({ index, count: data.readInt32BE(start + 4), ctx: xdCardContext(plain) });
    });
    return { data, copies: copies.sort((a, b) => b.count - a.count) };
  }
  const data = fs.readFileSync(path.join(saveDir, COLOSSEUM.file)), copies = [];
  if (data.length !== gciSave.SIZE) throw new Error('This save is damaged: it isn\'t the size the game writes. Restore a backup from the Saves tab.');
  for (let index = 0; index < gciSave.SLOTS; index++) {
    const slot = data.subarray(gciSave.SLOT_START + index * gciSave.SLOT_SIZE, gciSave.SLOT_START + (index + 1) * gciSave.SLOT_SIZE);
    if (!gciSave.headerValid(slot) || slot.readInt32BE(4) <= 0) continue;
    const plain = gciSave.unscramble(slot);
    if (!plain) continue;
    const hash = pcBoxes.stampedHash(plain);
    const extra = hash === null ? null : pcBoxes.boxesFor(saveDir, hash);
    copies.push({ index, count: slot.readInt32BE(4), ctx: { game: 'colosseum', plain, extra: extra ? Buffer.from(extra) : null, hash } });
  }
  return { data, copies: copies.sort((a, b) => b.count - a.count) };
}

// The save the game would load, as a model, or null when there is none yet.
function readCard(saveDir, gameId) {
  let copies;
  try { ({ copies } = cardCopies(saveDir, gameId)); } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  if (!copies.length) return null;
  return { ...model(copies[0].ctx), saveCount: copies[0].count, source: 'card' };
}

// live.bin, from the running game (SPEC.md): its header and its context, or null while it has no save in memory.
const LIVE_MAGIC = 0x4353544c, LIVE_HEADER = 0x40;
function parseLive(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < LIVE_HEADER || bytes.readUInt32BE(0) !== LIVE_MAGIC || bytes.readUInt32BE(4) !== 1) return null;
  const game = bytes.readUInt32BE(8) === 1 ? 'xd' : 'colosseum', state = bytes.readUInt32BE(0x10);
  const head = { game, sequence: bytes.readUInt32BE(0x0c), loaded: Boolean(state & 1), safe: Boolean(state & 2), canSave: Boolean(state & 4),
    busy: Boolean(state & 8), trainerId: bytes.readUInt32BE(0x14), saveCount: bytes.readUInt32BE(0x18), lastCommand: bytes.readUInt32BE(0x1c) };
  if (!head.loaded) return { head, ctx: null };
  const bodySize = bytes.readUInt32BE(0x20), extraSize = bytes.readUInt32BE(0x24);
  if (LIVE_HEADER + bodySize + extraSize > bytes.length) return null;
  const body = bytes.subarray(LIVE_HEADER, LIVE_HEADER + bodySize);
  if (game === 'xd') {
    return { head, ctx: { game, plain: Buffer.from(body), sections: { ...XD.ram } } };
  }
  // the slot's plain bytes from its offset 8 on: put back the 8 bytes of header in front, so offsets are the card's
  const plain = Buffer.concat([Buffer.alloc(8), body]);
  const extra = extraSize ? Buffer.from(bytes.subarray(LIVE_HEADER + bodySize, LIVE_HEADER + bodySize + extraSize)) : null;
  return { head, ctx: { game, plain, extra } };
}

function readLive(file) {
  let bytes;
  try { bytes = fs.readFileSync(file); } catch (_) { return null; }
  const live = parseLive(bytes);
  if (!live) return null;
  return { head: live.head, model: live.ctx ? { ...model(live.ctx), saveCount: live.head.saveCount, source: 'live' } : null, ctx: live.ctx };
}

// ---- Shadowtrade's rules ----

// A Pokémon's place in a context: { buffer, at } of the slot holding it, by place, or by identity anywhere.
function findPokemon(ctx, identity, place) {
  const slots = ctx.game === 'xd' ? xdSlots(ctx) : colosseumSlots(ctx), size = ctx.game === 'xd' ? XD.size : COLOSSEUM.size;
  const at = ctx.game === 'xd' ? XD.at : COLOSSEUM.at;
  const matches = item => item.buffer.readUInt16BE(item.at + at.species) === identity.species &&
    item.buffer.readUInt32BE(item.at + at.rnd) === identity.rnd >>> 0 && item.buffer.readUInt32BE(item.at + at.trainer) === identity.trainer >>> 0;
  const exact = place && slots.find(item => item.area === place.area && item.box === place.box && item.slot === place.slot);
  const found = exact && matches(exact) ? exact : slots.find(matches);
  return found ? { ...found, bytes: found.buffer.subarray(found.at, found.at + size) } : null;
}

// Why a Pokémon of this save can't go to Shadowtrade, or null when it can. pokemon: one of the model's.
function offerProblem(saveModel, pokemon) {
  if (!pokemon) return 'There is no Pokémon there.';
  if (pokemon.egg) return 'Eggs can\'t be traded.';
  if (!pokemon.shadow) return 'Only Shadow Pokémon can go to Shadowtrade.';
  if (saveModel.game === 'xd') {
    if (pokemon.shadowId === XD_LUGIA) return 'XD-001 can\'t be traded: the Purify Chamber needs it.';
    if (pokemon.shadowId > XD_LAST_ID) return 'This Shadow Pokémon isn\'t one of the story\'s.';
    if (saveModel.shadows[pokemon.shadowId]?.status !== XD_STATUS.snagged) return 'Only a snagged Shadow Pokémon can be traded.';
    const copies = allPokemon(saveModel).filter(each => each.shadowId === pokemon.shadowId);
    if (copies.length > 1) return 'Another Pokémon in this save shares this one\'s Shadow, so neither can be traded.';
  } else if (!COLOSSEUM_STORY_IDS.includes(pokemon.shadowId)) return 'This Shadow Pokémon isn\'t one of the story\'s.';
  if (pokemon.area === 'party') {
    const others = saveModel.party.filter(each => each && each.key !== pokemon.key && !each.egg && each.hp > 0);
    if (!others.length) return 'You can\'t trade your last Pokémon that can battle: keep one in your party.';
  }
  return null;
}

const allPokemon = saveModel => [...saveModel.party, ...saveModel.boxes.flatMap(box => box.pokemon)].filter(Boolean);

// The Shadow ids this save can take a Pokémon of: [n].
// Colosseum: any story id the save hasn't purified, while no unpurified Pokémon of that id is in it (two would share
// one walking counter, and the first purified would leave the other unable to drop its gauge by walking). A save that
// hasn't met the id yet still takes it: the story's trainer will have their own.
// XD: the record must be free for it: missed (status 2), or snagged and then traded away or released with no Pokémon
// of that id left in the save. An id not met yet would make the story's trainer a copy of the received one, sharing its
// heart gauge, so it waits until the player has met it.
function shadowAccepts(saveModel, ctx = null) {
  const held = new Set(allPokemon(saveModel).filter(each => each.shadow).map(each => each.shadowId));
  if (saveModel.game === 'xd') {
    const anywhere = new Set(allPokemon(saveModel).map(each => each.shadowId));
    if (ctx) for (const bytes of xdElsewhere(ctx)) if (bytes.readUInt16BE(0)) anywhere.add(bytes.readUInt16BE(XD.at.shadow));
    return Object.entries(saveModel.shadows).map(([n, record]) => [Number(n), record]).filter(([n, record]) => n !== XD_LUGIA &&
      (record.status === XD_STATUS.missed || (record.status === XD_STATUS.snagged && [XD_WHERE.traded, XD_WHERE.released].includes(record.where) && !anywhere.has(n))))
      .map(([n]) => n);
  }
  if (ctx?.plain && ctx.plain.length >= COLOSSEUM_DAYCARE_POKEMON + COLOSSEUM.size) {
    const dayCare = colosseumPokemon(ctx.plain.subarray(COLOSSEUM_DAYCARE_POKEMON, COLOSSEUM_DAYCARE_POKEMON + COLOSSEUM.size));
    if (dayCare?.shadow) held.add(dayCare.shadowId);
  }
  return COLOSSEUM_STORY_IDS.filter(n => !saveModel.shadows[n]?.purified && !held.has(n));
}

// What a save takes once `pokemon` (one of its own) has left it for Shadowtrade: it no longer holds it, and in XD its
// record says traded away.
function acceptsAfterTaking(saveModel, ctx, pokemon) {
  const gone = each => each && each.key === pokemon.key && each.area === pokemon.area && each.box === pokemon.box && each.slot === pokemon.slot ? null : each;
  const after = { ...saveModel, party: saveModel.party.map(gone), boxes: saveModel.boxes.map(box => ({ ...box, pokemon: box.pokemon.map(gone) })) };
  if (saveModel.game === 'xd' && saveModel.shadows[pokemon.shadowId]) after.shadows = { ...saveModel.shadows, [pokemon.shadowId]: { ...saveModel.shadows[pokemon.shadowId], where: XD_WHERE.traded } };
  return shadowAccepts(after, ctx);
}

// XD: B's record for the received Pokémon, from A's (sent with it) and B's own: A's heart gauge, pools, Hyper Mode,
// IVs, personality and walking; B's species row; status snagged, the "new" mark, a traded-in marker (snatchFromWho 2,
// which the game never writes), its place, and an order met (B's own if B has met it).
function mergeXdRecord(bRecord, aRecord, n, place, nextIndex) {
  const out = Buffer.from(aRecord);
  bRecord.copy(out, 0x1a, 0x1a, 0x1c);                       // species row: B's
  out.writeUInt16BE(n, 0x3e);
  const a = aRecord.readUInt32BE(0);
  let word = (XD_STATUS.snagged << 29) >>> 0;
  word |= a & ((7 << 25) | (1 << 22) | (7 << 18));            // snatchInfoLevel, Hyper Mode, newly revealed moves
  word |= 1 << 21;                                            // new on the Shadow Monitor
  word |= 2 << 23;                                            // traded in
  word |= (place.area === 'party' ? XD_WHERE.party : XD_WHERE.box) << 15;
  out.writeUInt32BE(word >>> 0, 0);
  out[0x11] = place.area === 'party' ? 0 : place.box;
  out[0x13] = xdStatus(bRecord) >= XD_STATUS.met ? bRecord[0x13] : nextIndex & 0xff;
  return out;
}

// ---- the two changes, on one copy of a save ----

// Takes the Pokémon out: from the party, the later members move up; from a box, its slot is left empty. XD: its record
// says traded away (status stays snagged), as the game's own trade does. Returns where it was, or null when this copy
// doesn't have it.
function takeFrom(ctx, identity, place) {
  const found = findPokemon(ctx, identity, place);
  if (!found) return null;
  const size = ctx.game === 'xd' ? XD.size : COLOSSEUM.size;
  const shadowId = found.bytes.readUInt16BE(ctx.game === 'xd' ? XD.at.shadow : COLOSSEUM.at.shadow);
  const bytes = Buffer.from(found.bytes);
  if (found.area === 'party') {
    const first = found.at - found.slot * size;
    found.buffer.copy(found.buffer, found.at, found.at + size, first + PARTY_SIZE * size);
    found.buffer.fill(0, first + (PARTY_SIZE - 1) * size, first + PARTY_SIZE * size);
  } else found.buffer.fill(0, found.at, found.at + size);
  let record = null;
  if (ctx.game === 'xd' && shadowId) {
    const live = xdRecord(ctx, shadowId);
    record = Buffer.from(live);
    const word = (live.readUInt32BE(0) & ~(7 << 15)) | (XD_WHERE.traded << 15);
    live.writeUInt32BE(word >>> 0, 0);
    live[0x11] = 0;
  }
  return { area: found.area, box: found.box, slot: found.slot, bytes, record };
}

function firstFree(ctx) {
  const slots = ctx.game === 'xd' ? xdSlots(ctx) : colosseumSlots(ctx);
  return slots.find(item => !item.buffer.readUInt16BE(item.at));
}

// Puts a received Pokémon in: the first free party slot, else the first free box slot. Colosseum: its heart gauge
// kept within this save's for its id, and the id marked snagged. XD: its record merged (mergeXdRecord). Returns where
// it went ({ already: true } when this copy has it already), or null when there's no room.
function giveTo(ctx, pokemon, record = null) {
  const at = ctx.game === 'xd' ? XD.at : COLOSSEUM.at;
  const identity = { species: pokemon.readUInt16BE(at.species), rnd: pokemon.readUInt32BE(at.rnd), trainer: pokemon.readUInt32BE(at.trainer) };
  const existing = findPokemon(ctx, identity);
  if (existing) return { area: existing.area, box: existing.box, slot: existing.slot, already: true };
  const free = firstFree(ctx);
  if (!free) return null;
  const bytes = Buffer.from(pokemon);
  const shadowId = bytes.readUInt16BE(at.shadow);
  if (ctx.game === 'xd') {
    const live = xdRecord(ctx, shadowId), hero = ctx.sections.hero;
    const count = ctx.plain.readUInt32BE(hero + XD.meetCount);
    const merged = mergeXdRecord(live, record, shadowId, free, count);
    if (xdStatus(live) < XD_STATUS.met) ctx.plain.writeUInt32BE((count + 1) >>> 0, hero + XD.meetCount);
    merged.copy(live);
  } else {
    const max = ctx.plain.readUInt16BE(COLOSSEUM_HEART_MAX(shadowId));
    if (max && bytes.readInt32BE(at.heart) > max * 100) bytes.writeInt32BE(max * 100, at.heart);
    setColosseumFlag(ctx.plain, 'snagged', shadowId);
  }
  bytes.copy(free.buffer, free.at);
  return { area: free.area, box: free.box, slot: free.slot };
}

// ---- writing the card (the game closed) ----

function writeAtomic(file, bytes) {
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.shadowtrade-${process.pid}`);
  try {
    fs.writeFileSync(temporary, bytes, { mode: 0o600 });
    fs.renameSync(temporary, file);
  } finally { fs.rmSync(temporary, { force: true }); }
}

// Applies change(ctx) to every copy of the card save the game could load (so an older copy, which the game falls back
// to when the newest is damaged, can't bring a traded Pokémon back), then writes the card. change returns a result for
// a copy, or null when that copy has nothing to change. The newest copy must change. Colosseum's boxes 4 to 10 go to a
// new entry of the .boxes file, which the copy's stamp names; the file keeps the entries the copies named before too
// until the card is written, so a failed write leaves every copy's boxes readable.
function editCard(saveDir, gameId, change) {
  const { data, copies } = cardCopies(saveDir, gameId);
  if (!copies.length) throw new Error('There is no save to change yet.');
  const out = Buffer.from(data);
  let result = null;
  const entries = [];
  copies.forEach((copy, order) => {
    const before = copy.ctx.extra ? Buffer.from(copy.ctx.extra) : null;
    const done = change(copy.ctx);
    if (order === 0) result = done;
    if (!done || done.already) return;
    if (gameId === 'xd') {
      const start = xdSave.SLOTS[copy.index];
      xdSave.encipher(copy.ctx.plain).copy(out, start + xdSave.PACK);
      return;
    }
    if (copy.ctx.extra && !copy.ctx.extra.equals(before)) {
      const hash = pcBoxes.fnv64(copy.ctx.extra);
      pcBoxes.writeStamp(copy.ctx.plain, hash);
      entries.push({ hash, data: copy.ctx.extra, previous: copy.ctx.hash });
    }
    gciSave.scramble(copy.ctx.plain).copy(out, gciSave.SLOT_START + copy.index * gciSave.SLOT_SIZE);
  });
  if (!result) return null;
  if (result.already) return result;
  if (entries.length) pcBoxes.writeEntries(saveDir, entries, copies.map(copy => copy.ctx.hash).filter(hash => hash !== null && hash !== undefined));
  writeAtomic(path.join(saveDir, gameId === 'xd' ? XD.file : COLOSSEUM.file), out);
  return result;
}

module.exports = { COLOSSEUM, XD, COLOSSEUM_STORY_IDS, XD_STATUS, XD_WHERE, PARTY_SIZE, model, readCard, readLive, parseLive, cardCopies,
  colosseumFlag, offerProblem, shadowAccepts, acceptsAfterTaking, mergeXdRecord, takeFrom, giveTo, editCard, findPokemon, allPokemon, keyOf, xdElsewhere };
