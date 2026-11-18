'use strict';

// Shadow Pokémon received through Shadowtrade each get an entry of their own in the save, never the story's entry for
// their Shadow id (which the save's own story Shadow of that id keeps: a randomizer run's story Geodude and a
// traded-in Geodude are two Shadows, each with its own heart gauge, Hyper Mode and flags). This is the launcher's half
// of the game's rules (host/shadowtrade.c and host/xd/shadowtrade.c, SPEC "v2 as built"): an offline edit must do
// exactly what the game does when it gives or takes one while running.
//
// An entry E remembers the story id N the Pokémon came from: on the way out it is sent as N again, and the next save
// gives it an entry of its own. Entries are the save's spare Shadow ids first, then ids 0x100 and up kept in a file
// beside the save (<save>.shadows), 2048 of them, named by a stamp in the save as pokemon_colosseum.boxes is.
// E is free when no Pokémon that is still a Shadow holds it; a purified Pokémon still holding it is a normal Pokémon,
// and its id is set to 0 when E is used again.

const fs = require('node:fs');
const path = require('node:path');
const xdSave = require('./xd-save');

const SIDE_FIRST = 0x100, SIDE_MAX = 2048, SIDE_SLOTS = 6;
const SIDE_MAGIC = 0x43535345;   // CSSE
const SIDE_HEAD = 0x20;

// Colosseum: the 48 ids the story doesn't use (the e-Reader's), in the game's order; record E = 0x1B4AC + 0x18E
// (species +0x10, story id byte +0x12, first-met order +0x14, heart max +0x16, its own id +0x0E), runtime slot E =
// 0x1B020 + 0xCE (walking counter +2, personality +4, place +8). The Shadow block counts first meetings at 0x1B01C.
const COLOSSEUM_ENTRIES = [...range(0x2d, 0x36), ...range(0x3a, 0x42), ...range(0x44, 0x60)];
const C_RECORD = id => 0x1b4ac + 0x18 * id, C_RUNTIME = id => 0x1b020 + 0xc * id, C_COUNTER = 0x1b01c;
const C_STAMP = 0x1b4ae;          // record 0 +2: u16 0x4353, the entries' hash u64
const C_SIDE_ENTRY = 0x10;        // +0 flags (1 met, 2 snagged, 4 purified, 8 new), +1 N, +2 walking, +4 species, +6 heart max, +8 personality, +0xC place
const C_STATIC_MAX = 50;
// XD: records 0x54..0x7F; the story id is remembered at +0x43; a new save makes each record zero with species 0x118
// and its own id at +0x3E.
const XD_ENTRIES = range(0x54, 0x7f);
const XD_STORY = 0x43, XD_FILLER_SPECIES = 0x118, XD_RECORD = 0x48;
const XD_LIVE_STAMP = 0x1f980;    // reserve 1 +0x40 in the game's memory; in a card pack, reserve 1's room +0x40

// Colosseum's flags for each Shadow id 1..0x60: bits of the game's flag level 3 (slot 0x1BE64), bit = first + id, the u32
// big-endian word bit >> 5, mask 1 << (bit & 31). Proven for all 96 ids against the game's own flag table.
const COLOSSEUM_FLAG_LEVEL = 0x1be64;
const COLOSSEUM_FLAGS = { met: 1235, snagged: 4307, purified: 1139, isNew: 1043 };
function colosseumFlag(plain, kind, id) {
  const bit = COLOSSEUM_FLAGS[kind] + id;
  const at = COLOSSEUM_FLAG_LEVEL + 4 * (bit >> 5), mask = (1 << (bit & 31)) >>> 0;
  return { at, mask, set: ((plain.readUInt32BE(at) & mask) >>> 0) !== 0 };
}
function setColosseumFlag(plain, kind, id, on = true) {
  const { at, mask } = colosseumFlag(plain, kind, id);
  plain.writeUInt32BE((on ? plain.readUInt32BE(at) | mask : plain.readUInt32BE(at) & ~mask) >>> 0, at);
}

function range(a, b) { return Array.from({ length: b - a + 1 }, (_, i) => a + i); }

// The game's hash of the entries in use (host/shadowtrade_io.c hash_bytes), | 1 so it is never 0.
function sideHash(bytes) {
  const P = 0x100000001b3n, M = (1n << 64n) - 1n;
  let h = 0x9e3779b97f4a7c15n, i = 0;
  for (; i + 8 <= bytes.length; i += 8) {
    h = ((h ^ bytes.readBigUInt64LE(i)) * P) & M;
    h ^= h >> 29n;
  }
  for (; i < bytes.length; i++) h = ((h ^ BigInt(bytes[i])) * P) & M;
  return h | 1n;
}
function check32(head) {
  let c = 0x811c9dc5;
  for (let i = 0; i < 28; i++) c = Math.imul(c ^ head[i], 0x01000193) >>> 0;
  return c;
}
const sideFile = (saveDir, game) => path.join(saveDir, game === 'xd' ? 'PokemonXD.shadows' : 'pokemon_colosseum.shadows');
const entrySize = game => (game === 'xd' ? XD_RECORD : C_SIDE_ENTRY);

function slots(file) {
  let bytes;
  try { bytes = fs.readFileSync(file); } catch (_) { return []; }
  const out = [];
  for (let at = 0, n = 0; n < SIDE_SLOTS && at + SIDE_HEAD <= bytes.length; n++) {
    const head = bytes.subarray(at, at + SIDE_HEAD);
    if (head.readUInt32BE(0) !== SIDE_MAGIC || head.readUInt32BE(28) !== check32(head)) break;
    const size = head.readUInt32BE(12), count = head.readUInt32BE(16);
    out.push({ generation: head.readUInt32BE(8), size, count, hash: head.readBigUInt64BE(20), data: bytes.subarray(at + SIDE_HEAD, at + SIDE_HEAD + size * count) });
    at += SIDE_HEAD + size * count;
  }
  return out;
}

// The entries a save names (its stamp's hash), or null when the file doesn't have them.
function readSide(saveDir, game, hash) {
  if (!hash) return Buffer.alloc(0);
  const slot = slots(sideFile(saveDir, game)).find(each => each.hash === hash && each.size === entrySize(game));
  return slot && sideHash(slot.data) === hash ? Buffer.from(slot.data) : null;
}

// The file again: the entries the save's copies name now (keep), and the new ones (each { hash, data }), up to 6.
function writeSide(saveDir, game, added, keep) {
  const file = sideFile(saveDir, game), old = slots(file);
  let generation = old.reduce((max, each) => Math.max(max, each.generation), 0);
  const kept = old.filter(each => keep.includes(each.hash) && !added.some(entry => entry.hash === each.hash));
  const fresh = [];
  for (const entry of added) if (entry.data.length && !fresh.some(each => each.hash === entry.hash)) fresh.push(entry);
  const all = [...kept.map(each => ({ hash: each.hash, data: each.data, generation: each.generation })), ...fresh.map(each => ({ ...each, generation: ++generation }))].slice(-SIDE_SLOTS);
  const out = Buffer.concat(all.flatMap(entry => {
    const head = Buffer.alloc(SIDE_HEAD);
    head.writeUInt32BE(SIDE_MAGIC, 0); head.writeUInt32BE(1, 4); head.writeUInt32BE(entry.generation >>> 0, 8);
    head.writeUInt32BE(entrySize(game), 12); head.writeUInt32BE(entry.data.length / entrySize(game), 16);
    head.writeBigUInt64BE(entry.hash, 20); head.writeUInt32BE(check32(head), 28);
    return [head, entry.data];
  }));
  const temporary = path.join(saveDir, `.${path.basename(file)}.shadowtrade-${process.pid}`);
  try {
    fs.writeFileSync(temporary, out, { mode: 0o600 });
    fs.renameSync(temporary, file);
  } finally { fs.rmSync(temporary, { force: true }); }
}

// ---- the stamp: where it is in a context ----

function stampAt(ctx) {
  if (ctx.game !== 'xd') return C_STAMP;
  return ctx.live ? XD_LIVE_STAMP : xdSave.stampAt(ctx.plain) + 0x40;
}

function readStamp(ctx) {
  const at = stampAt(ctx), p = ctx.plain;
  if (at + 0x10 > p.length) return 0n;
  if (ctx.game !== 'xd') return p.readUInt16BE(at) === 0x4353 ? p.readBigUInt64BE(at + 2) : 0n;
  if (p.readUInt32BE(at) !== SIDE_MAGIC || p.readUInt32BE(at + 12) !== ((SIDE_MAGIC ^ p.readUInt32BE(at + 4) ^ p.readUInt32BE(at + 8)) >>> 0)) return 0n;
  return p.readBigUInt64BE(at + 4);
}

function writeStamp(ctx, hash) {
  const at = stampAt(ctx), p = ctx.plain;
  p.fill(0, at, at + (ctx.game === 'xd' ? 0x10 : 10));
  if (!hash) return;
  if (ctx.game !== 'xd') { p.writeUInt16BE(0x4353, at); p.writeBigUInt64BE(hash, at + 2); return; }
  p.writeUInt32BE(SIDE_MAGIC, at); p.writeBigUInt64BE(hash, at + 4);
  p.writeUInt32BE((SIDE_MAGIC ^ p.readUInt32BE(at + 4) ^ p.readUInt32BE(at + 8)) >>> 0, at + 12);
}

// The entries in use, trimmed to the last one not all zero (as the game counts them).
function usedSide(side, game) {
  const size = entrySize(game);
  let n = side.length / size;
  while (n && side.subarray((n - 1) * size, n * size).every(byte => !byte)) n--;
  return side.subarray(0, n * size);
}

// ---- entries in a context ----
// ctx.side: the sidecar entries (Buffer, grown as needed); ctx.game; ctx.plain; XD ctx.sections; Colosseum ctx.extra.

function sideSlice(ctx, id, grow = false) {
  const size = entrySize(ctx.game), n = id - SIDE_FIRST;
  if (n < 0 || n >= SIDE_MAX) return null;
  if ((n + 1) * size > ctx.side.length) {
    if (!grow) return Buffer.alloc(size);   // past the end: all zero, free
    ctx.side = Buffer.concat([ctx.side, Buffer.alloc((n + 1) * size - ctx.side.length)]);
  }
  return ctx.side.subarray(n * size, (n + 1) * size);
}

function xdRecordAt(ctx, id, grow = false) {
  if (id >= SIDE_FIRST) return sideSlice(ctx, id, grow);
  const at = ctx.sections.darkPokemon + id * XD_RECORD;
  return at + XD_RECORD <= ctx.plain.length ? ctx.plain.subarray(at, at + XD_RECORD) : null;
}

const isEntryId = (game, id) => id >= SIDE_FIRST || (game === 'xd' ? XD_ENTRIES.includes(id) : COLOSSEUM_ENTRIES.includes(id));

// What an entry says: { storyId, heartMax (Colosseum), status (XD) }, or null when id isn't a traded-in entry.
function entryInfo(ctx, id) {
  if (!isEntryId(ctx.game, id)) return null;
  if (ctx.game === 'xd') {
    const record = xdRecordAt(ctx, id);
    if (!record) return null;
    return { storyId: record[XD_STORY], status: record[0] >> 5 };
  }
  if (id >= SIDE_FIRST) {
    const entry = sideSlice(ctx, id);
    return { storyId: entry[1], heartMax: entry.readUInt16BE(6), purified: Boolean(entry[0] & 4) };
  }
  const record = C_RECORD(id);
  return { storyId: ctx.plain[record + 0x12], heartMax: ctx.plain.readUInt16BE(record + 0x16) };
}

// Every Pokémon's bytes in the save that a Shadow id can be on: party, boxes, the day care, XD's Purify Chamber.
function holderSlots(ctx, all) {
  return all(ctx).map(place => place.buffer.subarray(place.at, place.at + (ctx.game === 'xd' ? 0xc4 : 0x138))).filter(bytes => bytes.length && bytes.readUInt16BE(0));
}

function stillShadow(ctx, bytes, id) {
  if (ctx.game === 'xd') {
    const record = xdRecordAt(ctx, id);
    return bytes.readUInt16BE(0xba) === id && Boolean(record) && (record[0] >> 5) !== 4;
  }
  return bytes.readUInt16BE(0xd8) === id && bytes.readInt32BE(0xdc) >= 0;
}

function usable(ctx, id) {
  if (id >= SIDE_FIRST) return true;
  if (ctx.game === 'xd') {
    const record = xdRecordAt(ctx, id);
    return Boolean(record) && (record[XD_STORY] !== 0 || (record[0] >> 5) === 0);
  }
  const record = C_RECORD(id), p = ctx.plain;
  if (p[record + 0x12]) return true;
  const flag = kind => colosseumFlag(p, kind, id).set;
  return !p.readUInt16BE(record + 0x10) && p.readUInt16BE(record + 0x14) === 0xffff && !flag('met') && !flag('snagged') && !flag('purified');
}

// The lowest usable, free entry, or null when there's none.
function chooseEntry(ctx, all) {
  const holders = holderSlots(ctx, all);
  const ids = [...(ctx.game === 'xd' ? XD_ENTRIES : COLOSSEUM_ENTRIES), ...range(SIDE_FIRST, SIDE_FIRST + SIDE_MAX - 1)];
  for (const id of ids) {
    if (!usable(ctx, id)) continue;
    if (!holders.some(bytes => stillShadow(ctx, bytes, id))) return id;
  }
  return null;
}

function clearEntry(ctx, id) {
  if (id >= SIDE_FIRST) { sideSlice(ctx, id, true).fill(0); return; }
  if (ctx.game === 'xd') {
    const record = xdRecordAt(ctx, id);
    record.fill(0);
    record.writeUInt16BE(XD_FILLER_SPECIES, 0x1a);
    record.writeUInt16BE(id, 0x3e);
    return;
  }
  const record = C_RECORD(id), p = ctx.plain;
  p.fill(0, record, record + 0x18);
  p[record + 0x0e] = id;
  p.writeUInt16BE(0xffff, record + 0x14);
  p.writeUInt16BE(C_STATIC_MAX, record + 0x16);
  p.fill(0, C_RUNTIME(id), C_RUNTIME(id) + 0xc);
  for (const kind of ['met', 'snagged', 'purified', 'isNew']) setColosseumFlag(p, kind, id, false);
}

// Before an entry is used again: the purified Pokémon still holding it become normal Pokémon (id 0).
function releaseHolders(ctx, all, id) {
  const field = ctx.game === 'xd' ? 0xba : 0xd8;
  for (const bytes of holderSlots(ctx, all)) if (bytes.readUInt16BE(field) === id) bytes.writeUInt16BE(0, field);
}

// Gives the received Pokémon (bytes: its copy, with its story id N) an entry: writes the entry and sets the copy's id
// to it. merge(bRecord) makes XD's record from the sender's (save-pokemon.js mergeXdRecord). Returns E, or null.
function giveEntry(ctx, all, bytes, { heartMaxOf, merge }) {
  const id = chooseEntry(ctx, all);
  if (id === null) return null;
  releaseHolders(ctx, all, id);
  clearEntry(ctx, id);
  if (ctx.game === 'xd') {
    const n = bytes.readUInt16BE(0xba);
    const record = xdRecordAt(ctx, id, true);
    const merged = merge(record);
    merged.writeUInt16BE(id, 0x3e);
    merged.writeUInt16BE(bytes.readUInt16BE(0), 0x1a);
    merged[XD_STORY] = n;
    merged.copy(record);
    bytes.writeUInt16BE(id, 0xba);
    return id;
  }
  const n = bytes.readUInt16BE(0xd8), max = heartMaxOf(n);
  if (max && bytes.readInt32BE(0xdc) > max * 100) bytes.writeInt32BE(max * 100, 0xdc);
  if (id >= SIDE_FIRST) {
    const entry = sideSlice(ctx, id, true);
    entry[0] = 0x0b; entry[1] = n;
    entry.writeUInt16BE(bytes.readUInt16BE(0), 4);
    entry.writeUInt16BE(max, 6);
    entry.writeUInt32BE(bytes.readUInt32BE(4), 8);
  } else {
    const record = C_RECORD(id), p = ctx.plain;
    p.writeUInt16BE(bytes.readUInt16BE(0), record + 0x10);
    p.writeUInt16BE(max, record + 0x16);
    p[record + 0x12] = n;
    for (const kind of ['met', 'isNew', 'snagged']) setColosseumFlag(p, kind, id, true);
    const counter = p.readUInt32BE(C_COUNTER);
    p.writeUInt16BE(counter & 0xffff, record + 0x14);
    p.writeUInt32BE((counter + 1) >>> 0, C_COUNTER);
    p.writeUInt32BE(bytes.readUInt32BE(4), C_RUNTIME(id) + 4);
    p.writeUInt32BE(0, C_RUNTIME(id) + 8);
  }
  bytes.writeUInt16BE(id, 0xd8);
  return id;
}

// The copy of a traded-in Pokémon (on entry E) to send: its story id N again (XD: its record too, traded away); E is
// then free. bytes/record: the copies taken out of the save (changed in place).
function sendEntry(ctx, bytes, record) {
  const field = ctx.game === 'xd' ? 0xba : 0xd8, id = bytes.readUInt16BE(field);
  const info = entryInfo(ctx, id);
  if (!info?.storyId) return false;
  bytes.writeUInt16BE(info.storyId, field);
  if (ctx.game === 'xd' && record) {
    record.writeUInt16BE(info.storyId, 0x3e);
    record[XD_STORY] = 0;
    record.writeUInt32BE(((record.readUInt32BE(0) & ~(7 << 15)) | (5 << 15)) >>> 0, 0);
    record[0x11] = 0;
  }
  clearEntry(ctx, id);
  return true;
}

module.exports = { colosseumFlag, setColosseumFlag, SIDE_FIRST, SIDE_MAX, COLOSSEUM_ENTRIES, XD_ENTRIES, sideHash, readSide, writeSide, readStamp, writeStamp, usedSide,
  xdRecordAt, isEntryId, entryInfo, chooseEntry, clearEntry, giveEntry, sendEntry, entrySize };
