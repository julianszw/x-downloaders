'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'background.js'), 'utf8');
const tick = () => new Promise((resolve) => setTimeout(resolve, 5));
// Los objetos creados dentro del contexto vm tienen otros prototipos.
const plain = (value) => JSON.parse(JSON.stringify(value));
const SENDER = { id: 'ext-id', url: 'https://x.com/home' };

function makeWorker(fetchImpl) {
  const handlers = {};
  const event = (name) => ({ addListener: (fn) => { handlers[name] = fn; } });
  const calls = { download: [], tabMessages: [] };
  const chrome = {
    runtime: { id: 'ext-id', onMessage: event('message'), onConnect: event('connect') },
    downloads: {
      onChanged: event('changed'),
      download: async (options) => { calls.download.push(options); return 7; },
      search: async () => [{ id: 7, byExtensionId: 'ext-id', error: 'NETWORK_FAILED' }],
    },
    tabs: {
      query: async () => [{ id: 11 }],
      sendMessage: async (tabId, message) => { calls.tabMessages.push({ tabId, message }); },
    },
  };
  vm.runInNewContext(source, { chrome, fetch: fetchImpl, URL, AbortController, btoa, console });
  return { handlers, calls };
}

async function send(worker, message, sender = SENDER) {
  let response;
  worker.handlers.message(message, sender, (value) => { response = value; });
  await tick();
  return response;
}

const VALID = { type: 'download', url: 'https://video.twimg.com/v/1.mp4', filename: 'x_ejemplo_123.mp4' };

test('download: un pedido válido llama a chrome.downloads', async () => {
  const worker = makeWorker();
  const response = await send(worker, VALID);
  assert.deepEqual(plain(response), { ok: true, id: 7 });
  assert.equal(worker.calls.download.length, 1);
  assert.equal(worker.calls.download[0].url, VALID.url);
  assert.equal(worker.calls.download[0].filename, VALID.filename);
});

test('download: se rechazan URL ajena, nombre inválido y emisor ajeno', async () => {
  const worker = makeWorker();
  const bad = [
    [{ ...VALID, url: 'https://evil.example/v.mp4' }, SENDER],
    [{ ...VALID, url: 'http://video.twimg.com/v/1.mp4' }, SENDER],
    [{ ...VALID, url: 'https://video.twimg.com.evil.example/v.mp4' }, SENDER],
    [{ ...VALID, filename: '../../x_a_1.mp4' }, SENDER],
    [{ ...VALID, filename: 'x_a_1.exe' }, SENDER],
    [VALID, { id: 'otra-extension', url: 'https://x.com/home' }],
    [VALID, { id: 'ext-id', url: 'https://evil.example/' }],
    [VALID, { id: 'ext-id' }],
  ];
  for (const [message, sender] of bad) {
    const response = await send(worker, message, sender);
    assert.equal(response.ok, false, JSON.stringify([message, sender]));
  }
  assert.equal(worker.calls.download.length, 0);
});

test('downloads.onChanged avisa a las pestañas de X el fin o la interrupción', async () => {
  const worker = makeWorker();
  await worker.handlers.changed({ id: 7, filename: { current: 'x' } }); // cambio irrelevante
  assert.equal(worker.calls.tabMessages.length, 0);
  await worker.handlers.changed({ id: 7, state: { current: 'interrupted' } });
  await tick();
  assert.deepEqual(plain(worker.calls.tabMessages), [
    { tabId: 11, message: { type: 'download-state', id: 7, state: 'interrupted', error: 'NETWORK_FAILED' } },
  ]);
});

// Puerto simulado que junta lo que el service worker envía.
function connect(worker, url, sender = SENDER) {
  const messages = [];
  let onMessage;
  const port = {
    name: 'xdl-fetch',
    sender,
    onDisconnect: { addListener() {} },
    onMessage: { addListener: (fn) => { onMessage = fn; } },
    postMessage: (message) => messages.push(message),
  };
  worker.handlers.connect(port);
  onMessage({ url });
  return messages;
}

function streamResponse(bytes, pieceSize, headers = {}) {
  let offset = 0;
  const stream = new ReadableStream({
    pull(controller) {
      if (offset >= bytes.length) return controller.close();
      controller.enqueue(bytes.subarray(offset, offset + pieceSize));
      offset += pieceSize;
    },
  });
  return new Response(stream, { headers });
}

test('respaldo: los trozos reensamblados son idénticos al original', async () => {
  const original = new Uint8Array(2.5 * 1024 * 1024 + 13);
  for (let i = 0; i < original.length; i++) original[i] = (i * 31 + 7) % 256;
  const worker = makeWorker(async () => streamResponse(original, 70000));
  const messages = connect(worker, 'https://video.twimg.com/v/1.mp4');
  await new Promise((resolve) => setTimeout(resolve, 200));

  assert.equal(messages.at(-1).type, 'done');
  assert.equal(messages.at(-1).size, original.length);
  const chunks = messages.filter((m) => m.type === 'chunk').map((m) => Buffer.from(m.data, 'base64'));
  assert.equal(chunks.length, 3);
  assert.ok(Buffer.concat(chunks).equals(Buffer.from(original)));
});

test('respaldo: un video mayor al tope devuelve too-big sin enviar datos', async () => {
  const big = String(301 * 1024 * 1024);
  const worker = makeWorker(async () => streamResponse(new Uint8Array(10), 10, { 'content-length': big }));
  const messages = connect(worker, 'https://video.twimg.com/v/1.mp4');
  await tick();
  assert.deepEqual(plain(messages), [{ type: 'error', code: 'too-big' }]);
});

test('respaldo: URL ajena, emisor ajeno y error de red', async () => {
  let fetched = 0;
  const worker = makeWorker(async () => { fetched++; throw new Error('sin red'); });
  assert.deepEqual(plain(connect(worker, 'https://evil.example/v.mp4')), [{ type: 'error', code: 'invalid' }]);
  assert.deepEqual(plain(connect(worker, 'https://video.twimg.com/v/1.mp4', { id: 'x', url: 'https://x.com/' })), [{ type: 'error', code: 'invalid' }]);
  assert.equal(fetched, 0);
  const messages = connect(worker, 'https://video.twimg.com/v/1.mp4');
  await tick();
  assert.equal(messages[0].code, 'network');
  assert.equal(fetched, 1);
});
