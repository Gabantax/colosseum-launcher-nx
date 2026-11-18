'use strict';

// Updates, as players see them: one "Update ready" button in the top bar, a card under it when an update arrives,
// and one modal that offers the update and then shows it going. The launcher works out the order itself: a new
// launcher first (download, then a restart), then the game it brings, so nobody has to know which comes first.
// renderer.js keeps the flow (what is under way) and draws these; this file only says what each shows.
//
// `data` is the launcher's state (main.js state()); `notes` is the changelog (main.js changelogState: releases, beta).
// `flow` is renderer.js's update under way: null, or { phase: 'launcher' | 'restart' | 'game' | 'done' | 'error',
// launcher: { from, to } | null, game: { to } | null, laterGame, resumed, waiting, error }.
(function (root) {
  const BUILDING = ['Update game', 'Prepare game', 'Build game'];
  const WAITING = ['available', 'downloading', 'ready'];
  const baseVersion = version => String(version || '').replace(/-.*$/, '');

  // The changelog's entry for a launcher version, or null.
  function releaseOf(notes, version) {
    return (notes?.releases || []).find(release => release.version === version || release.version === baseVersion(version)) || null;
  }

  // What there is to get: { launcher, game, laterGame } with launcher { kind, from, to, state, percent } (kind
  // 'auto' updates itself, 'portable' comes from the releases page) and game { from, to }. A new launcher's game is
  // the one its changelog entry pins; laterGame when a new launcher may bring a game this one can't name yet.
  function plan(data, notes) {
    const update = data?.appUpdate || {};
    const launcher = WAITING.includes(update.state) && (update.kind === 'auto' || update.kind === 'portable')
      ? { kind: update.kind, from: data?.game?.launcherVersion || null, to: update.version || null, state: update.state,
        percent: Number.isFinite(update.percent) ? update.percent : null }
      : null;
    const installed = data?.game?.installedVersion || null;
    const pinned = launcher ? releaseOf(notes, launcher.to)?.game?.version || null : null;
    const ready = Boolean(data?.binaryReady);
    let game = null;
    if (ready && pinned && pinned !== installed) game = { from: installed, to: pinned };
    else if (ready && data?.game?.needsUpdate) game = { from: installed, to: data.game.availableVersion || null };
    return { launcher, game, laterGame: Boolean(launcher && ready && !pinned && !game) };
  }
  const hasUpdate = value => Boolean(value?.launcher || value?.game);

  // Up to three lines of what's new in the update, each a short headline (src/changelog-text.js).
  function news(notes, value, split = root.coloChangelogText?.splitChange) {
    const lines = [];
    if (value?.launcher) {
      const release = releaseOf(notes, value.launcher.to);
      if (release) lines.push(...(release.launcher || []), ...(release.game?.changes || []));
      else if (/-beta/.test(String(value.launcher.to)) && notes?.beta) lines.push(...(notes.beta.launcher || []), ...(notes.beta.game || []));
    } else if (value?.game) {
      const release = (notes?.releases || []).find(entry => entry.game?.version === value.game.to);
      if (release) lines.push(...(release.game.changes || []));
      else if (notes?.beta) lines.push(...(notes.beta.game || []));
    }
    return lines.slice(0, 3).map(line => {
      if (!split) return String(line);
      const parts = split(line);
      return `${parts.tag ? `${parts.tag}: ` : ''}${parts.headline}${parts.runOn || ''}`.replace(/[.!?]?$/, '.');
    });
  }

  const percentText = value => Number.isFinite(value) ? ` ${value}%` : '…';
  const active = flow => ['launcher', 'restart', 'game'].includes(flow?.phase);

  // The top bar's button: null when there's nothing to get, or { label, busy, title }. It always opens the modal.
  function chip(data, value, flow) {
    if (flow?.phase === 'launcher') return { label: `Updating${percentText(data?.appUpdate?.percent)}`, busy: true, title: 'Downloading the new launcher' };
    if (flow?.phase === 'restart') return { label: 'Restarting…', busy: true, title: 'The launcher restarts to finish its update' };
    if (flow?.phase === 'game') return { label: `Updating game${percentText(data?.active?.percent)}`, busy: true, title: 'Updating the game' };
    if (!hasUpdate(value)) return null;
    if (!value.launcher && BUILDING.includes(data?.active?.label)) return { label: 'Updating game…', busy: true, title: 'Updating the game' };
    return { label: 'Update ready', busy: false, title: summary(value) };
  }

  // "Launcher 0.5.1 and game 2026.11.17.1", for the card and the button's tooltip.
  function summary(value) {
    const launcher = value?.launcher && `Launcher ${value.launcher.to || 'update'}`;
    const game = value?.game && `${launcher ? 'game' : 'Game'} ${value.game.to || 'update'}`;
    return [launcher, game].filter(Boolean).join(' and ');
  }

  // The card under the button when an update arrives: { title, detail }.
  function card(value, lines = []) {
    const restart = value?.launcher?.kind === 'auto' ? ' The launcher restarts once.' : value?.launcher ? ' Get it from the releases page.' : '';
    return { title: summary(value), detail: `${lines[0] || 'Fixes and improvements.'}${restart}` };
  }

  // The steps of an update under way: [{ state: 'done' | 'active' | '', title, detail, percent }].
  function steps(data, flow) {
    const gameTo = flow?.game?.to;
    const gameTitle = gameTo ? `Update the game to ${gameTo}` : 'Update the game';
    const game = { state: '', title: gameTitle, detail: 'Your saves carry over.', percent: null };
    if (flow?.phase === 'game') Object.assign(game, { state: 'active', title: gameTo ? `Updating the game to ${gameTo}` : 'Updating the game',
      detail: flow.waiting ? 'Waiting for the current task to finish…'
        : `${Number.isFinite(data?.active?.percent) ? `${data.active.percent}% · ` : ''}${data?.active?.detail || 'Starting…'}`,
      percent: Number.isFinite(data?.active?.percent) ? data.active.percent : null });
    if (flow?.phase === 'done') Object.assign(game, { state: 'done', title: gameTo ? `Updated the game to ${gameTo}` : 'The game is up to date',
      detail: flow.gameSkipped ? 'It was already up to date.' : 'Your saves carried over.' });
    if (!flow?.launcher) return [game];
    const to = flow.launcher.to || '';
    const download = { state: 'done', title: `Downloaded launcher ${to}`.trim(), detail: '', percent: null };
    if (flow.phase === 'launcher') {
      const percent = Number.isFinite(data?.appUpdate?.percent) ? data.appUpdate.percent : null;
      Object.assign(download, { state: 'active', title: `Downloading launcher ${to}`.trim(), detail: percent === null ? 'Starting…' : `${percent}%`, percent });
    }
    const restart = { state: flow.resumed ? 'done' : '', title: flow.resumed ? 'Restarted the launcher' : 'Restart the launcher',
      detail: flow.resumed ? `Now on v${data?.game?.launcherVersion || to}` : 'By itself, once the download is done.', percent: null };
    if (flow.phase === 'restart') Object.assign(restart, { state: 'active', title: 'Restarting the launcher',
      detail: flow.waiting ? 'Waiting for the game and any task to finish…' : 'Restarting now…' });
    if (!flow.resumed && flow.phase !== 'done') game.detail = flow.game || flow.laterGame
      ? `After the restart${flow.laterGame && !flow.game ? ', if the new launcher brings a newer game' : ''}. Your saves carry over.`
      : 'After the restart, if the new launcher brings a newer game.';
    return [download, restart, game];
  }

  // What the modal shows. mode: 'offer' (with `context`: null, 'play' or { eyebrow, title, lead, warn } from the Online
  // page), 'progress', 'done' or 'error'. Returns { eyebrow, title, lead, rows, steps, news, note, warn, auto, secondary,
  // primary }: rows [{ kind, title, detail, from, to }], auto { label } or null, buttons { label, action } or null.
  function modal(mode, { data, notes, value, flow, context } = {}) {
    if (mode === 'progress' || mode === 'done' || mode === 'error') return progressModal(mode, data, flow);
    const rows = [];
    const portable = value?.launcher?.kind === 'portable';
    if (value?.launcher) rows.push({ kind: 'launcher', title: 'Launcher',
      detail: portable ? 'Download it from the releases page' : 'Restarts once, by itself', from: `v${value.launcher.from || '?'}`, to: `v${value.launcher.to || '?'}` });
    if (value?.game) rows.push({ kind: 'game', title: 'Game',
      detail: value.launcher && !portable ? 'Updated after the restart. Your saves carry over.' : 'Your saves carry over.', from: value.game.from || '?', to: value.game.to || '?' });
    const both = Boolean(value?.launcher && value?.game);
    const out = { eyebrow: 'UPDATE READY', title: both ? 'Update the launcher and game' : value?.launcher ? 'Update the launcher' : 'Update the game',
      lead: both ? 'One update brings both. Your saves carry over.' : value?.launcher ? `Launcher ${value.launcher.to || 'update'} is out.` : 'Your saves carry over.',
      rows, steps: null, news: news(notes, value), warn: null, auto: { label: 'Update automatically from now on' },
      note: portable ? 'A portable launcher updates by downloading the new one from the releases page. The new launcher then updates the game.'
        : value?.launcher ? `The launcher downloads${both || value.laterGame ? ', restarts and updates the game' : ' and restarts'} by itself. There's nothing to press in between.`
          : 'The launcher updates the game by itself. It takes a few minutes.',
      secondary: { label: 'Later', action: 'later' }, primary: portable ? { label: 'Open releases page', action: 'releases' } : { label: 'Update now', action: 'update' } };
    if (context === 'play') Object.assign(out, { eyebrow: 'BEFORE YOU PLAY', title: value?.launcher ? 'An update is ready' : 'A game update is ready',
      lead: 'Update first, or play the version you have.', auto: { label: 'Always update before playing' },
      note: value?.launcher && !portable ? 'The launcher restarts once. Press Play when it\'s done.' : out.note,
      secondary: { label: `Play ${data?.game?.installedVersion || 'now'}`, action: 'play' },
      primary: portable ? out.primary : value?.launcher ? { label: 'Update now', action: 'update' } : { label: 'Update and play', action: 'update-play' } });
    else if (context && typeof context === 'object') Object.assign(out, { eyebrow: context.eyebrow || 'UPDATE TO BATTLE', title: context.title || out.title,
      lead: context.lead || out.lead, warn: context.warn || null, news: [], auto: null, note: portable ? out.note : null,
      secondary: { label: 'Not now', action: 'close' } });
    return out;
  }

  function progressModal(mode, data, flow) {
    const list = steps(data, flow);
    const both = Boolean(flow?.launcher);
    if (mode === 'error') return { eyebrow: 'UPDATE STOPPED', title: 'The update didn\'t finish', lead: flow?.error || 'Something went wrong.',
      rows: [], steps: list, news: [], note: 'Nothing is lost: your game and saves are as they were. The activity log says more.', warn: null, auto: null,
      secondary: { label: 'Close', action: 'close' }, primary: { label: 'Try again', action: 'update' } };
    if (mode === 'done') return { eyebrow: 'UP TO DATE', title: 'You\'re up to date',
      lead: `Launcher v${data?.game?.launcherVersion || '?'} and game ${data?.game?.installedVersion || '?'}.`, rows: [], steps: list, news: [], note: null, warn: null, auto: null,
      secondary: { label: 'What\'s new', action: 'changelog' }, primary: { label: 'Play', action: 'play-now' } };
    const at = list.findIndex(step => step.state === 'active');
    const eyebrow = list.length > 1 && at >= 0 ? `UPDATING · STEP ${at + 1} OF ${list.length}` : 'UPDATING';
    const title = flow?.phase === 'game' && flow.resumed ? `Launcher ${data?.game?.launcherVersion || flow.launcher?.to || ''} is installed. Finishing the game.`
      : both ? (flow.game || flow.laterGame ? 'Updating the launcher and game' : 'Updating the launcher') : 'Updating the game';
    const lead = flow?.phase === 'launcher' ? 'You can keep using the launcher. It restarts by itself once the download is done.'
      : flow?.phase === 'restart' ? (flow.waiting ? 'The launcher restarts as soon as the game and any task have finished.' : 'The launcher closes and opens again in a moment.')
        : 'Play comes back as soon as the game is ready.';
    return { eyebrow, title, lead, rows: [], steps: list, news: [], note: null, warn: null, auto: null,
      secondary: flow?.phase === 'game' ? { label: 'View build log', action: 'log' } : null, primary: { label: 'Hide', action: 'hide' } };
  }

  const api = { plan, hasUpdate, news, chip, summary, card, steps, modal, active, releaseOf };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.coloUpdateStatus = api;
})(typeof globalThis === 'object' ? globalThis : this);
