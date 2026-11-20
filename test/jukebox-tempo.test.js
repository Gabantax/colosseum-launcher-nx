'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const tempo = require('../src/jukebox-tempo');

// A song to find the beat of: a kick drum (a short falling tone) on each beat, the first of each bar harder, a hi-hat between the beats, and a
// steady pad under it all.
function song({ bpm, offset, seconds = 40, rate = 32000, noise = 0 }) {
  const left = new Float32Array(rate * seconds), right = new Float32Array(rate * seconds), period = 60 / bpm;
  let seed = 7;
  const random = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32 - 0.5; };
  for (let i = 0; i < left.length; i++) {
    const t = i / rate;
    let value = 0.15 * Math.sin(2 * Math.PI * 220 * t) + noise * random();
    const since = (t - offset) % period, beatNumber = Math.floor((t - offset) / period);
    if (t >= offset && since < 0.12) value += (beatNumber % 4 === 0 ? 1 : 0.7) * Math.sin(2 * Math.PI * (55 + 120 * Math.exp(-since * 30)) * since) * Math.exp(-since * 25);
    const off = (t - offset - period / 2) % period;
    if (t >= offset && off >= 0 && off < 0.03) value += 0.25 * random();
    left[i] = right[i] = value;
  }
  return { left, right, rate };
}

// How far `found` is from the nearest beat of the true grid, in seconds
const phaseError = (found, truth) => {
  const d = ((found.offset - truth.offset) % truth.period + truth.period) % truth.period;
  return Math.min(d, truth.period - d);
};

test('the FFT finds a tone where it is', () => {
  const n = 256, re = new Float64Array(n), im = new Float64Array(n);
  for (let i = 0; i < n; i++) re[i] = Math.sin(2 * Math.PI * 16 * i / n);
  tempo.fft(re, im);
  let peak = 0;
  for (let k = 1; k < n / 2; k++) if (Math.hypot(re[k], im[k]) > Math.hypot(re[peak], im[peak])) peak = k;
  assert.equal(peak, 16);
});

for (const [bpm, offset] of [[117, 0.23], [96, 0.41], [140, 0.05], [128, 0.3]]) {
  test(`${bpm} BPM starting ${offset} s in: the tempo and the beats' place are found, to within a few thousandths and a few hundredths of a second`, () => {
    const { left, right, rate } = song({ bpm, offset });
    const found = tempo.analyze(left, right, rate);
    assert.ok(found, 'a result');
    assert.ok(Math.abs(found.period - 60 / bpm) / (60 / bpm) < 0.006, `period ${found.period} against ${60 / bpm}`);
    assert.ok(phaseError(found, { offset, period: 60 / bpm }) < 0.025, `the beats are ${phaseError(found, { offset, period: 60 / bpm })} s out`);
    assert.ok(found.confidence > tempo.CONFIDENT, `confidence ${found.confidence}`);
  });
}

test('the first beat of a bar is the one the drum hits hardest', () => {
  const { left, right, rate } = song({ bpm: 120, offset: 0.2 });
  const found = tempo.analyze(left, right, rate);
  // the beat at `offset` is number `bar` of its bar: the harder kicks fall on beats 0, 4, 8... of the true grid
  const beatOfTruth = Math.round((found.offset - 0.2) / 0.5);
  assert.equal(((beatOfTruth - found.bar) % 4 + 4) % 4 === 0 || found.bar === (4 - (beatOfTruth % 4)) % 4, true);
});

test('with noise on top the beat is still found, and with nothing but noise there is no confident answer', () => {
  const noisy = song({ bpm: 110, offset: 0.17, noise: 0.35 }), found = tempo.analyze(noisy.left, noisy.right, noisy.rate);
  assert.ok(Math.abs(found.period - 60 / 110) / (60 / 110) < 0.01);
  assert.ok(found.confidence > tempo.CONFIDENT, `confidence ${found.confidence}`);
  const rate = 32000, left = new Float32Array(rate * 30), right = new Float32Array(rate * 30);
  let seed = 3;
  for (let i = 0; i < left.length; i++) { seed = (seed * 1664525 + 1013904223) >>> 0; left[i] = right[i] = (seed / 2 ** 32 - 0.5) * 0.3; }
  const none = tempo.analyze(left, right, rate);
  assert.ok(!none || none.confidence < tempo.CONFIDENT, `noise gave confidence ${none?.confidence}`);
});

test('a song too short to tell is not guessed at', () => {
  const rate = 32000;
  assert.equal(tempo.analyze(new Float32Array(rate), new Float32Array(rate), rate), null);
});

test('a song\'s calm and intense parts are told apart, whatever its overall loudness', () => {
  const rate = 16000, seconds = 40, left = new Float32Array(rate * seconds), right = new Float32Array(rate * seconds);
  let seed = 11;
  const random = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32 - 0.5; };
  for (let i = 0; i < left.length; i++) {
    const t = i / rate, loud = t >= 20;
    // the first half a soft low tone; the second a loud one with a busy noisy top
    left[i] = right[i] = loud ? 0.5 * Math.sin(2 * Math.PI * 110 * t) + 0.3 * random() : 0.08 * Math.sin(2 * Math.PI * 110 * t) + 0.01 * random();
  }
  const profile = tempo.intensity(left, right, rate);
  assert.equal(profile.step, 0.25);
  assert.ok(profile.values.every(v => v >= 0 && v <= 1));
  assert.ok(tempo.intensityAt(profile, 8) < 0.3, `calm part ${tempo.intensityAt(profile, 8)}`);
  assert.ok(tempo.intensityAt(profile, 32) > 0.7, `intense part ${tempo.intensityAt(profile, 32)}`);
  assert.equal(tempo.intensityAt(null, 3), 0.5);
  // the fast profile follows quicker changes than the smoothed one
  const wiggle = (v, from, to) => { let total = 0; for (let i = Math.floor(from / 0.25) + 1; i < Math.floor(to / 0.25); i++) total += Math.abs(v[i] - v[i - 1]); return total; };
  assert.ok(wiggle(profile.fast, 0, 40) >= wiggle(profile.values, 0, 40));
  assert.ok(tempo.intensityAt(profile, 32, true) > 0.5);
  assert.equal(tempo.intensity(new Float32Array(100), new Float32Array(100), rate), null);
});

test('the drops and breaks of a song are found: where it kicks in and where it falls away', () => {
  const rate = 16000, seconds = 60, left = new Float32Array(rate * seconds), right = new Float32Array(rate * seconds);
  let seed = 5;
  const random = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32 - 0.5; };
  // soft for 20 s, then loud and busy until 40 s, then soft again
  for (let i = 0; i < left.length; i++) {
    const t = i / rate, loud = t >= 20 && t < 40;
    left[i] = right[i] = loud ? 0.5 * Math.sin(2 * Math.PI * 110 * t) + 0.3 * random() : 0.08 * Math.sin(2 * Math.PI * 110 * t) + 0.01 * random();
  }
  const { events } = tempo.intensity(left, right, rate);
  const drop = events.find(each => each.kind === 'drop'), pause = events.find(each => each.kind === 'break');
  assert.ok(drop && Math.abs(drop.time - 20) < 2.5, `drop at ${drop?.time}`);
  assert.ok(pause && Math.abs(pause.time - 40) < 2.5, `break at ${pause?.time}`);
  for (let i = 1; i < events.length; i++) assert.ok(events[i].time - events[i - 1].time >= 6, 'events are a few seconds apart');
  // a steady song has none
  for (let i = 0; i < left.length; i++) left[i] = right[i] = 0.2 * Math.sin(2 * Math.PI * 110 * i / rate);
  assert.deepEqual(tempo.intensity(left, right, rate).events, []);
});

test('a change of style at the same volume is found: new notes and a new sound, no louder and no brighter', () => {
  const rate = 16000, seconds = 60, left = new Float32Array(rate * seconds), right = new Float32Array(rate * seconds);
  // 30 s of a soft chord of three plain tones, then 30 s of another set of notes in a buzzier timbre, scaled to the same loudness
  const a = t => (Math.sin(2 * Math.PI * 220 * t) + Math.sin(2 * Math.PI * 277 * t) + Math.sin(2 * Math.PI * 330 * t)) / 3;
  const b = t => (Math.sin(2 * Math.PI * 196 * t) + 0.5 * Math.sin(2 * Math.PI * 392 * t) + 0.3 * Math.sin(2 * Math.PI * 784 * t) + Math.sin(2 * Math.PI * 247 * t)) / 2.2;
  let powerA = 0, powerB = 0;
  for (let i = 0; i < rate; i++) { powerA += a(i / rate) ** 2; powerB += b(i / rate) ** 2; }
  const gain = Math.sqrt(powerA / powerB);
  for (let i = 0; i < left.length; i++) { const t = i / rate; left[i] = right[i] = 0.2 * (t < 30 ? a(t) : b(t) * gain); }
  const found = tempo.intensity(left, right, rate).events;
  assert.ok(found.some(each => Math.abs(each.time - 30) < 1.5), `events ${found.map(each => each.time)}`);
});

test('an event is put on the beat of the song where the change is, not the quarter second it was found at', () => {
  // 120 BPM kicks; at beat 41 (20.5 s) the song gets a new sound: a brighter pad comes in under it
  const rate = 16000, seconds = 50, period = 0.5, left = new Float32Array(rate * seconds), right = new Float32Array(rate * seconds), change = 20.5;
  for (let i = 0; i < left.length; i++) {
    const t = i / rate, since = t % period;
    let v = 0.4 * Math.sin(2 * Math.PI * (60 + 90 * Math.exp(-since * 30)) * since) * Math.exp(-since * 25);
    if (t >= change) v += 0.25 * (Math.sin(2 * Math.PI * 440 * t) + Math.sin(2 * Math.PI * 660 * t) + Math.sin(2 * Math.PI * 1320 * t)) / 3;
    left[i] = right[i] = v;
  }
  const grid = { period, offset: 0, bar: 0 };
  const refined = tempo.refineEvents([{ time: 20.75, kind: 'drop', strength: 1 }], grid, left, right, rate);
  assert.equal(refined.length, 1);
  assert.equal(refined[0].beat, 41);
  assert.ok(Math.abs(refined[0].time - 20.5) < 1e-9);
  assert.deepEqual(tempo.refineEvents([], grid, left, right, rate), []);
  assert.deepEqual(tempo.refineEvents([{ time: 3, kind: 'drop', strength: 1 }], null, left, right, rate).length, 1, 'with no grid the events are left as they are');
});
