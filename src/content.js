// Corre en el world ISOLATED. Recibe de interceptor.js los videos detectados,
// agrega "Enviar mp4" al menú de los tres puntos de los tweets con video y
// ejecuta la acción: compartir el archivo si el navegador puede, o descargarlo.
(function () {
  'use strict';

  const S = XDL_SELECTORS;
  const MAX_ENTRIES = 500;
  const VIDEO_HOST = 'video.twimg.com';
  const NUMERIC_ID = /^\d+$/;
  const LABEL = 'Enviar mp4';
  const MENU_WAIT_MS = 2000;
  const READY_TTL_MS = 60000;
  const SVG_NS = 'http://www.w3.org/2000/svg'; // namespace, no es una petición

  const ICONS = {
    send: 'M11 3h2v10.17l3.59-3.58L18 11l-6 6-6-6 1.41-1.41L11 13.17V3zM5 19h14v2H5v-2z',
    share: 'M12 2.59l5.7 5.7-1.41 1.42L13 6.41V16h-2V6.41l-3.3 3.3-1.41-1.42L12 2.59zM21 15v4.5c0 1.38-1.12 2.5-2.5 2.5h-13C4.12 22 3 20.88 3 19.5V15h2v4.5c0 .28.22.5.5.5h13c.28 0 .5-.22.5-.5V15h2z',
    done: 'M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41L9 16.17z',
    error: 'M11 7h2v7h-2V7zm0 9h2v2h-2v-2zm1-14C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8z',
  };

  function debugEnabled() {
    try {
      return localStorage.getItem('xdlDebug') === '1';
    } catch {
      return false;
    }
  }

  function log(...args) {
    if (debugEnabled()) console.log('[xdl]', ...args);
  }

  // --- Videos detectados ----------------------------------------------------

  const videos = new Map(); // tweetId -> { tweetId, url, hlsOnly, quotedId, user }

  function isVideoUrl(value) {
    try {
      const url = new URL(value);
      return url.protocol === 'https:' && url.hostname === VIDEO_HOST;
    } catch {
      return false;
    }
  }

  // Los mensajes vienen del world MAIN, que es territorio de la página: cada
  // campo se valida y se copia, nunca se confía en el objeto recibido.
  function sanitizeEntry(raw) {
    if (!raw || typeof raw.tweetId !== 'string' || !NUMERIC_ID.test(raw.tweetId)) return null;
    const entry = { tweetId: raw.tweetId, url: null, hlsOnly: false, quotedId: null, user: null };
    if (typeof raw.user === 'string') entry.user = raw.user;
    if (typeof raw.url === 'string') {
      if (!isVideoUrl(raw.url)) return null;
      entry.url = raw.url;
    } else if (raw.hlsOnly === true) {
      entry.hlsOnly = true;
    } else if (typeof raw.quotedId === 'string' && NUMERIC_ID.test(raw.quotedId)) {
      entry.quotedId = raw.quotedId;
    } else {
      return null;
    }
    return entry;
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window || event.origin !== location.origin) return;
    const data = event.data;
    if (!data || data.source !== 'xdl' || data.type !== 'videos' || !Array.isArray(data.entries)) return;
    let accepted = 0;
    for (const raw of data.entries) {
      const entry = sanitizeEntry(raw);
      if (!entry) continue;
      const previous = videos.get(entry.tweetId);
      if (previous && previous.url && !entry.url) continue;
      videos.delete(entry.tweetId);
      videos.set(entry.tweetId, entry);
      accepted++;
    }
    while (videos.size > MAX_ENTRIES) videos.delete(videos.keys().next().value);
    log(`content: ${accepted}/${data.entries.length} entradas aceptadas (mapa: ${videos.size})`);
  });

  window.postMessage({ source: 'xdl', type: 'hello' }, location.origin);

  // Video del tweet, o el de su tweet citado si no tiene uno propio.
  function resolveVideo(tweetId) {
    const entry = videos.get(tweetId);
    if (entry && entry.quotedId) return videos.get(entry.quotedId) || null;
    return entry || null;
  }

  // --- Aviso de estado ------------------------------------------------------

  let toastEl = null;
  let toastTimer = 0;

  function svgIcon(path) {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    const el = document.createElementNS(SVG_NS, 'path');
    el.setAttribute('d', path);
    svg.appendChild(el);
    return svg;
  }

  function hideToast() {
    clearTimeout(toastTimer);
    if (toastEl) toastEl.hidden = true;
  }

  // state: loading | ready | done | error. `action` agrega un botón al aviso.
  function showToast(state, text, { action = null, timeout = 0 } = {}) {
    if (!toastEl) {
      toastEl = document.createElement('div');
      toastEl.className = 'xdl-toast';
      toastEl.setAttribute('role', 'status');
      toastEl.setAttribute('aria-live', 'polite');
    }
    if (!toastEl.isConnected) (document.body || document.documentElement).appendChild(toastEl);
    clearTimeout(toastTimer);
    toastEl.replaceChildren();
    toastEl.dataset.state = state;
    toastEl.hidden = false;

    const icon = document.createElement('span');
    icon.className = 'xdl-toast-icon';
    if (state === 'loading') icon.classList.add('xdl-spinner');
    else icon.appendChild(svgIcon(state === 'ready' ? ICONS.share : ICONS[state]));
    const label = document.createElement('span');
    label.className = 'xdl-toast-text';
    label.textContent = text;
    toastEl.append(icon, label);

    if (action) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'xdl-toast-action';
      button.textContent = action.label;
      button.addEventListener('click', action.onClick);
      toastEl.appendChild(button);
      button.focus({ preventScroll: true });
    }
    if (timeout) toastTimer = setTimeout(hideToast, timeout);
  }

  const showError = (text) => showToast('error', text, { timeout: 7000 });

  // --- Opción en el menú del tweet -------------------------------------------

  let menuObserver = null;
  let menuTimer = 0;

  function describeTweet(article) {
    const links = [...article.querySelectorAll(S.permalink)];
    const link = links.find((a) => a.querySelector('time')) || links[0];
    const match = link && /^\/([^/]+)\/status\/(\d+)/.exec(new URL(link.href, location.origin).pathname);
    if (!match) return null;
    return { id: match[2], user: match[1], hasVideo: Boolean(article.querySelector(S.video)) };
  }

  function stopWaitingForMenu() {
    clearTimeout(menuTimer);
    if (menuObserver) menuObserver.disconnect();
    menuObserver = null;
  }

  function closeMenu(menu) {
    const init = { key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true, cancelable: true };
    menu.dispatchEvent(new KeyboardEvent('keydown', init));
    menu.dispatchEvent(new KeyboardEvent('keyup', init));
  }

  function buildMenuItem(template, tweet) {
    const item = template.cloneNode(true);
    item.classList.add('xdl-item');
    item.removeAttribute('data-testid');
    item.removeAttribute('id');
    item.removeAttribute('href');
    item.setAttribute('role', 'menuitem');
    item.setAttribute('tabindex', '0');

    // Texto: se reutiliza el primer nodo de texto del clon y se vacían los demás.
    const walker = document.createTreeWalker(item, NodeFilter.SHOW_TEXT);
    let first = true;
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (!node.nodeValue.trim()) continue;
      node.nodeValue = first ? LABEL : '';
      first = false;
    }
    if (first) item.append(LABEL);

    const svg = item.querySelector('svg');
    if (svg) {
      svg.setAttribute('viewBox', '0 0 24 24');
      const path = document.createElementNS(SVG_NS, 'path');
      path.setAttribute('d', ICONS.send);
      svg.replaceChildren(path);
    }

    const activate = (event) => {
      event.preventDefault();
      event.stopPropagation();
      const menu = item.closest(S.menu);
      if (menu) closeMenu(menu);
      sendVideo(tweet);
    };
    item.addEventListener('click', activate);
    item.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') activate(event);
    });
    return item;
  }

  // Devuelve true cuando ya no hay nada más que esperar.
  function tryInjectMenuItem(tweet) {
    const menu = document.querySelector(S.menu);
    if (!menu) return false;
    if (menu.querySelector('.xdl-item')) return true;
    const items = [...menu.querySelectorAll(S.menuItem)];
    if (!items.length) return false;
    const template = items.find((el) => el.tagName !== 'A') || items[0];
    items[0].parentNode.insertBefore(buildMenuItem(template, tweet), items[0]);
    log(`menú: opción agregada para el tweet ${tweet.id}`);
    return true;
  }

  // El menú se abre en una capa aparte del tweet, así que se recuerda qué
  // tweet lo pidió y se espera, por poco tiempo, a que aparezca.
  document.addEventListener('click', (event) => {
    const target = event.target instanceof Element ? event.target : null;
    const caret = target && target.closest(S.caret);
    if (!caret) return;
    stopWaitingForMenu();
    const article = caret.closest(S.tweet);
    const tweet = article && describeTweet(article);
    if (!tweet) return;
    if (!tweet.hasVideo && !resolveVideo(tweet.id)) {
      log(`menú: el tweet ${tweet.id} no tiene video`);
      return;
    }
    menuObserver = new MutationObserver(() => {
      if (tryInjectMenuItem(tweet)) stopWaitingForMenu();
    });
    menuObserver.observe(document.documentElement, { childList: true, subtree: true });
    menuTimer = setTimeout(stopWaitingForMenu, MENU_WAIT_MS);
  }, true);

  // --- Acción ----------------------------------------------------------------

  let busy = false;       // hay una obtención de video para compartir en curso
  let readyTimer = 0;     // vencimiento del archivo retenido para "Compartir"
  const downloads = new Map(); // id de descarga -> nombre de archivo

  function canShareFiles(file) {
    try {
      const probe = file || new File([], 'x.mp4', { type: 'video/mp4' });
      return typeof navigator.share === 'function' && typeof navigator.canShare === 'function' &&
        navigator.canShare({ files: [probe] });
    } catch {
      return false;
    }
  }

  function fileNameFor(tweet, video) {
    const owner = video.user || (video.tweetId === tweet.id ? tweet.user : '');
    const user = String(owner || '').replace(/[^A-Za-z0-9_]/g, '') || 'video';
    return `x_${user}_${video.tweetId}.mp4`;
  }

  async function download(video, filename) {
    showToast('loading', `Descargando ${filename}…`);
    let response;
    try {
      response = await chrome.runtime.sendMessage({ type: 'download', url: video.url, filename });
    } catch (error) {
      response = { ok: false, error: 'La extensión se recargó. Recargá la página y probá de nuevo.' };
    }
    if (!response || !response.ok) {
      showError(`No se pudo descargar: ${(response && response.error) || 'error desconocido'}`);
      return;
    }
    downloads.set(response.id, filename);
    // Si el aviso de fin no llega, el aviso no queda colgado para siempre.
    showToast('loading', `Descargando ${filename}…`, { timeout: 20000 });
  }

  chrome.runtime.onMessage.addListener((message) => {
    if (!message || message.type !== 'download-state' || !downloads.has(message.id)) return;
    const filename = downloads.get(message.id);
    downloads.delete(message.id);
    if (message.state === 'complete') {
      showToast('done', `Descargado: ${filename}`, { timeout: 4000 });
    } else if (message.error === 'USER_CANCELED') {
      hideToast();
    } else {
      showError(`La descarga falló (${message.error || 'interrumpida'}). Elegí «${LABEL}» otra vez para reintentar.`);
    }
  });

  function base64ToBytes(data) {
    const binary = atob(data);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }

  // Respaldo cuando la página no puede leer el mp4: lo trae el service worker
  // y lo manda en trozos, porque la mensajería no transporta binarios.
  function fetchViaWorker(url) {
    return new Promise((resolve, reject) => {
      const parts = [];
      let settled = false;
      const finish = (fn, value) => {
        if (settled) return;
        settled = true;
        fn(value);
        port.disconnect();
      };
      const port = chrome.runtime.connect({ name: 'xdl-fetch' });
      port.onMessage.addListener((message) => {
        if (message.type === 'chunk') parts.push(base64ToBytes(message.data));
        else if (message.type === 'done') finish(resolve, new Blob(parts, { type: 'video/mp4' }));
        else finish(reject, Object.assign(new Error(message.message || message.code), { code: message.code }));
      });
      port.onDisconnect.addListener(() => finish(reject, new Error('Se cortó la conexión con la extensión.')));
      port.postMessage({ url });
    });
  }

  async function fetchBlob(url) {
    try {
      const response = await fetch(url, { credentials: 'omit' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.blob();
    } catch (error) {
      log('fetch directo falló, uso el service worker:', error);
      return fetchViaWorker(url);
    }
  }

  // `automatic` distingue el intento hecho al terminar la descarga (puede
  // fallar por activación vencida) del clic explícito en "Compartir".
  async function share(file, video, automatic) {
    try {
      await navigator.share({ files: [file] });
      showToast('done', 'Video compartido', { timeout: 4000 });
    } catch (error) {
      if (error && error.name === 'AbortError') {
        hideToast();
      } else if (automatic && error && error.name === 'NotAllowedError') {
        offerShare(file, video);
      } else {
        log('compartir falló, descargo:', error);
        await download(video, file.name);
      }
    }
  }

  function offerShare(file, video) {
    let pending = file;
    const release = () => {
      clearTimeout(readyTimer);
      pending = null;
    };
    showToast('ready', 'Video listo', {
      action: {
        label: 'Compartir',
        onClick: () => {
          const current = pending;
          release();
          if (current) share(current, video, false);
        },
      },
    });
    clearTimeout(readyTimer);
    readyTimer = setTimeout(() => {
      release();
      hideToast();
    }, READY_TTL_MS);
  }

  async function sendVideo(tweet) {
    const video = resolveVideo(tweet.id);
    if (!video) {
      showError('No tengo los datos de este video. Recargá la página y probá de nuevo.');
      return;
    }
    if (!video.url) {
      showError('Video no disponible en mp4.');
      return;
    }
    const filename = fileNameFor(tweet, video);

    if (!canShareFiles()) {
      await download(video, filename);
      return;
    }
    if (busy) {
      log('ya hay un video en curso');
      return;
    }
    busy = true;
    clearTimeout(readyTimer);
    try {
      showToast('loading', 'Obteniendo video…');
      const blob = await fetchBlob(video.url);
      const file = new File([blob], filename, { type: 'video/mp4' });
      if (!canShareFiles(file)) await download(video, filename);
      else if (navigator.userActivation && navigator.userActivation.isActive) await share(file, video, true);
      else offerShare(file, video);
    } catch (error) {
      if (error && error.code === 'too-big') await download(video, filename);
      else showError(`No se pudo obtener el video: ${(error && error.message) || error}. Elegí «${LABEL}» otra vez para reintentar.`);
    } finally {
      busy = false;
    }
  }
})();
