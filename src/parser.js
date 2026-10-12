// Parser de las respuestas de la API de X. Función pura: recibe el JSON ya
// parseado y devuelve los videos que encuentra, sin depender de la ruta exacta
// en la que aparece cada tweet.
//
// Si X cambia la forma de sus respuestas y los videos dejan de detectarse,
// este es el archivo a tocar (ver README, "Qué tocar cuando X cambie algo").
(function (root) {
  'use strict';

  const NUMERIC_ID = /^\d+$/;
  const QUOTE_KEYS = new Set(['quoted_status_result', 'quoted_status']);

  function isObject(value) {
    return value !== null && typeof value === 'object';
  }

  // Devuelve el id si el objeto es un tweet, o null. Hay dos formas:
  //  - resultado GraphQL: { __typename: "Tweet", rest_id, legacy: {...} }
  //  - objeto "legacy":   { id_str, full_text, extended_entities, ... }
  // Los usuarios también tienen rest_id + legacy, y la media tiene id_str:
  // las condiciones extra evitan confundirlos con un tweet.
  function tweetIdOf(node) {
    if (typeof node.rest_id === 'string' && NUMERIC_ID.test(node.rest_id) &&
        node.__typename !== 'User' && isObject(node.legacy)) {
      const legacy = node.legacy;
      if (node.__typename === 'Tweet' || 'full_text' in legacy || 'extended_entities' in legacy) {
        return node.rest_id;
      }
    }
    if (typeof node.id_str === 'string' && NUMERIC_ID.test(node.id_str) &&
        ('full_text' in node || 'extended_entities' in node)) {
      return node.id_str;
    }
    return null;
  }

  function screenNameOf(node) {
    const user = node.core && node.core.user_results && node.core.user_results.result;
    if (!isObject(user)) return null;
    const name = (user.core && user.core.screen_name) || (user.legacy && user.legacy.screen_name);
    return typeof name === 'string' ? name : null;
  }

  function isMp4(variant) {
    if (!isObject(variant) || typeof variant.url !== 'string') return false;
    if (typeof variant.content_type === 'string') return variant.content_type === 'video/mp4';
    return /\.mp4(\?|$)/.test(variant.url);
  }

  // URL del mp4 de mayor bitrate, o null si no hay ninguna variante mp4.
  function bestMp4(variants) {
    let best = null;
    for (const variant of variants) {
      if (!isMp4(variant)) continue;
      const bitrate = Number(variant.bitrate ?? variant.bit_rate) || 0;
      if (!best || bitrate > best.bitrate) best = { url: variant.url, bitrate };
    }
    return best ? best.url : null;
  }

  function parseVideos(json) {
    if (!isObject(json)) return [];

    const tweets = new Map(); // id -> { id, urls, seen, quotedId, user }
    const tweetFor = (id) => {
      let tweet = tweets.get(id);
      if (!tweet) {
        tweet = { id, urls: [], seen: new Set(), quotedId: null, user: null };
        tweets.set(id, tweet);
      }
      return tweet;
    };

    // Pila explícita: `tweet` es el tweet contenedor más cercano y `quoter`
    // el tweet que está citando lo que venga debajo, si lo hay.
    const stack = [{ node: json, tweet: null, quoter: null }];
    while (stack.length) {
      const { node, tweet: parentTweet, quoter: parentQuoter } = stack.pop();
      let tweet = parentTweet;
      let quoter = parentQuoter;

      if (!Array.isArray(node)) {
        const id = tweetIdOf(node);
        if (id) {
          tweet = tweetFor(id);
          if (quoter && quoter.id !== id) {
            if (!quoter.quotedId) quoter.quotedId = id;
            quoter = null;
          }
          if (!tweet.user) tweet.user = screenNameOf(node);
        }

        if (tweet) {
          const quotedId = node.quoted_status_id_str;
          if (typeof quotedId === 'string' && NUMERIC_ID.test(quotedId) &&
              quotedId !== tweet.id && !tweet.quotedId) {
            tweet.quotedId = quotedId;
          }

          const variants = node.video_info && node.video_info.variants;
          if (Array.isArray(variants) && variants.length) {
            // La misma media viene repetida en entities y extended_entities.
            const mediaKey = node.id_str || node.media_key || JSON.stringify(variants);
            if (!tweet.seen.has(mediaKey)) {
              tweet.seen.add(mediaKey);
              tweet.urls.push(bestMp4(variants));
            }
          }
        }
      }

      // Se apila en orden inverso para visitar en el orden del documento,
      // así "el primer video del tweet" es realmente el primero.
      const keys = Object.keys(node);
      for (let i = keys.length - 1; i >= 0; i--) {
        const child = node[keys[i]];
        if (!isObject(child)) continue;
        const childQuoter = tweet && !Array.isArray(node) && QUOTE_KEYS.has(keys[i]) ? tweet : quoter;
        stack.push({ node: child, tweet, quoter: childQuoter });
      }
    }

    const entries = [];
    for (const tweet of tweets.values()) {
      if (tweet.urls.length) {
        const url = tweet.urls.find(Boolean) || null;
        entries.push({ tweetId: tweet.id, url, hlsOnly: !url, quotedId: null, user: tweet.user });
      } else if (tweet.quotedId && tweets.get(tweet.quotedId)?.urls.length) {
        // Vínculo: este tweet no tiene video propio pero cita a uno que sí.
        entries.push({ tweetId: tweet.id, url: null, hlsOnly: false, quotedId: tweet.quotedId, user: tweet.user });
      }
    }
    return entries;
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { parseVideos };
  } else {
    root.__xdlParseVideos = parseVideos;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
