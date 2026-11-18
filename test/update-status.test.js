'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const S = require('../src/update-status');
const { splitChange } = require('../src/changelog-text');

const notes = { releases: [
  { version: '0.5.1', launcher: ['Online: players on different game versions can battle. More words here.'], game: { version: '2026.11.17.1', changes: ['Fixed fast-forward on slower PCs.'] } },
  { version: '0.5.0', launcher: [], game: { version: '2026.11.12.1', changes: ['Fixed XD freezing on the Strategy Memo.'] } }] };
const data = (fields = {}) => ({ binaryReady: true, active: null,
  game: { needsUpdate: false, installedVersion: '2026.11.12.1', availableVersion: '2026.11.12.1', launcherVersion: '0.5.0' },
  appUpdate: { state: 'current', kind: 'auto' }, ...fields });
const available = { state: 'available', kind: 'auto', version: '0.5.1' };

test('nothing to get: no button, no plan', () => {
  const plan = S.plan(data(), notes);
  assert.equal(S.hasUpdate(plan), false);
  assert.equal(S.chip(data(), plan, null), null);
});

test('a new launcher brings the game its changelog entry pins, in one update', () => {
  const plan = S.plan(data({ appUpdate: available }), notes);
  assert.deepEqual(plan.launcher, { kind: 'auto', from: '0.5.0', to: '0.5.1', state: 'available', percent: null });
  assert.deepEqual(plan.game, { from: '2026.11.12.1', to: '2026.11.17.1' });
  assert.equal(S.chip(data({ appUpdate: available }), plan, null).label, 'Update ready');
  assert.equal(S.summary(plan), 'Launcher 0.5.1 and game 2026.11.17.1');
  const view = S.modal('offer', { data: data({ appUpdate: available }), notes, value: plan });
  assert.equal(view.title, 'Update the launcher and game');
  assert.deepEqual(view.rows.map(row => [row.kind, row.from, row.to]), [['launcher', 'v0.5.0', 'v0.5.1'], ['game', '2026.11.12.1', '2026.11.17.1']]);
  assert.deepEqual(view.primary, { label: 'Update now', action: 'update' });
  assert.deepEqual(view.secondary, { label: 'Later', action: 'later' });
  assert.equal(view.auto.label, 'Update automatically from now on');
  assert.deepEqual(S.news(notes, plan, splitChange), ['Online: Players on different game versions can battle.', 'Fixed fast-forward on slower PCs.']);
});

test('a launcher the changelog doesn\'t know yet may still bring a game', () => {
  const plan = S.plan(data({ appUpdate: { ...available, version: '0.5.2' } }), notes);
  assert.equal(plan.game, null);
  assert.equal(plan.laterGame, true);
  assert.match(S.modal('offer', { data: data(), notes, value: plan }).note, /restarts and updates the game by itself/);
});

test('only the game: one step, no restart', () => {
  const d = data({ game: { ...data().game, needsUpdate: true, availableVersion: '2026.11.17.1' } });
  const plan = S.plan(d, notes);
  assert.equal(plan.launcher, null);
  assert.equal(S.modal('offer', { data: d, notes, value: plan }).title, 'Update the game');
  const flow = { phase: 'game', launcher: null, game: { to: '2026.11.17.1' } };
  const steps = S.steps({ ...d, active: { label: 'Update game', percent: 40, detail: 'Building' } }, flow);
  assert.equal(steps.length, 1);
  assert.deepEqual([steps[0].state, steps[0].percent, steps[0].detail], ['active', 40, '40% · Building']);
  assert.equal(S.modal('progress', { data: d, flow }).eyebrow, 'UPDATING');
  assert.equal(S.chip({ ...d, active: { percent: 40 } }, plan, flow).label, 'Updating game 40%');
});

test('the steps of a launcher update: download, restart, then the game after the restart', () => {
  const flow = { phase: 'launcher', launcher: { from: '0.5.0', to: '0.5.1' }, game: { to: '2026.11.17.1' }, resumed: false };
  const d = data({ appUpdate: { ...available, state: 'downloading', percent: 42 } });
  let steps = S.steps(d, flow);
  assert.deepEqual(steps.map(step => step.state), ['active', '', '']);
  assert.equal(steps[0].percent, 42);
  assert.match(steps[2].detail, /After the restart/);
  const view = S.modal('progress', { data: d, flow });
  assert.equal(view.eyebrow, 'UPDATING · STEP 1 OF 3');
  assert.deepEqual(view.primary, { label: 'Hide', action: 'hide' });
  assert.equal(S.chip(d, S.plan(d, notes), flow).label, 'Updating 42%');
  steps = S.steps(d, { ...flow, phase: 'restart', waiting: true });
  assert.deepEqual(steps.map(step => step.state), ['done', 'active', '']);
  assert.match(steps[1].detail, /Waiting for the game/);
  const after = data({ game: { ...data().game, launcherVersion: '0.5.1' }, active: { percent: 64, detail: 'Building' } });
  const resumed = { ...flow, phase: 'game', resumed: true };
  steps = S.steps(after, resumed);
  assert.deepEqual(steps.map(step => step.state), ['done', 'done', 'active']);
  assert.equal(steps[1].detail, 'Now on v0.5.1');
  const finishing = S.modal('progress', { data: after, flow: resumed });
  assert.equal(finishing.eyebrow, 'UPDATING · STEP 3 OF 3');
  assert.equal(finishing.title, 'Launcher 0.5.1 is installed. Finishing the game.');
  assert.deepEqual(finishing.secondary, { label: 'View build log', action: 'log' });
  assert.deepEqual(S.steps(after, { ...resumed, phase: 'done' }).map(step => step.state), ['done', 'done', 'done']);
  assert.equal(S.modal('done', { data: after, flow: { ...resumed, phase: 'done' } }).title, 'You\'re up to date');
});

test('before Play, and from the Online page, the offer says why', () => {
  const d = data({ game: { ...data().game, needsUpdate: true, availableVersion: '2026.11.17.1' } });
  const plan = S.plan(d, notes);
  const play = S.modal('offer', { data: d, notes, value: plan, context: 'play' });
  assert.equal(play.title, 'A game update is ready');
  assert.deepEqual(play.secondary, { label: 'Play 2026.11.12.1', action: 'play' });
  assert.deepEqual(play.primary, { label: 'Update and play', action: 'update-play' });
  assert.equal(play.auto.label, 'Always update before playing');
  // with a launcher update too, Play can't follow the restart
  const both = S.modal('offer', { data: d, notes, value: S.plan({ ...d, appUpdate: available }, notes), context: 'play' });
  assert.deepEqual(both.primary, { label: 'Update now', action: 'update' });
  const online = S.modal('offer', { data: d, notes, value: plan, context: { title: 'Update to battle Rui', lead: 'Rui has a newer game.', warn: 'Rui\'s room might fill up.' } });
  assert.equal(online.eyebrow, 'UPDATE TO BATTLE');
  assert.equal(online.warn, 'Rui\'s room might fill up.');
  assert.equal(online.auto, null);
  assert.deepEqual(online.secondary, { label: 'Not now', action: 'close' });
});

test('a portable launcher\'s update comes from the releases page', () => {
  const d = data({ appUpdate: { state: 'available', kind: 'portable', version: '0.5.1' } });
  const plan = S.plan(d, notes);
  assert.equal(plan.launcher.kind, 'portable');
  const view = S.modal('offer', { data: d, notes, value: plan });
  assert.deepEqual(view.primary, { label: 'Open releases page', action: 'releases' });
  assert.match(S.card(plan, []).detail, /releases page/);
});

test('an update stopped says so, and can be tried again', () => {
  const view = S.modal('error', { data: data(), flow: { phase: 'error', error: 'No network.', launcher: null, game: { to: 'x' } } });
  assert.equal(view.lead, 'No network.');
  assert.deepEqual(view.primary, { label: 'Try again', action: 'update' });
});
