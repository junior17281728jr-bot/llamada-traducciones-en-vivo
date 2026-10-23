# Arquitectura

Este documento describe el diseño y cómo encaja cada pieza. Lo que está probado (y contra qué) figura en [`ESTADO.md`](ESTADO.md); el canal de llamadas en [`CANALES.md`](CANALES.md); el modo audio del PC en [`MODO-AUDIO-PC.md`](MODO-AUDIO-PC.md).

## Flujo de una llamada

```
 Pasajero: teléfono simulado (/sim) · modo audio del PC (cable A) · [Twilio / WhatsApp: no implementados]
        │  audio del canal (PCM16 16 kHz mono tras convertir en el borde)
        ▼
 ┌────────────────────────────────────────────────────┐
 │ CallChannel: MockCallChannel (/sim) o               │  Cada llamada es un ChannelCall.
 │ DesktopAudioChannel (tramas 0x04 del operador)      │  ChannelCall.onAudio es EL punto donde se mide la
 └───────────────────────────┬────────────────────────┘  onda del pasajero (pista 0), sea cual sea el canal.
                             │
                             ▼
 ┌───────────────────────────────────────────────────────────────────────────┐
 │ CallManager + CallSession (una por llamada, en @tw/server)                │
 │  · reparte la entrante al operador libre (timbre, RING_TIMEOUT_SECONDS,   │
 │    contestación automática), marca la saliente o arranca la local        │
 │  · límite MAX_CONCURRENT_CALLS (3); una conexión de operador = una llamada│
 │  · estado: queued → ringing → active → ended ; LanguageSettings vigentes, │
 │    LanguageState detectado y LanguageNotice                               │
 │                                                                           │
 │   DirectionPipeline passenger_to_operator   DirectionPipeline operator_to_passenger │
 │   audio pasajero                            micrófono del operador (0x01) │
 │     → STT (idioma por segmento)               → STT (idioma = operatorLang)│
 │     → traductor: traduce + identifica idioma  → traductor                  │
 │     → TTS en operatorLang                     → TTS en el idioma que oye   │
 │          │                                        │   el pasajero          │
 │          │            LanguageController          │                        │
 │          └──► detectado (STT + traductor) ────────┘ (follow / retención)   │
 └──────┬──────────────────────────────────────────────────┬─────────────────┘
        │ voz traducida (0x02) + niveles pista 2            │ voz traducida: ChannelCall.sendAudio
        ▼                                                   ▼   (teléfono simulado → sim.audio;
 WebSocket /operator  ◄── JSON + tramas binarias ──►         modo audio del PC → trama 0x05 → cable B)
        │
        ▼
 App de escritorio (Electron + React) o navegador (Vite)
   · carril «Pasajero»: onda de las tramas de niveles pista 0 (audio real recibido del canal)
   · carril «Operador»: onda del micrófono local (las mismas muestras que se envían), confirmada por la
     pista 1 del servidor (detecta «el servidor no recibe tu micrófono»); sin micrófono queda plana
   · etapas por sentido (Recibiendo voz, Transcribiendo, Traduciendo, Reproduciendo traducción),
     texto original y traducción, selector Manual / Automático / Mixto con cambio en directo

 Almacenes (detrás de interfaces de @tw/shared): FileTranscriptStore (historial JSONL + segmentos),
 FileRecordingStore (WAV por tramo), FileSecretsStore (claves cifradas con AES-256-GCM en DATA_DIR),
 FilePreferencesStore (preferencias por operador), OperatorStore (usuarios con scrypt),
 ElevenLabsCatalogProvider (idiomas soportados a la vez por STT, traductor y TTS),
 DefaultConnectionTester (botones «Probar conexión»).
```

### Formato de audio

Todo el audio interno es **PCM16 mono little-endian a 16 000 Hz**. Los canales y los proveedores convierten en su borde (`WireToInternal` / `InternalToWire` en `@tw/shared`: PCM de 8 a 48 kHz, mu-law y a-law). Las tramas binarias del WebSocket del operador llevan un byte de tipo: `0x01` micrófono del operador, `0x02` voz traducida hacia el operador, `0x03` voz **original** del pasajero (solo cuando ambos hablan el mismo idioma), `0x04` voz del pasajero capturada del cable A (modo audio del PC), `0x05` voz traducida del operador hacia el cable B, `0x10` niveles. El servidor acepta del operador como mucho 1,5× tiempo real por tipo de trama (ráfaga de 5 s); lo que sobra se descarta y no se graba ni se transcribe.

### Mismo idioma en ambos extremos

`directAudioFor(direction, settings, state)` (`@tw/pipeline`) decide, con los mismos datos que usan los pipelines, cuándo los dos extremos de un sentido comparten idioma con seguridad: `passengerSpeaks` fijo igual a `operatorLang`, o idioma detectado **utilizable** (confirmado, o tentativo con una coincidencia) igual a `operatorLang`; para operador → pasajero, el idioma que oye el pasajero (`heardLanguageFor`) utilizable e igual a `operatorLang`. Cuando es cierto, `CallSession` reenvía la **voz original** (pasajero → operador como `0x03`; operador → pasajero el micrófono tal cual con `ChannelCall.sendAudio`), el pipeline solo transcribe (sin traductor ni TTS) y `call.languages.directAudio` se lo dice a la app, que lo rotula en cada carril. Mientras la detección automática no es utilizable, una frase que el STT ya sitúa en el idioma del operador se envía igualmente al traductor (devuelve el texto sin cambios e identifica el idioma, la segunda señal de la detección) y se **reproduce sintetizada**, para que el operador nunca se quede en silencio; con el reenvío activo el traductor solo se consulta hasta confirmar el idioma y cuando el STT sitúa una frase en otro idioma, de modo que un cambio de idioma se detecta y el reenvío se apaga. En las transiciones puede haber una frase en la que la decisión de la sesión y la del pipeline no coincidan (una frase doble o con voz sintética): se asume y se documenta.

### Reconexión del operador

Si el socket de un operador se cierra en mitad de una llamada, `CallManager` no cuelga: desvincula el enlace (`DETACHED_LINK`, todo se descarta) y espera `RECONNECT_GRACE_SECONDS` (10 s). La app reconecta sola con `auth.resume`; `connectOperator` reconoce al operador desvinculado, vuelve a enganchar el enlace y la sesión reenvía `call.state` y `call.languages`. Pasado el plazo, la llamada termina con el motivo `connection_lost` (así queda en el historial) y el operador se da de baja. En `auth.ok` la app compara `operator.currentCallId` con la llamada que muestra: si el servidor ya no la tiene, la pantalla pasa a «terminada» con ese motivo; un `call.hangup` sobre una llamada que ya no existe recibe `unknown_call` y también cierra la pantalla.

### Proveedores: simulados y reales

`PipelineFactory` (en `@tw/shared/interfaces`) crea un `DirectionPipeline` por sentido. Hay dos fábricas en `@tw/pipeline`:

- **`MockPipelineFactory`** (`PROVIDERS=mock`): `ScriptedStt` recibe el texto de cada frase por un `UtteranceBus` (el audio sintético no es habla, así que el texto viaja aparte) y lo «transcribe» al ritmo del audio real; `MockTextTranslator` devuelve `[en>es] …` e identifica el idioma del texto con heurísticas; `MockTts` sintetiza una señal parecida a voz con un tono por idioma. Todo dice `simulated: true` y la interfaz lo rotula «Simulado».
- **`ElevenLabsPipelineFactory`** (`PROVIDERS=elevenlabs`): clientes reales detrás de las mismas interfaces, **probados solo contra servidores WebSocket locales y un `fetch` simulado** (UNVERIFIED contra los servicios):
  - `elevenlabs/protocol.ts`: el ÚNICO sitio con rutas, parámetros, tipos de mensaje, errores y su política (ignorar / reconectar / fatal). Cada constante lleva su nota UNVERIFIED.
  - `ElevenLabsSttProvider` (Scribe v2 Realtime por WebSocket): audio en base64, reloj de audio para los tiempos, búfer de audio no confirmado que se reenvía al reconectar (reconexión limitada, pausa mayor tras `rate_limited`), errores fatales tipados en español, deduplicación de transcripciones confirmadas.
  - `ElevenLabsTtsProvider` (stream-input por WebSocket): una sesión por idioma y voz (`ELEVENLABS_VOICE_<CÓDIGO>`, sin valores por defecto), **una conexión por frase** cerrada con `{text:''}` porque `isFinal` es la única señal fiable de fin, con una conexión de reserva preabierta (standby) para que el cambio de idioma en directo no deje hueco; decodificación de `pcm_*`, `ulaw_8000` y `alaw_8000` a PCM16 16 kHz.
  - `ClaudeTranslator` (`@anthropic-ai/sdk`): prompt de sistema corto de intérprete, un mensaje de usuario con destino, origen (o «identifícalo»), últimos turnos y la frase; respuesta JSON `{"t","s"}` parseada con tolerancia; 6 s máximo con un reintento en red / 429 / 5xx; `refusal`, 401/403, 400 y 404 como errores en español sin reintento; el cliente se reconstruye si cambia la clave.
  - Las claves se resuelven **al abrir cada sesión** (`SecretsStore.resolve`: Ajustes primero, luego entorno), así una clave guardada desde Ajustes se usa sin reiniciar. Sin clave, el servidor arranca y la primera llamada falla con un mensaje claro.
  - Con `PROVIDERS=elevenlabs` y `CHANNEL=mock`, el teléfono simulado sigue emitiendo audio sintético que no es habla: el STT real no lo entenderá. Los proveedores reales solo tienen sentido con audio real (modo audio del PC o un canal real futuro).

### Canales

`CallChannel` (`CANALES.md`): `MockCallChannel` (teléfonos simulados por `/sim`, solo desde la misma máquina) y `DesktopAudioChannel` (modo audio del PC). El servidor construye **siempre** el canal de audio del PC y lo pasa al `CallManager` como `localChannel`; con `CHANNEL=desktop-audio` es además el canal principal (sin entrantes, sin marcación, sin `/sim`). `twilio` y `whatsapp` no están implementados: el servidor se niega a arrancar en vez de fingir.

### Modo audio del PC

La app captura el **cable A** sin procesado (sin cancelación de eco ni supresión de ruido) y lo envía en tramas `0x04`; el servidor lo trata como la voz del pasajero (mismo punto de medida `onAudio`, misma `CallSession`); la voz traducida del operador vuelve en tramas `0x05` y la app la reproduce **solo** en el **cable B** (nunca en los auriculares). El operador contesta y cuelga en el otro programa; la app solo traduce. Detalle, instalación de VB-Cable / BlackHole y enrutado en `MODO-AUDIO-PC.md`. **UNVERIFIED** con WhatsApp real, cables reales y Electron.

### Idiomas por llamada

Tres conceptos independientes (`LanguageSettings`):

- `operatorLang`: idioma que el operador habla y oye (por defecto `es`).
- `passengerSpeaks`: `{mode:'auto'}` o `{mode:'fixed', lang}`: idioma que habla el pasajero.
- `passengerHears`: `{mode:'follow'}` o `{mode:'fixed', lang}`: idioma de la voz traducida que oye el pasajero.

El usuario ve tres modos: **Manual** (fijo + fijo), **Automático** (auto + follow) y **Mixto** (auto + fijo). `settingsForMode` los convierte conservando los idiomas ya elegidos. Los cambios en directo (`call.setLanguages`) se aplican a las **frases siguientes**; la frase en traducción o en TTS termina en el idioma anterior y no se corta el audio que está sonando. El TTS del idioma nuevo se precalienta en segundo plano (`TtsSession.prewarm`) y el cambio se hace en el límite entre segmentos.

La detección del idioma del pasajero (`LanguageController`) combina dos señales por segmento confirmado: el idioma del STT (y su probabilidad, si existe: UNVERIFIED) y el que identifica el traductor en la misma frase. Estados: `unknown`, `tentative`, `confirmed`, `uncertain`. Se confirma con dos segmentos seguidos de 3 palabras o más en que ambas señales coinciden (umbrales en `.env`). Si discrepan, el texto es muy corto o la probabilidad es baja, el estado es `uncertain` y se avisa al operador (`LanguageNotice`). Un idioma confirmado solo cambia tras N segmentos seguidos en otro idioma, y se avisa (`changed`). Mientras no se conoce el idioma, el texto del operador se retiene unos segundos y después se usa el idioma de respaldo, avisando.

### Visualización del audio

- Cada 20 ms de audio real se resumen en una ventana `{min, max, rms}` (`computeEnvelope` / `EnvelopeMeter`).
- `LevelsFrameBuilder` las empaqueta en tramas binarias `0x10` (formato documentado en `packages/shared/src/protocol.ts`). Pistas: 0 pasajero entrante, 1 operador entrante, 2 voz traducida hacia el operador, 3 voz traducida hacia el pasajero.
- El cliente guarda las ventanas en un búfer circular por carril (`LevelSource`) y las dibuja en un canvas **solo cuando llegan ventanas nuevas** (nunca por temporizador). Sin audio, las ventanas son silencio digital y la onda queda plana; no hay animaciones decorativas ni valores aleatorios. Si dejan de llegar tramas (incluidos los latidos vacíos), el carril lo indica en lugar de moverse.
- El carril del operador dibuja el **micrófono local**; la pista 1 solo confirma que el servidor lo recibe. Por eso en un navegador sin micrófono (o con «Dices tú» de la caja de voz simulada) el carril del operador no se mueve aunque el pasajero oiga la traducción.
- Los estados de cada sentido (`idle`, `receiving`, `transcribing`, `translating`, `speaking`, `error`) los emite cada `DirectionPipeline` y el servidor los reenvía como `pipeline.stage`.

### Claves y pruebas de conexión

Las claves se introducen en Ajustes (solo administrador) y se envían al servidor con `PUT /api/settings/keys`. **Nunca se devuelven**: solo se muestran los últimos 4 caracteres y la fecha. Se guardan cifradas (AES-256-GCM, clave derivada de `SECRETS_KEY` o generada en un archivo `0600` en `DATA_DIR`). **Salvedad**: con `SECRETS_KEY` vacío la clave de cifrado vive junto a los datos cifrados, así que el cifrado solo protege frente a la lectura aislada del archivo cifrado, no frente a una copia de `DATA_DIR`; en producción, `SECRETS_KEY` fuera de la carpeta. Un valor guardado que ya no se puede descifrar (cambió la clave) se informa como «configurada, sin poder descifrar» con un aviso, nunca como error 500, y `resolve` pasa a la variable de entorno. La clave de Ajustes tiene prioridad sobre la variable de entorno. `POST /api/settings/test/:service` ejecuta una comprobación real y devuelve `ok`, `fail`, `unconfigured` o `simulated` (este último dice expresamente que no se contactó ningún servicio real). Con proveedores reales la prueba de ElevenLabs hace `GET /v1/models` con `xi-api-key` y la de Anthropic `POST /v1/messages` con `max_tokens: 1` (ambas UNVERIFIED). El estado `system.status` de un proveedor real es `configured` («Clave configurada, sin comprobar») mientras ninguna prueba real haya terminado en `ok`; solo entonces es `ok`, un fallo lo deja en `down`, y cambiar la clave vuelve a `configured`; cada cambio se difunde a los operadores conectados.

### Configuración

`loadConfig` valida el entorno con mensajes en español. `loadDotEnv` (sin dependencias) lee un `.env` desde donde se lanzó `npm run` (o `TW_ENV_FILE`), después desde la carpeta actual y sus padres **solo hasta la raíz del proyecto** (la primera carpeta con `.git` o un archivo de bloqueo), sin pisar variables ya definidas: un `.env` de otro proyecto más arriba nunca se carga por accidente. Todas las variables están documentadas en `.env.example`. Las sesiones de operador son tokens aleatorios en memoria (no se firman ni persisten; un reinicio las invalida).

## Decisiones

1. **Monorepo con npm workspaces** (`packages/*`, `apps/*`, `tools/*`), TypeScript estricto, ESM, NodeNext. Las pruebas y Vite resuelven `@tw/*` contra el código fuente (sin compilar antes); `tsc -b` compila con referencias de proyecto. `npm run dev:server` compila antes `packages/server` (y sus dependencias) porque `tsx` resuelve `@tw/shared` y `@tw/pipeline` por `dist/`.
2. **Todo lo externo va detrás de interfaces** (`@tw/shared/interfaces`) y se prueba contra servidores simulados locales (WebSocket con `ws` en puertos efímeros). Los proveedores simulados dicen «Simulado» siempre.
3. **`@tw/shared` es isomórfico** (sin APIs de Node): lo usan el servidor, la app y el simulador.
4. **ElevenLabs no traduce texto**: la traducción la hace Claude (`@anthropic-ai/sdk`, modelo configurable, sin `temperature` ni `top_p`, `stop_reason: "refusal"` tratado como fallo recuperable) detrás de `TextTranslator`, que además identifica el idioma de origen (segunda señal de detección).
5. **«Eleven Realtime Translation»** (alfa Enterprise) podría sustituir STT + traducción + TTS: `DirectionPipeline` queda preparada, el cliente NO se implementa (protocolo sin verificar, sin acceso). Aun con él puede hacer falta un detector aparte del idioma del pasajero.
6. **Una conexión de operador atiende una sola llamada**, por eso las tramas binarias no llevan `callId`. 3 llamadas en dos sentidos = 6 sesiones STT y hasta 6 TTS simultáneas.
7. **Catálogo de idiomas**: solo se muestra lo que STT, traductor y TTS confirman a la vez. La lista base sale de la documentación (UNVERIFIED) y se puede refrescar con una consulta en vivo a ElevenLabs si hay clave; Ajustes indica la fuente («Sin verificar» para la de documentación) y la fecha.
8. **El renderer se prueba en Chromium** (Playwright, `/opt/pw-browsers`), no en Electron: el binario de Electron no se puede descargar aquí. El código de `src/main` y `src/preload` compila pero **no se ha ejecutado**.
9. **Preload en CommonJS** (`index.cts` → `index.cjs`) para poder ejecutarse con `sandbox: true`.
10. **Modo audio del PC sin canal duplicado**: el canal de audio del PC existe siempre junto al principal; `CHANNEL=desktop-audio` solo elige ese mismo canal como principal.
11. **Búsqueda del historial**: por número (sin espacios) o por identificador completo o prefijo de 8 caracteres como mínimo; nunca por subcadena de un identificador aleatorio.

## Qué hay en cada paquete

| Paquete | Contenido |
| --- | --- |
| `packages/shared` (`@tw/shared`) | Tipos, protocolo del operador y del simulador (zod), tramas binarias, audio (PCM16 16 kHz, remuestreo, G.711, envolventes, WAV, señal sintética), catálogo de idiomas, interfaces de proveedores, canales y almacenes |
| `packages/pipeline` (`@tw/pipeline`) | `LanguageController`, `TranslationDirectionPipeline`, proveedores simulados (`ScriptedStt`, `MockTextTranslator`, `MockTts`, `UtteranceBus`, `MockPipelineFactory`), clientes reales de ElevenLabs (STT, TTS, `protocol.ts`) y Claude, `ElevenLabsPipelineFactory` |
| `packages/server` (`@tw/server`) | `loadConfig` + `loadDotEnv`, usuarios (scrypt) y sesiones, claves cifradas, preferencias, historial JSONL, grabaciones WAV, `MockCallChannel` (`/sim`), `DesktopAudioChannel`, `CallSession` (niveles por tramo), `CallManager` (reparto, timbre, límite, salientes, locales), API HTTP, WebSocket `/operator`, `application.ts`, `main.ts`, CLI `operador:crear` |
| `apps/desktop` (`@tw/desktop`) | Electron `src/main` y `src/preload` (sin ejecutar), renderer React: `core` (sesión, HTTP, reductor, cliente de llamada con WebSocket + micrófono + reproducción + cables, niveles, onda), `call` (pantalla de llamada, carriles, chips, panel de idiomas, modo audio del PC), `app` (inicio de sesión, barra, pestañas, aviso de entrante, marcador), `history`, `settings`, `theme`; pruebas jsdom y de navegador (`e2e/`) |
| `tools/simulador` (`@tw/simulador`) | CLI de pasajeros simulados: `llamar`, `escuchar`, `colgar`, `cargar-prueba`, `escenarios`; guiones JSON incluidos |

Puntos de unión (no cambiar su forma sin avisar): contratos de `@tw/shared` (`interfaces.ts`, `protocol.ts`, `types.ts`, `languages.ts`); `core/types.ts` (`CallClientApi`, `CallClientState`, `LevelSource`) y `core/CallContext.tsx`; `call/index.ts` exporta `createCallClient`, `CallScreen` y `LocalCallStart`; `app/index.ts` exporta `AppShell`; `theme/tokens.css` (azul = pasajero, naranja = operador).

## Pruebas que sostienen el diseño

- Que cada onda corresponde a la persona correcta: el carril del pasajero solo cambia con el audio de la pista 0; el del operador, con el micrófono local (y la pista 1). Con audio en un carril y silencio digital en el otro, el otro se mantiene plano. Está probado por red en `packages/server/src/server.test.ts`, en jsdom en `apps/desktop/src/renderer/src/core/call-client.test.ts` y en Chromium contra un servidor real en modo simulado en `apps/desktop/e2e/smoke.spec.ts`.
- Que el cambio de idioma en directo no corta el audio: `packages/pipeline/src/direction-pipeline.test.ts` (proveedores simulados) y `elevenlabs/real-pipeline.test.ts` (clientes reales contra simuladores de su protocolo).
- Con llamadas reales **nada de esto está verificado** y se documenta así en `ESTADO.md`.
