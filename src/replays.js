'use strict';

// Replays of online battles. Both players' games play one battle from one seed, so a battle is its start (the seed,
// both parties, the rules) and the lines each player's game sent: what was chosen each turn, and who came in after a
// faint (src/online.js). Every random roll follows from those, crits and misses included, and each line carries the
// battle's random state and a digest of its state as it was chosen, which the game playing the replay checks turn by
// turn: one that plays the battle differently stops, rather than showing another battle.
//
// Each launcher keeps the online battles it played or watched as files in its replays folder, the last KEEP of them
// unless the player keeps one (kept: true), and plays a replay as a spectator's game plays a room's battle: the game
// gets `replay TURNS`, then everything a spectator's would, every line at once, and plays the battle at its own pace
// (host/replay.c in the game). It says which turn it is at; going on to a later turn plays fast to it, and going back
// to an earlier one starts the game again and plays fast to that, as a battle can't go backwards.
//
// A replay file is JSON, small enough to send to someone (a few dozen KB):
//   { format: 1, kind: 'orre-replay', savedAt, kept, game ('colosseum' | 'xd', the game that recorded it), cross (a room
//     for both games: either game plays it), build (the room's build: online.buildId), version, launcher, protocol,
//     role ('host' | 'joiner' | 'watcher'), players: [name, name], rules, bestOf, set: { wins } | null,
//     games: [{ game, start: { seed, rules, bestOf, gamePicks, players: [{ name, party, members, look }] }, lines: [[side, line]],
//               result: { reason, winner } | null }] }

const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const online = require('./online');
const formats = require('./formats');
const storyParty = require('./story-party');
const heroColors = require('./hero-colors');

const FORMAT = 1;
const KIND = 'orre-replay';
const EXTENSION = '.replay';
const KEEP = 50;                  // replays kept that the player hasn't chosen to keep
const MAX_BYTES = 4 * 1024 * 1024;
const MAX_GAMES = 9;
const MAX_LINES = 4000;           // a game's lines: a long battle has a few hundred
const SPEEDS = [5, 10, 20, 40, 80];   // tenths, as the game's controls step them (host/replay.c)
// a line as the games send them: act, irekae or pick, and numbers (d= its digest)
const LINE = /^(act|irekae|pick)( (\d{1,10}|d=[0-9a-f]{8}))+$/;
const NAME = /^[^\r\n]{1,16}$/;

const u16 = value => Number.isInteger(value) && value >= 0 && value <= 0xFFFF;

// --- Recording: what one session saw of its room's battles

class Recorder {
  constructor({ game, cross, build, version, launcher, role }) {
    this.meta = { game, cross: Boolean(cross), build: String(build || ''), version: String(version || ''), launcher: String(launcher || ''), role };
    this.games = new Map();   // game number -> { game, start, lines, result }
    this.set = null;
    this.savedAt = new Date().toISOString();
    this.file = null;
  }

  entry(game) {
    const number = Number.isInteger(game) && game > 0 ? game : 1;
    if (!this.games.has(number)) this.games.set(number, { game: number, start: null, lines: [], result: null });
    return this.games.get(number);
  }

  // a game's start message, as the room sent it: what's private (the player's key) or this player's own (their side) stays out
  start(msg) {
    const entry = this.entry(msg.game);
    if (entry.start) return;
    const { type, key, side, ...start } = msg;
    entry.start = JSON.parse(JSON.stringify(start));
  }

  line(game, side, line) {
    if ((side !== 0 && side !== 1) || typeof line !== 'string' || !LINE.test(line)) return;
    const entry = this.entry(game);
    if (entry.lines.length < MAX_LINES) entry.lines.push([side, line]);
  }

  end(game, result) {
    const entry = this.games.get(Number.isInteger(game) && game > 0 ? game : 1);
    if (!entry || entry.result || !result) return;
    entry.result = { reason: String(result.reason || ''), winner: Number.isInteger(result.winner) ? result.winner : null };
  }

  finishSet(set) { this.set = { wins: Array.isArray(set?.wins) ? set.wins.map(Number) : [0, 0] }; }

  // the replay, or null with nothing worth keeping (no game got as far as a turn)
  replay() {
    const games = [...this.games.values()].filter(entry => entry.start && turnsOf(entry.lines) > 0).sort((a, b) => a.game - b.game);
    if (!games.length) return null;
    const first = games[0].start;
    return { format: FORMAT, kind: KIND, savedAt: this.savedAt, kept: false, ...this.meta, protocol: online.PROTOCOL,
      players: first.players.map(player => player.name), rules: first.rules, bestOf: first.bestOf || 1, set: this.set,
      games: games.map(({ game, start, lines, result }) => ({ game, start, lines, result })) };
  }
}

// --- What a replay's lines say

// A game's turns: the host's choices, one a turn
function turnsOf(lines) { return lines.filter(([side, line]) => side === 0 && line.startsWith('act ')).length; }

// Where Pokémon fainted: after which turn each replacement came, and whose ({ turn, side })
function faintsOf(lines) {
  const acts = [0, 0], out = [];
  for (const [side, line] of lines) {
    if (line.startsWith('act ')) acts[side]++;
    else if (line.startsWith('irekae ')) out.push({ turn: Math.max(1, acts[side]), side });
  }
  return out;
}

// --- Reading a replay file, which may have come from anyone: everything checked before any of it goes to the game

function validStart(start) {
  if (!start || typeof start !== 'object' || !Number.isInteger(start.seed) || start.seed < 0 || start.seed > 0xFFFFFFFF) return null;
  if (!Array.isArray(start.players) || start.players.length !== 2) return null;
  const players = [];
  for (const player of start.players) {
    if (!player || typeof player.name !== 'string' || !NAME.test(player.name)) return null;
    if (!Array.isArray(player.party) || !player.party.length || player.party.length > storyParty.PARTY_SIZE || !player.party.every(u16)) return null;
    const members = Array.isArray(player.members) ? player.members.slice(0, storyParty.PARTY_SIZE) : null;
    // a member that isn't a party member's shape is left out (startLines makes that Pokémon from its species, as the room's games did)
    // their hero and colours (src/hero-bake.js), as the room's games showed them: a look that isn't one is left out
    const look = player.look && typeof player.look === 'object' && heroColors.hero(player.look.hero)
      ? { hero: player.look.hero, colors: heroColors.normalizeColors(player.look.hero, player.look.colors) } : null;
    players.push({ name: player.name, party: player.party.slice(),
      ...(members ? { members: members.map((member, slot) => storyParty.validWireMember(member, player.party[slot]) ? member.slice() : null) } : {}),
      ...(look ? { look } : {}) });
  }
  const rules = { ...formats.normalize(start.rules || {}), stage: Number.isInteger(start.rules?.stage) && start.rules.stage >= 0 && start.rules.stage < online.STAGES ? start.rules.stage : 0 };
  return { seed: start.seed, players, rules, bestOf: formats.bestOf(start.bestOf), game: Number.isInteger(start.game) ? start.game : 1,
    ...(start.gamePicks ? { gamePicks: true } : {}) };
}

// The replay in `text`, checked, or an Error saying why it won't do.
function parse(text) {
  let value;
  try { value = JSON.parse(text); } catch (_) { return new Error('That file isn\'t a replay.'); }
  if (!value || value.kind !== KIND || !Number.isInteger(value.format)) return new Error('That file isn\'t a replay.');
  if (value.format > FORMAT) return new Error('That replay was saved by a newer launcher. Update the launcher to watch it.');
  if (!Array.isArray(value.games) || !value.games.length || value.games.length > MAX_GAMES) return new Error('That replay has no battle in it.');
  const games = [];
  for (const game of value.games) {
    const start = validStart(game?.start);
    if (!start || !Array.isArray(game.lines) || game.lines.length > MAX_LINES) return new Error('That replay is damaged.');
    const lines = [];
    for (const each of game.lines) {
      if (!Array.isArray(each) || (each[0] !== 0 && each[0] !== 1) || typeof each[1] !== 'string' || each[1].length > 480 || !LINE.test(each[1]))
        return new Error('That replay is damaged.');
      lines.push([each[0], each[1]]);
    }
    const result = game.result && typeof game.result === 'object'
      ? { reason: String(game.result.reason || '').slice(0, 20), winner: game.result.winner === 0 || game.result.winner === 1 ? game.result.winner : null } : null;
    games.push({ game: Number.isInteger(game.game) ? game.game : games.length + 1, start, lines, result, turns: turnsOf(lines), faints: faintsOf(lines) });
  }
  const players = games[0].start.players.map(player => player.name);
  return { format: value.format, kind: KIND, savedAt: typeof value.savedAt === 'string' && !Number.isNaN(Date.parse(value.savedAt)) ? value.savedAt : null,
    kept: value.kept === true, game: value.game === 'xd' ? 'xd' : 'colosseum', cross: value.cross === true,
    build: typeof value.build === 'string' ? value.build.slice(0, 64) : '', version: typeof value.version === 'string' ? value.version.slice(0, 64) : '',
    launcher: typeof value.launcher === 'string' ? value.launcher.slice(0, 32) : '', role: ['host', 'joiner', 'watcher'].includes(value.role) ? value.role : 'watcher',
    players, rules: games[0].start.rules, bestOf: games[0].start.bestOf,
    set: value.set && Array.isArray(value.set.wins) ? { wins: value.set.wins.slice(0, 2).map(win => Number.isInteger(win) ? win : 0) } : null, games };
}

// --- The replays folder

// A file name for a replay: when, and who battled
function fileName(replay) {
  const when = new Date(replay.savedAt || Date.now());
  const pad = n => String(n).padStart(2, '0');
  const stamp = `${when.getFullYear()}-${pad(when.getMonth() + 1)}-${pad(when.getDate())} ${pad(when.getHours())}${pad(when.getMinutes())}${pad(when.getSeconds())}`;
  const name = text => String(text || 'Trainer').replace(/[^\p{L}\p{N} _.-]/gu, '').trim().slice(0, 16) || 'Trainer';
  return `${stamp} ${name(replay.players[0])} vs ${name(replay.players[1])}${EXTENSION}`;
}

// What the Replays list shows of each file in the folder, newest first: { file, name, ...summary } or { file, error }
function list(folder) {
  let names;
  try { names = fs.readdirSync(folder).filter(name => name.endsWith(EXTENSION)); } catch (_) { return []; }
  const out = [];
  for (const name of names) {
    const file = path.join(folder, name);
    try {
      const stat = fs.statSync(file);
      if (!stat.isFile()) continue;
      if (stat.size > MAX_BYTES) { out.push({ file, name, error: 'Too large to be a replay.', savedAt: stat.mtime.toISOString() }); continue; }
      const replay = parse(fs.readFileSync(file, 'utf8'));
      if (replay instanceof Error) { out.push({ file, name, error: replay.message, savedAt: stat.mtime.toISOString() }); continue; }
      out.push({ file, name, ...summary(replay), savedAt: replay.savedAt || stat.mtime.toISOString() });
    } catch (error) { out.push({ file, name, error: error.message }); }
  }
  return out.sort((a, b) => String(b.savedAt || '').localeCompare(String(a.savedAt || '')));
}

// What the page shows of one replay
function summary(replay) {
  const last = replay.games[replay.games.length - 1];
  return { players: replay.players, kept: replay.kept, game: replay.game, cross: replay.cross, build: replay.build, version: replay.version,
    role: replay.role, rules: replay.rules, bestOf: replay.bestOf, set: replay.set, savedAt: replay.savedAt,
    games: replay.games.map(game => ({ game: game.game, turns: game.turns, result: game.result, faints: game.faints })),
    turns: replay.games.reduce((sum, game) => sum + game.turns, 0), result: last.result };
}

function writeJson(file, value) {
  const temp = `${file}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(value)}\n`);
  fs.renameSync(temp, file);
}

// The replays the player hasn't kept, past the newest `keep`, go
function prune(folder, keep = KEEP) {
  const loose = list(folder).filter(each => !each.error && !each.kept);
  const gone = [];
  for (const each of loose.slice(keep)) {
    try { fs.unlinkSync(each.file); gone.push(each.file); } catch (_) {}
  }
  return gone;
}

// Saves a recorder's replay, into its own file (the same file each time for one session), and prunes. The file, or null.
function save(folder, recorder, keep = KEEP) {
  const replay = recorder.replay();
  if (!replay) return null;
  fs.mkdirSync(folder, { recursive: true });
  if (!recorder.file) {
    let file = path.join(folder, fileName(replay));
    for (let n = 2; fs.existsSync(file); n++) file = path.join(folder, fileName(replay).replace(EXTENSION, ` (${n})${EXTENSION}`));
    recorder.file = file;
  }
  // kept since it was first saved: it stays kept
  try { replay.kept = JSON.parse(fs.readFileSync(recorder.file, 'utf8')).kept === true; } catch (_) {}
  writeJson(recorder.file, replay);
  prune(folder, keep);
  return recorder.file;
}

// A replay file in the folder (and only there)
function inFolder(folder, file) {
  const resolved = path.resolve(file);
  return path.dirname(resolved) === path.resolve(folder) && resolved.endsWith(EXTENSION) ? resolved : null;
}

function read(file) {
  const stat = fs.statSync(file);
  if (stat.size > MAX_BYTES) throw new Error('That file is too large to be a replay.');
  const replay = parse(fs.readFileSync(file, 'utf8'));
  if (replay instanceof Error) throw replay;
  return replay;
}

function setKept(folder, file, kept) {
  const at = inFolder(folder, file);
  if (!at) throw new Error('That replay isn\'t in the replays folder.');
  const value = JSON.parse(fs.readFileSync(at, 'utf8'));
  if (value?.kind !== KIND) throw new Error('That file isn\'t a replay.');
  value.kept = Boolean(kept);
  writeJson(at, value);
}

function remove(folder, file) {
  const at = inFolder(folder, file);
  if (!at) throw new Error('That replay isn\'t in the replays folder.');
  fs.unlinkSync(at);
}

// A replay from elsewhere (someone sent it), copied into the folder and kept: { file, added } (added false when the
// folder had that battle already)
function importFile(folder, source) {
  const replay = read(source);
  fs.mkdirSync(folder, { recursive: true });
  const text = fs.readFileSync(source, 'utf8');
  const value = JSON.parse(text);
  value.kept = true;
  // already here: the same file
  for (const each of list(folder)) {
    if (each.error) continue;
    try {
      const other = JSON.parse(fs.readFileSync(each.file, 'utf8'));
      if (JSON.stringify(other.games) === JSON.stringify(value.games)) {
        if (!other.kept) setKept(folder, each.file, true);
        return { file: each.file, added: false };
      }
    } catch (_) {}
  }
  let file = path.join(folder, fileName(replay));
  for (let n = 2; fs.existsSync(file); n++) file = path.join(folder, fileName(replay).replace(EXTENSION, ` (${n})${EXTENSION}`));
  writeJson(file, value);
  return { file, added: true };
}

// --- Playing a replay: a session as src/online.js's, for the launcher's playBattle, with a bridge to the game and no room

// `dress(start)`, when given, makes the players' looks for a game's start, as a room's Session has it: { lines, folders }.
const DRESS_WAIT = 20000;
class ReplaySession extends EventEmitter {
  constructor(replay, { features = {}, dress = null, setTimeout: later = global.setTimeout } = {}) {
    super();
    this.replay = replay;
    this.features = features;   // rules, picks, crossplay: as src/online.js's Session has them
    this.dress = dress;
    this.later = later;
    this.dressing = null;       // { index, lines, folders }: the looks made for a game of the set
    this.role = 'replay';
    this.bridge = null;
    this.index = 0;             // the game of the set that plays
    this.turn = 0;              // the turn it is at, as the game says
    this.seekTo = 0;
    this.speed = 10;
    this.paused = false;
    this.pending = { index: 0, seek: 0 };   // what the game starts with next: null while nothing waits
    this.running = false;
    this.ended = false;         // the playing game's battle has its end
    this.closing = false;
    this.over = false;
    this.error = null;
  }

  get watcher() { return true; }
  get game() { return this.replay.games[this.index]; }
  get start() { return this.game.start; }   // (playBattle makes the game's battle rules file from its rules)

  async attachGame(createBridgeImpl = online.createBridge) {
    this.bridge = createBridgeImpl({ onLine: line => this.onGameLine(line), onClose: () => this.onGameClosed() });
    return this.bridge.listen();
  }

  // What the game is sent as it starts: the replay, then what a spectator's game is sent, with every line
  prepareGame() {
    const { index, seek } = this.pending;
    this.pending = null;
    this.index = index;
    this.turn = 0;
    this.seekTo = seek;
    this.ended = false;
    this.running = true;
    const game = this.game, start = game.start;
    this.bridge.reset?.();
    this.bridge.send(`replay ${game.turns}`);
    let line = this.features.rules ? formats.rulesLine(start.rules) : null;
    if (start.gamePicks && this.features.picks && start.rules.preview) line = `${line || 'rules'} pick=1`;
    if (this.features.crossplay) line = `${line || 'rules'} crossplay=1`;
    if (line) this.bridge.send(line);
    this.bridge.send(online.configLine({ side: online.WATCHING, rules: start.rules }));
    const looks = this.dressing?.index === index ? this.dressing.lines : [];
    for (const each of online.startLines(start, looks)) this.bridge.send(each);
    if (seek > 0) this.bridge.send(`seek ${seek}`);
    if (this.speed !== 10) this.bridge.send(`speed ${this.speed}`);
    for (const [side, each] of game.lines) this.bridge.send(`from ${side} ${each}`);
    this.emit('start', { ...start, game: game.game });
    this.emit('progress');
  }

  // Whether to start the game (again): at first, for a seek back, and for the set's next game once one ends
  again() {
    if (this.closing || this.over) return Promise.resolve(false);
    if (!this.pending) return Promise.resolve(false);
    return this.dressed(this.pending.index).then(() => {
      if (this.closing || this.over || !this.pending) return false;
      this.prepareGame();
      return true;
    });
  }

  // The players' looks for a game of the set, made once (a seek back starts the game again with the same ones); a game
  // waits up to DRESS_WAIT for them, then shows its usual trainers
  dressed(index) {
    if (!this.dress || this.dressing?.index === index) return Promise.resolve();
    const dressing = { index, lines: [], folders: [] };
    this.dressing = dressing;
    let making;
    try { making = Promise.resolve(this.dress(this.replay.games[index].start)); } catch (error) { making = Promise.reject(error); }
    const ready = making.then(made => {
      dressing.lines = Array.isArray(made?.lines) ? made.lines : [];
      dressing.folders = Array.isArray(made?.folders) ? made.folders : [];
    }, () => {});
    return new Promise(resolve => {
      const timer = this.later(resolve, DRESS_WAIT);
      ready.then(() => { clearTimeout(timer); resolve(); });
    });
  }

  // The folders of the players' looks' HD images, for the game about to start (playBattle)
  get looks() { return this.dressing?.index === this.index ? this.dressing.folders : []; }

  onGameLine(line) {
    const [word, value] = line.split(' ');
    const number = Number(value);
    if (word === 'turn' && Number.isInteger(number)) {
      this.turn = number;
      if (this.seekTo <= number) this.seekTo = 0;
      // a battle saved before its end: the game ends it where its lines do, once it has played the last turn
      if (number >= this.game.turns && !this.finishedGame()) this.bridge?.send('left');
      this.emit('progress');
    } else if (word === 'goto' && Number.isInteger(number)) this.seek(number);
    else if (word === 'speed' && Number.isInteger(number)) { this.speed = number; this.emit('progress'); }
    else if (word === 'paused') { this.paused = value === '1'; this.emit('progress'); }
    else if (word === 'desync') this.finish({ reason: 'desync', turn: this.turn });
    else if (word === 'end') {
      const winner = Number(value);
      this.finish({ reason: 'over', winner: Number.isInteger(winner) && winner >= 0 ? winner : null });
    }
  }

  finishedGame() { return this.game.result?.reason === 'over'; }

  finish(result) {
    if (this.ended) return;
    this.ended = true;
    this.paused = false;
    // the next game of the set plays once this one's game closes
    if (result.reason === 'over' && this.index + 1 < this.replay.games.length && !this.pending) this.pending = { index: this.index + 1, seek: 0, next: true };
    if (result.reason === 'desync') this.error = result;
    this.emit('end', { ...result, game: this.game.game });
    this.emit('progress');
  }

  onGameClosed() {
    this.running = false;
    // a game that stopped short of its end (the player closed it) ends the replay, unless a seek or the next game waits
    if (!this.pending && !this.ended) this.finish({ reason: 'closed' });
  }

  // Controls, from the page or the game's own buttons

  // to a turn of the playing game (0: its start): fast to a later one, from the start again for an earlier one
  seek(turn, index = this.index) {
    if (this.closing || !this.replay.games[index]) return;
    const target = Math.max(0, Math.min(Math.trunc(turn) || 0, this.replay.games[index].turns));
    if (index === this.index && this.running && !this.ended && target > this.turn) {
      this.seekTo = target;
      this.paused = false;
      this.bridge?.send(`seek ${target}`);
      this.emit('progress');
      return;
    }
    this.pending = { index, seek: target };
    this.seekTo = target;
    this.paused = false;
    if (this.running) this.bridge?.send('quit');
    this.emit('progress');
    this.emit('restart');
  }

  setSpeed(tenths) {
    if (!SPEEDS.includes(tenths)) return;
    this.speed = tenths;
    this.bridge?.send(`speed ${tenths}`);
    this.emit('progress');
  }

  setPaused(paused) {
    this.paused = Boolean(paused) && this.running && !this.ended;
    this.bridge?.send(`pause ${this.paused ? 1 : 0}`);
    this.emit('progress');
  }

  // What the page shows of where the replay is
  progress() {
    return { index: this.index, games: this.replay.games.map(game => ({ game: game.game, turns: game.turns, faints: game.faints, result: game.result })),
      turn: this.turn, seekTo: this.seekTo, speed: this.speed, paused: this.paused, running: this.running, ended: this.ended,
      restarting: Boolean(this.pending) && !this.pending.next && this.running, next: this.pending?.next ? this.pending.index : null };
  }

  close() {
    this.closing = true;
    this.over = true;
    this.pending = null;
    this.bridge?.close();
    this.bridge = null;
    this.emit('end-session');
  }
}

module.exports = { FORMAT, KIND, EXTENSION, KEEP, SPEEDS, Recorder, turnsOf, faintsOf, parse, fileName, list, summary, prune, save, read, setKept, remove, importFile, inFolder, ReplaySession };
