'use strict';
// The launcher link: one local connection with the game the launcher started, for what the launcher asks of the
// running game and what the game tells it (the game's host/launcherlink.c). The launcher listens on 127.0.0.1 and
// gives the game COLO_LINK=port:token; the game connects as it starts and says
// "hello link=1 token=… game=colosseum|xd caps=shadowtrade.2". A message is a line of text, a verb then key=value
// words, ended by \n; with bytes=N in it, N bytes of data follow the line. A verb nobody handles is let go, so either
// side can be newer than the other. Only a game that knows the token is listened to.
const crypto = require('crypto');
const net = require('net');
const { EventEmitter } = require('events');

const LINK_VERSION = 1;
const LINE_MAX = 1024;
const DATA_MAX = 64 * 1024 * 1024;   // the most one message from the game may carry (a whole save is under 1 MB)
const HELLO_WAIT_MS = 10 * 1000;     // a connection that hasn't said hello by then isn't the game

// "verb a=1 b=2" → { verb, fields: { a: '1', b: '2' } }
function parseLine(line) {
  const [verb = '', ...words] = line.split(' ').filter(Boolean);
  const fields = {};
  for (const word of words) {
    const at = word.indexOf('=');
    if (at > 0) fields[word.slice(0, at)] = word.slice(at + 1);
  }
  return { verb, fields };
}

function formatLine(verb, fields = {}, size = 0) {
  const words = [verb, ...Object.entries(fields).map(([key, value]) => `${key}=${value}`)];
  if (size) words.push(`bytes=${size}`);
  const line = words.join(' ');
  if (line.length >= LINE_MAX || /[\n\r]/.test(line)) throw new Error('A launcher link line can\'t be sent like that.');
  return `${line}\n`;
}

// Reads messages from a stream of chunks: push(chunk) calls onMessage({ verb, fields, line, data }) for each whole
// one, and returns an error message once the stream breaks the rules (then nothing more is read).
function createReader(onMessage) {
  let pending = Buffer.alloc(0), message = null, broken = null;
  return function push(chunk) {
    if (broken) return broken;
    pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
    for (;;) {
      if (message) {
        if (pending.length < message.size) return null;
        const data = Buffer.from(pending.subarray(0, message.size));
        pending = pending.subarray(message.size);
        const done = message;
        message = null;
        onMessage({ verb: done.verb, fields: done.fields, line: done.line, data });
        continue;
      }
      const end = pending.indexOf(0x0a);
      if (end < 0) {
        if (pending.length >= LINE_MAX) return (broken = 'line too long');
        return null;
      }
      if (end >= LINE_MAX) return (broken = 'line too long');
      const line = pending.subarray(0, end).toString('latin1').replace(/\r$/, '');
      pending = pending.subarray(end + 1);
      if (!line) continue;
      const { verb, fields } = parseLine(line);
      const size = fields.bytes === undefined ? 0 : Number(fields.bytes);
      if (!Number.isSafeInteger(size) || size < 0 || size > DATA_MAX) return (broken = 'bad bytes=');
      if (size) message = { verb, fields, line, size };
      else onMessage({ verb, fields, line, data: Buffer.alloc(0) });
    }
  };
}

// One game's link. Events: 'hello' (fields: game, caps as a Set, link), 'message' ({ verb, fields, line, data }) and
// `message:<verb>` for each, 'close'. send() before the game is linked waits for it.
class GameLink extends EventEmitter {
  constructor({ token = crypto.randomBytes(16).toString('hex'), createServer = net.createServer, log = () => {} } = {}) {
    super();
    this.token = token;
    this.log = log;
    this.socket = null;
    this.hello = null;
    this.waiting = [];
    this.closed = false;
    this.server = createServer(connection => this.connected(connection));
    this.server.on('error', error => this.log(`Launcher link: ${error.message}`));
  }

  listen() {
    return new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(0, '127.0.0.1', () => { this.port = this.server.address().port; resolve(this.port); });
    });
  }

  // what the game's environment needs for the link
  environment() { return { COLO_LINK: `${this.port}:${this.token}` }; }

  get linked() { return Boolean(this.socket && this.hello); }

  has(capability) { return Boolean(this.hello?.caps.has(capability)); }

  connected(connection) {
    // one game a link: another connection while it is linked is let go
    if (this.socket || this.closed) return connection.destroy();
    connection.setNoDelay?.(true);
    let hello = null;
    const timer = setTimeout(() => { if (!hello) connection.destroy(); }, HELLO_WAIT_MS);
    const push = createReader(message => {
      if (!hello) {
        const ok = message.verb === 'hello' && message.fields.token === this.token && Number(message.fields.link) >= 1;
        if (!ok) { this.log('Launcher link: a connection that isn\'t the game was refused.'); connection.destroy(); return; }
        clearTimeout(timer);
        hello = { link: Number(message.fields.link), game: message.fields.game || null,
          caps: new Set((message.fields.caps || '').split(',').filter(Boolean)) };
        this.socket = connection;
        this.hello = hello;
        connection.write(formatLine('welcome', { link: LINK_VERSION }));
        for (const each of this.waiting) connection.write(each);
        this.waiting = [];
        this.emit('hello', hello);
        return;
      }
      this.emit('message', message);
      this.emit(`message:${message.verb}`, message);
    });
    connection.on('data', chunk => {
      const broken = push(chunk);
      if (broken) { this.log(`Launcher link: the game's messages broke off (${broken}).`); connection.destroy(); }
    });
    connection.on('error', () => {});
    connection.on('close', () => {
      clearTimeout(timer);
      if (this.socket !== connection) return;
      this.socket = null;
      this.hello = null;
      this.emit('close');
    });
  }

  send(verb, fields = {}, data = null) {
    const head = formatLine(verb, fields, data ? data.length : 0);
    const bytes = data?.length ? Buffer.concat([Buffer.from(head, 'latin1'), data]) : Buffer.from(head, 'latin1');
    if (this.linked) this.socket.write(bytes);
    else if (!this.closed) this.waiting.push(bytes);
  }

  close() {
    this.closed = true;
    this.waiting = [];
    this.socket?.destroy();
    this.server.close();
  }
}

module.exports = { GameLink, createReader, parseLine, formatLine, LINK_VERSION };
