# Telecomway: llamadas con traducción de voz en vivo

Software de escritorio (Windows y Mac, Electron + React) para operadores que hablan español y atienden a pasajeros extranjeros con **traducción de voz en vivo en ambos sentidos**. Llamadas **entrantes y salientes**, hasta **3 operadores y 3 llamadas a la vez**.

La idea central: **si llaman, la llamada entra al programa y ya funciona.** Una llamada entrante se asigna sola a un operador libre, suena en su programa, se contesta (o se contesta sola) y la transcripción y la traducción arrancan solas, detectando el idioma del pasajero, sin configurar nada por llamada. En las salientes, el operador marca un número y elige el idioma del pasajero (o deja la detección automática).

En la pantalla de llamada hay dos carriles, **«Pasajero»** (azul) y **«Operador»** (naranja), cada uno con su onda de audio **real** (sin animaciones decorativas), las etapas de su sentido (Recibiendo voz, Transcribiendo, Traduciendo, Reproduciendo traducción), el texto original y la traducción. El selector de idiomas tiene tres modos, **Manual / Automático / Mixto**, y se puede cambiar en directo sin cortar el audio. Hay historial con grabaciones y Ajustes con claves de solo escritura y botones «Probar conexión».

**Mismo idioma en los dos extremos** (un pasajero que habla español, o Manual con el mismo idioma a ambos lados): no se traduce ni se sintetiza nada; el servidor reenvía la **voz original** (al operador como trama `0x03`, al pasajero el micrófono tal cual) y cada carril lo indica («Oyes su voz original»). En Automático, mientras el idioma del pasajero no está confirmado, sus frases en español se transcriben y se reproducen con la voz sintética, para que nunca haya silencio.

**Si se cae la conexión de la app** en mitad de una llamada, la llamada sigue durante `RECONNECT_GRACE_SECONDS` (10 s por defecto) mientras la app reconecta sola y reanuda con su token; al volver, la pantalla recibe de nuevo el estado de la llamada. Si no vuelve a tiempo, la llamada termina con el motivo «se perdió la conexión del operador» y así queda en el historial.

## Instalar en Mac o Windows (doble clic, sin terminal)

La app de escritorio lo lleva todo dentro: no hay que instalar ni arrancar nada más. Guía paso a paso para quien la
usa: [`docs/GUIA-RAPIDA.md`](docs/GUIA-RAPIDA.md).

1. Descarga el instalador de la versión «ultima»:
   https://github.com/junior17281728jr-bot/llamada-traducciones-en-vivo/releases/tag/ultima
   - Mac: el `.dmg` (`arm64` para chips Apple M1 o posteriores; `x64` para Intel).
   - Windows: el `.exe`.
2. Mac: abre el `.dmg` y arrastra «Telecomway Traductor» a Aplicaciones. Como no está firmada por Apple, la primera
   vez macOS la bloquea: intenta abrirla, ve a Ajustes del Sistema > Privacidad y seguridad y pulsa **Abrir de todos
   modos** (en macOS 14 o anterior basta clic derecho > Abrir). Si dice «está dañada», abre Terminal y ejecuta
   `xattr -cr "/Applications/Telecomway Traductor.app"` y vuelve a abrirla.
   Windows: si sale «Windows protegió su PC», pulsa «Más información» > «Ejecutar de todas formas».
3. Sigue la guía «Empezar en 3 pasos» de la pantalla de inicio:
   1. **Claves**: pega tu clave de ElevenLabs y la de Anthropic en Ajustes > Claves y pulsa «Probar conexión».
   2. **Cables**: instala los dos cables de audio virtuales y elígelos en Ajustes > Audio y WhatsApp (la guía de la
      pantalla dice exactamente qué elegir en WhatsApp y en la app, en Mac y en Windows).
   3. **Entrada automática**: déjala activada.
4. Contesta o llama por WhatsApp en ese ordenador como siempre: cuando suena o alguien habla, la llamada **entra sola**
   en la app y se traduce en los dos sentidos. Al colgar en WhatsApp, la traducción se cierra sola tras unos segundos
   de silencio (con aviso y botón «Sigo en la llamada»).

Qué hace la app instalada (`PROVIDERS=auto`):
- **Llamadas de WhatsApp de ese ordenador: traducción real** con ElevenLabs (escuchar y hablar) y Claude (traducir),
  usando las claves de Ajustes.
- **Plan B si ElevenLabs falla**: si falla su voz, lee la traducción la **voz del ordenador** (Mac: `say`; Windows: la
  voz de Windows); si falla la transcripción o la traducción, se pasa la **voz original sin traducir** para que nadie
  se quede en silencio. Se recupera sola. Las dos opciones se pueden apagar en Ajustes > Voz y plan B.
- **«Recibir llamada de prueba»**: un pasajero simulado en inglés, para ver las pantallas sin gastar saldo. Esa sí es
  simulada y lo dice.
- Los datos (historial, grabaciones, claves cifradas, usuario local) se guardan en la carpeta de datos de la app.

## Estado, en una frase

Probado de verdad: todo el recorrido con simuladores, por red y en Chromium (pruebas automáticas), la **voz del
ordenador** en un Mac y un Windows reales (en cada compilación de GitHub Actions) y el paso a la voz original cuando
ElevenLabs no responde (de punta a punta con el cliente real de ElevenLabs sin clave). **No probado todavía**: ElevenLabs
y Anthropic con claves reales, WhatsApp real con cables de audio reales y la app de Electron abierta en un Mac o Windows.
El detalle honesto está en [`docs/ESTADO.md`](docs/ESTADO.md).

## Requisitos

- Node 22 y npm 10.
- Para la app de escritorio hace falta el binario de Electron (`npm install` lo descarga salvo que se defina `ELECTRON_SKIP_BINARY_DOWNLOAD=1`). La interfaz también se puede usar **en un navegador** con Vite, que es como se ha probado aquí.
- Para las pruebas de navegador, el Chromium de Playwright (`PLAYWRIGHT_BROWSERS_PATH`; en este entorno `/opt/pw-browsers`).

```bash
npm install          # instala todos los workspaces (packages/*, apps/*, tools/*)
npm run build        # compila paquetes, proceso principal de Electron y la interfaz (Vite)
npm run typecheck    # TypeScript estricto en los cinco workspaces
npm test             # vitest run, no interactivo
```

## Arranque en modo simulado, paso a paso

En modo simulado no hace falta ninguna clave ni ningún teléfono. Se necesitan tres terminales: servidor, interfaz y simulador de pasajeros.

### 1. Servidor

```bash
cp .env.example .env        # opcional: los valores por defecto ya son el modo simulado (PROVIDERS=mock, CHANNEL=mock)
npm run dev:server          # compila packages/server y arranca tsx watch src/main.ts en http://127.0.0.1:8787
```

Al arrancar imprime `MODO SIMULADO: voz, traducción y llamadas son simuladas`, la carpeta de datos (`DATA_DIR`, por defecto `./data`) y, **la primera vez**, la contraseña generada del administrador `admin` (si no has puesto `ADMIN_PASSWORD` en `.env`). Guárdala: no se vuelve a mostrar.

El servidor lee `.env` desde la carpeta en la que lanzaste `npm run` (o la que indique `TW_ENV_FILE`); una variable ya definida en el entorno tiene prioridad, por ejemplo `PORT=0 npm run dev:server` elige un puerto libre.

### 2. Operadores

Un operador puede atender una llamada a la vez; con tres operadores conectados se atienden tres llamadas. Se crean así (la contraseña va en una variable para que no quede en el historial del terminal):

```bash
TW_NEW_PASSWORD='una-contraseña' npm run operador:crear -- ana --nombre "Ana"
TW_NEW_PASSWORD='otra-contraseña' npm run operador:crear -- luis --rol admin --nombre "Luis"
```

O, para empezar, `OPERATORS=ana:contraseña,luis:contraseña` en `.env` (se crean al arrancar si no existen). Los operadores ven solo sus llamadas en el historial; el administrador ve las de todos y es el único que puede guardar claves.

### 3. Interfaz del operador

**En el navegador** (así se ha probado):

```bash
npm run dev:desktop         # Vite en http://127.0.0.1:5173
```

Abre esa dirección, escribe el servidor (`http://127.0.0.1:8787`), el usuario y la contraseña y pulsa **Entrar**. Arriba verás el estado de la conexión, los chips de servicios (todos «Simulado») y la insignia **Simulado**. Pestañas: **Llamada** (espera, aviso de entrante, pantalla de llamada), **Marcador**, **Historial** y **Ajustes**. El navegador pedirá permiso para el micrófono al entrar en una llamada; si no hay micrófono, el carril «Operador» queda plano y lo dice.

**En Electron** (sin verificar: el binario no se ha podido ejecutar en este entorno):

```bash
npm run build && npm run dev:electron     # carga dist/renderer con file:// ; TW_SERVER_URL fija el servidor propuesto
TW_RENDERER_URL=http://127.0.0.1:5173 npm run dev:electron   # o carga la interfaz desde Vite
```

### 4. Simulador de pasajeros

Con el servidor en modo simulado y un operador conectado y libre:

```bash
npm run sim -- escenarios                                   # lista los guiones incluidos
npm run sim -- llamar --guion ingles-vuelo-cancelado        # llamada entrante en inglés con guion
npm run sim -- llamar --guion cambio-de-idioma              # empieza en portugués y pasa al inglés
npm run sim -- llamar --desde +34600000000 --idioma de      # sin guion: queda abierta hasta que alguien cuelgue
npm run sim -- escuchar --idioma pt --guion frances-traslado   # teléfono libre para probar el Marcador (saliente)
npm run sim -- cargar-prueba                                # 3 llamadas a la vez + comprueba que la 4.ª se rechaza (3 operadores)
npm run sim -- colgar                                       # cuelga los teléfonos simulados en marcha
```

En la app aparece el aviso **Llamada entrante** con el número y la pista de idioma; pulsa **Contestar** (o activa la contestación automática en las preferencias o con `AUTO_ACCEPT=true`). Mientras el pasajero simulado «habla», el carril **Pasajero** se mueve y aparece su texto con la traducción `[en>es] …` del traductor simulado; el pasajero oye la voz sintética de lo que tú digas. Sin micrófono, usa la caja **«Probar con voz simulada»** de la pantalla de llamada: «Dice el pasajero» o «Dices tú (en español)». Para colgar, **Colgar**; la llamada queda en **Historial** (con grabación si `RECORD_CALLS=true`, reproducible por tramo Mezcla / Pasajero / Operador).

Todo lo que sale de aquí es simulado: el audio del pasajero es una señal sintética (no habla), la traducción es un prefijo `[xx>es]` y la voz es un tono. Sirve para probar el reparto de llamadas, las ondas, las etapas, el cambio de idioma en directo, el historial y los límites, **no** la calidad de ningún servicio real.

### 5. Pruebas de navegador (opcional)

```bash
npm run build && npm run test:e2e     # Playwright + Chromium: arranca el servidor compilado en modo simulado (PORT=0, datos temporales),
                                      # crea un operador con la CLI, inicia sesión, recibe una llamada por /sim, comprueba «Simulado»,
                                      # que solo la onda del pasajero se mueve cuando habla, cuelga y comprueba el historial.
```

## Pasar a ElevenLabs + Claude (proveedores reales)

> **UNVERIFIED.** Los clientes reales existen y están probados contra simuladores locales de su protocolo, pero desde el entorno de desarrollo no hay acceso a ElevenLabs ni a Anthropic: ninguna petición real se ha hecho nunca. Lo primero que hay que hacer con claves reales es pulsar **Probar conexión** y hacer una llamada corta en el modo audio del PC.

1. En `.env`: `PROVIDERS=elevenlabs`. Deja `CHANNEL=mock` para seguir viendo llamadas simuladas (ojo: su audio sintético no es habla, así que el STT real no transcribirá nada útil) o `CHANNEL=desktop-audio` para usar solo el modo audio del PC, que sí lleva voz real.
2. **Claves**: desde **Ajustes > Claves** (solo administrador): `ELEVENLABS_API_KEY` y `ANTHROPIC_API_KEY`. Son de **solo escritura**: se guardan cifradas (AES-256-GCM) en `DATA_DIR`, se usan en la siguiente sesión de llamada sin reiniciar y la pantalla solo muestra «Configurada ····1234, guardada el <fecha>». También valen en `.env`; la de Ajustes tiene prioridad. **Ojo**: con `SECRETS_KEY` vacío la clave de cifrado se guarda en `DATA_DIR/secrets.key`, junto a los datos cifrados, así que una copia de la carpeta entera basta para recuperarlas; en producción pon una `SECRETS_KEY` fuera de `DATA_DIR`. Si cambias `SECRETS_KEY`, las claves guardadas dejan de poder descifrarse: Ajustes lo avisa y hay que guardarlas de nuevo (mientras tanto se usa la del entorno, si la hay).
3. **Voces por idioma**: `ELEVENLABS_VOICE_ES`, `ELEVENLABS_VOICE_EN`, `ELEVENLABS_VOICE_FR`… con el `voice_id` de tu cuenta (en `.env`; sin valores por defecto a propósito). Si el pasajero oye un idioma sin voz configurada, esa traducción falla con un mensaje que nombra la variable.
4. **Modelos y formatos** (`.env`): `ELEVENLABS_STT_MODEL`, `ELEVENLABS_TTS_MODEL`, `ELEVENLABS_TTS_OUTPUT_FORMAT` (`pcm_16000` por defecto, **no confirmado**), `TRANSLATOR_MODEL` (`claude-haiku-5-5` por defecto).
5. **Probar conexión** (Ajustes > Claves): ElevenLabs hace `GET /v1/models`; Anthropic un `POST /v1/messages` mínimo con el modelo configurado. El resultado se muestra tal cual: `ok` con latencia, `fail` con el motivo (clave rechazada, sin conexión…), `unconfigured` si falta la clave o `simulated` («SIMULADO: no se contactó ningún servicio real») en modo simulado. Los chips de la barra superior y de la pantalla de llamada dicen **«Clave configurada, sin comprobar»** hasta que una prueba real termine en `ok` (entonces «Conectado», con la hora de la comprobación); una prueba fallida los pone en «Sin conexión» y cambiar la clave vuelve a «sin comprobar».
6. **Catálogo de idiomas**: por defecto sale de la documentación (chip «Sin verificar» en Ajustes > Idiomas). Con clave, **Actualizar en vivo** (o `LANGUAGE_CATALOG_LIVE=true`) pregunta a ElevenLabs qué idiomas admite el modelo de voz; lo que no confirme queda fuera.

La traducción la hace **Claude** (ElevenLabs no traduce texto): un prompt corto de intérprete, respuesta JSON, 6 s máximo con un reintento, y además identifica el idioma de cada frase como segunda señal de la detección. «Eleven Realtime Translation» (alfa) podría sustituir a los tres servicios; no hay acceso y no está implementado.

## Modo audio del PC (WhatsApp sin la API de Meta)

El operador atiende la llamada en **WhatsApp Desktop** (o cualquier otro programa) y Telecomway se pone en medio solo con el audio del ordenador, mediante **dos cables de audio virtuales** (VB-Cable en Windows, BlackHole en Mac): la salida de WhatsApp entra por el cable A como «voz del pasajero» y la voz traducida del operador sale por el cable B como micrófono de WhatsApp. Los dispositivos se eligen en **Ajustes > Audio** y la sesión se arranca con **Empezar traducción** en la pestaña Llamada (etiqueta «WhatsApp», idioma del pasajero fijo o automático). Está disponible con cualquier `CHANNEL`; con `CHANNEL=desktop-audio` es lo único que hay.

Probado solo con audio sintético por WebSocket. **UNVERIFIED** con WhatsApp real, VB-Cable, BlackHole, `setSinkId` y Electron. Instalación de los cables, tabla de enrutado, cómo probarlo y qué hacer si hay eco: [`docs/MODO-AUDIO-PC.md`](docs/MODO-AUDIO-PC.md).

## Instaladores de Windows y de Mac

Los instaladores se construyen con electron-builder (`apps/desktop/package.json`, bloque `build`): NSIS `.exe` para Windows x64 y `.dmg` para Mac (arm64 y x64), con el permiso de micrófono declarado para macOS.

- **Automático (recomendado)**: al subir el repositorio a GitHub, en la pestaña **Actions** elige «Construir app de escritorio» y pulsa **Run workflow** (o crea una etiqueta `v*`). El flujo [`.github/workflows/construir-app.yml`](.github/workflows/construir-app.yml) compila en `windows-latest` y `macos-latest` y deja los instaladores en «Artifacts». **Sin probar**: se escribió sin poder ejecutarlo.
- **Manual**: en Windows `npm run package:win -w @tw/desktop`; en un Mac `npm run package:mac -w @tw/desktop`.
- **Sin firmar**: Windows mostrará «Windows protegió su PC» (Más información → Ejecutar de todas formas) y en Mac hay que abrirlo con clic derecho → Abrir. Firmar requiere certificados de pago de cada plataforma (no incluidos). Más en [`docs/EMPAQUETADO.md`](docs/EMPAQUETADO.md).

La app pide la URL del servidor al iniciar sesión (`TW_SERVER_URL` cambia la propuesta por defecto). El servidor puede estar en el PC de un operador o en una máquina de la red, pero **habla HTTP y WebSocket en claro**: fuera de `127.0.0.1` hace falta un **proxy TLS** delante (`https://` y `wss://`, por ejemplo Caddy o nginx con un certificado) y escribir esa dirección `https://` en la app; si no, contraseñas, tokens, transcripciones y audio cruzarían la red sin cifrar (la pantalla de inicio avisa al ver `http://` hacia otra máquina). Ajusta `HOST` y `ALLOWED_ORIGINS` en consecuencia y **no reenvíes `/sim` a través del proxy**: detrás de él todas las conexiones parecen locales y el simulador quedaría abierto. Las sesiones de operador viven en memoria (se pierden al reiniciar el servidor).

## Estructura

| Carpeta | Paquete | Contenido |
| --- | --- | --- |
| `packages/shared` | `@tw/shared` | Tipos, protocolo (zod), tramas binarias, audio (PCM16 16 kHz, remuestreo, G.711, envolventes, WAV), idiomas e interfaces |
| `packages/pipeline` | `@tw/pipeline` | Control de idiomas, pipeline por sentido, proveedores simulados, clientes reales de ElevenLabs (STT/TTS) y Claude |
| `packages/server` | `@tw/server` | Servidor puente: canales (simulado y audio del PC), sesiones de llamada, operadores por WebSocket, API HTTP, claves cifradas, historial, grabaciones, CLI `operador:crear` |
| `apps/desktop` | `@tw/desktop` | App de escritorio: `src/main` y `src/preload` (Electron), `src/renderer` (React + Vite), `e2e/` (Playwright) |
| `tools/simulador` | `@tw/simulador` | CLI que simula pasajeros que llaman (`README.md` propio con el formato de guion) |

Comandos de la raíz: `build`, `typecheck`, `test`, `test:e2e`, `dev:server`, `start:server` (compilado), `dev:desktop`, `dev:electron`, `sim`, `operador:crear`, `clean`. Cada workspace tiene además `npx vitest run` y `npm run typecheck`.

## Límites (honestos)

- **Sin servicios reales probados**: ElevenLabs (STT y TTS), Anthropic, `GET /v1/models`, Twilio, Meta. Todo lo que depende de ellos es UNVERIFIED y puede fallar por un nombre de campo.
- **Sin línea telefónica**: los canales Twilio y WhatsApp (API de Meta) no están implementados; el servidor se niega a arrancar con ellos. Hoy las llamadas reales solo pueden pasar por el modo audio del PC, que tampoco está probado con WhatsApp ni con cables reales.
- **Electron nunca se ha ejecutado** aquí: permiso del micrófono (solo para `dist/renderer/index.html`), bloqueo de navegación y de `webview`, selección de salida de audio (`setSinkId`), carga con `file://`, instaladores y flujo de GitHub están escritos pero sin probar. La política de contenido (CSP) va en una etiqueta `<meta>` que Vite añade al compilar y sí se ejercita en Chromium con la prueba de navegador.
- **Traductor real (Claude)**: el texto del pasajero entra en el prompt; la única defensa frente a una frase con instrucciones («ignore the above…») es un prompt que ordena solo traducir y un control mínimo de la respuesta (longitud respecto al original; respuestas cortadas por `max_tokens` se descartan). UNVERIFIED con la API real.
- **Micrófono y altavoces reales**: el cliente de audio del navegador está probado solo con dispositivos falsos en jsdom; en Chromium sin micrófono la app lo detecta y avisa.
- **Latencia real**, pérdida de paquetes y calidad del audio telefónico: desconocidas; los simuladores reproducen en tiempo real pero sin red real.
- **Detección de idioma**: probada con el traductor simulado (heurísticas); con Claude y el STT real los umbrales de `.env` pueden necesitar ajuste.
- **Grabación y aviso de IA**: `RECORD_CALLS` existe, pero la revisión legal (consentimiento, aviso al pasajero, residencia de datos en la UE) está pendiente; `CALL_NOTICE_TEXT` se lee y no se reproduce todavía.
- **Un operador = una llamada**; una sesión del modo audio del PC cuenta como llamada. Probablemente una cuenta de WhatsApp solo admite una llamada a la vez (sin verificar).
- `npm audit` informa de avisos en dependencias **de desarrollo** (vitest 3.x/tinypool y electron-builder); revisar antes de distribuir.

## Documentación

- [`docs/ESTADO.md`](docs/ESTADO.md): probado contra simuladores, sin verificar contra servicios reales y pendiente.
- [`docs/ARQUITECTURA.md`](docs/ARQUITECTURA.md): flujo de la llamada, proveedores simulados y reales, modo audio del PC, decisiones.
- [`docs/CANALES.md`](docs/CANALES.md): la interfaz `CallChannel` y cómo conectar WhatsApp u otros canales.
- [`docs/MODO-AUDIO-PC.md`](docs/MODO-AUDIO-PC.md): cables virtuales, enrutado, pruebas y eco.
- [`docs/EMPAQUETADO.md`](docs/EMPAQUETADO.md): instaladores.
- [`tools/simulador/README.md`](tools/simulador/README.md): comandos, salida y formato de guion del simulador.
