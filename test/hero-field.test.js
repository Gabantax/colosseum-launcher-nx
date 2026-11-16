'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const hsd = require('../src/hsd-model');
const field = require('../src/hero-field');

// A .dat of blocks: `build(alloc, point)` lays them out and returns the scene_data root's offset.
function datFile(build) {
  const chunks = [], pointers = [];
  let size = 0;
  const alloc = bytes => { const block = { at: size, buffer: Buffer.alloc(bytes) }; chunks.push(block.buffer); size += bytes; return block; };
  const point = (block, offset, target) => { block.buffer.writeUInt32BE(target.at ?? target, offset); pointers.push(block.at + offset); };
  alloc(0x20);   // nothing starts at 0, which reads as a null pointer
  const root = build(alloc, point);
  const data = Buffer.concat(chunks), relocations = Buffer.alloc(pointers.length * 4), name = Buffer.from('scene_data\0', 'latin1');
  pointers.sort((a, b) => a - b).forEach((at, i) => relocations.writeUInt32BE(at, i * 4));
  const table = Buffer.alloc(8), header = Buffer.alloc(0x20);
  table.writeUInt32BE(root, 0);
  header.writeUInt32BE(0x20 + data.length + relocations.length + table.length + name.length, 0);
  header.writeUInt32BE(data.length, 4);
  header.writeUInt32BE(pointers.length, 8);
  header.writeUInt32BE(1, 12);
  return Buffer.concat([header, data, relocations, table, name]);
}

// A JObj: flags, then scale 1 and a translation
function joint(alloc, flags, translation = [0, 0, 0]) {
  const j = alloc(0x40);
  j.buffer.writeUInt32BE(flags, 4);
  [1, 1, 1].forEach((v, k) => j.buffer.writeFloatBE(v, 0x20 + k * 4));
  translation.forEach((v, k) => j.buffer.writeFloatBE(v, 0x2c + k * 4));
  return j;
}

// A battle model as far as this needs one: three joints in a line, the middle one bent by the game (an IK joint with its
// constraint), one battle clip with key data, and a material animation list
function battleDat() {
  return datFile((alloc, point) => {
    const j0 = joint(alloc, 0), j1 = joint(alloc, 0x200001, [0, 1, 0]), j2 = joint(alloc, 1, [0, 1, 0]);
    point(j0, 8, j1); point(j1, 8, j2);
    const robj = alloc(0x14);
    robj.buffer.writeUInt32BE(0xc0000001, 4);
    point(j1, 0x3c, robj);
    // the battle clip: an AnimJoint for each joint, the middle one keyed, and plenty of key data
    const anims = [alloc(0x14), alloc(0x14), alloc(0x14)], aobj = alloc(0x10), fobj = alloc(0x14), keys = alloc(0x400);
    point(anims[0], 0, anims[1]); point(anims[1], 0, anims[2]);
    aobj.buffer.writeFloatBE(10, 4);
    point(anims[1], 8, aobj); point(aobj, 8, fobj);
    keys.buffer.set(field.encodeTrack(Float32Array.from({ length: 11 }, (_, f) => f / 10), 1e-4));
    fobj.buffer.writeUInt32BE(0x400, 4); fobj.buffer.writeUInt8(1, 0x0c);
    point(fobj, 0x10, keys);
    const animList = alloc(8), matAnim = alloc(0x10), matList = alloc(8);
    point(animList, 0, anims[0]); point(matList, 0, matAnim);
    const set = alloc(0x10), models = alloc(8), scene = alloc(0x10);
    point(set, 0, j0); point(set, 4, animList); point(set, 8, matList);
    point(models, 0, set); point(scene, 0, models);
    return scene.at;
  });
}

// Frames of nine values for each of three joints, from `pose(frame, joint)` giving a joint's rotation
function clipOf(samples, pose) {
  const values = new Float32Array(samples * 3 * 9);
  for (let f = 0; f < samples; f++) for (let j = 0; j < 3; j++) values.set([1, 1, 1, ...pose(f, j), 0, j ? 1 : 0, 0], (f * 3 + j) * 9);
  return { samples, values, end: samples - 1, flags: 0 };
}

test('a track is a line of keys where the values are a line, and keys where they bend', () => {
  assert.deepEqual(field.keyFrames([0, 1, 2, 3, 4], 1e-6), [0, 4]);
  assert.deepEqual(field.keyFrames([0, 1, 2, 1, 0], 1e-6), [0, 2, 4]);
  assert.deepEqual(field.keyFrames([5], 1e-6), [0, 1], 'a still track still has two keys');
  // linear op 2, one key interval, the first key's float (low byte first) and its wait
  const bytes = field.encodeTrack(Float32Array.of(0, 1, 2), 1e-6);
  assert.equal(bytes[0], 0x02 | (1 << 4));
  assert.equal(bytes.readFloatLE(1), 0);
  assert.equal(bytes[5], 2);
  assert.equal(bytes.readFloatLE(6), 2);
  // more than seven intervals: the count's high bits follow in a varint
  const long = field.encodeTrack(Float32Array.from({ length: 21 }, (_, f) => (f % 2) * f), 1e-6);
  assert.equal(long[0] & 0x80, 0x80);
  assert.equal(((long[0] >> 4) & 7) + 1 + (long[1] & 0x7f) * 8, 21);
});

test('a field model\'s 155 clips: the clips given, the empty slots one empty animation, no material animations, plain joints', () => {
  const hero = battleDat(), slots = new Array(field.CLIP_SLOTS).fill(null);
  slots[5] = clipOf(31, (f, j) => (j === 1 ? [Math.sin(f / 5), 0, 0] : j === 2 ? [0, f / 30, 0] : [0, 0, 0]));
  slots[8] = clipOf(17, (f, j) => (j === 1 ? [0, 0, f / 16] : [0, 0, 0]));
  const keyed = [new Set(), new Set([3, 4, 5]), new Set([3, 4, 5])];
  const tolerances = [1e-4, Math.PI / 3600, 1e-4];
  const made = field.fieldDat(hero, slots, keyed, tolerances, { plain: [1], unpinned: [] });
  const pkx = field.asPkx(made);

  for (const index of [5, 8]) {
    const clip = hsd.parseClip(pkx, index), given = slots[index];
    assert.equal(clip.frames, given.end, 'as many frames as Michael\'s clip has');
    for (let k = 0; k < clip.values.length; k++) assert.ok(Math.abs(clip.values[k] - given.values[k]) < 1e-3, `clip ${index} value ${k}`);
  }
  const empty = hsd.parseClip(pkx, 0);
  assert.equal(empty.frames, 1);
  assert.deepEqual(Array.from(empty.values.subarray(9, 18)), [1, 1, 1, 0, 0, 0, 0, 1, 0], 'an empty slot leaves the joints at rest');

  const dat = field.readDat(made), set = field.sceneSet(dat), pointers = new Set(dat.pointers);
  const list = dat.data.readUInt32BE(set + 4), roots = [];
  for (let i = 0; pointers.has(list + i * 4); i++) roots.push(dat.data.readUInt32BE(list + i * 4));
  assert.equal(roots.length, field.CLIP_SLOTS);
  assert.equal(dat.data.readUInt32BE(list + roots.length * 4), 0, 'the list ends with a null');
  assert.equal(new Set(roots.filter((_, i) => !slots[i])).size, 1, 'every empty slot is the one empty animation joint');
  assert.equal(dat.data.readUInt32BE(set + 8), 0, 'no material animations');
  assert.ok(!pointers.has(set + 8));
  const j1 = dat.data.readUInt32BE(dat.data.readUInt32BE(set) + 8);
  assert.equal(dat.data.readUInt32BE(j1 + 4), 1, 'the leg joint is a plain joint');
  assert.equal(dat.data.readUInt32BE(j1 + 0x3c), 0, 'and has no constraint');
  assert.ok(!pointers.has(j1 + 0x3c));
  for (const at of dat.pointers) assert.ok(dat.data.readUInt32BE(at) < dat.data.length);

  // the battle clip's key data, its list and the constraint are left out; nothing that's read changes
  const whole = field.fieldDat(hero, slots, keyed, tolerances, { plain: [1], unpinned: [] }, { compact: false });
  assert.ok(made.length < whole.length - 0x400, `${made.length} vs ${whole.length}`);
  for (const index of [0, 5, 8]) assert.deepEqual(hsd.parseClip(pkx, index).values, hsd.parseClip(field.asPkx(whole), index).values);
});

test('cutting dead objects out of a .dat keeps each kept object\'s place in 32 bytes', () => {
  const file = datFile((alloc, point) => {
    const dead = alloc(0x24), image = alloc(0x40), scene = alloc(8);
    image.buffer.fill(7);
    point(scene, 0, image); point(scene, 4, dead);
    return scene.at;
  });
  const dat = field.readDat(file);
  // the scene's pointer to the dead object taken off, as fieldDat does
  dat.data.writeUInt32BE(0, 0x84 + 4);
  dat.pointers = dat.pointers.filter(at => at !== 0x84 + 4);
  const relocations = Buffer.alloc(dat.pointers.length * 4);
  dat.pointers.forEach((at, i) => relocations.writeUInt32BE(at, i * 4));
  const trimmed = Buffer.concat([dat.header, dat.data, relocations, dat.tables]);
  trimmed.writeUInt32BE(trimmed.length, 0); trimmed.writeUInt32BE(dat.pointers.length, 8);
  const out = field.readDat(field.compactDat(trimmed, [0x20, 0x44, 0x84], new Set([0x20])));
  const image = out.data.readUInt32BE(out.data.length - 8);
  assert.equal(image % 32, 0x44 % 32, 'the image keeps its place in 32 bytes');
  assert.ok(out.data.length < dat.data.length);
  assert.ok(out.data.subarray(image, image + 0x40).every(byte => byte === 7));
});

test('a Michael-style people model\'s slots: empty ones are null, the others their end frame and flags', () => {
  const people = datFile((alloc, point) => {
    const j0 = joint(alloc, 0), emptyAnim = alloc(0x14), anim = alloc(0x14), aobj = alloc(0x10);
    aobj.buffer.writeFloatBE(30, 4);
    point(anim, 8, aobj);
    const list = alloc(12), set = alloc(0x10), models = alloc(8), scene = alloc(0x10);
    point(list, 0, emptyAnim); point(list, 4, anim);
    point(set, 0, j0); point(set, 4, list); point(models, 0, set); point(scene, 0, models);
    return scene.at;
  });
  const slots = field.clipSlots(people);
  assert.equal(slots.length, 2);
  assert.equal(slots[0], null);
  assert.equal(slots[1].end, 30);
  assert.equal(slots[1].flags, 0);
});

test('turns move as little as they can from frame to frame, and are exactly the rest angles when turned as at rest', () => {
  const rest = Float32Array.from([1, 1, 1, 2.9, 0.3, 2.9, 0, 0, 0]);
  const frames = [[3.0, 0.3, 3.0], [3.1, 0.3, 3.1], [-3.1, 0.3, -3.1], [2.9 + Math.PI, Math.PI - 0.3, 2.9 + Math.PI]];
  const values = new Float32Array(frames.length * 9);
  frames.forEach((angles, f) => values.set([1, 1, 1, ...angles, 0, 0, 0], f * 9));
  field.steadyTurns(values, frames.length, rest);
  assert.ok(Math.abs(values[2 * 9 + 3] - (2 * Math.PI - 3.1)) < 1e-5, 'past pi, not round the other way');
  assert.deepEqual(Array.from(values.subarray(3 * 9 + 3, 3 * 9 + 6)), Array.from(rest.subarray(3, 6)));
});

test('only moved channels are keyed, all three of a turn or a place, and never the root joint\'s', () => {
  const rest = new Float32Array(2 * 9);
  const clip = { samples: 2, values: new Float32Array(2 * 2 * 9) };
  clip.values[(1 * 2 + 0) * 9 + 6] = 5;   // the root moved: not keyed
  clip.values[(1 * 2 + 1) * 9 + 4] = 0.5;  // joint 1 turned about Y
  const keyed = field.movedChannels([clip], rest);
  assert.equal(keyed[0].size, 0);
  assert.deepEqual([...keyed[1]].sort(), [3, 4, 5]);
});

test('a leg reaches all the way, then eases toward straight without getting there', () => {
  assert.equal(field.softReach(5, 3, 3), 5);
  assert.equal(field.softReach(0, 3, 2), 1 + 5e-4, 'never folded flatter than its bones allow');
  let last = 0;
  for (let d = 5.5; d < 9; d += 0.1) {
    const reach = field.softReach(d, 3, 3);
    assert.ok(reach > last && reach < 6);
    last = reach;
  }
});

test('limbs are matched place by place, from the last joint at each place back', () => {
  const at = [[0, 10, 0], [1, 9, 0], [1, 9, 0], [1, 5, 0], [1, 1, 0], [1, 0, 1]];
  assert.deepEqual(field.placeGroups(at, [1, 2, 3, 4, 5], 10), [[1, 2], [3], [4], [5]]);
  assert.deepEqual(field.legJoints(at, 0, [1, 2, 3, 4, 5], 10), { thigh: 2, knee: 3, ankle: 4 });
  const map = [];
  field.matchPlaces(map, [[1, 2], [3], [4], [5]], [[11, 12], [13], [14]]);
  assert.deepEqual(map.slice(1), [11, 12, 13, 14, 14]);
  field.matchPlaces(map, [[2]], [[11, 12]]);
  assert.equal(map[2], 12, 'a hero\'s one joint at a shoulder turns as Michael\'s joint that turns the upper arm');
});

test('a clip can key one joint more, the root\'s last child\'s next sibling, added after the clip', () => {
  const dat = field.readDat(battleDat()), set = field.sceneSet(dat), { pointer } = field.reader(dat);
  const root = pointer(set), last = pointer(root + 8), joints = field.jointOffsets(dat, set);
  assert.equal(joints.length, 3);
  const samples = 6, values = new Float32Array(samples * 4 * 9);
  for (let f = 0; f < samples; f++) for (let j = 0; j < 4; j++) values.set([1, 1, 1, 0, 0, 0, ...(j === 3 ? [f, 2 * f, -f] : [0, j ? 1 : 0, 0])], (f * 4 + j) * 9);
  const keyed = [new Set(), new Set(), new Set(), new Set([6, 7, 8])];
  const added = new field.Added((dat.data.length + 31) & ~31), lead = added.base - dat.data.length;
  const carrier = added.alloc(0x40);
  for (let k = 0; k < 3; k++) carrier.buffer.writeFloatBE(1, 0x20 + k * 4);
  const anim = field.addClip(added, dat, set, { samples, values }, { end: samples - 1 }, keyed, [1e-4, 1e-4, 1e-4], last);
  const list = added.alloc(8);
  added.pointer(list, 0, anim);
  dat.data.writeUInt32BE(list.at, set + 4);
  dat.data.writeUInt32BE(carrier.at, last + 0x0c);
  dat.pointers.push(last + 0x0c);
  const made = field.writeDat(dat, Buffer.concat([Buffer.alloc(lead), added.bytes()]), added.pointers.map(at => at + lead));
  const again = field.readDat(made), order = field.jointOffsets(again, field.sceneSet(again));
  assert.equal(order.length, 4, 'numbered after every joint the model had');
  assert.equal(order[3], carrier.at);
  assert.equal(field.reader(again).pointer(order[1] + 0x0c), carrier.at, 'the root\'s last child\'s next');
  const clip = hsd.parseClip(field.asPkx(made), 0);
  for (let f = 0; f < samples - 1; f++) {
    const at = (f * 4 + 3) * 9 + 6;
    assert.deepEqual(Array.from(clip.values.subarray(at, at + 3)).map(v => Math.round(v * 1000) / 1000), [f, 2 * f, -f]);
  }
});
