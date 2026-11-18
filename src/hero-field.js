'use strict';

// Pokémon XD's field as Wes, Brendan, May, Red or Leaf. XD's disc has no field (people) model of these heroes, but it
// carries Colosseum's battle model of each, at the field's scale (Colosseum's own field Wes is as tall as his battle
// model). This makes a people model from one: the hero's battle model as it is (joints, meshes, textures), with its
// battle clips replaced by Michael's field clips moved onto the hero's skeleton, each at the clip index Michael's own
// models (rinto_0000 in people_archive.fsys, then his other rinto entries for the clips it hasn't got) have it, so
// XD's people code plays them unchanged: idle 3, walk 5, run 8, pushing a crate 31-33 and the rest. A people model has
// 155 clip slots; a slot none of Michael's models fills points at an empty animation joint, as his do.
//
// How a clip is moved over:
//   - the limbs are matched place by place (hips, each leg's hip, knee, ankle and toes, each arm's collarbone, shoulder,
//     elbow, wrist and hand) and the spine by what each joint is (up to the chest, the neck, the head);
//   - arms turn as hero-retarget.js turns them (each bone first pointed along Michael's, as the rest poses differ); the
//     hips, spine and feet turn from the hero's rest as Michael's turn from his, as both stand upright, feet flat;
//   - the hips follow the middle of Michael's hips (where his legs meet his body), not his pelvis joint: a battle
//     model's pelvis joint sits on the ground, and turning it there would swing the hips about;
//   - the hips' moves, and every foot's, are Michael's scaled by the heroes' leg lengths (hip to ankle at rest);
//   - each leg is bent (thigh and knee, the knee the way his bends) to put its ankle where Michael's is, scaled, and
//     when his foot is on the ground, the hero's foot on it too.
// The battle models' legs are inverse kinematics (the game bends them to reach a foot target joint) and Wes's pelvis is
// pinned to a joint of its own; Michael's people model has neither, and the clips here set every leg joint, so those
// legs are made plain joints and the pins on joints the clips move are taken off. Other pins (held things on the hands)
// stay. The material animations (the faces' expressions in battle) go, as Michael's model has none: the faces show
// their textures as at rest, which is as the battle idles start. The battle clips, material animations and pins taken
// off are left out of the file, so it's about the size of Michael's.
//
// Only joint channels that move are keyed, the same ones in every clip (the people code blends clips), and never the
// root joint: the game places the model by it. Michael's clips move nothing forward (the people code moves him), and
// neither do these. The people code moves a person by its PeopleInfo walk and run lengths (Michael's 11 and 26 a
// cycle); a hero's feet keep pace with lengths scaled by `legScale`, and its neck and chest joints (which the PeopleInfo
// row names, Michael's 30 and 18) are other joints: fieldInfo gives them.

const hsd = require('./hsd-model');
const retarget = require('./hero-retarget');
const { colosseumPkx } = require('./xd-disc');

// The models' version: made again when it changes (raise it whenever what buildFieldModel makes changes)
const VERSION = 2;
const PKX_HEADER = 0x40;
const CLIP_SLOTS = 155;
// JObj: flags at +4, child +8, next +0x0C, constraints (RObj list) +0x3C. The flags that make a joint part of a leg the
// game bends itself (JOINT1, JOINT2, effector).
const JOBJ_FLAGS = 0x04, JOBJ_CHILD = 0x08, JOBJ_NEXT = 0x0c, JOBJ_ROBJ = 0x3c, JOBJ_IK_MASK = 0x600000;
// Track types for a joint's nine values (scale xyz, rotation xyz, translation xyz), and the linear key op
const CHANNEL_TYPE = [8, 9, 10, 1, 2, 3, 5, 6, 7];
const OP_LINEAR = 2;
const align32 = n => (n + 31) & ~31;

// --- a .dat, as it can be added to ------------------------------------------------------------------------------------

function readDat(file) {
  if (file.length < 0x20) throw new Error('A model file ended early.');
  const size = file.readUInt32BE(0), dataSize = file.readUInt32BE(4), relocations = file.readUInt32BE(8);
  const table = 0x20 + dataSize + relocations * 4;
  if (size > file.length || table > size) throw new Error('A model file is damaged.');
  const pointers = [];
  for (let i = 0; i < relocations; i++) pointers.push(file.readUInt32BE(0x20 + dataSize + i * 4));
  return { header: Buffer.from(file.subarray(0, 0x20)), data: Buffer.from(file.subarray(0x20, 0x20 + dataSize)), pointers,
    tables: Buffer.from(file.subarray(table, size)) };
}

// The .dat with `added` (whose own pointers are `addedPointers`, offsets into it) after its data
function writeDat(dat, added, addedPointers) {
  const base = dat.data.length, data = Buffer.concat([dat.data, added]);
  const pointers = [...dat.pointers, ...addedPointers.map(at => base + at)].sort((a, b) => a - b);
  const relocations = Buffer.alloc(pointers.length * 4);
  pointers.forEach((at, i) => relocations.writeUInt32BE(at, i * 4));
  const header = Buffer.from(dat.header);
  header.writeUInt32BE(0x20 + data.length + relocations.length + dat.tables.length, 0);
  header.writeUInt32BE(data.length, 4);
  header.writeUInt32BE(pointers.length, 8);
  return Buffer.concat([header, data, relocations, dat.tables]);
}

// Bytes added after a .dat's data: pointers are to offsets in the whole data, `base` on
class Added {
  constructor(base) { Object.assign(this, { base, chunks: [], size: 0, pointers: [] }); }
  alloc(bytes, align = 4) {
    const pad = (align - ((this.base + this.size) % align)) % align;
    if (pad) this.chunks.push(Buffer.alloc(pad));
    const buffer = Buffer.alloc(bytes);
    this.chunks.push(buffer);
    const at = this.size + pad;
    this.size = at + bytes;
    return { at: this.base + at, buffer };
  }
  pointer(block, offset, target) {
    if (!target) return;
    block.buffer.writeUInt32BE(target, offset);
    this.pointers.push(block.at - this.base + offset);
  }
  bytes() { return Buffer.concat(this.chunks); }
}

function reader(dat) {
  const pointers = new Set(dat.pointers);
  const pointer = at => (pointers.has(at) ? dat.data.readUInt32BE(at) : 0);
  const list = at => { const items = []; if (at) for (let item; pointers.has(at + items.length * 4) && (item = dat.data.readUInt32BE(at + items.length * 4));) items.push(item); return items; };
  return { pointers, pointer, list };
}

// The model set (joints, animations, material animations, shape animations) of the scene_data root
function sceneSet(dat) {
  const { pointer } = reader(dat), roots = dat.header.readUInt32BE(12), strings = dat.tables.subarray((roots + dat.header.readUInt32BE(16)) * 8);
  for (let i = 0; i < roots; i++) {
    const name = dat.tables.readUInt32BE(i * 8 + 4);
    if (strings.toString('latin1', name, strings.indexOf(0, name)) !== 'scene_data') continue;
    const set = pointer(pointer(dat.tables.readUInt32BE(i * 8)));
    if (set) return set;
  }
  throw new Error('A model file has no scene.');
}

// Every JObj of the set's tree, in the order hsd-model.js numbers them (a joint, its children, then its next)
function jointOffsets(dat, set) {
  const { pointer } = reader(dat), out = [];
  const walk = first => { for (let at = first; at; at = pointer(at + JOBJ_NEXT)) { out.push(at); walk(pointer(at + JOBJ_CHILD)); } };
  walk(pointer(set));
  return out;
}

// --- animations as the game reads them (HSD_FObjInterpretAnim; hsd-model.js's Track reads them back) ------------------

// The keys a track needs: each frame's value is the line between the keys around it, to within `tolerance`
function keyFrames(values, tolerance) {
  const n = values.length, keys = [0];
  const fits = (from, to) => {
    for (let k = from + 1; k < to; k++) {
      const line = values[from] + (values[to] - values[from]) * (k - from) / (to - from);
      if (Math.abs(values[k] - line) > tolerance) return false;
    }
    return true;
  };
  for (let from = 0; from < n - 1;) {
    let to = from + 1;
    while (to + 1 < n && fits(from, to + 1)) to++;
    keys.push(to);
    from = to;
  }
  if (keys.length === 1) keys.push(Math.max(1, n - 1));   // a track needs two keys to set its value at all
  return keys;
}

const varint = value => { const out = []; do { let byte = value & 0x7f; value = Math.floor(value / 128); if (value) byte |= 0x80; out.push(byte); } while (value); return out; };

// One track's key data: linear keys of 32-bit floats (stored low byte first), each followed by the frames to the next
function encodeTrack(values, tolerance) {
  const keys = keyFrames(values, tolerance), count = keys.length - 1;
  const bytes = [OP_LINEAR | (count & 7) << 4 | (count > 7 ? 0x80 : 0)];
  if (count > 7) bytes.push(...varint(count >> 3));
  keys.forEach((frame, i) => {
    const value = Buffer.alloc(4);
    value.writeFloatLE(values[Math.min(frame, values.length - 1)]);
    bytes.push(...value, ...varint(i + 1 < keys.length ? keys[i + 1] - frame : 0));
  });
  return Buffer.from(bytes);
}

// A clip (`samples` frames of nine values for each joint, the last at frame `end`) as an AnimJoint tree with the joint
// tree's shape, keying `keyed[j]`'s channels of joint j. Returns the root's offset.
// `after`, a JObj: the clip's last joint is one more, not yet in the tree, its next sibling (the last in the order)
function addClip(added, dat, set, clip, { end, flags = 0 }, keyed, tolerances, after = 0) {
  const { pointer } = reader(dat), jointCount = keyed.length;
  let next = 0;
  const node = () => {
    const j = next++, anim = added.alloc(0x14);
    if (j >= jointCount) throw new Error('A field motion doesn\'t fit the hero\'s skeleton.');
    if (!keyed[j].size) return anim;
    const aobj = added.alloc(0x10);
    aobj.buffer.writeUInt32BE(flags, 0);
    aobj.buffer.writeFloatBE(end, 4);
    let previous = null;
    for (let channel = 0; channel < 9; channel++) {
      if (!keyed[j].has(channel)) continue;
      const values = new Float32Array(clip.samples);
      for (let frame = 0; frame < clip.samples; frame++) values[frame] = clip.values[(frame * jointCount + j) * 9 + channel];
      const keys = encodeTrack(values, tolerances[Math.floor(channel / 3)]);
      const fobj = added.alloc(0x14), data = added.alloc(keys.length, 1);
      keys.copy(data.buffer);
      fobj.buffer.writeUInt32BE(keys.length, 4);
      fobj.buffer.writeUInt8(CHANNEL_TYPE[channel], 0x0c);
      added.pointer(fobj, 0x10, data.at);
      added.pointer(previous || aobj, previous ? 0 : 8, fobj.at);
      previous = fobj;
    }
    added.pointer(anim, 8, aobj.at);
    return anim;
  };
  // pre-order, a joint's children before its next sibling, as the game and hsd-model.js's bakeClip pair them
  const walk = first => {
    let head = null, previous = null;
    for (let joint = first; joint; joint = pointer(joint + JOBJ_NEXT)) {
      const anim = node(), child = walk(pointer(joint + JOBJ_CHILD));
      if (child) added.pointer(anim, 0, child.at);
      if (previous) added.pointer(previous, 4, anim.at);
      else head = anim;
      previous = anim;
      if (joint === after) {
        const extra = node();
        added.pointer(previous, 4, extra.at);
        previous = extra;
      }
    }
    return head;
  };
  const root = walk(pointer(set));
  if (next !== jointCount) throw new Error('A field motion doesn\'t fit the hero\'s skeleton.');
  return root.at;
}

// The people model's .dat: `heroDat` (a bare .dat) with its animation list made `slots` (CLIP_SLOTS of them, each a
// clip or null for an empty slot, which points at one empty AnimJoint as Michael's model's do), no material
// animations, and the constraints and leg flags `rig` names taken off its joints.
function fieldDat(heroDat, slots, keyed, tolerances, rig = { plain: [], unpinned: [] }, { compact = true } = {}) {
  const dat = readDat(heroDat), set = sceneSet(dat), { pointer } = reader(dat), joints = jointOffsets(dat, set);
  if (joints.length !== keyed.length) throw new Error('A field motion doesn\'t fit the hero\'s skeleton.');
  // the battle clips, material animations and constraints taken off, which nothing else uses, are left out
  const objects = objectsOf(dat), goes = objects.reach([pointer(set + 4), pointer(set + 8), ...[...rig.plain, ...rig.unpinned].map(j => pointer(joints[j] + JOBJ_ROBJ))].filter(Boolean));
  const drop = new Set([set + 8]);
  for (const j of rig.plain) dat.data.writeUInt32BE((dat.data.readUInt32BE(joints[j] + JOBJ_FLAGS) & ~JOBJ_IK_MASK) >>> 0, joints[j] + JOBJ_FLAGS);
  for (const j of [...rig.plain, ...rig.unpinned]) drop.add(joints[j] + JOBJ_ROBJ);
  for (const at of drop) if (pointer(at) || at === set + 8) dat.data.writeUInt32BE(0, at);
  dat.pointers = dat.pointers.filter(at => !drop.has(at));

  // what's added starts on a 32-byte boundary, as the data's own end
  const added = new Added(align32(dat.data.length)), lead = added.base - dat.data.length;
  const empty = added.alloc(0x14);
  const roots = slots.map(clip => (clip ? addClip(added, dat, set, clip, clip, keyed, tolerances) : empty.at));
  const list = added.alloc((roots.length + 1) * 4);
  roots.forEach((at, i) => added.pointer(list, i * 4, at));
  dat.data.writeUInt32BE(list.at, set + 4);
  if (!dat.pointers.includes(set + 4)) dat.pointers.push(set + 4);
  const file = writeDat(dat, Buffer.concat([Buffer.alloc(lead), added.bytes()]), added.pointers.map(at => at + lead));
  return compact ? compactDat(file, objects.starts, new Set([...goes].map(r => objects.starts[r]))) : file;
}

// A .dat's data cut into objects: each runs from where a pointer (or a root) points to where the next one does.
// reach(offsets) is the set of objects reached from the objects at `offsets`, by their pointers.
function objectsOf(dat, extraStarts = []) {
  const { pointers } = reader(dat), roots = dat.header.readUInt32BE(12) + dat.header.readUInt32BE(16);
  const rootOffsets = Array.from({ length: roots }, (_, i) => dat.tables.readUInt32BE(i * 8));
  const starts = [...new Set([0, ...dat.pointers.map(at => dat.data.readUInt32BE(at)), ...rootOffsets, ...extraStarts])].filter(at => at < dat.data.length).sort((a, b) => a - b);
  const of = at => { let lo = 0, hi = starts.length - 1; while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (starts[mid] <= at) lo = mid; else hi = mid - 1; } return lo; };
  const end = r => (r + 1 < starts.length ? starts[r + 1] : dat.data.length);
  const reach = (offsets, from = new Set()) => {
    const seen = new Set(from), stack = offsets.map(of);
    while (stack.length) {
      const r = stack.pop();
      if (seen.has(r)) continue;
      seen.add(r);
      for (let at = starts[r]; at < end(r); at += 4) if (pointers.has(at)) stack.push(of(dat.data.readUInt32BE(at)));
    }
    return seen;
  };
  return { starts, of, end, reach, rootOffsets };
}

// The .dat without the objects that start at `removable` offsets and that nothing kept points to: objects are cut where
// `starts` (the data as it was before) and the file's own pointers say, and each kept one keeps its place in 32 bytes
// (textures must start on 32).
function compactDat(file, starts, removable) {
  const dat = readDat(file), objects = objectsOf(dat, starts);
  const reached = objects.reach(objects.rootOffsets);
  const kept = objects.reach(objects.starts.filter((at, r) => !reached.has(r) && !removable.has(at)), reached);
  const place = new Map(), parts = [];
  let size = 0;
  objects.starts.forEach((at, r) => {
    if (!kept.has(r)) return;
    const pad = ((at % 32) - (size % 32) + 32) % 32;
    if (pad) parts.push(Buffer.alloc(pad));
    size += pad;
    place.set(r, size);
    parts.push(dat.data.subarray(at, objects.end(r)));
    size += objects.end(r) - at;
  });
  const moved = at => { const r = objects.of(at); if (!place.has(r)) throw new Error('A model file is damaged.'); return place.get(r) + at - objects.starts[r]; };
  const data = Buffer.concat(parts), relocations = [];
  for (const at of dat.pointers) {
    if (!kept.has(objects.of(at))) continue;
    data.writeUInt32BE(moved(dat.data.readUInt32BE(at)), moved(at));
    relocations.push(moved(at));
  }
  relocations.sort((a, b) => a - b);
  const tables = Buffer.from(dat.tables);
  objects.rootOffsets.forEach((at, i) => tables.writeUInt32BE(moved(at), i * 8));
  return writeDat({ header: dat.header, data, pointers: relocations, tables }, Buffer.alloc(0), []);
}

// --- Michael's clips --------------------------------------------------------------------------------------------------

// Each of a people model's clip slots: null when empty (no joint animated), else its AObjs' end frame and flags.
function clipSlots(peopleDat) {
  const dat = readDat(peopleDat), { pointer, list } = reader(dat), set = sceneSet(dat);
  return list(pointer(set + 4)).map(root => {
    let found = null;
    const walk = first => {
      for (let at = first; at; at = pointer(at + 4)) {
        const aobj = pointer(at + 8);
        if (aobj) {
          const end = dat.data.readFloatBE(aobj + 4);
          found = found ? { ...found, end: Math.max(found.end, end) } : { end, flags: dat.data.readUInt32BE(aobj), aobjs: [] };
          found.aobjs.push(aobj);
        }
        walk(pointer(at));
      }
    };
    walk(root);
    return found;
  });
}

// A people .dat as hsd-model.js reads a model: a pkx header whose first word is the .dat's size
function asPkx(datBytes) {
  const pkx = Buffer.concat([Buffer.alloc(PKX_HEADER), datBytes]);
  pkx.writeUInt32BE(datBytes.length, 0);
  return pkx;
}

// Michael's clip in slot `index`, frames 0 to its end frame (one more than hsd-model.js bakes: the frame a looping clip
// returns to), read from a copy of his model whose clips run one frame longer.
function michaelClip(longer, index) {
  const clip = hsd.parseClip(longer, index);
  return { frames: clip.frames, values: clip.values };
}
function longerClips(peopleDat, slots) {
  const copy = Buffer.from(peopleDat);
  for (const slot of slots) if (slot) for (const aobj of slot.aobjs) copy.writeFloatBE(slot.end + 1, 0x20 + aobj + 4);
  return asPkx(copy);
}

// --- poses ------------------------------------------------------------------------------------------------------------

function multiply(a, b) {
  const out = new Array(16);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++)
    out[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
  return out;
}
function invertAffine(m) {
  const [a, b, c, , d, e, f, , g, h, i] = m, det = a * (e * i - f * h) - d * (b * i - c * h) + g * (b * f - c * e) || 1;
  const r = [(e * i - f * h) / det, (c * h - b * i) / det, (b * f - c * e) / det, 0, (f * g - d * i) / det, (a * i - c * g) / det, (c * d - a * f) / det, 0,
    (d * h - e * g) / det, (b * g - a * h) / det, (a * e - b * d) / det, 0, 0, 0, 0, 1];
  for (let k = 0; k < 3; k++) r[12 + k] = -(r[k] * m[12] + r[4 + k] * m[13] + r[8 + k] * m[14]);
  return r;
}
const placeOf = m => [m[12], m[13], m[14]];
const applyPoint = (m, [x, y, z]) => [m[0] * x + m[4] * y + m[8] * z + m[12], m[1] * x + m[5] * y + m[9] * z + m[13], m[2] * x + m[6] * y + m[10] * z + m[14]];
const applyVector = (m, [x, y, z]) => [m[0] * x + m[4] * y + m[8] * z, m[1] * x + m[5] * y + m[9] * z, m[2] * x + m[6] * y + m[10] * z];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scaled = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const length = a => Math.hypot(a[0], a[1], a[2]);
const unit = a => { const l = length(a) || 1; return scaled(a, 1 / l); };
const middle = (a, b) => scaled(add(a, b), 0.5);

// 3x3 rotations, column-major (r[c * 3 + row])
function rotationOf(m) {
  const out = new Array(9);
  for (let c = 0; c < 3; c++) {
    const l = Math.hypot(m[c * 4], m[c * 4 + 1], m[c * 4 + 2]) || 1;
    for (let r = 0; r < 3; r++) out[c * 3 + r] = m[c * 4 + r] / l;
  }
  return out;
}
function mul3(a, b) {
  const out = new Array(9);
  for (let c = 0; c < 3; c++) for (let r = 0; r < 3; r++) out[c * 3 + r] = a[r] * b[c * 3] + a[3 + r] * b[c * 3 + 1] + a[6 + r] * b[c * 3 + 2];
  return out;
}
const transpose3 = m => [m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]];
const apply3 = (m, [x, y, z]) => [m[0] * x + m[3] * y + m[6] * z, m[1] * x + m[4] * y + m[7] * z, m[2] * x + m[5] * y + m[8] * z];
const turnOf = rotation => rotationOf(retarget.jointLocal([1, 1, 1], rotation, [0, 0, 0]));
// How far apart two rotations are, in radians
const turnApart = (a, b) => { let t = 0; for (let k = 0; k < 9; k++) t += a[k] * b[k]; return Math.acos(Math.max(-1, Math.min(1, (t - 1) / 2))); };
// The shortest turn taking direction `from` to direction `to` (both of length 1)
function turnBetween(from, to) {
  const axis = cross(from, to), s = length(axis), c = dot(from, to);
  if (s < 1e-9) return c > 0 ? [1, 0, 0, 0, 1, 0, 0, 0, 1] : turnAbout(unit(cross(from, Math.abs(from[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0])), Math.PI);
  return turnAbout(scaled(axis, 1 / s), Math.atan2(s, c));
}
function turnAbout([x, y, z], angle) {
  const c = Math.cos(angle), s = Math.sin(angle), t = 1 - c;
  return [t * x * x + c, t * x * y + s * z, t * x * z - s * y, t * x * y - s * z, t * y * y + c, t * y * z + s * x, t * x * z + s * y, t * y * z - s * x, t * z * z + c];
}

// Each joint's matrix in the model's space on one frame of `values` (nine values a joint, hsd-model.js's order)
function worlds(model, values, frame) {
  const count = model.joints.length, out = new Array(count);
  for (let j = 0; j < count; j++) {
    const o = (frame * count + j) * 9;
    const local = retarget.jointLocal([values[o], values[o + 1], values[o + 2]], [values[o + 3], values[o + 4], values[o + 5]], [values[o + 6], values[o + 7], values[o + 8]]);
    const parent = model.joints[j].parent;
    out[j] = parent >= 0 ? multiply(out[parent], local) : local;
  }
  return out;
}
const restValues = model => Float32Array.from(model.joints.flatMap(joint => [...joint.scale, ...joint.rotation, ...joint.translation]));

// Sets joint j's rotation on a frame so its turn in the model's space is `world` (a 3x3), under its parent as posed
function setWorldTurn(model, values, frame, posed, j, world) {
  const parent = model.joints[j].parent, local = parent >= 0 ? mul3(transpose3(rotationOf(posed[parent])), world) : world;
  values.set(retarget.eulerOf(local), (frame * model.joints.length + j) * 9 + 3);
}

// A leg's joints by place, from the hips down: a hip is often two joints in one place, one turning the other. The hips
// joint itself only when the leg starts there.
function legGroups(at, hips, chain, height) {
  const groups = placeGroups(at, [hips, ...chain], height);
  if (groups[0].length === 1 && groups[0][0] === hips && groups.length > 3) groups.shift();
  if (groups.length < 3) throw new Error('A hero\'s leg isn\'t a thigh, knee and ankle.');
  return groups;
}

// A leg's thigh, knee and ankle joints: the last joint at each of its first three places
function legJoints(at, hips, chain, height) {
  const [thigh, knee, ankle] = legGroups(at, hips, chain, height).slice(0, 3).map(group => group[group.length - 1]);
  return { thigh, knee, ankle };
}

// A chain's joints by place, from the body outwards (a shoulder is often two joints in one place, one turning the other)
function placeGroups(at, chain, height) {
  const groups = [];
  for (const j of chain) {
    const last = groups[groups.length - 1];
    if (last && length(sub(at[j], at[last[0]])) < height * 1e-3) last.push(j);
    else groups.push([j]);
  }
  return groups;
}

// Two chains matched place by place, from the body outwards (the hero's places past Michael's last on his last): within
// a place, from the last joint back, as the last one there is the one turning the bone to the next place.
function matchPlaces(map, mine, his) {
  mine.forEach((group, k) => {
    const at = his[Math.min(k, his.length - 1)];
    group.forEach((j, n) => { map[j] = at[Math.max(0, at.length - group.length + n)]; });
  });
}

// The limbs matched by place rather than by height: a battle model's pelvis joint sits on the ground, where matching by
// height takes it for one of Michael's ankles, and his shoulder is two joints in one place, where the hero's upper arm
// matched to the first would stay held out. The hips go to his hips; each leg (hip, knee, ankle, toes) and arm
// (collarbone, shoulder, elbow, wrist, hand) place by place.
function matchLimbs(match, michael, hero) {
  match.map[hero.limbs.hips] = michael.limbs.hips;
  const legOf = (body, chain) => legGroups(body.at, body.limbs.hips, chain, body.height).map(group => group.filter(j => j !== body.limbs.hips)).filter(group => group.length);
  hero.limbs.legs.forEach((chain, i) => matchPlaces(match.map, legOf(hero, chain), legOf(michael, michael.limbs.legs[i])));
  hero.limbs.arms.forEach((chain, i) => {
    if (chain.length && michael.limbs.arms[i].length) matchPlaces(match.map, placeGroups(hero.at, chain, hero.height), placeGroups(michael.at, michael.limbs.arms[i], michael.height));
  });
}

// Every vertex at the rest pose, with the joint that moves it most (as hero-retarget.js reads them)
function restVertices(model, world) {
  const inverse = model.inverseBind.map(m => m && Array.from(m));
  const draw = model.draw.map(({ parts }) => {
    const m = new Array(16).fill(0);
    for (const { joint, weight, inverse: undo } of parts) {
      const part = undo && inverse[joint] ? multiply(world[joint], inverse[joint]) : world[joint];
      for (let e = 0; e < 16; e++) m[e] += part[e] * weight;
    }
    const main = parts.reduce((best, part) => (part.weight > best.weight ? part : best), parts[0]);
    return { m, joint: main ? main.joint : -1 };
  });
  const out = [];
  for (const shape of model.shapes) for (let i = 0; i < shape.drawIndex.length; i++) {
    const d = draw[shape.drawIndex[i]];
    if (d && d.joint >= 0) out.push({ at: applyPoint(d.m, [shape.position[i * 3], shape.position[i * 3 + 1], shape.position[i * 3 + 2]]), joint: d.joint });
  }
  return out;
}

// A foot: its vertices (those the ankle and the joints past it move most) in the ankle's own frame at rest, and the
// ground: the model's lowest vertex at rest
function feetOf(model, world, at, limbs, height, legs) {
  const vertices = restVertices(model, world);
  return {
    ground: Math.min(...vertices.map(v => v.at[1])),
    soles: limbs.legs.map((chain, i) => {
      const joints = new Set(legGroups(at, limbs.hips, chain, height).slice(2).flat()), undo = invertAffine(world[legs[i].ankle]);
      return vertices.filter(v => joints.has(v.joint)).map(v => applyPoint(undo, v.at));
    }),
  };
}
const lowest = (m, sole, vector = false) => sole.reduce((low, v) => Math.min(low, (vector ? applyVector : applyPoint)(m, v)[1]), Infinity);

// What moving Michael's clips onto a hero needs: the matched joints, the legs, the leg scale and the hips' middle.
function rigFor(michael, hero) {
  const match = retarget.matchJoints(michael, hero);
  const ms = retarget.skeletonOf(michael), hs = retarget.skeletonOf(hero), ml = retarget.limbs(ms), hl = retarget.limbs(hs);
  const mAt = ms.world.map(placeOf), hAt = hs.world.map(placeOf);
  const torso = matchSpine(match, { model: michael, limbs: ml }, { model: hero, limbs: hl });
  matchLimbs(match, { limbs: ml, at: mAt, height: ms.height }, { limbs: hl, at: hAt, height: hs.height });
  const mLegs = ml.legs.map(chain => legJoints(mAt, ml.hips, chain, ms.height));
  const hLegs = hl.legs.map(chain => legJoints(hAt, hl.hips, chain, hs.height));
  // hips to ankle, at rest, as tall as Michael's
  const drop = (at, leg) => at[leg.thigh][1] - at[leg.ankle][1];
  const legScale = (drop(hAt, hLegs[0]) + drop(hAt, hLegs[1])) / (drop(mAt, mLegs[0]) + drop(mAt, mLegs[1]));
  if (!(legScale > 0.2 && legScale < 5)) throw new Error('A hero\'s legs don\'t match Michael\'s.');
  match.scale = legScale;
  const heroCentre = middle(hAt[hLegs[0].thigh], hAt[hLegs[1].thigh]);
  return {
    match, legScale, mLegs, hLegs, hips: match.hips, torso,
    michaelCentre: middle(mAt[mLegs[0].thigh], mAt[mLegs[1].thigh]), heroCentre,
    // the hips' middle in the hips joint's own frame
    centreLocal: applyPoint(invertAffine(hs.world[match.hips]), heroCentre),
    // where each foot is moved from: the hero's own ankle at rest, as wide apart and as high, but as far ahead of the
    // hips as Michael's (scaled), so the stride falls about the hips as his does: a battle model's rest foot is a little
    // behind or ahead of the hips, and moved from there the hero's leg comes up short at the end of a step
    mAnkles: mLegs.map(leg => mAt[leg.ankle]),
    hAnkles: hLegs.map((leg, i) => [hAt[leg.ankle][0], hAt[leg.ankle][1], heroCentre[2] + (mAt[mLegs[i].ankle][2] - middle(mAt[mLegs[0].thigh], mAt[mLegs[1].thigh])[2]) * legScale]),
    bones: hLegs.map(leg => ({ a: length(sub(hAt[leg.knee], hAt[leg.thigh])), b: length(sub(hAt[leg.ankle], hAt[leg.knee])) })),
    // the way the model faces (+Z) in each thigh's own frame at rest
    fronts: hLegs.map(leg => apply3(transpose3(rotationOf(hs.world[leg.thigh])), [0, 0, 1])),
    mThighs: mLegs.map(leg => length(sub(mAt[leg.knee], mAt[leg.thigh]))),
    mFeet: feetOf(michael, ms.world, mAt, ml, ms.height, mLegs), hFeet: feetOf(hero, hs.world, hAt, hl, hs.height, hLegs),
    // the joints turned from rest as Michael's (fieldClip): the hips, the spine, each foot from the ankle down
    asAtRest: [hl.hips, ...hl.spine, ...hl.legs.flatMap(chain => legGroups(hAt, hl.hips, chain, hs.height).slice(2).flat())].filter(j => match.map[j] >= 0).sort((a, b) => a - b),
    michaelRestTurns: ms.world.map(m => transpose3(rotationOf(m))), heroRestTurns: hs.world.map(rotationOf),
    height: hs.height, mHeight: ms.height,
  };
}

// How far a leg of bones `a` and `b` reaches toward a point `distance` away: all the way until it's nearly straight,
// then easing to straight (never quite) rather than snapping straight and back at the end of a step, when the hero's
// proportions ask a little more of the leg than Michael's do of his
const SOFT_REACH = 0.97;
function softReach(distance, a, b) {
  const most = a + b, soft = most * SOFT_REACH, least = Math.abs(a - b) + 1e-4 * most;
  if (distance <= soft) return Math.max(least, distance);
  return soft + (most - soft) * Math.tanh((distance - soft) / (most - soft)) * (1 - 1e-4);
}

// Michael's clip (frames of nine values for each of his joints) on the hero's skeleton
function fieldClip(michael, hero, rig, clip) {
  const { match, legScale } = rig, values = Float32Array.from(retarget.retarget(michael, clip, hero, match).values);
  const count = hero.joints.length, hipsParent = hero.joints[rig.hips].parent;
  for (let frame = 0; frame < clip.frames; frame++) {
    const mw = worlds(michael, clip.values, frame);
    let hw = worlds(hero, values, frame);
    // the hips, spine and feet: each turned from the hero's rest as Michael's joint turns from his. Both stand upright
    // at rest, feet flat; turned to point their bones along his (hero-retarget.js, right for arms held out at other
    // angles) they'd take on his skeleton's leans: his neck joint leans back, his pelvis joint forward.
    const turns = hw.map(rotationOf);
    for (const j of rig.asAtRest) turns[j] = mul3(mul3(rotationOf(mw[match.map[j]]), rig.michaelRestTurns[match.map[j]]), rig.heroRestTurns[j]);
    // (a matched joint hanging on one of them keeps its own turn; the others hang on as they are)
    for (let j = 0, own = new Set(rig.asAtRest); j < count; j++) {
      const parent = hero.joints[j].parent;
      if (!own.has(j) && !(match.map[j] >= 0 && parent >= 0 && own.has(parent))) continue;
      setWorldTurn(hero, values, frame, hw, j, turns[j]);
      hw = worlds(hero, values, frame);
    }
    // the hips: their middle where Michael's is, scaled from rest
    const centre = add(rig.heroCentre, scaled(sub(middle(placeOf(mw[rig.mLegs[0].thigh]), placeOf(mw[rig.mLegs[1].thigh])), rig.michaelCentre), legScale));
    const place = sub(centre, applyVector(hw[rig.hips], rig.centreLocal));
    values.set(hipsParent >= 0 ? applyPoint(invertAffine(hw[hipsParent]), place) : place, (frame * count + rig.hips) * 9 + 6);
    hw = worlds(hero, values, frame);
    // each leg bent to put its ankle where Michael's is, scaled from rest
    rig.hLegs.forEach((leg, i) => {
      // the ankle across and along as Michael's (scaled from rest); up, so the foot's lowest point is as far off the
      // ground as his foot's (scaled), or on it when his goes into it: his toes take the last push of a run step,
      // and a foot of other proportions lifted as his ankle is would leave the ground early
      const goal = add(rig.hAnkles[i], scaled(sub(placeOf(mw[rig.mLegs[i].ankle]), rig.mAnkles[i]), legScale));
      // (near the ground: up in the air, the ankle goes where his goes, scaled, as across and along)
      if (rig.hFeet.soles[i].length && rig.mFeet.soles[i].length) {
        const lift = Math.max(0, lowest(mw[rig.mLegs[i].ankle], rig.mFeet.soles[i]) - rig.mFeet.ground);
        const near = 1 - Math.min(1, Math.max(0, (lift / rig.mHeight - 0.005) / 0.01));
        const planted = rig.hFeet.ground + lift * legScale - lowest(hw[leg.ankle], rig.hFeet.soles[i], true);
        goal[1] += (planted - goal[1]) * near * near * (3 - 2 * near);
      }
      const hip = placeOf(hw[leg.thigh]), knee0 = placeOf(hw[leg.knee]);
      const { a, b } = rig.bones[i], toward = sub(goal, hip);
      const reach = softReach(length(toward), a, b);
      const u = unit(toward);
      // the knee bends the way Michael's does (off the line from his hip to his ankle), and when his leg is nearly
      // straight, to the front of the thigh as it's turned (the way the model faces at rest, +Z, turned with it)
      const perpendicular = v => sub(v, scaled(u, dot(v, u)));
      const mHip = placeOf(mw[rig.mLegs[i].thigh]), mLine = unit(sub(placeOf(mw[rig.mLegs[i].ankle]), mHip)), mKnee = sub(placeOf(mw[rig.mLegs[i].knee]), mHip);
      const his = sub(mKnee, scaled(mLine, dot(mKnee, mLine)));
      const front = unit(perpendicular(apply3(rotationOf(hw[leg.thigh]), rig.fronts[i])));
      let pole = add(scaled(perpendicular(his), 1 / rig.mThighs[i]), scaled(front, 0.05));
      if (length(pole) < 1e-6) pole = perpendicular(sub(knee0, hip));
      pole = unit(pole);
      const cosine = Math.max(-1, Math.min(1, (a * a + reach * reach - b * b) / (2 * a * reach)));
      const knee = add(hip, scaled(add(scaled(u, cosine), scaled(pole, Math.sqrt(1 - cosine * cosine))), a));
      const ankle = add(hip, scaled(u, reach));
      const ankleTurn = rotationOf(hw[leg.ankle]);
      const thighTurn = turnBetween(unit(sub(knee0, hip)), unit(sub(knee, hip)));
      setWorldTurn(hero, values, frame, hw, leg.thigh, mul3(thighTurn, rotationOf(hw[leg.thigh])));
      hw = worlds(hero, values, frame);
      const kneeTurn = turnBetween(unit(sub(placeOf(hw[leg.ankle]), placeOf(hw[leg.knee]))), unit(sub(ankle, knee)));
      setWorldTurn(hero, values, frame, hw, leg.knee, mul3(kneeTurn, rotationOf(hw[leg.knee])));
      hw = worlds(hero, values, frame);
      setWorldTurn(hero, values, frame, hw, leg.ankle, ankleTurn);
      hw = worlds(hero, values, frame);
    });
  }
  return { samples: clip.frames, values };
}

// Each joint's rotation as angles that move as little as they can from one frame to the next, starting nearest the
// joint's rest angles, and exactly its rest angles when it's turned as at rest: the game draws between keys (and blends
// clips), and the same turn as other angles would whip the joint round in between. Rotated X, then Y, then Z, (x, y, z)
// is the same turn as (x + pi, pi - y, z + pi), and any angle a whole turn more.
function steadyTurns(values, samples, rest) {
  const count = rest.length / 9, turn = 2 * Math.PI, near = (angle, to) => angle - turn * Math.round((angle - to) / turn);
  for (let j = 0; j < count; j++) {
    const restAngles = Array.from(rest.subarray(j * 9 + 3, j * 9 + 6)), restTurn = turnOf(restAngles);
    let previous = restAngles;
    for (let frame = 0; frame < samples; frame++) {
      const at = (frame * count + j) * 9 + 3, [x, y, z] = values.subarray(at, at + 3);
      let chosen;
      if (turnApart(turnOf([x, y, z]), restTurn) < 1e-5) chosen = restAngles;
      else {
        const [px, py, pz] = previous;
        const choices = [[x, y, z], [x + Math.PI, Math.PI - y, z + Math.PI]].map(([a, b, c]) => [near(a, px), near(b, py), near(c, pz)]);
        const distance = ([a, b, c]) => Math.abs(a - px) + Math.abs(b - py) + Math.abs(c - pz);
        chosen = distance(choices[0]) <= distance(choices[1]) ? choices[0] : choices[1];
      }
      values.set(chosen, at);
      previous = chosen;
    }
  }
}

// The channels any clip moves off the joint's rest values, on each joint; never the root joint's, which the game sets.
function movedChannels(clips, rest) {
  const count = rest.length / 9, keyed = Array.from({ length: count }, () => new Set());
  for (const clip of clips) for (let frame = 0; frame < clip.samples; frame++) for (let j = 1; j < count; j++)
    for (let channel = 3; channel < 9; channel++) {
      const value = clip.values[(frame * count + j) * 9 + channel], at = rest[j * 9 + channel];
      if (Math.abs(value - at) > 1e-6) {
        // a turn keys all three angles, a move all three places
        const first = channel < 6 ? 3 : 6;
        for (let k = first; k < first + 3; k++) keyed[j].add(k);
      }
    }
  return keyed;
}

// The joints the hero's legs and pins hang on that the clips set: legs the game would bend itself are made plain
// joints, and pins on joints the clips move (Wes's pelvis) taken off. JObj flags and constraints, by joint.
function rigEdits(heroDat, match) {
  const dat = readDat(heroDat), { pointer } = reader(dat), joints = jointOffsets(dat, sceneSet(dat));
  const plain = [], unpinned = [];
  joints.forEach((at, j) => {
    if (dat.data.readUInt32BE(at + JOBJ_FLAGS) & JOBJ_IK_MASK) plain.push(j);
    else if (pointer(at + JOBJ_ROBJ) && match.map[j] >= 0) unpinned.push(j);
  });
  return { plain, unpinned };
}

// A body's chest (the joint both arms hang from: Michael's PeopleInfo row names his, 18) and its head (two joints up the
// spine from the chest, past the neck: his row's neck joint, 30), from its limbs (hero-retarget.js).
function torsoOf(model, limbs) {
  const roots = limbs.arms.filter(arm => arm.length).map(arm => model.joints[arm[0]].parent);
  const chest = roots.find(j => limbs.spine.includes(j)) ?? limbs.spine[0];
  const at = limbs.spine.indexOf(chest);
  return { chest, neck: limbs.spine[Math.min(at + 1, limbs.spine.length - 1)], head: limbs.spine[Math.min(at + 2, limbs.spine.length - 1)], spine: limbs.spine, at };
}

// The spine matched by what each joint is rather than by height (Michael is a child, with a bigger head): the hero's
// joints up to the chest turn as Michael's chest, the next as his neck, the rest (the head, a hat) as his head.
function matchSpine(match, michael, hero) {
  const m = torsoOf(michael.model, michael.limbs), h = torsoOf(hero.model, hero.limbs);
  h.spine.forEach((j, i) => { match.map[j] = i <= h.at ? m.chest : i === h.at + 1 ? m.neck : m.head; });
  return { michael: m, hero: h };
}

function prepare(heroBattlePkxXd, michaelPeople) {
  const heroPkx = colosseumPkx(heroBattlePkxXd), heroDat = heroPkx.subarray(PKX_HEADER, PKX_HEADER + heroPkx.readUInt32BE(0));
  const hero = hsd.parseModel(heroPkx), michael = hsd.parseModel(asPkx(michaelPeople));
  const slots = clipSlots(michaelPeople);
  if (slots.length !== CLIP_SLOTS) throw new Error('Michael\'s field model isn\'t as expected.');
  return { heroDat, hero, michael, slots, rig: rigFor(michael, hero) };
}

// Where the field model's numbers differ from Michael's: the hero's joints for his neck and chest, and how much
// further the hero's feet go than his (scale his PeopleInfo walk and run lengths by it).
function fieldInfo(heroBattlePkxXd, michaelPeople) {
  const { rig } = prepare(heroBattlePkxXd, michaelPeople);
  return { neck: rig.torso.hero.head, chest: rig.torso.hero.chest, legScale: rig.legScale };
}

// An XD people model (a people_archive.fsys entry's bytes, an HSD .dat) of the hero whose XD battle pkx is given, with
// Michael's field clips at his clip indices. `michaelPeople` is his rinto_0000 entry (his walk, run and idle, and the
// skeleton the rest is fitted to); `more` his other field models (people_archive's other rinto entries), whose clips
// fill the slots rinto_0000 leaves empty. XD numbers the people clips once for every model, and the game opens rinto_1000
// on the S.S. Libra and elsewhere, asking it for clips rinto_0000 hasn't got: gimmickBox.cpp's crate push (31, 32, 33)
// and jump off a crate (34), timed by their lengths. The hero's one model stands in for all of Michael's
// (host/xd/player.c), so it carries every clip any of his has: each slot from the first model, in the order given, that
// has that slot, fitted from that model's own skeleton.
function buildFieldModel(heroBattlePkxXd, michaelPeople, { compact = true, more = [] } = {}) {
  const { heroDat, hero, michael, slots, rig } = prepare(heroBattlePkxXd, michaelPeople);
  const rest = restValues(hero);
  const lists = [slots, ...more.map(people => {
    const other = clipSlots(people);
    if (other.length !== CLIP_SLOTS) throw new Error('Michael\'s field model isn\'t as expected.');
    return other;
  })];
  const from = clipSources(lists), sources = [];
  // only a model a clip comes from is fitted
  for (const k of new Set(from.filter(k => k >= 0))) {
    const people = k ? more[k - 1] : michaelPeople, body = k ? hsd.parseModel(asPkx(people)) : michael;
    sources[k] = { michael: body, slots: lists[k], rig: k ? rigFor(body, hero) : rig, longer: longerClips(people, lists[k]) };
  }
  const clips = from.map((k, index) => {
    if (k < 0) return null;
    const source = sources[k], slot = source.slots[index], clip = michaelClip(source.longer, index);
    if (clip.frames !== Math.ceil(slot.end) + 1) throw new Error('Michael\'s field model isn\'t as expected.');
    const moved = fieldClip(source.michael, hero, source.rig, clip);
    steadyTurns(moved.values, moved.samples, rest);
    return { ...moved, end: slot.end, flags: slot.flags };
  });
  const keyed = movedChannels(clips.filter(Boolean), rest);
  // a rotation to within a twentieth of a degree, a position to within a ten-thousandth of the hero's height
  const tolerances = [1e-4, Math.PI / 3600, rig.height * 1e-4];
  return fieldDat(heroDat, clips, keyed, tolerances, rigEdits(heroDat, rig.match), { compact });
}

// Which of several people models' clip slots (clipSlots lists, in order) each slot's clip comes from: the first that
// has one, or -1 when none has.
function clipSources(lists) {
  return Array.from({ length: Math.max(0, ...lists.map(list => list.length)) }, (_, index) => lists.findIndex(list => list[index]));
}

module.exports = {
  VERSION, CLIP_SLOTS, buildFieldModel, fieldInfo, clipSources,
  // for hero-snag.js, which moves Michael's battle clips onto the heroes' battle models as these move his field clips
  rigFor, fieldClip, addClip, readDat, writeDat, Added, reader, sceneSet, jointOffsets, worlds, restValues, steadyTurns,
  // for the tests
  fieldDat, compactDat, clipSlots, encodeTrack, keyFrames, movedChannels, softReach, placeGroups, legJoints, matchPlaces, asPkx,
};
