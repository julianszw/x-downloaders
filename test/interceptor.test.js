'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const read = (name) => fs.readFileSync(path.join(__dirname, '..', 'src', name), 'utf8');
const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

function body(id) {
  return JSON.stringify({ data: { result: {
    __typename: 'Tweet', rest_id: String(id),
    legacy: { full_text: 'x', extended_entities: { media: [{ id_str: `m${id}`, video_info: { variants: [
      { content_type: 'video/mp4', bitrate: 1, url: `https://video.twimg.com/v/${id}.mp4` },
    ] } }] } },
  } } });
}

// Página simulada: lo mínimo que usan parser.js e interceptor.js.
function makePage({ debug = false } = {}) {
  const posted = [];
  const listeners = [];
  const logs = [];
  class FakeXHR {
    constructor() { this.handlers = {}; this.responseType = ''; }
    open(method, url) { this.opened = [method, url]; return 'open-result'; }
    addEventListener(type, fn) { (this.handlers[type] ||= new Set()).add(fn); }
    respond(status, text) {
      this.status = status; this.responseText = text;
      for (const fn of this.handlers.load || []) fn.call(this);
    }
  }
  const page = {
    console: { log: (...args) => logs.push(args.join(' ')) },
    location: { origin: 'https://x.com' },
    localStorage: { getItem: (key) => (debug && key === 'xdlDebug' ? '1' : null) },
    XMLHttpRequest: FakeXHR,
    fetch: async (url) => page.nextResponse(url),
    postMessage: (data, origin) => posted.push({ data, origin }),
    addEventListener: (type, fn) => listeners.push(fn),
  };
  page.window = page;
  page.posted = posted;
  page.logs = logs;
  page.dispatch = (event) => listeners.forEach((fn) => fn(event));
  vm.createContext(page);
  page.realm = vm.runInContext('globalThis', page); // el `window` que ve el script
  vm.runInContext(read('parser.js'), page);
  vm.runInContext(read('interceptor.js'), page);
  return page;
}

test('fetch: la respuesta original llega intacta y se publica la entrada', async () => {
  const page = makePage();
  const original = new Response(body(1), { status: 200 });
  page.nextResponse = () => original;
  const received = await page.fetch('https://x.com/i/api/graphql/abc/HomeTimeline');
  assert.equal(received, original);
  assert.equal(await received.text(), body(1)); // el cuerpo sigue sin consumir
  await tick();
  assert.equal(page.posted.length, 1);
  assert.equal(page.posted[0].origin, 'https://x.com');
  assert.equal(page.posted[0].data.source, 'xdl');
  assert.equal(page.posted[0].data.entries[0].tweetId, '1');
  assert.equal(page.posted[0].data.entries[0].url, 'https://video.twimg.com/v/1.mp4');
  assert.equal(page.__xdlParseVideos, undefined); // no queda expuesto a la página
  assert.deepEqual(page.logs, []); // sin diagnóstico no se escribe en consola
});

test('fetch: se ignoran URLs ajenas, JSON inválido y errores de red', async () => {
  const page = makePage();
  page.nextResponse = () => new Response(body(2));
  await page.fetch('https://x.com/otra/cosa');
  page.nextResponse = () => new Response('video_info {no es json');
  await page.fetch('https://x.com/i/api/graphql/abc/TweetDetail');
  page.nextResponse = () => { throw new Error('sin red'); };
  await assert.rejects(page.fetch('https://x.com/i/api/graphql/abc/TweetDetail'), /sin red/);
  await tick();
  assert.equal(page.posted.length, 0);
});

test('XHR: open conserva su resultado y la respuesta se lee al cargar', () => {
  const page = makePage({ debug: true });
  const xhr = new page.XMLHttpRequest();
  assert.equal(xhr.open('GET', 'https://x.com/i/api/graphql/abc/UserTweets'), 'open-result');
  xhr.open('GET', 'https://x.com/i/api/graphql/abc/UserTweets'); // reabrir no duplica el listener
  xhr.respond(200, body(3));
  assert.equal(page.posted.length, 1);
  assert.equal(page.posted[0].data.entries[0].tweetId, '3');
  assert.ok(page.logs.some((line) => line.includes('3 -> https://video.twimg.com/v/3.mp4')));

  const failed = new page.XMLHttpRequest();
  failed.open('GET', 'https://x.com/i/api/graphql/abc/UserTweets');
  failed.respond(500, body(4));
  assert.equal(page.posted.length, 1);
});

test('el mapa no pasa de 500 y "hello" reenvía solo lo retenido', () => {
  const page = makePage();
  for (let id = 1; id <= 520; id++) {
    const xhr = new page.XMLHttpRequest();
    xhr.open('GET', 'https://x.com/i/api/graphql/abc/HomeTimeline');
    xhr.respond(200, body(id));
  }
  page.posted.length = 0;
  const hello = { source: page.realm, origin: 'https://x.com', data: { source: 'xdl', type: 'hello' } };
  page.dispatch({ ...hello, origin: 'https://evil.example' });
  page.dispatch({ ...hello, source: {} });
  assert.equal(page.posted.length, 0);
  page.dispatch(hello);
  const ids = page.posted[0].data.entries.map((e) => e.tweetId);
  assert.equal(ids.length, 500);
  assert.equal(ids[0], '21');
  assert.equal(ids.at(-1), '520');
});
