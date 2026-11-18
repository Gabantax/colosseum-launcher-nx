'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const { GameLink, createReader, parseLine, formatLine } = require('../src/game-link');

const connect = port => new Promise(resolve => { const socket = net.connect(port, '127.0.0.1', () => resolve(socket)); });
const until = (emitter, event) => new Promise(resolve => emitter.once(event, resolve));

test('a message is a line of words, with its data after it however the stream is cut', () => {
  const got = [];
  const push = createReader(message => got.push(message));
  const data = Buffer.from([0, 10, 13, 255, 10]);
  const stream = Buffer.concat([Buffer.from('live part=all seq=3 bytes=5\n'), data, Buffer.from('\nresult bytes=2\nok'), Buffer.from('welcome link=1\r\n')]);
  for (let i = 0; i < stream.length; i += 3) assert.equal(push(stream.subarray(i, i + 3)), null);
  assert.deepEqual(got.map(m => [m.verb, m.fields, [...m.data]]), [
    ['live', { part: 'all', seq: '3', bytes: '5' }, [...data]],
    ['result', { bytes: '2' }, [0x6f, 0x6b]],
    ['welcome', { link: '1' }, []]
  ]);
  assert.deepEqual(parseLine('cancel id=00ff'), { verb: 'cancel', fields: { id: '00ff' } });
  assert.equal(formatLine('command', {}, 12), 'command bytes=12\n');
  assert.throws(() => formatLine('command', { id: 'a\nb' }), /can't be sent/);
});

test('a stream that breaks the rules is read no further', () => {
  const push = createReader(() => {});
  assert.equal(push(Buffer.alloc(2000, 0x41)), 'line too long');
  assert.equal(createReader(() => {})(Buffer.from('live bytes=-1\n')), 'bad bytes=');
});

test('only the game with the token is linked, and what was sent before waits for it', async t => {
  const link = new GameLink();
  t.after(() => link.close());
  const port = await link.listen();
  assert.deepEqual(link.environment(), { COLO_LINK: `${port}:${link.token}` });
  link.send('command', {}, Buffer.from('id 0000000000000001\ntake party 0 0 1 2 3\n'));

  // not the game: refused, and nothing is sent to it
  const stranger = await connect(port);
  const strangerGot = [];
  stranger.on('data', chunk => strangerGot.push(chunk));
  stranger.write('hello link=1 token=wrong game=xd\n');
  await until(stranger, 'close');
  assert.equal(Buffer.concat(strangerGot).length, 0);
  assert.equal(link.linked, false);

  const game = await connect(port);
  t.after(() => game.destroy());
  const got = [];
  const push = createReader(message => got.push(message));
  game.on('data', chunk => push(chunk));
  const hello = until(link, 'hello');
  game.write(`hello link=1 token=${link.token} game=xd caps=shadowtrade.2,settings.1\n`);
  const info = await hello;
  assert.equal(info.game, 'xd');
  assert.equal(link.has('shadowtrade.2'), true);
  assert.equal(link.has('presence.1'), false);
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.deepEqual(got.map(m => m.verb), ['welcome', 'command']);
  assert.match(got[1].data.toString(), /^id 0000000000000001\n/);

  // a second game while one is linked is let go
  const second = await connect(port);
  await until(second, 'close');
  assert.equal(link.linked, true);

  // the game's messages, each as an event of its verb
  const live = until(link, 'message:live');
  game.write(Buffer.concat([Buffer.from('live part=head seq=2 bytes=4\n'), Buffer.from([1, 2, 3, 4])]));
  const message = await live;
  assert.deepEqual([message.fields.part, [...message.data]], ['head', [1, 2, 3, 4]]);
  const closed = until(link, 'close');
  game.destroy();
  await closed;
  assert.equal(link.linked, false);
});
