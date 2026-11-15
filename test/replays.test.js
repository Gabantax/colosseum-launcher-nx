'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const replays = require('../src/replays');
const online = require('../src/online');

const START = { type: 'start', key: 'k'.repeat(32), side: 1, game: 1, seed: 42, bestOf: 1, rules: { level: 50, size: 6, stage: 2 },
  players: [{ name: 'Ash', party: [1, 2, 3, 4, 5, 6] }, { name: 'Misty', party: [7, 8, 9, 10, 11, 12] }] };
const act = (seq, rng = 100) => `act ${seq} ${rng} ${seq + 5} 1 1 0 0 19 0 2151111848 53 15 1 0 0 d=0000abcd`;

function recorded({ turns = 3, result = { reason: 'over', winner: 0 }, game = 1, recorder = null } = {}) {
  const r = recorder || new replays.Recorder({ game: 'colosseum', cross: false, build: 'abc-def', version: '2026.11.15', launcher: '0.4.0', role: 'joiner' });
  r.start({ ...START, game });
  for (let t = 0; t < turns; t++) { r.line(game, 0, act(t)); r.line(game, 1, act(t)); }
  r.line(game, 1, 'irekae 3 77 99 2 d=00000001');
  if (result) r.end(game, result);
  return r;
}

const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'replays-'));

test('a recorded battle is its start without the player\'s key or side, and both players\' lines', () => {
  const replay = recorded().replay();
  assert.equal(replay.kind, replays.KIND);
  assert.equal(replay.games.length, 1);
  assert.equal(replay.games[0].start.key, undefined);
  assert.equal(replay.games[0].start.side, undefined);
  assert.deepEqual(replay.players, ['Ash', 'Misty']);
  assert.equal(replay.games[0].lines.length, 7);
  assert.deepEqual(replay.games[0].result, { reason: 'over', winner: 0 });
});

test('lines that aren\'t a game\'s choices are left out, and a battle without a turn is no replay', () => {
  const r = new replays.Recorder({ game: 'colosseum', role: 'host' });
  r.start(START);
  r.line(1, 0, 'act 0 1 2\nstart 1');
  r.line(1, 2, act(0));
  r.line(1, 0, 'restart');
  assert.equal(r.replay(), null);
});

test('turns are the host\'s choices, and a faint shows after the turn of the replacement\'s side', () => {
  const lines = [[0, act(0)], [1, act(0)], [1, act(1)], [0, act(1)], [1, 'irekae 2 1 1 3 d=00000000'], [0, act(2)]];
  assert.equal(replays.turnsOf(lines), 3);
  assert.deepEqual(replays.faintsOf(lines), [{ turn: 2, side: 1 }]);
});

test('a replay file is checked before anything of it goes to the game', () => {
  const good = recorded().replay();
  const parsed = replays.parse(JSON.stringify(good));
  assert.ok(!(parsed instanceof Error));
  assert.equal(parsed.games[0].turns, 3);
  assert.equal(parsed.games[0].start.rules.stage, 2);
  const bad = structuredClone(good);
  bad.games[0].lines.push([0, 'act 1 2 3\nconfig 0 50 6 0']);
  assert.match(replays.parse(JSON.stringify(bad)).message, /damaged/);
  const named = structuredClone(good);
  named.games[0].start.players[0].name = 'x'.repeat(40);
  assert.match(replays.parse(JSON.stringify(named)).message, /damaged/);
  assert.match(replays.parse('{"kind":"something"}').message, /isn't a replay/);
  assert.match(replays.parse(JSON.stringify({ ...good, format: 99 })).message, /newer launcher/);
  assert.match(replays.parse('not json').message, /isn't a replay/);
});

test('saving keeps the newest replays and every kept one, and a session saves to one file', () => {
  const folder = temp();
  try {
    const kept = recorded();
    kept.savedAt = '2026-01-01T00:00:00.000Z';
    const keptFile = replays.save(folder, kept, 2);
    replays.setKept(folder, keptFile, true);
    for (let n = 0; n < 4; n++) {
      const r = recorded();
      r.savedAt = `2026-02-0${n + 1}T00:00:00.000Z`;
      replays.save(folder, r, 2);
    }
    const list = replays.list(folder);
    assert.equal(list.length, 3);
    assert.ok(list.some(each => each.file === keptFile && each.kept));
    assert.deepEqual(list.filter(each => !each.kept).map(each => each.savedAt), ['2026-02-04T00:00:00.000Z', '2026-02-03T00:00:00.000Z']);
    // saved again (the next game's end): the same file, still kept
    replays.save(folder, kept, 2);
    assert.equal(replays.list(folder).length, 3);
    assert.equal(JSON.parse(fs.readFileSync(keptFile, 'utf8')).kept, true);
  } finally { fs.rmSync(folder, { recursive: true, force: true }); }
});

test('a replay from elsewhere is copied in and kept, once', () => {
  const folder = temp(), other = temp();
  try {
    const source = replays.save(other, recorded(), 50);
    const { file, added } = replays.importFile(folder, source);
    assert.equal(added, true);
    assert.equal(path.dirname(file), folder);
    assert.deepEqual(replays.importFile(folder, source), { file, added: false });
    const list = replays.list(folder);
    assert.equal(list.length, 1);
    assert.equal(list[0].kept, true);
    assert.throws(() => replays.remove(folder, source), /isn't in the replays folder/);
    replays.remove(folder, file);
    assert.equal(replays.list(folder).length, 0);
  } finally { fs.rmSync(folder, { recursive: true, force: true }); fs.rmSync(other, { recursive: true, force: true }); }
});

function bridge() {
  const b = { lines: [], send: line => b.lines.push(line), listen: async () => 5555, close: () => { b.closed = true; }, reset: () => { b.lines = []; } };
  return options => Object.assign(b, options);
}

async function playing(replay, features = { rules: true, picks: true }) {
  const session = new replays.ReplaySession(replays.parse(JSON.stringify(replay)), { features });
  const make = bridge();
  await session.attachGame(make);
  return { session, game: make({}) };
}

test('a replay\'s game is sent the replay, a spectator\'s config and every line at once', async () => {
  const { session, game } = await playing(recorded().replay());
  assert.equal(await session.again(), true);
  assert.equal(game.lines[0], 'replay 3');
  assert.equal(game.lines[1], `config ${online.WATCHING} 50 6 2`);
  assert.equal(game.lines[2], 'start 42 Ash Misty 1 2 3 4 5 6 7 8 9 10 11 12');
  assert.equal(game.lines.filter(line => line.startsWith('from ')).length, 7);
  assert.equal(session.start.seed, 42);
  session.close();
});

test('each player\'s hero is kept, and the replay\'s game is dressed in them once, for seeks back too', async () => {
  const r = new replays.Recorder({ game: 'colosseum', cross: false, build: 'abc-def', version: '2026.11.15', launcher: '0.4.0', role: 'host' });
  r.start({ ...START, players: [{ ...START.players[0], look: { hero: 'may', colors: { bag: '#5a5a66', nose: '#ffffff' } } },
    { ...START.players[1], look: { hero: 'nobody' } }] });
  for (let t = 0; t < 4; t++) { r.line(1, 0, act(t)); r.line(1, 1, act(t)); }
  const replay = replays.parse(JSON.stringify(r.replay()));
  assert.deepEqual(replay.games[0].start.players[0].look, { hero: 'may', colors: { bag: '#5a5a66' } });
  assert.equal(replay.games[0].start.players[1].look, undefined);
  const dressed = [];
  const dress = start => { dressed.push(start.players.map(player => player.look?.hero || null)); return { lines: ['look 0 2 /made/may.pkx'], folders: ['/made/may-hd'] }; };
  const session = new replays.ReplaySession(replay, { features: { rules: true }, dress });
  const make = bridge();
  await session.attachGame(make);
  const game = make({});
  assert.equal(await session.again(), true);
  assert.deepEqual(dressed, [['may', null]]);
  assert.ok(game.lines.indexOf('look 0 2 /made/may.pkx') < game.lines.findIndex(line => line.startsWith('start ')));
  assert.deepEqual(session.looks, ['/made/may-hd']);
  game.onLine('turn 3');
  session.seek(1);
  game.onClose();
  assert.equal(await session.again(), true);
  assert.equal(dressed.length, 1);
  assert.ok(game.lines.includes('look 0 2 /made/may.pkx'));
  session.close();
});

test('a later turn is played to fast; an earlier one starts the game again and plays to it', async () => {
  const { session, game } = await playing(recorded({ turns: 6 }).replay());
  await session.again();
  game.onLine('turn 2');
  session.seek(5);
  assert.equal(game.lines.at(-1), 'seek 5');
  game.onLine('turn 5');
  assert.equal(session.seekTo, 0);
  session.seek(3);
  assert.equal(game.lines.at(-1), 'quit');
  game.onClose();
  assert.equal(await session.again(), true);
  assert.equal(game.lines[0], 'replay 6');
  assert.ok(game.lines.includes('seek 3'));
  session.close();
});

test('the game\'s own buttons ask for a turn, a speed and a pause, which the page shows', async () => {
  const { session, game } = await playing(recorded({ turns: 6 }).replay());
  await session.again();
  game.onLine('turn 4');
  game.onLine('goto 3');
  assert.equal(game.lines.at(-1), 'quit');
  const { session: other, game: second } = await playing(recorded({ turns: 6 }).replay());
  await other.again();
  second.onLine('speed 40');
  second.onLine('paused 1');
  assert.equal(other.progress().speed, 40);
  assert.equal(other.progress().paused, true);
  other.setSpeed(20);
  assert.equal(second.lines.at(-1), 'speed 20');
  other.setSpeed(33);
  assert.equal(second.lines.at(-1), 'speed 20');
  session.close();
  other.close();
});

test('a battle saved partway ends where its lines do, once its last turn plays', async () => {
  const { session, game } = await playing(recorded({ turns: 3, result: { reason: 'left', winner: null } }).replay());
  await session.again();
  game.onLine('turn 2');
  assert.ok(!game.lines.includes('left'));
  game.onLine('turn 3');
  assert.equal(game.lines.at(-1), 'left');
  session.close();
});

test('a set plays its games in turn, and a desync ends the replay saying where', async () => {
  const r = recorded({ game: 1 });
  recorded({ game: 2, turns: 2, result: { reason: 'over', winner: 1 }, recorder: r });
  r.finishSet({ wins: [1, 1] });
  const { session, game } = await playing(r.replay());
  await session.again();
  const ends = [];
  session.on('end', result => ends.push(result));
  game.onLine('end 0');
  game.onClose();
  assert.equal(await session.again(), true);
  assert.equal(session.index, 1);
  assert.equal(game.lines[0], 'replay 2');
  game.onLine('turn 1');
  game.onLine('desync');
  game.onClose();
  assert.equal(await session.again(), false);
  assert.deepEqual(ends.map(end => end.reason), ['over', 'desync']);
  assert.equal(ends[1].turn, 1);
  session.close();
});

test('a room\'s session says what it hears, for its replay', async () => {
  class FakeSocket extends EventTarget {
    constructor(url) { super(); this.url = url; this.readyState = 1; this.sent = []; FakeSocket.last = this; queueMicrotask(() => this.dispatchEvent(new Event('open'))); }
    send(text) { this.sent.push(text); }
    close() { this.readyState = 3; }
    receive(value) { this.dispatchEvent(Object.assign(new Event('message'), { data: JSON.stringify(value) })); }
  }
  const session = new online.Session({ url: 'http://rooms.test', WebSocket: FakeSocket });
  const heard = [];
  session.on('record', (...args) => heard.push(args));
  const joined = session.join({ code: 'KQ7M2D', name: 'Misty', build: 'b', version: 'v', launcher: 'l', party: [7, 8, 9, 10, 11, 12] });
  await new Promise(resolve => setImmediate(resolve));
  FakeSocket.last.receive(START);
  await joined;
  await session.attachGame(bridge());
  session.prepareGame();
  session.bridge.onLine(act(0));
  FakeSocket.last.receive({ type: 'game', game: 1, seq: 1, line: act(0, 7) });
  FakeSocket.last.receive({ type: 'game', game: 1, seq: 1, line: act(0, 7) });   // again, after a reconnection
  assert.deepEqual(heard.map(([kind, ...rest]) => kind === 'start' ? ['start', rest[0].seed] : [kind, ...rest]),
    [['start', 42], ['line', 1, 1, act(0)], ['line', 1, 0, act(0, 7)]]);
  session.close();
});
