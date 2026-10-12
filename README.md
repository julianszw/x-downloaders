# X: Enviar mp4

Extensión para Brave (Chromium, Manifest V3) que agrega la opción **Enviar mp4** al menú de los tres puntos de los tweets con video en x.com. Al elegirla, obtiene el video como archivo mp4 y lo comparte (si el navegador puede compartir archivos) o lo descarga como `x_<usuario>_<tweetId>.mp4`.

Uso personal. JavaScript vanilla, sin build ni dependencias, sin telemetría: las únicas peticiones que origina son a `video.twimg.com`, para bajar el video que pediste.

## Instalación en Brave

1. Abrí `brave://extensions`.
2. Activá **Modo de desarrollador** (arriba a la derecha).
3. Hacé clic en **Cargar descomprimida** y elegí esta carpeta (`x-downloader/`).
4. Abrí o recargá una pestaña de `https://x.com`.

Después de modificar cualquier archivo: botón de recargar de la extensión en `brave://extensions` y recargar la pestaña de X.

## Uso

En un tweet con video o GIF, abrí los tres puntos (arriba a la derecha del tweet) y elegí **Enviar mp4**. Un aviso azul abajo de la pantalla muestra el progreso.

## Permisos

| Permiso | Para qué |
| --- | --- |
| `x.com`, `twitter.com` | Leer las respuestas que X ya carga y agregar la opción al menú. |
| `video.twimg.com` | Bajar el mp4. |
| `downloads` | Guardar el archivo con el gestor de descargas. |

## Limitaciones

- **Compartir depende del sistema operativo.** Chromium solo implementa Web Share de archivos en Windows, ChromeOS y Android. En Linux y macOS la opción siempre descarga. Para saber qué hará en tu máquina, ejecutá en la consola de x.com:
  `navigator.canShare?.({ files: [new File([], "x.mp4", { type: "video/mp4" })] })`
- **Videos solo HLS**: si X no ofrece una variante mp4, el aviso dice "Video no disponible en mp4". No se unen audio y video.
- **Varios videos en un tweet**: se usa el primero.
- **"No tengo los datos de este video"**: el tweet se mostró sin que la extensión viera su respuesta (por ejemplo, la extensión se cargó con la pestaña ya abierta). Recargá la página.

## Diagnóstico

En la consola de x.com:

```js
localStorage.xdlDebug = "1"   // activar, y recargar la página
delete localStorage.xdlDebug  // desactivar
```

Con el diagnóstico activo aparecen líneas con prefijo `[xdl]`: los tweets con video detectados (`tweetId -> url`), el tamaño del mapa y las decisiones del menú.

## Pruebas manuales

### Etapa 1 — Intercepción

1. Activá el diagnóstico y recargá x.com con la consola abierta.
2. Debe aparecer `[xdl] interceptor activo` y, al cargar el feed, líneas `[xdl]   <id> -> https://video.twimg.com/...mp4` por cada tweet con video o GIF, seguidas de `[xdl] content: N/N entradas aceptadas`.
3. Repetí en la vista de un tweet, en un perfil y en una búsqueda. Un tweet que cita un video aparece como `<id> -> (cita a <otro id>)`.
4. Hacé mucho scroll: el número de `(mapa: N)` no debe pasar de 500.
5. X debe funcionar igual que siempre, sin errores nuevos en consola.

### Etapa 2 — Menú

1. Abrí los tres puntos de un tweet con video: **Enviar mp4** aparece primera, una sola vez, con el mismo aspecto que las demás opciones.
2. En un tweet sin video no aparece. Tampoco en el menú de compartir.
3. Probá en el feed, en la vista de un tweet y en un perfil, y en tema claro y oscuro.
4. Al elegirla, el menú se cierra y la página no navega al tweet.

### Etapa 3 — Acción

1. Elegí **Enviar mp4** en un video y en un GIF: se descarga `x_<usuario>_<tweetId>.mp4` y el aviso termina en "Descargado".
2. En un tweet que cita un video se descarga el video citado.
3. Con DevTools → Network → Offline, el aviso termina en error; al volver a estar en línea, elegir la opción otra vez funciona.
4. En Network, las únicas peticiones de la extensión son a `video.twimg.com`.

### Tests automáticos

```sh
cd x-downloader && node --test
```

Cubren el parser, la intercepción y el service worker con entornos simulados. No cubren el DOM de X: eso se prueba a mano.

## Qué tocar cuando X cambie algo

| Síntoma | Dónde mirar |
| --- | --- |
| **Enviar mp4** no aparece en el menú | `src/selectors.js` |
| Aparece pero dice "No tengo los datos de este video" aun después de recargar | `src/parser.js` |
| Se descarga otro video, o con el usuario equivocado | `src/parser.js` (citas, usuario) y `permalink` en `src/selectors.js` |
| El menú no se cierra al elegir la opción | `closeMenu` en `src/content.js` |

### `src/selectors.js`

Todos los selectores del DOM de X están en el objeto `XDL_SELECTORS`. Para revisarlos, abrí las DevTools en x.com y probá cada uno:

```js
document.querySelectorAll('article[data-testid="tweet"]').length  // tweets visibles
document.querySelector('[data-testid="caret"]')                    // tres puntos
// con el menú de los tres puntos abierto:
document.querySelector('[role="menu"]')
document.querySelectorAll('[role="menu"] [role="menuitem"]').length
```

El que devuelva `null` o `0` es el que cambió: inspeccioná el elemento real y actualizá el valor. Con el diagnóstico activo, `[xdl] menú: ...` indica hasta dónde llegó la extensión.

### `src/parser.js`

Recorre el JSON completo sin depender de rutas, pero sí de algunos nombres de campos. Si los videos dejan de detectarse:

1. En DevTools → Network, filtrá por `graphql`, abrí una respuesta (`HomeTimeline`, `TweetDetail`…) y buscá `video_info`.
2. Compará con lo que espera el parser:
   - el tweet es un objeto con `rest_id` + `legacy` (o un objeto con `id_str` + `full_text`/`extended_entities`) → función `tweetIdOf`;
   - el video es un objeto con `video_info.variants`, cada variante con `content_type`, `bitrate` y `url` → funciones `isMp4` y `bestMp4`;
   - el tweet citado cuelga de `quoted_status_result` o se nombra en `quoted_status_id_str` → `QUOTE_KEYS`;
   - el usuario está en `core.user_results.result` → función `screenNameOf`.
3. Ajustá la función que corresponda y agregá un caso en `test/parser.test.js` con la forma nueva.

Si lo que cambió es la URL de la API (ya no contiene `/graphql/` ni `/i/api/`), el filtro es `API_URL` en `src/interceptor.js`.
