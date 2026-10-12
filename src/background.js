// Service worker. Hace lo que un content script no puede: descargar con
// chrome.downloads y leer video.twimg.com sin las restricciones de CORS de la
// página. Cada pedido se valida: solo páginas de X, solo videos de X.
'use strict';

const VIDEO_HOST = 'video.twimg.com';
const PAGE_HOSTS = new Set(['x.com', 'twitter.com']);
const PAGE_PATTERNS = ['https://x.com/*', 'https://twitter.com/*'];
const FILENAME = /^x_[A-Za-z0-9_]+_\d+\.mp4$/;
const MAX_BYTES = 300 * 1024 * 1024;
const CHUNK_BYTES = 1024 * 1024;

function isVideoUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname === VIDEO_HOST;
  } catch {
    return false;
  }
}

function isTrustedSender(sender) {
  if (!sender || sender.id !== chrome.runtime.id) return false;
  try {
    const url = new URL(sender.url || (sender.tab && sender.tab.url) || '');
    return url.protocol === 'https:' && PAGE_HOSTS.has(url.hostname);
  } catch {
    return false;
  }
}

// --- Descarga directa -------------------------------------------------------

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.type !== 'download') return false;
  if (!isTrustedSender(sender)) {
    sendResponse({ ok: false, error: 'Pedido de origen no permitido.' });
    return false;
  }
  if (!isVideoUrl(message.url) || typeof message.filename !== 'string' || !FILENAME.test(message.filename)) {
    sendResponse({ ok: false, error: 'Pedido de descarga inválido.' });
    return false;
  }
  chrome.downloads
    .download({ url: message.url, filename: message.filename, conflictAction: 'uniquify' })
    .then(
      (id) => sendResponse({ ok: true, id }),
      (error) => sendResponse({ ok: false, error: String((error && error.message) || error) }),
    );
  return true; // respuesta asíncrona
});

// Cuando una descarga iniciada por la extensión termina o se interrumpe, se
// avisa a las pestañas de X para que actualicen su aviso. No se guarda estado
// en memoria: el service worker puede haberse reiniciado en el medio.
chrome.downloads.onChanged.addListener(async (delta) => {
  const state = delta.state && delta.state.current;
  if (state !== 'complete' && state !== 'interrupted') return;
  try {
    const [item] = await chrome.downloads.search({ id: delta.id });
    if (!item || item.byExtensionId !== chrome.runtime.id) return;
    const tabs = await chrome.tabs.query({ url: PAGE_PATTERNS });
    for (const tab of tabs) {
      chrome.tabs
        .sendMessage(tab.id, { type: 'download-state', id: delta.id, state, error: item.error || null })
        .catch(() => {});
    }
  } catch {
    // Sin pestañas a las que avisar: no hay nada que hacer.
  }
});

// --- Respaldo: leer el mp4 y pasarlo en trozos ------------------------------

function toBase64(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

async function streamVideo(port, url, signal) {
  const response = await fetch(url, { credentials: 'omit', signal });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  if (Number(response.headers.get('content-length')) > MAX_BYTES) {
    port.postMessage({ type: 'error', code: 'too-big' });
    return;
  }

  const reader = response.body.getReader();
  const buffer = new Uint8Array(CHUNK_BYTES);
  let filled = 0;
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > MAX_BYTES) {
      await reader.cancel();
      port.postMessage({ type: 'error', code: 'too-big' });
      return;
    }
    let offset = 0;
    while (offset < value.length) {
      const take = Math.min(CHUNK_BYTES - filled, value.length - offset);
      buffer.set(value.subarray(offset, offset + take), filled);
      filled += take;
      offset += take;
      if (filled === CHUNK_BYTES) {
        port.postMessage({ type: 'chunk', data: toBase64(buffer) });
        filled = 0;
      }
    }
  }
  if (filled) port.postMessage({ type: 'chunk', data: toBase64(buffer.subarray(0, filled)) });
  port.postMessage({ type: 'done', size: total });
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'xdl-fetch') return;
  const controller = new AbortController();
  let started = false;
  port.onDisconnect.addListener(() => controller.abort());
  port.onMessage.addListener((message) => {
    if (started) return;
    started = true;
    if (!isTrustedSender(port.sender) || !message || !isVideoUrl(message.url)) {
      port.postMessage({ type: 'error', code: 'invalid' });
      return;
    }
    streamVideo(port, message.url, controller.signal).catch((error) => {
      if (controller.signal.aborted) return; // la pestaña se fue: nada que avisar
      try {
        port.postMessage({ type: 'error', code: 'network', message: String((error && error.message) || error) });
      } catch {
        // El puerto ya está cerrado.
      }
    });
  });
});
