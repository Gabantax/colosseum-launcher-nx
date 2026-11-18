'use strict';
// One player's connection to an Online Trades room (colosseum-server-api src/trades.js; shadowtrade-work/SPEC-trades.md):
// a trade code made or joined, then the room's `state` after every change. The trade window draws from the last state;
// the player's choices go back with offer(), verdict(), ready(), unready() and leave(), and the trade itself (deposit,
// abort, ack) is online-trades.js's. A dropped connection comes back in with this player's key.
const { EventEmitter } = require('events');
const { openSocket, socketUrl, parseRoomCode, formatRoomCode } = require('./online');

const TRADE_PROTOCOL = 1;
const PING_EVERY = 30000;
const REPLY_WAIT = 8000;
const RECONNECT_EVERY = 2000;
const RECONNECT_FOR = 5 * 60 * 1000;   // a trade room waits; so does a player whose network blinked

const REFUSED = {
  launcher: 'That trade room\'s player has another version of the launcher. Both players need the newest one.',
  game: 'That trade room can\'t take this game.'
};

// Events: 'state' (the room's whole state for this side), 'room' ({ code, key }), 'error' (a reason the room gave for
// refusing a message), 'closed' (the room is gone: { reason }), 'connection' ('lost' | 'back').
class TradeSession extends EventEmitter {
  constructor({ url, WebSocket = globalThis.WebSocket, later = global.setTimeout, hello }) {
    super();
    this.url = url;
    this.WebSocket = WebSocket;
    this.later = later;
    this.hello = hello;      // { name, game, launcher }
    this.ws = null;
    this.code = null;
    this.key = null;
    this.role = null;
    this.state = null;
    this.closing = false;
    this.timer = null;
  }

  // A new trade code: resolves with it once the room has made it.
  async host() {
    this.role = 'host';
    await this.connect(`${socketUrl(this.url)}/v1/trades/new`);
    return this.first();
  }

  // Into the room of a code another player shared: resolves once in.
  async join(code) {
    const parsed = parseRoomCode(code);
    if (!parsed) throw new Error('That isn\'t a trade code: it has six letters and numbers.');
    this.role = 'joiner';
    this.code = parsed;
    try { await this.connect(`${socketUrl(this.url)}/v1/trades/${parsed}/join`); }
    catch (_) { throw new Error('No trade room has that code, or it\'s full. Check the code with the other player.'); }
    return this.first();
  }

  // Back into a room this player was in (after the launcher restarted), with its key.
  async resume({ role, code, key }) {
    Object.assign(this, { role, code, key });
    await this.connect(this.rejoinUrl());
    return this.first();
  }

  rejoinUrl() {
    return this.role === 'host' ? `${socketUrl(this.url)}/v1/trades/new?code=${this.code}&key=${this.key}`
      : `${socketUrl(this.url)}/v1/trades/${this.code}/join?key=${this.key}`;
  }

  get displayCode() { return this.code ? formatRoomCode(this.code) : null; }

  first() {
    return new Promise((resolve, reject) => {
      const timer = this.later(() => { cleanup(); reject(new Error('The trade server didn\'t answer.')); }, REPLY_WAIT);
      const done = state => { cleanup(); resolve(state); };
      const refused = reason => { cleanup(); reject(new Error(REFUSED[reason] || 'The trade room turned you away.')); };
      const cleanup = () => { clearTimeout(timer); this.off('state', done); this.off('refused', refused); };
      this.on('state', done);
      this.on('refused', refused);
    });
  }

  async connect(url) {
    const ws = await openSocket(url, this.WebSocket);
    this.ws = ws;
    ws.addEventListener('message', event => this.onMessage(ws, event.data));
    ws.addEventListener('close', event => this.onClose(ws, event));
    clearInterval(this.timer);
    this.timer = setInterval(() => this.send('ping'), PING_EVERY);
    this.timer.unref?.();
  }

  onMessage(ws, data) {
    if (ws !== this.ws || data === 'pong') return;
    let msg;
    try { msg = JSON.parse(data); } catch (_) { return; }
    if (msg.type === 'room') {
      this.code = msg.code;
      this.key = msg.key;
      this.emit('room', { code: msg.code, key: msg.key, role: this.role });
      this.sendJson({ type: 'hello', ...this.hello, protocol: TRADE_PROTOCOL });
    } else if (msg.type === 'state') {
      this.state = msg;
      this.emit('state', msg);
    } else if (msg.type === 'refused') this.emit('refused', msg.reason);
    else if (msg.type === 'error') this.emit('room-error', msg.reason);
    else if (msg.type === 'closed') { this.closing = true; this.emit('closed', { reason: 'host-left' }); }
  }

  async onClose(ws, event) {
    if (ws !== this.ws || this.closing) return;
    this.ws = null;
    if (event?.code === 4400 || event?.code === 4404) { this.emit('closed', { reason: 'gone' }); return; }
    this.emit('connection', 'lost');
    const until = Date.now() + RECONNECT_FOR;
    while (!this.closing && Date.now() < until) {
      try { await this.connect(this.rejoinUrl()); this.emit('connection', 'back'); return; }
      catch (_) { await new Promise(resolve => this.later(resolve, RECONNECT_EVERY)); }
    }
    if (!this.closing) this.emit('closed', { reason: 'dropped' });
  }

  send(text) { try { this.ws?.send(text); } catch (_) { /* reconnecting */ } }
  sendJson(value) { this.send(JSON.stringify(value)); }

  offer(pokemon) { this.sendJson({ type: 'offer', pokemon }); }
  verdict(hash, ok, reason) { this.sendJson({ type: 'verdict', hash, ok, ...(reason ? { reason } : {}) }); }
  ready() {
    const mine = this.state?.you.offer?.hash, theirs = this.state?.peer.offer?.hash;
    if (mine && theirs) this.sendJson({ type: 'ready', mine, theirs });
  }
  unready() { this.sendJson({ type: 'unready' }); }
  deposit(tradeId, pokemon) { this.sendJson({ type: 'deposit', tradeId, pokemon }); }
  abort(tradeId, reason) { this.sendJson({ type: 'abort', tradeId, reason }); }
  ack(tradeId) { this.sendJson({ type: 'ack', tradeId }); }

  leave() {
    this.sendJson({ type: 'leave' });
    this.close();
  }

  close() {
    this.closing = true;
    clearInterval(this.timer);
    try { this.ws?.close(1000, 'Done'); } catch (_) {}
    this.ws = null;
  }
}

module.exports = { TradeSession, TRADE_PROTOCOL };
