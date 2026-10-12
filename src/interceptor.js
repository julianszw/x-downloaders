// Corre en el world MAIN, antes que los scripts de X. Lee (sin alterarlas)
// las respuestas de la API de X y publica los videos encontrados para
// content.js mediante window.postMessage.
(function () {
  'use strict';

  const parseVideos = window.__xdlParseVideos;
  delete window.__xdlParseVideos;
  if (typeof parseVideos !== 'function' || window.__xdlInstalled) return;
  window.__xdlInstalled = true;

  const MAX_ENTRIES = 500;
  const API_URL = /\/graphql\/|\/i\/api\//;
  const store = new Map(); // tweetId -> entrada

  function debugEnabled() {
    try {
      return localStorage.getItem('xdlDebug') === '1';
    } catch {
      return false;
    }
  }

  function publish(entries) {
    window.postMessage({ source: 'xdl', type: 'videos', entries }, location.origin);
  }

  function remember(entries) {
    const fresh = [];
    for (const entry of entries) {
      const previous = store.get(entry.tweetId);
      // Un vínculo a un tweet citado nunca pisa un video propio ya conocido.
      if (previous && previous.url && !entry.url) continue;
      const changed = !previous || previous.url !== entry.url ||
        previous.quotedId !== entry.quotedId || previous.hlsOnly !== entry.hlsOnly;
      store.delete(entry.tweetId);
      store.set(entry.tweetId, entry);
      if (changed) fresh.push(entry);
    }
    while (store.size > MAX_ENTRIES) store.delete(store.keys().next().value);

    if (!fresh.length) return;
    publish(fresh);
    if (debugEnabled()) {
      console.log(`[xdl] +${fresh.length} tweets con video (mapa: ${store.size})`);
      for (const entry of fresh) {
        const target = entry.url || (entry.hlsOnly ? '(solo HLS, sin mp4)' : `(cita a ${entry.quotedId})`);
        console.log(`[xdl]   ${entry.tweetId} -> ${target}`);
      }
    }
  }

  function ingest(body) {
    try {
      let json = body;
      if (typeof body === 'string') {
        if (!body.includes('video_info')) return;
        json = JSON.parse(body);
      }
      const entries = parseVideos(json);
      if (entries.length) remember(entries);
    } catch {
      // Respuesta que no se puede interpretar: se ignora.
    }
  }

  const originalFetch = window.fetch;
  if (typeof originalFetch === 'function') {
    window.fetch = function (...args) {
      const promise = originalFetch.apply(this, args);
      try {
        const input = args[0];
        const url = typeof input === 'string' ? input : String((input && input.url) || input);
        if (API_URL.test(url)) {
          promise.then((response) => {
            if (!response.ok) return;
            response.clone().text().then(ingest, () => {});
          }, () => {});
        }
      } catch {
        // Nunca interferir con la petición de la página.
      }
      return promise;
    };
  }

  function onXhrLoad() {
    try {
      if (this.status < 200 || this.status >= 300) return;
      if (this.responseType === '' || this.responseType === 'text') ingest(this.responseText);
      else if (this.responseType === 'json') ingest(this.response);
    } catch {
      // Ídem.
    }
  }

  if (typeof XMLHttpRequest === 'function') {
    const originalOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (method, url) {
      try {
        if (API_URL.test(String(url))) this.addEventListener('load', onXhrLoad);
      } catch {
        // Ídem.
      }
      return originalOpen.apply(this, arguments);
    };
  }

  // content.js puede arrancar después de las primeras respuestas: al saludar
  // se le reenvía todo lo capturado hasta el momento.
  window.addEventListener('message', (event) => {
    if (event.source !== window || event.origin !== location.origin) return;
    const data = event.data;
    if (!data || data.source !== 'xdl' || data.type !== 'hello') return;
    if (store.size) publish([...store.values()]);
  });

  if (debugEnabled()) console.log('[xdl] interceptor activo');
})();
