# Estado del proyecto

Regla: aquí no se marca como funcional nada que solo esté simulado. Cada fase actualiza estas tres listas. Última actualización: fase Base (esqueleto y contratos).

## Probado contra simuladores

Nada todavía. No hay servidor, proveedores simulados ni simulador de pasajeros: llegan en la fase siguiente. Cuando existan, aquí se anotará cada característica probada con su prueba y la etiqueta «Simulado».

Lo único probado en la fase Base es **lógica pura con pruebas unitarias** (no es una integración con ningún servicio, ni siquiera simulado):

- `@tw/shared` audio: base64, remuestreo lineal (también en flujo), G.711 mu-law y a-law, tramas, mezcla, WAV, `computeEnvelope` y `EnvelopeMeter` (min/max/RMS por ventana de 20 ms sobre muestras reales; la ventana de un carril solo depende de sus propias muestras), señal sintética parecida a voz (`synthesizeSpeechSignal`, determinista).
- `@tw/shared` idiomas: normalización de códigos, catálogo y selección de idiomas por rol mostrando solo lo confirmado.
- `@tw/shared` tipos: conversión entre Manual / Automático / Mixto, mezcla de ajustes, resolución de idiomas.
- `@tw/shared` protocolo: validación zod de los mensajes del operador y del simulador, tramas binarias de audio y de niveles (`0x10`) con codificación y decodificación, `LevelsFrameBuilder`.
- Renderer: almacén de sesión, cliente HTTP (con `fetch` simulado), contexto `useCall()` con el cliente vacío, y contraste AA de los tokens de color (calculado a partir de `tokens.css`).
- Navegador (Playwright + Chromium, `npm run test:e2e -w @tw/desktop`): la interfaz base carga, respeta `prefers-color-scheme` y no desborda a 360 px. Se ejecutó una vez a mano; no forma parte de `npm test`.

## Sin verificar contra servicios reales

Marcado UNVERIFIED en el código o por su naturaleza. Nada de esto se ha contrastado con la API real:

- **ElevenLabs Scribe v2 Realtime** (voz a texto): URL, parámetros, nombres de campos de los mensajes, lista de errores y la probabilidad de idioma (`SttFinal.langProbability`) vienen de resúmenes de documentación y de memoria.
- **ElevenLabs TTS por WebSocket**: mensajes, `output_format` (`pcm_16000` no está confirmado) y respuestas.
- **Lista de idiomas** (`DOCUMENTED_TTS_LANGUAGES`, `documentationCatalog`): los 32 idiomas de Flash v2.5 salen de un resumen; el STT se da por válido solo para esos mismos idiomas. `GET /v1/models` para el refresco en vivo es de memoria.
- **Claude como traductor**: modelo por defecto `claude-haiku-5-5`; no se ha hecho ninguna llamada a la API de Anthropic.
- **Canales Twilio y WhatsApp (Meta)**: nombres de variables y comportamiento previstos, sin implementar ni probar.
- **Electron**: `src/main` y `src/preload` compilan, pero el binario de Electron no se puede descargar en este entorno, así que **nunca se han ejecutado**. Tampoco el permiso del micrófono ni el empaquetado con electron-builder.
- **Llamadas reales**: la visualización de ondas con llamadas reales no está verificada; el audio real de un canal telefónico puede traer particularidades (silencios sin tramas, pérdida de paquetes) que el simulador no reproduce.
- **Procedimiento de instalación**: `npm install` con `ELECTRON_SKIP_BINARY_DOWNLOAD=1` y `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1`; los scripts de instalación de las dependencias se ejecutaron con normalidad (no hizo falta `--ignore-scripts`).

## Pendiente

Fase siguiente (cinco agentes en paralelo, ver `ARQUITECTURA.md`):

- Pipeline: protocolo ElevenLabs centralizado, STT y TTS por WebSocket contra servidor simulado, traductor Claude, control y detección de idiomas, proveedores simulados, `PipelineFactory`.
- Servidor: canal simulado, sesiones de llamada, asignación a operadores, WebSocket `/operator`, niveles de audio, API HTTP, almacenes, claves cifradas, pruebas de conexión, catálogo de idiomas.
- Simulador: CLI de pasajeros con audio sintético.
- Renderer (llamada): cliente `CallClientApi`, micrófono, reproducción, pantalla con las dos ondas.
- Renderer (app): inicio de sesión, marcador, historial, Ajustes, enrutado, diseño general.

Más adelante:

- Canales Twilio y WhatsApp (`CallChannel`), cuando haya acceso para probarlos.
- Cliente de «Eleven Realtime Translation» (solo si ElevenLabs concede el acceso y se verifica el protocolo).
- Política de contenido (CSP) y firma/empaquetado de la app para Windows y Mac.
- `npm audit` informa de 11 avisos (2 críticos) en dependencias **de desarrollo** (vitest 3.x/tinypool y electron-builder). No se han actualizado para no cambiar de versión mayor sin necesidad; revisar antes de distribuir.
