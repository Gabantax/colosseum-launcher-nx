// Pokémon that came from a trade (Online Trades or Shadowtrade) and are already in the save, waiting for the running game
// to show them: its P★DA-style notice, a trade evolution with the game's own scene, then a card with the Pokémon and
// "Open PC" or "Close" (the game's "arrive" command, host/arrival.c). Kept in a file until the game has shown each, so a
// trade made with the game closed is shown the next time it runs, and a trade evolution waits for it too.
//
// An arrival: { id, game, kind: 'trade'|'shadowtrade', from, data (base64: the Pokémon as this game has it), identity,
// place, evolvesInto (0 or the species it evolves into by trade), tradeId, at }.
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const STATE_VERSION = 1;
const SHOW_DAYS = 30;   // a notice not shown in this long is let go (a trade evolution never is)

function writeAtomic(file, text) {
  const temporary = `${file}.tmp`;
  fs.writeFileSync(temporary, text);
  try { fs.renameSync(temporary, file); } catch (error) {
    if (process.platform !== 'win32') throw error;
    fs.rmSync(file, { force: true });
    fs.renameSync(temporary, file);
  }
}

class Arrivals {
  // describe(arrival) -> { lines: ['show ...'], art: [{ width, height, rgba }] } (main.js: names, sprites); onDone(arrival,
  // result): shown (result.evolved: the species it evolved into, 0 none).
  constructor({ folder, log = () => {}, onChange = () => {}, describe = () => ({ lines: [], art: [] }), onDone = () => {}, now = () => Date.now() }) {
    Object.assign(this, { folder, log, onChange, describe, onDone, now });
    this.file = path.join(folder, 'state.json');
    this.state = this.load();
    this.busy = null;
  }

  load() {
    try {
      const state = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (state.version === STATE_VERSION && Array.isArray(state.waiting)) return state;
    } catch (_) { /* none yet */ }
    return { version: STATE_VERSION, waiting: [] };
  }

  save() {
    fs.mkdirSync(this.folder, { recursive: true });
    writeAtomic(this.file, JSON.stringify(this.state, null, 2));
    this.onChange(this.view());
  }

  view() { return { waiting: this.state.waiting.map(({ data, ...rest }) => rest) }; }

  add(arrival) {
    const entry = { id: crypto.randomBytes(8).toString('hex'), at: this.now(), evolvesInto: 0, ...arrival };
    if (entry.tradeId && this.state.waiting.some(each => each.tradeId === entry.tradeId)) return null;
    this.state.waiting.push(entry);
    this.save();
    return entry;
  }

  pending(game) { return this.state.waiting.filter(each => !game || each.game === game); }
  isWaiting(tradeId) { return this.state.waiting.some(each => each.tradeId === tradeId); }

  remove(entry) {
    this.state.waiting = this.state.waiting.filter(each => each !== entry);
    this.save();
  }

  // Shows what is waiting for `game` in the running game, one at a time (access: shadowtrade.js liveAccess; a card's
  // access has no game to show it in, so they wait). Stops at the first the game couldn't show now (it tries again later).
  deliver(game, access) {
    if (this.busy) return this.busy;
    const run = (async () => {
      {
        if (!access || access.mode !== 'live') return;
        for (const entry of this.pending(game)) {
          if (!entry.evolvesInto && this.now() - entry.at > SHOW_DAYS * 864e5) { this.remove(entry); continue; }
          let result;
          if (access.arrive) {
            let shown = { lines: [], art: [] };
            try { shown = this.describe(entry) || shown; } catch (error) { this.log(`Trades: couldn't describe the Pokémon (${error.message}).`); }
            result = await access.arrive(entry.identity, entry.place, { evolve: Boolean(entry.evolvesInto), lines: shown.lines, art: shown.art });
          } else if (entry.evolvesInto && access.evolve) {
            result = await access.evolve(entry.identity, entry.place || { area: 'party', box: 0, slot: 0 });
            if (result.ok) result.evolved = result.area === 'evolved' ? entry.evolvesInto : 0;   // ("ok evolved party 0 1 into N")
          } else result = { ok: true, evolved: 0 };   // a game too old to show it: nothing to wait for
          if (!result.ok && result.code !== 'missing') {
            this.log(`Trades: the game will show ${entry.kind === 'shadowtrade' ? 'the Shadowtrade' : 'the trade'} later (${result.code}).`);
            return;
          }
          this.remove(entry);
          this.onDone(entry, result);
        }
      }
    })();
    this.busy = run.finally(() => { if (this.busy === guarded) this.busy = null; });
    const guarded = this.busy;
    return guarded;
  }
}

module.exports = { Arrivals };
