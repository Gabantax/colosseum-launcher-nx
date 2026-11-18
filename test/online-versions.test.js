'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parse, order, compare, battleOf } = require('../src/online-versions');

const mine = (fields = {}) => ({ build: 'aaaa-bbbb', crossBuild: 'cross-aaaa', version: '2026.11.17.1', launcher: '0.5.0', protocol: 8,
  waiting: { launcher: false, game: false }, ...fields });
const room = (fields = {}) => ({ name: 'Rui', build: 'aaaa-bbbb', version: '2026.11.17.1', launcher: '0.5.0', protocol: 8, ...fields });

test('release and Beta versions of either game are put in order', () => {
  assert.deepEqual(parse('2026.11.17.1'), { date: [2026, 11, 17], number: 1, beta: null });
  assert.deepEqual(parse('XD 2026.11.17.xd2'), { date: [2026, 11, 17], number: 2, beta: null });
  assert.deepEqual(parse('2026.11.17-beta.37c245b'), { date: [2026, 11, 17], number: 0, beta: '37c245b' });
  assert.deepEqual(parse('XD 2026.11.17-beta.37c245b.xd'), { date: [2026, 11, 17], number: 0, beta: '37c245b' });
  assert.equal(parse('master@37c245b'), null);
  assert.equal(order('2026.11.20.1', '2026.11.17.1'), 1);
  assert.equal(order('2026.11.17.1', '2026.11.17.2'), -1);
  assert.equal(order('XD 2026.11.17.xd1', '2026.11.17.1'), 0);
  assert.equal(order('2026.11.18-beta.abcdef0', '2026.11.17.1'), 1);
  // a Beta game of the same day as a release can be either side of it
  assert.equal(order('2026.11.17-beta.abcdef0', '2026.11.17.1'), null);
  assert.equal(order('custom', '2026.11.17.1'), null);
});

test('a Stable player and a Beta player are told the channels differ, whichever way round', () => {
  const beta = compare(room({ build: 'beta-build', version: '2026.11.18-beta.abcdef0' }), mine());
  assert.equal(beta.direction, 'channel');
  assert.match(beta.detail, /Rui is on Beta \(game 2026\.11\.18-beta\.abcdef0\) and you're on Stable/);
  assert.match(beta.detail, /join the Beta under Settings → Launcher/);
  const stable = compare(room({ build: 'old-build', version: '2026.11.12.1' }), mine({ version: '2026.11.17-beta.37c245b' }));
  assert.match(stable.detail, /You're on Beta .* and Rui is on Stable/);
  // two Betas apart: the older one needs the newest Beta
  assert.equal(compare(room({ build: 'b2', version: '2026.11.18-beta.abcdef0' }), mine({ version: '2026.11.17-beta.37c245b' })).direction, 'newer');
  // the same commit on both channels is the same build: they battle
  assert.equal(compare(room({ version: '2026.11.17-beta.37c245b' }), mine()).ok, true);
});

test('the same build and protocol can battle', () => {
  assert.equal(compare(room(), mine()).ok, true);
});

test('a newer game in the room says to update, and which update is waiting', () => {
  const newer = room({ build: 'cccc-dddd', version: '2026.11.20.1' });
  const none = compare(newer, mine());
  assert.equal(none.ok, false);
  assert.equal(none.direction, 'newer');
  assert.match(none.detail, /Rui has a newer game \(2026\.11\.20\.1; you have 2026\.11\.17\.1\)/);
  assert.match(none.detail, /check now/);
  assert.equal(none.fix, null);
  const launcher = compare(newer, mine({ waiting: { launcher: true, game: false } }));
  assert.match(launcher.detail, /Your update is ready: press Update to join, or Update ready in the top bar/);
  assert.equal(launcher.fix, 'updates');
  assert.equal(launcher.summary, 'Rui has a newer game (2026.11.20.1; you have 2026.11.17.1).');
  assert.equal(compare(newer, mine({ waiting: { launcher: false, game: true } })).fix, 'updates');
});

test('an older game in the room says the other player needs to update', () => {
  const fit = compare(room({ build: 'eeee-ffff', version: '2026.11.12.1' }), mine());
  assert.equal(fit.direction, 'older');
  assert.equal(fit.short, 'older game: they need to update');
  assert.match(fit.detail, /They need to update/);
});

test('another build of the same version, or a custom one, says so', () => {
  assert.equal(compare(room({ build: 'eeee-ffff' }), mine()).direction, 'other');
  assert.equal(compare(room({ build: 'eeee-ffff', version: 'master@37c245b' }), mine()).direction, 'other');
});

test('the same game with another launcher protocol says whose launcher is behind', () => {
  const newer = compare(room({ protocol: 9, launcher: '0.6.0' }), mine());
  assert.equal(newer.part, 'launcher');
  assert.equal(newer.direction, 'newer');
  assert.match(newer.detail, /newer launcher \(v0\.6\.0; you have v0\.5\.0\)/);
  const older = compare(room({ protocol: 7, launcher: '0.4.0' }), mine());
  assert.equal(older.direction, 'older');
});

test('a room for both games compares the cross build, and needs a game that can join one', () => {
  assert.equal(compare(room({ build: 'cross-aaaa', version: 'XD 2026.11.17.xd1' }), mine()).ok, true);
  const old = compare(room({ build: 'cross-aaaa' }), mine({ crossBuild: null }));
  assert.equal(old.direction, 'newer');
  assert.match(old.detail, /Colosseum and XD players together/);
});

test('without a game set up, the room asks for setup first', () => {
  assert.equal(compare(room(), { build: null, launcher: '0.5.0', protocol: 8 }).short, 'set up your game to join');
});

test('games of one battle version battle, whatever their versions and channels', () => {
  const v3 = { build: 'colosseum-battle-3', crossBuild: 'cross-battle-3', battle: 3 };
  const older = compare(room({ build: 'colosseum-battle-3', version: '2026.11.12.1' }), mine(v3));
  assert.equal(older.ok, true);
  assert.match(older.detail, /Game 2026\.11\.12\.1, which battles the same as yours \(2026\.11\.17\.1, battle version 3\)/);
  assert.equal(compare(room({ build: 'colosseum-battle-3', version: '2026.11.18-beta.abcdef0' }), mine(v3)).ok, true);
  assert.equal(compare(room({ build: 'cross-battle-3', version: 'XD 2026.11.12.xd1' }), mine(v3)).ok, true);
  assert.equal(battleOf('xd-battle-12'), 12);
  assert.equal(battleOf('aaaa-bbbb'), null);
});

test('battle versions say who is behind, even against the dates', () => {
  const v3 = { build: 'colosseum-battle-3', crossBuild: 'cross-battle-3', battle: 3 };
  // a later battle version is newer, whatever the dates say
  const newer = compare(room({ build: 'colosseum-battle-4', version: '2026.11.17.1' }), mine({ ...v3, version: '2026.11.18.1' }));
  assert.equal(newer.direction, 'newer');
  assert.match(newer.detail, /Rui has a newer game \(2026\.11\.17\.1, battle version 4; you have 2026\.11\.18\.1, battle version 3\)/);
  assert.equal(compare(room({ build: 'colosseum-battle-2' }), mine(v3)).direction, 'older');
  // a game from before battle versions is older than one with them
  assert.equal(compare(room({ build: 'aaaa-bbbb', version: '2026.11.20.1' }), mine(v3)).direction, 'older');
  assert.equal(compare(room({ build: 'colosseum-battle-1' }), mine()).direction, 'newer');
  // Beta's newer battle version: Stable can't update to it
  const beta = compare(room({ build: 'colosseum-battle-4', version: '2026.11.18-beta.abcdef0' }), mine(v3));
  assert.equal(beta.direction, 'channel');
  assert.match(beta.detail, /Beta's battles have changed since/);
});

test('a room for the other game only says so', () => {
  const xd = compare(room({ build: 'xd-battle-3', version: 'XD 2026.11.17.xd1' }), mine({ build: 'colosseum-battle-3', battle: 3 }));
  assert.equal(xd.direction, 'game');
  assert.equal(xd.short, 'for XD players only');
  assert.match(xd.detail, /tick Colosseum and XD players can join/);
});

test('another launcher protocol is told before the game', () => {
  const fit = compare(room({ build: 'colosseum-battle-3', protocol: 9, launcher: '0.6.0' }), mine());
  assert.equal(fit.part, 'launcher');
  assert.equal(fit.direction, 'newer');
});
