'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseVideos } = require('../src/parser.js');

const mp4 = (name, bitrate) => ({ content_type: 'video/mp4', bitrate, url: `https://video.twimg.com/ext_tw_video/1/pu/vid/${name}.mp4?tag=12` });
const hls = { content_type: 'application/x-mpegURL', url: 'https://video.twimg.com/ext_tw_video/1/pu/pl/x.m3u8' };

function media(id, variants, type = 'video') {
  return { id_str: id, type, media_key: `7_${id}`, video_info: { aspect_ratio: [16, 9], variants } };
}

// Resultado GraphQL de un tweet, con la forma que usa la API de X.
function tweet(id, { medias = [], user = 'ejemplo', extra = {}, legacyExtra = {} } = {}) {
  return {
    __typename: 'Tweet',
    rest_id: id,
    core: { user_results: { result: { __typename: 'User', rest_id: '999', core: { screen_name: user }, legacy: { name: 'Ejemplo' } } } },
    legacy: {
      id_str: id,
      full_text: 'hola',
      entities: medias.length ? { media: medias } : {},
      ...(medias.length ? { extended_entities: { media: medias } } : {}),
      ...legacyExtra,
    },
    ...extra,
  };
}

// Envuelve resultados de tweets como una respuesta de timeline.
function timeline(...results) {
  return {
    data: { home: { home_timeline_urt: { instructions: [{
      type: 'TimelineAddEntries',
      entries: results.map((result, i) => ({
        entryId: `tweet-${i}`,
        content: { itemContent: { itemType: 'TimelineTweet', tweet_results: { result } } },
      })),
    }] } } },
  };
}

const byId = (entries) => Object.fromEntries(entries.map((e) => [e.tweetId, e]));

test('elige el mp4 de mayor bitrate entre varias calidades', () => {
  const variants = [hls, mp4('low', 256000), mp4('high', 2176000), mp4('mid', 832000)];
  const entries = parseVideos(timeline(tweet('100', { medias: [media('m1', variants)] })));
  assert.equal(entries.length, 1);
  assert.equal(entries[0].tweetId, '100');
  assert.match(entries[0].url, /high\.mp4/);
  assert.equal(entries[0].hlsOnly, false);
  assert.equal(entries[0].user, 'ejemplo');
});

test('GIF animado con bitrate 0', () => {
  const entries = parseVideos(timeline(tweet('101', { medias: [media('g1', [mp4('gif', 0)], 'animated_gif')] })));
  assert.equal(entries.length, 1);
  assert.match(entries[0].url, /gif\.mp4/);
});

test('tweet citado con video: video en el citado y vínculo desde el que cita', () => {
  const quoted = tweet('201', { medias: [media('m2', [mp4('q', 832000)])], user: 'citado' });
  const outer = tweet('200', {
    extra: { quoted_status_result: { result: quoted } },
    legacyExtra: { is_quote_status: true, quoted_status_id_str: '201' },
  });
  const entries = byId(parseVideos(timeline(outer)));
  assert.match(entries['201'].url, /q\.mp4/);
  assert.equal(entries['201'].user, 'citado');
  assert.equal(entries['200'].url, null);
  assert.equal(entries['200'].hlsOnly, false);
  assert.equal(entries['200'].quotedId, '201');
});

test('tweet citado sin quoted_status_id_str: el vínculo sale de la anidación', () => {
  const quoted = { __typename: 'TweetWithVisibilityResults', tweet: tweet('211', { medias: [media('m3', [mp4('q2', 1)])] }) };
  const outer = tweet('210', { extra: { quoted_status_result: { result: quoted } } });
  const entries = byId(parseVideos(timeline(outer)));
  assert.match(entries['211'].url, /q2\.mp4/);
  assert.equal(entries['210'].quotedId, '211');
});

test('tweet con video propio que además cita otro video conserva el propio', () => {
  const quoted = tweet('221', { medias: [media('m4', [mp4('quoted', 1)])] });
  const outer = tweet('220', { medias: [media('m5', [mp4('own', 1)])], extra: { quoted_status_result: { result: quoted } } });
  const entries = byId(parseVideos(timeline(outer)));
  assert.match(entries['220'].url, /own\.mp4/);
  assert.match(entries['221'].url, /quoted\.mp4/);
});

test('TweetWithVisibilityResults: el tweet anidado en "tweet"', () => {
  const wrapped = { __typename: 'TweetWithVisibilityResults', tweet: tweet('300', { medias: [media('m6', [mp4('v', 5)])] }) };
  const entries = parseVideos(timeline(wrapped));
  assert.deepEqual(entries.map((e) => e.tweetId), ['300']);
});

test('video solo HLS queda marcado, no ausente', () => {
  const entries = parseVideos(timeline(tweet('400', { medias: [media('m7', [hls])] })));
  assert.equal(entries.length, 1);
  assert.equal(entries[0].url, null);
  assert.equal(entries[0].hlsOnly, true);
});

test('media repetida en entities y extended_entities cuenta una vez; se usa el primer video', () => {
  const first = media('a', [mp4('first', 10)]);
  const second = media('b', [mp4('second', 99999)]);
  const entries = parseVideos(timeline(tweet('500', { medias: [first, second] })));
  assert.equal(entries.length, 1);
  assert.match(entries[0].url, /first\.mp4/);
});

test('variantes sin content_type se reconocen por la extensión', () => {
  const variants = [{ url: 'https://video.twimg.com/a/x.m3u8' }, { bitrate: 3, url: 'https://video.twimg.com/a/x.mp4' }];
  const entries = parseVideos(timeline(tweet('600', { medias: [media('m8', variants)] })));
  assert.equal(entries[0].url, 'https://video.twimg.com/a/x.mp4');
});

test('objeto legacy suelto (API vieja) con id_str', () => {
  const legacy = { id_str: '700', full_text: 'x', extended_entities: { media: [media('m9', [mp4('old', 1)])] } };
  const entries = parseVideos({ globalObjects: { tweets: { 700: legacy } } });
  assert.deepEqual(entries.map((e) => e.tweetId), ['700']);
});

test('un usuario con rest_id no se toma por tweet', () => {
  const user = { __typename: 'User', rest_id: '999', legacy: { screen_name: 'u', pinned: media('m10', [mp4('x', 1)]) } };
  assert.deepEqual(parseVideos({ data: { user: { result: user } } }), []);
});

test('JSON sin videos y entradas que no son objetos', () => {
  assert.deepEqual(parseVideos(timeline(tweet('800'))), []);
  assert.deepEqual(parseVideos({}), []);
  assert.deepEqual(parseVideos([]), []);
  assert.deepEqual(parseVideos(null), []);
  assert.deepEqual(parseVideos('texto'), []);
  assert.deepEqual(parseVideos(42), []);
});
