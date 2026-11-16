'use strict';

// Shadowtrade: a Wonder Trade for Shadow Pokémon. The player picks a Shadow Pokémon from their party or PC on the
// Pokémon page; it leaves their save and goes to colosseum-server-api's pool (its src/shadowtrade.js), and the
// Pokémon another player sent comes back into the save, at once when one is waiting, or later.
//
// A Pokémon is never in two places and never lost on the way:
//   1. It is written into the journal (state.json here) before anything else, then taken out of the save. With the
//      game closed, the launcher edits the card (save-pokemon.js editCard); with it running, the game takes it out
//      itself and saves (a command: SPEC in host/shadowtrade.c), as the launcher must never write a card the game is
//      using.
//   2. Only once the save no longer has it is it sent. The server answers to the same trade id the same way, so
//      sending again after a lost answer is safe.
//   3. The Pokémon received is put into the save the same two ways, then acknowledged, and only then forgotten here.
// After a crash at any step, sync() picks the trade up where it was, by looking at the save itself.
//
// The rules for which Shadow Pokémon can go and which a save can take are save-pokemon.js's (offerProblem,
// shadowAccepts), worked out from the research into each game's Shadow data.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const telemetry = require('./telemetry');
const savePokemon = require('./save-pokemon');

const STATE_VERSION = 1;
const HISTORY = 30;
const COMMAND_TIMEOUT_MS = 10 * 60 * 1000;   // how long a command waits for the game to reach a safe moment
const COMMAND_POLL_MS = 250;

const b64 = bytes => Buffer.from(bytes).toString('base64');
const unb64 = text => Buffer.from(String(text || ''), 'base64');

function serverUrl(env = process.env) { return telemetry.endpoint(env); }

// Which pool a save trades in: its game's. A randomizer run trades with every other save of its game: a Shadow Pokémon
// received gets an entry of its own in the save (save-pokemon.js), so what the run made of each Shadow id doesn't
// matter. (`randomized` is kept for the server's randomized pools, which nothing sends to now.)
function poolFor(game, _randomized) { return game; }
const gameOfPool = pool => pool.split('-')[0];

// What the player sees of a Pokémon in a trade.
function summary(pokemon) {
  return { species: pokemon.species, shadowId: pokemon.shadowId, level: pokemon.level, nickname: pokemon.nickname, shiny: Boolean(pokemon.shiny) };
}

// Reads a received Pokémon's bytes as the game would (save-pokemon.js), and checks it is one this game can take:
// the right size, a species the game has, not an egg, a Shadow of the story.
function checkReceived(game, received) {
  const data = unb64(received?.pokemon?.data), record = received?.pokemon?.record ? unb64(received.pokemon.record) : null;
  const size = game === 'xd' ? savePokemon.XD.size : savePokemon.COLOSSEUM.size;
  if (data.length !== size || (game === 'xd' && (!record || record.length !== savePokemon.XD.recordSize))) throw new Error('The Pokémon received is damaged.');
  const species = data.readUInt16BE(0);
  if (!((species >= 1 && species <= 251) || (species >= 277 && species <= 411))) throw new Error('The Pokémon received isn\'t one this game has.');
  if (game === 'xd') {
    const id = data.readUInt16BE(savePokemon.XD.at.shadow);
    if ((data[savePokemon.XD.at.flags] & 0x80) || id < 1 || id > 0x53 || id === 73 || (record[0] >> 5) !== 3) throw new Error('The Pokémon received isn\'t a Shadow Pokémon.');
  } else {
    const id = data.readUInt16BE(savePokemon.COLOSSEUM.at.shadow), heart = data.readInt32BE(savePokemon.COLOSSEUM.at.heart);
    if (data[savePokemon.COLOSSEUM.at.egg] || !savePokemon.COLOSSEUM_STORY_IDS.includes(id) || heart < 0) throw new Error('The Pokémon received isn\'t a Shadow Pokémon.');
  }
  return { data, record };
}

// ---- access to a save: the card (game closed) or the running game (live.bin + commands) ----

// The card: read it, and change it with a backup first. backup(reason) makes one (main.js makeSaveBackup).
function cardAccess({ game, saveDir, randomized = false, backup = () => {} }) {
  return {
    game, mode: 'card', pool: poolFor(game, randomized),
    read() {
      const { copies } = savePokemon.cardCopies(saveDir, game);
      if (!copies.length) return null;
      return { model: savePokemon.model(copies[0].ctx), ctx: copies[0].ctx };
    },
    async take(identity, place) {
      backup('before-shadowtrade');
      const done = savePokemon.editCard(saveDir, game, ctx => savePokemon.takeFrom(ctx, identity, place));
      return done ? { ok: true, area: done.area, box: done.box, slot: done.slot } : { ok: false, code: 'missing' };
    },
    async give(data, record) {
      backup('before-shadowtrade');
      const done = savePokemon.editCard(saveDir, game, ctx => savePokemon.giveTo(ctx, data, record) || null);
      return done ? { ok: true, area: done.area, box: done.box, slot: done.slot, already: Boolean(done.already) } : { ok: false, code: 'full' };
    },
    has(identity) {
      const { copies } = savePokemon.cardCopies(saveDir, game);
      return Boolean(copies.length && savePokemon.findPokemon(copies[0].ctx, identity));
    }
  };
}

function writeAtomic(file, text) {
  const temporary = `${file}.tmp`;
  fs.writeFileSync(temporary, text);
  try { fs.renameSync(temporary, file); } catch (error) {
    if (process.platform !== 'win32') throw error;
    fs.rmSync(file, { force: true });
    fs.renameSync(temporary, file);
  }
}

function parseResult(text) {
  const lines = String(text).split('\n').map(line => line.trim()).filter(Boolean);
  const id = /^id ([0-9a-f]{16})$/.exec(lines[0] || '')?.[1];
  const words = (lines[1] || '').split(' ');
  if (!id) return null;
  if (words[0] === 'ok') {
    const already = words[1] === 'already', rest = already ? words.slice(2) : words.slice(1);
    return { id, ok: true, already, area: rest[0], box: Number(rest[1]), slot: Number(rest[2]) };
  }
  return { id, ok: false, code: words[1] || 'error', message: words.slice(2).join(' ') };
}

// The running game: it shows its save in live.bin and makes changes itself (SPEC: host/shadowtrade.c). Commands only
// go to a game playing the card's own save (its trainer), so a new game never saved can't save over it.
function liveAccess({ game, liveDir, cardTrainerId, randomized = false, wait = ms => new Promise(resolve => setTimeout(resolve, ms)), timeoutMs = COMMAND_TIMEOUT_MS, onWaiting = () => {} }) {
  const liveFile = path.join(liveDir, 'live.bin'), commandFile = path.join(liveDir, 'command.txt'), resultFile = path.join(liveDir, 'result.txt');
  const current = () => savePokemon.readLive(liveFile);
  async function command(lines) {
    const live = current();
    if (!live?.head.loaded) throw new Error('Load your save in the game first.');
    if (cardTrainerId !== null && cardTrainerId !== undefined && live.head.trainerId !== cardTrainerId)
      throw new Error('The game is playing a game that isn\'t saved yet. Save it in the game first.');
    const id = crypto.randomBytes(8).toString('hex');
    fs.rmSync(resultFile, { force: true });
    writeAtomic(commandFile, `id ${id}\n${lines}\n`);
    // The game's save ends on its own "saved" message, which waits for A: while it says it's busy with the command, the
    // command is under way however long that takes, and it's left for the game to finish.
    let until = Date.now() + timeoutMs;
    let told = false;
    for (;;) {
      let result = null;
      try { result = parseResult(fs.readFileSync(resultFile, 'utf8')); } catch (_) { /* not yet */ }
      if (result?.id === id) {
        fs.rmSync(resultFile, { force: true });
        return result;
      }
      const head = current()?.head;
      if (head?.busy) until = Math.max(until, Date.now() + COMMAND_POLL_MS * 8);
      if (Date.now() >= until) break;
      if (!told && head && !(head.safe && head.canSave)) { told = true; onWaiting(); }
      await wait(COMMAND_POLL_MS);
    }
    fs.rmSync(commandFile, { force: true });
    return { ok: false, code: 'timeout' };
  }
  return {
    game, mode: 'live', pool: poolFor(game, randomized),
    read() {
      const live = current();
      return live?.ctx ? { model: live.model, ctx: live.ctx, head: live.head } : null;
    },
    take(identity, place) {
      const hex = n => (n >>> 0).toString(16);
      return command(`take ${place.area} ${place.box} ${place.slot} ${hex(identity.species)} ${hex(identity.rnd)} ${hex(identity.trainer)}`);
    },
    give(data, record) { return command(`give ${data.toString('hex')}${record ? ` record ${record.toString('hex')}` : ''}`); },
    has(identity) {
      const live = current();
      return Boolean(live?.ctx && savePokemon.findPokemon(live.ctx, identity));
    }
  };
}

// ---- the trades ----

class Shadowtrade {
  constructor({ folder, url = serverUrl(), fetch = globalThis.fetch, log = () => {}, onChange = () => {} }) {
    this.folder = folder; this.url = url; this.fetch = fetch; this.log = log; this.onChange = onChange;
    this.file = path.join(folder, 'state.json');
    this.busy = null;
    this.state = this.load();
  }

  load() {
    try {
      const state = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (state.version === STATE_VERSION && /^[0-9a-f]{64}$/.test(state.key)) return { journal: [], history: [], ...state };
    } catch (_) { /* a new one */ }
    return { version: STATE_VERSION, key: crypto.randomBytes(32).toString('hex'), journal: [], history: [] };
  }

  save() {
    fs.mkdirSync(this.folder, { recursive: true });
    writeAtomic(this.file, JSON.stringify(this.state, null, 2));
    this.onChange(this.view());
  }

  view() {
    const each = entry => ({ tradeId: entry.tradeId, game: entry.game, pool: entry.pool, stage: entry.stage, sent: entry.sent.summary,
      received: entry.received ? { ...entry.received.summary, from: entry.received.from, returned: Boolean(entry.received.returned) } : null,
      placedAt: entry.placedAt || null, message: entry.message || null, createdAt: entry.createdAt });
    return { trades: this.state.journal.map(each), history: this.state.history.slice(0, HISTORY), busy: Boolean(this.busy) };
  }

  async post(action, body) {
    const response = await this.fetch(`${this.url}/v1/shadowtrade/${action}`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: this.state.key, ...body }) });
    let reply = null;
    try { reply = await response.json(); } catch (_) { /* below */ }
    if (!response.ok) throw Object.assign(new Error(reply?.error || `The Shadowtrade server answered ${response.status}.`), { status: response.status });
    return reply;
  }

  async exclusive(work) {
    while (this.busy) await this.busy.catch(() => {});
    this.busy = work();
    try { return await this.busy; } finally { this.busy = null; this.onChange(this.view()); }
  }

  // Sends the Shadow Pokémon at `place` ({ area, box, slot }) of the save `access` reaches.
  offer(access, place) {
    return this.exclusive(async () => {
      const read = access.read();
      if (!read) throw new Error('There is no save to trade from yet.');
      const list = place.area === 'party' ? read.model.party : read.model.boxes[place.box]?.pokemon;
      const pokemon = list?.[place.slot];
      const problem = savePokemon.offerProblem(read.model, pokemon);
      if (problem) throw new Error(problem);
      const identity = { species: pokemon.species, rnd: pokemon.rnd, trainer: pokemon.trainer };
      const found = savePokemon.findPokemon(read.ctx, identity, place);
      const record = access.game === 'xd' ? read.ctx.plain.subarray(read.ctx.sections.darkPokemon + pokemon.shadowId * savePokemon.XD.recordSize,
        read.ctx.sections.darkPokemon + (pokemon.shadowId + 1) * savePokemon.XD.recordSize) : null;
      const entry = { tradeId: crypto.randomBytes(16).toString('hex'), game: access.game, pool: access.pool, stage: 'taking', createdAt: Date.now(),
        trainerName: read.model.trainer, accepts: savePokemon.acceptsAfterTaking(read.model, read.ctx, pokemon),
        sent: { data: b64(found.bytes), record: record ? b64(record) : null, identity, place, summary: summary(pokemon) } };
      this.state.journal.push(entry);
      this.save();
      const taken = await access.take(identity, place);
      if (!taken.ok) {
        if (taken.code === 'missing' && !access.has(identity)) this.log('Shadowtrade: the Pokémon had already left the save.');
        else {
          this.state.journal = this.state.journal.filter(each => each !== entry);
          this.save();
          throw new Error(this.commandError(taken));
        }
      }
      entry.stage = 'taken';
      this.save();
      this.log(`Shadowtrade: ${pokemon.nickname} left the save for the ${entry.pool} pool.`);
      await this.send(entry);
      if (entry.stage === 'received') await this.deliver(entry, access);
      return this.view();
    });
  }

  commandError(result) {
    return { 'last-pokemon': 'You can\'t trade your last Pokémon that can battle: keep one in your party.', 'not-shadow': 'Only Shadow Pokémon can go to Shadowtrade.',
      lugia: 'XD-001 can\'t be traded.', full: 'Your party and PC boxes are full: make room for the Pokémon you\'ll receive.',
      save: 'The game couldn\'t save, so nothing was traded.', timeout: 'The game didn\'t reach a moment it could trade in: walk around in the field, outside menus and battles, and try again.',
      invalid: 'The game refused the Pokémon received.', missing: 'That Pokémon isn\'t in the save any more.' }[result.code] || `The game couldn't trade (${result.code}${result.message ? `: ${result.message}` : ''}).`;
  }

  // Sends a taken Pokémon (again, if an answer was lost). Leaves it 'taken' when the server can't be reached.
  async send(entry) {
    try {
      const reply = await this.post('offer', { pool: entry.pool, tradeId: entry.tradeId, trainerName: entry.trainerName, accepts: entry.accepts,
        pokemon: { data: entry.sent.data, ...(entry.sent.record ? { record: entry.sent.record } : {}) } });
      this.apply(entry, reply.trade);
    } catch (error) {
      entry.message = `Not sent yet: ${error.message} It's kept safe and sent when the server can be reached.`;
      this.log(`Shadowtrade: ${error.message}`);
      if (error.status === 400 || error.status === 409) entry.message = `The server refused it: ${error.message} Cancel to get it back.`;
    }
    this.save();
  }

  // The server's view of a trade, into the journal.
  apply(entry, trade) {
    if (!trade) return;
    entry.message = null;
    if (trade.status === 'waiting' && entry.stage === 'taken') entry.stage = 'waiting';
    if (trade.status === 'received' && trade.received && ['taken', 'waiting'].includes(entry.stage)) {
      entry.stage = 'received';
      entry.received = { data: trade.received.pokemon.data, record: trade.received.pokemon.record || null, from: trade.received.from,
        summary: summary(trade.received) };
    }
    if (trade.status === 'cancelled' && trade.returned && ['taken', 'waiting'].includes(entry.stage)) {
      entry.stage = 'received';
      entry.received = { data: trade.returned.pokemon.data, record: trade.returned.pokemon.record || null, from: entry.trainerName, returned: true,
        summary: entry.sent.summary };
    }
  }

  // Puts a received Pokémon into the save, then tells the server it's there.
  async deliver(entry, access) {
    if (!access) return;
    let checked;
    try { checked = checkReceived(entry.game, { pokemon: { data: entry.received.data, record: entry.received.record } }); } catch (error) {
      entry.message = error.message;
      this.save();
      return;
    }
    if (entry.stage === 'received') { entry.stage = 'giving'; this.save(); }
    if (entry.stage === 'giving') {
      const identity = { species: checked.data.readUInt16BE(0), rnd: checked.data.readUInt32BE(entry.game === 'xd' ? 0x28 : 0x04),
        trainer: checked.data.readUInt32BE(entry.game === 'xd' ? 0x24 : 0x14) };
      let record = checked.record;
      if (entry.game === 'xd' && access.mode === 'live') {
        // the game writes the record as given: merged here from this save's own (save-pokemon.js mergeXdRecord)
        const read = access.read();
        const at = read.ctx.sections.darkPokemon + checked.data.readUInt16BE(savePokemon.XD.at.shadow) * savePokemon.XD.recordSize;
        const party = read.model.party.filter(Boolean).length < savePokemon.PARTY_SIZE;
        record = savePokemon.mergeXdRecord(read.ctx.plain.subarray(at, at + savePokemon.XD.recordSize), checked.record, checked.data.readUInt16BE(savePokemon.XD.at.shadow),
          { area: party ? 'party' : 'box', box: 0 }, read.ctx.plain.readUInt32BE(read.ctx.sections.hero + savePokemon.XD.meetCount));
      }
      const given = access.has(identity) ? { ok: true, already: true } : await access.give(checked.data, record);
      if (!given.ok) {
        entry.stage = 'received';
        entry.message = this.commandError(given);
        this.save();
        return;
      }
      entry.stage = 'given';
      entry.placedAt = given.area ? { area: given.area, box: given.box, slot: given.slot } : entry.placedAt || null;
      this.save();
      this.log(`Shadowtrade: ${entry.received.summary.nickname} from ${entry.received.from || 'another player'} is in the save.`);
    }
    await this.finish(entry);
  }

  async finish(entry) {
    try { await this.post('ack', { pool: entry.pool, tradeId: entry.tradeId }); } catch (error) {
      entry.message = null;
      this.log(`Shadowtrade: couldn't tell the server yet (${error.message}).`);
      this.save();
      return;
    }
    this.state.journal = this.state.journal.filter(each => each !== entry);
    this.state.history.unshift({ tradeId: entry.tradeId, game: entry.game, sent: entry.sent.summary, received: entry.received.summary,
      from: entry.received.from, returned: Boolean(entry.received.returned), placedAt: entry.placedAt, at: Date.now() });
    this.state.history = this.state.history.slice(0, HISTORY);
    this.save();
  }

  // Everything not finished, moved on: interrupted takes and gives settled by looking at the save, unsent Pokémon
  // sent, waiting trades asked about (with each save's Shadow ids as they are now), received ones delivered.
  // accessFor(game) gives the access for a game's save now, or null when it can't be reached (then its trades wait).
  sync(accessFor) {
    return this.exclusive(async () => {
      const accesses = new Map();
      const access = game => { if (!accesses.has(game)) accesses.set(game, accessFor(game)); return accesses.get(game); };
      for (const entry of [...this.state.journal]) {
        const a = access(entry.game);
        if (entry.stage === 'taking') {
          if (!a) continue;
          // the take was cut short: did it happen?
          if (a.has(entry.sent.identity)) { this.state.journal = this.state.journal.filter(each => each !== entry); this.save(); continue; }
          entry.stage = 'taken';
          this.save();
        }
        if (entry.stage === 'taken') await this.send(entry);
      }
      const accepts = {};
      for (const pool of new Set(this.state.journal.filter(entry => entry.stage === 'waiting').map(entry => entry.pool))) {
        const read = access(gameOfPool(pool))?.read();
        if (read) accepts[pool] = savePokemon.shadowAccepts(read.model, read.ctx);
      }
      if (this.state.journal.some(entry => entry.stage === 'waiting')) {
        try {
          const reply = await this.post('status', { accepts });
          for (const trade of reply.trades || []) {
            const entry = this.state.journal.find(each => each.tradeId === trade.tradeId);
            if (entry) this.apply(entry, trade);
          }
          this.save();
        } catch (error) { this.log(`Shadowtrade: ${error.message}`); }
      }
      for (const entry of [...this.state.journal]) {
        if (['received', 'giving'].includes(entry.stage)) await this.deliver(entry, access(entry.game));
        else if (entry.stage === 'given') await this.finish(entry);
      }
      return this.view();
    });
  }

  // Takes a waiting Pokémon back out of the pool, if no one has it yet; it then comes back into the save.
  cancel(tradeId, accessFor) {
    return this.exclusive(async () => {
      const entry = this.state.journal.find(each => each.tradeId === tradeId);
      if (!entry) throw new Error('That trade is finished.');
      if (entry.stage === 'taken' || entry.stage === 'waiting') {
        // A taken one may have reached the server even if its answer was lost: ask. Only one the server has never
        // seen comes straight back.
        let reply;
        try { reply = await this.post('cancel', { pool: entry.pool, tradeId }); } catch (error) {
          if (error.status !== 404) throw new Error(`The Shadowtrade server can't be reached, so it can't be cancelled yet: ${error.message}`);
          entry.stage = 'received';
          entry.received = { data: entry.sent.data, record: entry.sent.record, from: entry.trainerName, returned: true, summary: entry.sent.summary };
        }
        if (reply) {
          if (entry.stage === 'taken') entry.stage = 'waiting';
          this.apply(entry, reply.trade);
        }
        if (entry.stage === 'waiting') { this.save(); throw new Error('It has already gone to another player: yours is on its way.'); }
      } else throw new Error('That trade can\'t be cancelled now.');
      this.save();
      await this.deliver(entry, accessFor(entry.game));
      return this.view();
    });
  }
}

module.exports = { Shadowtrade, cardAccess, liveAccess, checkReceived, poolFor, parseResult, serverUrl, COMMAND_TIMEOUT_MS };
