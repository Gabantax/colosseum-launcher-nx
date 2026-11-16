'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const snag = require('../src/hero-snag');

const JOINT1 = 0x200000, JOINT2 = 0x400000, EFFECTOR = 0x600000;
const plain = (refs = []) => ({ type: 0, refs, hint: null });

// A limb the game bends: the root, then the limb's first joint (JOINT1, bone 1), its second (JOINT2, bone 1), the
// effector reaching for a target joint, and the target, under the root at `target`. Values: scale 1, no turn, and each
// joint where `places` puts it under its parent.
function limb(target, { flip = false, pole = null } = {}) {
  const parents = [-1, 0, 1, 2, 0], joints = parents.map(parent => ({ parent }));
  const rig = [plain(), { type: JOINT1, refs: [], hint: { length: 1, turn: 0, flip: false } }, { type: JOINT2, refs: [], hint: { length: 1, turn: 0, flip } },
    { type: EFFECTOR, refs: [{ type: 1, joint: 4 }], hint: null }, plain()];
  const places = [[0, 0, 0], [0, 0, 0], [3, 0, 0], [5, 2, 0], target];
  if (pole) { joints.push({ parent: 0 }); rig.push(plain()); places.push(pole); rig[1].refs.push({ type: 3, joint: 5 }); }
  const values = new Float32Array(joints.length * 9);
  places.forEach((place, j) => values.set([1, 1, 1, 0, 0, 0, ...place], j * 9));
  return { model: { joints }, rig, values };
}
const place = m => [m[12], m[13], m[14]];
const near = (a, b, tolerance = 1e-5) => assert.ok(a.every((v, k) => Math.abs(v - b[k]) < tolerance), `${a} isn't ${b}`);
const distance = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

test('a bent limb reaches its target with bones of its hints\' lengths, whatever its own joints say', () => {
  const { model, rig, values } = limb([1, 1, 0]);
  const world = snag.posed(model, rig, values, 0);
  near(place(world[3]), [1, 1, 0]);
  near(place(world[1]), [0, 0, 0]);
  assert.ok(Math.abs(distance(place(world[2]), [0, 0, 0]) - 1) < 1e-5);
  assert.ok(Math.abs(distance(place(world[2]), [1, 1, 0]) - 1) < 1e-5);
  // the elbow bends in the plane the first joint's own Z axis is square to (no pole), on the side the hint says
  assert.ok(Math.abs(place(world[2])[2]) < 1e-5);
  const other = limb([1, 1, 0], { flip: true }), flipped = snag.posed(other.model, other.rig, other.values, 0);
  near(place(flipped[3]), [1, 1, 0]);
  assert.ok(distance(place(flipped[2]), place(world[2])) > 1, 'the flipped elbow is on the other side');
});

test('a limb out of reach points straight at its target, and a pole picks the side the elbow bends to', () => {
  const far = limb([4, 0, 0]);
  const world = snag.posed(far.model, far.rig, far.values, 0);
  near(place(world[2]), [1, 0, 0]);
  near(place(world[3]), [2, 0, 0]);
  const up = limb([1.5, 0, 0], { pole: [0.75, 5, 0] }), down = limb([1.5, 0, 0], { pole: [0.75, -5, 0] });
  assert.ok(place(snag.posed(up.model, up.rig, up.values, 0)[2])[1] > 0.5);
  assert.ok(place(snag.posed(down.model, down.rig, down.values, 0)[2])[1] < -0.5);
});

test('a joint pinned to another sits where that one is', () => {
  const joints = [{ parent: -1 }, { parent: 0 }, { parent: 0 }], rig = [plain(), plain([{ type: 1, joint: 2 }]), plain()];
  const values = new Float32Array(27);
  [[0, 0, 0], [1, 2, 3], [-4, 5, 6]].forEach((p, j) => values.set([1, 1, 1, 0, 0, 0, ...p], j * 9));
  near(place(snag.posed({ joints }, rig, values, 0)[1]), [-4, 5, 6]);
});

test('a clip\'s bent limbs set as drawn: its plain joints then put each where the game draws it', () => {
  const { model, rig, values } = limb([1, 1, 0]);
  const clip = snag.withLimbsSet(model, rig, { frames: 1, values });
  const unbent = rig.map(() => plain());
  const drawn = snag.posed(model, rig, values, 0), plainly = snag.posed(model, unbent, clip.values, 0);
  for (const j of [1, 2, 3]) near(place(plainly[j]), place(drawn[j]), 1e-4);
});

test('an XD battle model\'s slots: the first motion in use, and the joints its effects attach to', () => {
  const pkx = Buffer.alloc(0x84 + 8 * 0xd0);
  pkx.writeUInt32BE(8, 0x10);
  const slot = 0x84 + 7 * 0xd0;
  pkx.writeUInt32BE(2, slot + 4);
  pkx.writeUInt32BE(0, slot + 0x8c);
  pkx.writeUInt32BE(1, slot + 0x8c + 8);
  pkx.writeUInt32BE(0x3e, slot + 0x8c + 12);
  for (let k = 0; k < 16; k++) pkx.writeInt32BE(k === 6 ? 29 : -1, slot + 0x4c + k * 4);
  assert.equal(snag.slotClip(pkx, 7), 0x3e);
  assert.equal(snag.slotClip(pkx, 6), -1);
  assert.equal(snag.slotJoints(pkx, 7)[6], 29);
  assert.equal(snag.slotJoints(pkx, 7)[0], -1);
});

test('the Customize preview bends limbs and pins joints as the snag\'s emulation does (model-rig.js)', async () => {
  const { createRig } = await import('../src/model-rig.js');
  const limbOf = { [JOINT1]: 1, [JOINT2]: 2, [EFFECTOR]: 3 };
  const check = ({ model, rig, values }) => {
    const joints = model.joints.map(({ parent }, j) => ({ parent, scale: [1, 1, 1], rotation: [0, 0, 0], translation: [0, 0, 0],
      ...(rig[j].type || rig[j].refs.length || rig[j].hint ? { constraint: { limb: limbOf[rig[j].type] || 0, refs: rig[j].refs, hint: rig[j].hint } } : {}) }));
    const preview = createRig({ joints, inverseBind: joints.map(() => null), draw: [], shapes: [] }, () => null);
    preview.pose(values);
    const expected = snag.posed(model, snag.rigOfModel({ joints }), values, 0);
    joints.forEach((_, j) => near(place(Array.from(preview.world[j].elements)), place(expected[j]), 1e-4));
  };
  check(limb([1, 1, 0]));
  check(limb([1, 1, 0], { flip: true }));
  check(limb([1.5, 0, 0], { pole: [0.75, 5, 0] }));
  check(limb([4, 0, 0]));
  const joints = [{ parent: -1 }, { parent: 0 }, { parent: 0 }], rig = [plain(), plain([{ type: 1, joint: 2 }]), plain()];
  const values = new Float32Array(27);
  [[0, 0, 0], [1, 2, 3], [-4, 5, 6]].forEach((p, j) => values.set([1, 1, 1, 0, 0, 0, ...p], j * 9));
  check({ model: { joints }, rig, values });
});
