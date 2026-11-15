'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const gx = require('../src/gx-texture');
const heroBake = require('../src/hero-bake');
const colors = require('../src/hero-colors');

test('RGBA8 keeps every texel, past the edge of a texture that isn\'t whole tiles too', () => {
  const width = 6, height = 5, rgba = new Uint8Array(width * height * 4).map((_, i) => (i * 37 + 11) & 255);
  const data = heroBake.encodeRgba8(rgba, width, height);
  assert.equal(data.length, gx.textureSize(6, width, height));
  assert.deepEqual([...gx.decode(6, width, height, data)], [...rgba]);
});

// A pkx with one 4x4 image: its header, a model whose data is an HSD_ImageDesc and its texels, the relocation that
// points at them, and what follows the model (the particles and motion slots), which stays as it is.
function tinyPkx() {
  const data = Buffer.alloc(0x20 + 8);
  data.writeUInt32BE(0x20, 0);            // texels at 0x20
  data.writeUInt16BE(4, 4); data.writeUInt16BE(4, 6); data.writeUInt32BE(14, 8);
  data.writeUInt32BE(1, 0x0c);            // mipmaps, which the new texels haven't
  data.fill(0xab, 0x20);
  const relocations = Buffer.alloc(4);
  const header = Buffer.alloc(0x20);
  header.writeUInt32BE(0x20 + data.length + relocations.length, 0);
  header.writeUInt32BE(data.length, 4);
  header.writeUInt32BE(1, 8);
  const dat = Buffer.concat([header, data, relocations]);
  const top = Buffer.alloc(0x40);
  top.writeUInt32BE(dat.length, 0);
  top.writeUInt32BE(5, 0x10);
  const after = Buffer.from('the motion slots, as they were');
  return { pkx: Buffer.concat([top, dat, Buffer.alloc(((dat.length + 31) & ~31) - dat.length), after]), after };
}

test('repainted texels go after the model\'s data, pointed at as RGBA8, and the rest of the file stays as it is', () => {
  const { pkx, after } = tinyPkx();
  const texels = heroBake.encodeRgba8(new Uint8Array(64).fill(200), 4, 4);
  const out = heroBake.writePkx(pkx, [{ image: 0, data: texels, width: 4, height: 4 }]);
  const size = out.readUInt32BE(0), dat = out.subarray(0x40, 0x40 + size), dataSize = dat.readUInt32BE(4), data = dat.subarray(0x20, 0x20 + dataSize);
  assert.equal(dat.readUInt32BE(0), size);
  assert.equal(dat.readUInt32BE(8), 1, 'the same relocations');
  const at = data.readUInt32BE(0);
  assert.equal(at % 32, 0);
  assert.deepEqual(data.subarray(at, at + texels.length), texels);
  assert.equal(data.readUInt32BE(8), 6);
  assert.equal(data.readUInt32BE(0x0c), 0);
  assert.equal(dat.readUInt32BE(0x20 + dataSize), 0, 'the relocation table follows the data');
  assert.deepEqual(out.subarray(out.length - after.length), after);
  assert.equal(out.readUInt32BE(0x10), 5);
  assert.equal((0x40 + ((size + 31) & ~31)), out.length - after.length);
});

function plainWithStamp(hero, { magic = 0x43504852, broken = false } = {}) {
  const plain = Buffer.alloc(8 + 0x1dfd0), at = 8 + 0x1dfc0;
  plain.writeUInt32BE(magic, at);
  plain[at + 4] = 1;
  plain[at + 5] = hero;
  let check = 0x4e20c0de;
  for (let i = 0; i < 12; i += 4) check = Math.imul(check ^ plain.readUInt32BE(at + i), 0x01000193) >>> 0;
  plain.writeUInt32BE(broken ? check ^ 1 : check, at + 12);
  return plain;
}

test('a save\'s hero is the game\'s stamp in it, and Wes without a good one', () => {
  assert.equal(heroBake.stampedHero(plainWithStamp(3)), 'red');
  assert.equal(heroBake.stampedHero(plainWithStamp(1)), 'brendan');
  assert.equal(heroBake.stampedHero(plainWithStamp(3, { broken: true })), 'wes');
  assert.equal(heroBake.stampedHero(plainWithStamp(3, { magic: 0 })), 'wes');
  assert.equal(heroBake.stampedHero(plainWithStamp(9)), 'wes');
  assert.equal(heroBake.stampedHero(Buffer.alloc(16)), 'wes');
});

test('online, a player is the hero chosen for it, else their save\'s, in that hero\'s colours', () => {
  const looks = colors.normalizeLooks({ colors: { red: { vest: '#2F8A4A' }, may: { shirt: '#3a7ad8' } } });
  assert.equal(looks.online, null);
  assert.deepEqual(heroBake.onlineLook(looks, 'red'), { hero: 'red', colors: { vest: '#2f8a4a' } });
  assert.deepEqual(heroBake.onlineLook(looks, 'nobody'), { hero: 'wes', colors: {} });
  const chosen = colors.normalizeLooks({ ...looks, online: 'may' });
  assert.deepEqual(heroBake.onlineLook(chosen, 'red'), { hero: 'may', colors: { shirt: '#3a7ad8' } });
  assert.equal(colors.normalizeLooks({ online: 'gary' }).online, null);
});

test('a look from the room is a real hero and its real regions only', () => {
  assert.deepEqual(heroBake.normalizeLook({ hero: 'leaf', colors: { top: '#D04040', cape: '#000000', skirt: 'red' } }), { hero: 'leaf', colors: { top: '#d04040' } });
  assert.equal(heroBake.normalizeLook({ hero: 'gary' }), null);
  assert.equal(heroBake.normalizeLook(null), null);
  assert.equal(heroBake.painted({ hero: 'wes', colors: {} }), false);
});

test('the game hears each side\'s hero, with the model made in their colours when there is one', () => {
  const looks = [{ hero: 'red', colors: { vest: '#2f8a4a' } }, { hero: 'leaf', colors: {} }];
  assert.deepEqual(heroBake.lookLines(looks, [{ file: '/made/a b/hero.pkx' }, null]), ['look 0 3 /made/a b/hero.pkx', 'look 1 4']);
  assert.deepEqual(heroBake.lookLines([null, looks[1]], [null, null]), ['look 1 4']);
});
