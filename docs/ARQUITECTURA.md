# Arquitectura

Este documento describe el diseño acordado. Lo que está implementado y probado figura en [`ESTADO.md`](ESTADO.md); aquí se explica cómo encaja todo y quién construye qué.

## Flujo de una llamada

```
 Pasajero (teléfono / WhatsApp / simulador /sim)
        │  audio del canal (PCM16 16 kHz mono tras convertir en el borde)
        ▼
 ┌───────────────────────────────┐
 │ CallChannel (mock | twilio |  │   Cada llamada es un ChannelCall.
 │ whatsapp)                     │   ChannelCall.onAudio es EL punto donde se mide la onda
 └───────────────┬───────────────┘   del pasajero (igual para el canal simulado y los reales).
                 │
                 ▼
 ┌───────────────────────────────────────────────────────────────────────────┐
 │ CallSession (una por llamada, en @tw/server)                              │
 │  · asigna la llamada a un operador libre (entrante) o marca (saliente)    │
 │  · estado de la llamada: queued → ringing → active → ended                │
 │  · LanguageSettings vigentes + LanguageState detectado + avisos           │
 │                                                                           │
 │   Pipeline passenger_to_operator          Pipeline operator_to_passenger  │
 │   audio pasajero                          micrófono del operador          │
 │     → STT (idioma por segmento)             → STT (idioma = operatorLang) │
 │     → Claude: traduce + identifica idioma   → Claude: traduce             │
 │     → TTS en operatorLang                   → TTS en el idioma que oye    │
 │          │                                       │   el pasajero          │
 │          │            Control de idiomas         │                        │
 │          └──► detectado (STT + Claude) ──────────┘ (follow / retención)   │
 └──────┬───────────────────────────────────────────────┬────────────────────┘
        │ voz traducida (pista 2)                       │ voz traducida (pista 3)
        ▼                                               ▼
 WebSocket /operator  ◄── JSON + tramas binarias ──►   ChannelCall.sendAudio ──► Pasajero
        │
        ▼
 App de escritorio (Electron + React)
   · carril «Pasajero»: onda de las tramas de niveles pista 0 (audio real recibido del canal)
   · carril «Operador»: onda del micrófono local (las mismas muestras que se envían),
     confirmada por la pista 1 del servidor (detecta «el micrófono no llega»)
   · chips de estado por sentido, texto original y traducción, selector de modo y de idiomas

 Almacenes (detrás de interfaces): TranscriptStore (historial y segmentos), RecordingStore
 (grabaciones), SecretsStore (claves cifradas con AES-256-GCM en DATA_DIR), PreferencesStore
 (preferencias por operador), LanguageCatalogProvider (idiomas soportados a la vez por STT,
 traductor y TTS), ConnectionTester (botones «Probar conexión»).
```

### Formato de audio

Todo el audio interno es **PCM16 mono little-endian a 16 000 Hz**. Los canales y los proveedores convierten en su borde (`WireToInternal` / `InternalToWire` en `@tw/shared`: PCM de 8 a 48 kHz, mu-law y a-law).

### Idiomas por llamada

Tres conceptos independientes (`LanguageSettings`):

- `operatorLang`: idioma que el operador habla y oye (por defecto `es`).
- `passengerSpeaks`: `{mode:'auto'}` o `{mode:'fixed', lang}`: idioma que habla el pasajero.
- `passengerHears`: `{mode:'follow'}` o `{mode:'fixed', lang}`: idioma de la voz traducida que oye el pasajero.

El usuario ve tres modos: **Manual** (fijo + fijo), **Automático** (auto + follow) y **Mixto** (auto + fijo). `settingsForMode` los convierte conservando los idiomas ya elegidos. Los cambios en directo se aplican a las **frases siguientes**; la frase en traducción o en TTS termina en el idioma anterior y no se corta el audio que está sonando. El TTS del idioma nuevo se precalienta en segundo plano (`TtsSession.prewarm`) y el cambio se hace en el límite entre segmentos.

La detección del idioma del pasajero combina dos señales por segmento confirmado: el idioma del STT (y su probabilidad, si existe: UNVERIFIED) y el que identifica Claude en la misma frase. Estados: `unknown`, `tentative`, `confirmed`, `uncertain`. Se confirma con dos segmentos seguidos de 3 palabras o más en que ambas señales coinciden (umbrales en `.env`). Si discrepan, el texto es muy corto o la probabilidad es baja, el estado es `uncertain` y se avisa al operador (`LanguageNotice`). Un idioma confirmado solo cambia tras N segmentos seguidos en otro idioma, y se avisa. Mientras no se conoce el idioma, el texto del operador se retiene unos segundos y después se usa el idioma de respaldo, avisando.

### Visualización del audio

- Cada 20 ms de audio real se resumen en una ventana `{min, max, rms}` (`computeEnvelope` / `EnvelopeMeter`).
- `LevelsFrameBuilder` las empaqueta en tramas binarias `0x10` (formato documentado en `packages/shared/src/protocol.ts`: pista, secuencia u32, tiempo u32, ventanas con `min i16, max i16, rms u16`). Pistas: 0 pasajero entrante, 1 operador entrante, 2 voz traducida hacia el operador, 3 voz traducida hacia el pasajero.
- El cliente guarda las ventanas en un búfer circular por carril (`LevelSource`) y las dibuja en un canvas. Sin audio, las ventanas son silencio digital y la onda queda plana; no hay animaciones decorativas ni valores aleatorios. Si dejan de llegar tramas (incluidos los latidos vacíos), el carril lo indica en lugar de moverse.
- Los estados de cada sentido (`idle`, `receiving`, `transcribing`, `translating`, `speaking`, `error`) los emite cada `DirectionPipeline` y el servidor los reenvía como `pipeline.stage`.

### Claves y pruebas de conexión

Las claves se introducen en Ajustes (solo administrador) y se envían al servidor con `PUT /api/settings/keys`. **Nunca se devuelven**: solo se muestran los últimos 4 caracteres y la fecha. Se guardan cifradas (AES-256-GCM, clave derivada de `SECRETS_KEY` o generada en un archivo `0600` en `DATA_DIR`). La clave de Ajustes tiene prioridad sobre la variable de entorno. `POST /api/settings/test/:service` ejecuta una comprobación real y devuelve `ok`, `fail`, `unconfigured` o `simulated` (este último dice expresamente que no se contactó ningún servicio real).

## Decisiones

1. **Monorepo con npm workspaces** (`packages/*`, `apps/*`, `tools/*`), TypeScript estricto, ESM, NodeNext. Las pruebas y Vite resuelven `@tw/*` contra el código fuente (sin compilar antes); `tsc -b` compila con referencias de proyecto.
2. **Todo lo externo va detrás de interfaces** (`@tw/shared/interfaces`) y se prueba contra servidores simulados locales (WebSocket con `ws` en puertos efímeros). Los proveedores simulados dicen «Simulado» siempre.
3. **`@tw/shared` es isomórfico** (sin APIs de Node): lo usan el servidor, la app y el simulador.
4. **ElevenLabs no traduce texto**: la traducción la hace Claude (`@anthropic-ai/sdk`, modelo configurable, sin `temperature` ni `top_p`, `stop_reason: "refusal"` tratado como fallo recuperable) detrás de `TextTranslator`, que además identifica el idioma de origen (segunda señal de detección).
5. **«Eleven Realtime Translation»** (alfa Enterprise) podría sustituir STT + traducción + TTS: `DirectionPipeline` queda preparada, el cliente NO se implementa (protocolo sin verificar). Aun con él puede hacer falta un detector aparte del idioma del pasajero.
6. **Una conexión de operador atiende una sola llamada**, por eso las tramas binarias no llevan `callId`. 3 llamadas en dos sentidos = 6 sesiones STT y hasta 6 TTS simultáneas.
7. **Catálogo de idiomas**: solo se muestra lo que STT, traductor y TTS confirman a la vez. La lista base sale de la documentación (UNVERIFIED) y se puede refrescar con una consulta en vivo a ElevenLabs si hay clave; Ajustes indica la fuente y la fecha.
8. **El renderer se prueba en Chromium** (Playwright, `/opt/pw-browsers`), no en Electron: el binario de Electron no se puede descargar aquí. El código de `src/main` y `src/preload` compila pero **no se ha ejecutado**.
9. **Preload en CommonJS** (`index.cts` → `index.cjs`) para poder ejecutarse con `sandbox: true`.

## Reparto de trabajo (fase siguiente, cinco agentes en paralelo)

Nadie ejecuta `npm install`: las dependencias ya están instaladas. Cada agente prueba lo suyo con `npx vitest run` dentro de su paquete.

| Agente | Dueño de | Entrega |
| --- | --- | --- |
| Pipeline | `packages/pipeline/**` | `elevenlabs/protocol.ts` (todo lo UNVERIFIED centralizado), STT/TTS por WebSocket contra un servidor ElevenLabs simulado, traductor Claude detrás de `TextTranslator`, control de idiomas (detección, retención, cambio en directo), proveedores simulados y `PipelineFactory` |
| Servidor | `packages/server/**` | Canal simulado (`/sim`), sesiones de llamada, asignación a operadores, WebSocket `/operator`, niveles en `ChannelCall.onAudio` y en el tramo del operador, API HTTP, almacenes, claves cifradas, pruebas de conexión, catálogo de idiomas |
| Simulador | `tools/simulador/**` | CLI de pasajeros: llamadas entrantes y salientes, `sim.say` con audio sintético (`synthesizeSpeechSignal`) y silencio digital cuando no habla |
| Llamada (renderer) | `apps/desktop/src/renderer/src/core/**` y `call/**` | Cliente `CallClientApi` (WebSocket, micrófono, reproducción, búferes de niveles), pantalla de llamada con los dos carriles, chips, textos, selector de modo y avisos |
| App (renderer) | `src/renderer/src/app/**`, `settings/**`, `history/**`, `theme/**` | Inicio de sesión, marcador, historial, Ajustes (claves, pruebas de conexión, idiomas, preferencias), enrutado y diseño general |

Puntos de unión ya creados (no cambiar su forma sin avisar):

- `@tw/shared`: contratos de `interfaces.ts`, mensajes de `protocol.ts`, tipos de `types.ts`.
- `core/types.ts` (`CallClientApi`, `CallClientState`, `LevelSource`) y `core/CallContext.tsx` (`CallProvider`, `useCall`, `createEmptyCallClient`).
- `call/index.ts` exporta `createCallClient` y `CallScreen`; `app/index.ts` exporta `AppShell`. `App.tsx` los une.
- `theme/tokens.css`: variables de color, espaciado, radios y tipografía; azul = pasajero, naranja = operador.

### Pruebas que se esperan de la fase siguiente

- Que cada onda corresponde a la persona correcta: el carril del pasajero solo cambia con el audio de la pista 0; el del operador, con el micrófono local (y la pista 1). Con audio en un carril y silencio digital en el otro, el otro se mantiene plano.
- Que la visualización funciona con llamadas simuladas (servidor + simulador + cliente de pruebas). Con llamadas reales **no está verificado** y se documenta así.
