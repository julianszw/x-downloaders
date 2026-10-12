// Todos los selectores del DOM de X viven acá: es lo que más seguido se rompe.
// Si "Enviar mp4" deja de aparecer en el menú, revisá estos valores contra el
// DOM actual (ver README, "Qué tocar cuando X cambie algo").
var XDL_SELECTORS = {
  // Contenedor de un tweet, en el feed, en la vista de un tweet y en perfiles.
  tweet: 'article[data-testid="tweet"]',
  // Botón de los tres puntos del tweet.
  caret: '[data-testid="caret"]',
  // Algo que indique que el tweet muestra un video o un GIF.
  video: '[data-testid="videoPlayer"], [data-testid="videoComponent"], video',
  // Enlace permanente del tweet: /<usuario>/status/<id>.
  permalink: 'a[href*="/status/"]',
  // Menú desplegable que abren los tres puntos, y sus opciones.
  menu: '[role="menu"]',
  menuItem: '[role="menuitem"]',
};
