# Estado del proyecto

Regla: aquí no se marca como funcional nada que solo esté simulado. Tres listas: **probado contra simuladores**, **sin verificar contra servicios reales** y **pendiente**. Última actualización: corrección tras la revisión de seguridad y de corrección/honestidad (ver «Corregido en la revisión»).

**Resumen en una línea:** todo el recorrido (llamada entrante o saliente → reparto → transcripción → traducción → voz → ondas → historial con grabación) funciona **contra simuladores locales** y está cubierto por 527 pruebas automáticas (vitest) más una prueba de navegador real (Playwright + Chromium). **Nada ha tocado un servicio real**: ni ElevenLabs, ni Anthropic, ni Twilio, ni Meta, ni WhatsApp, ni un micrófono, ni Electron.

## Qué está solo simulado (y la interfaz lo rotula «Simulado»)

- **Voz a texto, traducción y voz** con `PROVIDERS=mock`: `ScriptedStt` recibe el texto por un bus (el audio sintético no es habla), `MockTextTranslator` antepone `[en>es]` al texto (o lo devuelve igual si ya está en el idioma de destino, como pide el prompt real) e identifica el idioma con heurísticas, `MockTts` emite un tono parecido a voz. Chips «Voz (ElevenLabs): Simulado», «Traductor: Simulado», insignia «Simulado» en la barra, en cada carril y en la caja «Probar con voz simulada».
- **El teléfono** con `CHANNEL=mock`: pasajeros simulados por WebSocket `/sim` (la CLI `@tw/simulador`). Chip «Llamadas: Simulado» y `simulated: true` en cada `call.state`.
- **Las pruebas de conexión** en modo simulado responden `simulated` con el texto «Modo simulado: NO se ha contactado ningún servicio real».
- **Los clientes reales de ElevenLabs y Claude** se han ejecutado únicamente contra servidores WebSocket locales y un `fetch` simulado que imitan lo que *creemos* que es su protocolo.

## Probado contra simuladores

Todas las pruebas se ejecutan con `npm test` en la raíz (42 archivos, 527 pruebas, ~21 s), salvo la de navegador (`npm run build && npm run test:e2e`) y las ejecuciones manuales indicadas.

### `@tw/shared` (113 pruebas: lógica pura)

- Audio: base64, remuestreo lineal (también en flujo), G.711 mu-law y a-law, tramas binarias, mezcla, WAV, `computeEnvelope` y `EnvelopeMeter` (ventanas de 20 ms con min/max/RMS sobre muestras reales), señal sintética determinista (`synthesizeSpeechSignal`).
- Idiomas: normalización de códigos, catálogo de documentación y selección por rol.
- Tipos: Manual / Automático / Mixto, mezcla de ajustes, resolución de idiomas.
- Protocolo: validación zod de los mensajes del operador y del simulador, tramas de audio y de niveles (`0x10`), `LevelsFrameBuilder`.

### `@tw/pipeline` (103 pruebas)

- `LanguageController`: detección con dos señales (STT + traductor), confianza, histéresis, `uncertain`, cambio con aviso, respaldo.
- `TranslationDirectionPipeline` con proveedores simulados: STT → traductor → TTS por sentido, etapas, retención del texto del operador mientras no se conoce el idioma, **cambio de idioma en directo sin cortar el audio** (la frase en curso termina en el idioma anterior; la siguiente sale en el nuevo); **mismo idioma en ambos extremos** (`directAudioFor`: Manual es/es sin traductor ni voz sintética; pasajero hispanohablante en Automático sintetizado hasta que la detección es utilizable y confirmado con la segunda señal; cambio a otro idioma detectado aunque se esté reenviando la voz original); **retroceso tras agotar los reintentos del STT** (sin nuevos intentos hasta pasar el plazo, que se duplica, o hasta un cambio de ajustes).
- **Clientes reales contra simuladores de su protocolo** (61 pruebas): STT ElevenLabs por WebSocket (éxito, formato ulaw, campos alternativos y duplicados, commit manual, 401, clave ausente, 429/404 en el upgrade, error fatal, avisos ignorados, caída y reconexión con reenvío del audio no confirmado, `rate_limited` con pausa, agotar reintentos, cierre limpio, mensaje desconocido, la clave nunca se registra); TTS ElevenLabs (audio exacto, cuatro formatos de salida decodificados, apertura perezosa + `prewarm` + keepalive + standby, dos frases en orden, voz o clave ausente, clave rechazada, reintento antes de audio, caída tras audio, `cancel`, standby cerrado por el servidor); traductor Claude con el SDK real y `fetch` falso (forma exacta de la petición, contexto, reutilización del cliente, JSON válido/roto/truncado, `refusal`, vacío, `max_tokens` proporcional a la frase y respuesta cortada por `max_tokens` rechazada, respuesta mucho más larga que el original rechazada, timeout con reintento, 401, 429/529, 404/400, red, cancelación externa); fábrica + pipeline completo inglés → español con audio exacto y cambio de voz en directo abriendo la conexión francesa mientras suena la inglesa.

### `@tw/server` (68 pruebas, incluidas de punta a punta por red)

- Configuración validada con mensajes en español; `loadDotEnv` (`.env` sin dependencias, sin pisar variables ya definidas; `TW_ENV_FILE`, `INIT_CWD`, carpeta actual y padres).
- Usuarios con scrypt, sesiones con token (en memoria), bloqueo tras intentos fallidos **por usuario y por dirección** (rotar el nombre de usuario no evita el bloqueo; tabla acotada), CORS restringido a `ALLOWED_ORIGINS`, `/api/health` solo responde `{ok:true}`, un porcentaje mal formado en la ruta responde 400.
- `FileSecretsStore`: claves cifradas AES-256-GCM, **nunca en claro en disco ni devueltas por la API** (solo máscara); la clave de Ajustes tiene prioridad sobre el entorno; con una `SECRETS_KEY` distinta a la usada al guardar, el valor se informa como «configurada, sin poder descifrar» (aviso en Ajustes) y se usa la del entorno, sin errores 500.
- Preferencias por operador validadas contra el catálogo (`400 unsupported_language`), historial JSONL con filtros (`limit`, `direction` incluido `local`, `from`, `to`, `q`, `operatorId`), grabaciones WAV por tramo **servidas en flujo desde disco** (cabecera WAV + lectura por trozos; la mezcla se suma trozo a trozo) con rangos HTTP byte a byte iguales al WAV en memoria y con las mismas cabeceras de seguridad que el JSON, acceso restringido (un operador no ve las llamadas de otro; el administrador ve todas), sin recorrido de rutas, purga por `RETENTION_DAYS`; el grabador descarta audio si el disco no da abasto en vez de acumularlo en memoria.
- `MockCallChannel` + `CallManager` + `CallSession`: entrante que **entra sola** y se reparte al operador libre, timbre con tiempo límite y paso a otro operador, contestación automática, rechazo cuando no hay operador libre o se alcanza el límite de 3, saliente a un teléfono simulado a la escucha, cuelgue por cualquiera de las partes, **niveles de audio reales por tramo** (pista 0 solo con audio del pasajero, pista 1 solo con el micrófono del operador; el otro queda en silencio digital), `debug.say` como pasajero y como operador; **dos «Contestar» seguidos** contestan una sola vez (una sesión, una grabación); **dos «Llamar» seguidos** colocan una sola llamada (`operator_busy` para el segundo) y el micrófono llega a la sesión; cuelgue del pasajero **mientras se abre la grabación** termina la sesión; **periodo de gracia** al caer la conexión del operador (la llamada sigue, el operador no recibe ofertas, al volver recibe de nuevo `call.state` y `call.languages`; pasado el plazo termina con `connection_lost`; con `RECONNECT_GRACE_SECONDS=0` cuelga en el acto); `call.hangup` sobre una llamada inexistente responde `unknown_call`; **mismo idioma**: Manual es/es reenvía la voz original en los dos sentidos (0x03 al operador; el micrófono tal cual al pasajero) sin voz sintética, y en Automático un pasajero hispanohablante se oye sintetizado hasta que la detección es utilizable y original después.
- WebSocket `/operator`: `auth.login`, `auth.resume`, rechazo de la segunda sesión del mismo operador, mensajes no autenticados, reconexión con token (en mitad de una llamada la pantalla recibe la llamada otra vez), un socket que se cierra durante la verificación de la contraseña **no deja un operador fantasma**, el audio del micrófono por encima de 1,5× tiempo real se descarta (no se graba ni se transcribe) sin cerrar la conexión; `/sim` solo desde la misma máquina **y nunca con cabecera `Origin`** (páginas web) salvo que esté en `ALLOWED_ORIGINS`.
- `system.status` con `PROVIDERS=elevenlabs`: `unconfigured` sin clave, **`configured` («Clave configurada, sin comprobar»)** con clave, `ok` solo tras una prueba de conexión real correcta, `down` tras una fallida, de nuevo `configured` al cambiar la clave; cada cambio se difunde a los operadores conectados. `LANGUAGE_CATALOG_LIVE=true` consulta el catálogo al arrancar (y solo entonces).
- **Modo audio del PC**: `call.startLocal` junto al canal simulado (tramas `0x04` alimentan el carril del pasajero y se transcriben; la voz traducida del operador sale en `0x05` y nunca en `0x02`; historial con `direction: 'local'`, etiqueta y grabación); `CHANNEL=desktop-audio` (sin línea, sin `/sim`, marcación rechazada, `operator_busy` en la segunda sesión local, idiomas fijos).
- Búsqueda del historial: por número sin espacios o por identificador completo / prefijo ≥ 8 caracteres (antes una subcadena como `999` podía coincidir por azar con un identificador aleatorio y volvía una prueba intermitente).

### `@tw/desktop` renderer (168 pruebas jsdom + 5 de navegador)

- `core`: sesión (memoria + `sessionStorage`/`localStorage` tolerantes a fallo), cliente HTTP tipado con `ApiError`, reductor de estado (tras reconectar, una llamada que el servidor ya no tiene pasa a «terminada» con motivo «se perdió la conexión»; `unknown_call` sobre la llamada en pantalla la cierra; `directAudio` de `call.languages`), `createCallClient` con WebSocket, micrófono, reproducción y cables falsos (conexión, reconexión, `call.incoming` → `accept`, niveles por carril, cambio de idioma, mute, `debug.say`, modo local con `0x04`/`0x05`, reproducción de la voz traducida `0x02` **y de la voz original `0x03`**, errores claros si faltan dispositivos o `setSinkId`), búferes de niveles, barras de la onda.
- `call`: pantalla de llamada con los dos carriles, etiqueta «Simulado» cuando procede, etapas, texto original y traducción, panel Manual / Automático / Mixto con cambio en directo, avisos de idioma, chips «Oyes su voz original» / «El pasajero oye tu voz original» cuando se reenvía la voz original, tarjeta «Modo audio del PC».
- `app`: inicio de sesión con errores específicos (credenciales, bloqueo, servidor inalcanzable, URL sin http) y **aviso de conexión sin cifrar** con `http://` hacia otra máquina, barra con estado y chips (incluido «Clave configurada, sin comprobar»), pestañas accesibles (teclado), aviso de llamada entrante con cuenta atrás y Contestar / Rechazar **de un solo clic** (ambos botones se deshabilitan hasta la respuesta del servidor), apertura automática de la pestaña Llamada al entrar una llamada, marcador con validación, **«Llamar» de un solo clic** y errores explicados (`dial_permission_required`, `max_calls_reached`, `operator_busy`, `invalid_number`, `dial_failed`).
- `history`: filtros (la dirección `local` también se pide al servidor), tabla responsive, detalle con reproductor por tramo (URL de blob revocada), «Esta llamada no tiene grabación», exportación de la transcripción a `.txt`.
- `settings`: claves de solo escritura con máscara, Guardar / Borrar / **Probar conexión** mostrando `ok` / `fail` / `unconfigured` / `simulated` tal cual, catálogo de idiomas con fuente y fecha, preferencias, audio (dispositivos, permiso, cables del modo audio del PC), servidor.
- Contraste AA de los tokens de color; tema oscuro por defecto y claro con `prefers-color-scheme`; sin desbordamiento horizontal a 360 px.
- **Navegador real (Playwright + Chromium, `apps/desktop/e2e/smoke.spec.ts`)**, ejecutado aquí con éxito (5 pruebas, ~15 s): `global-setup.ts` arranca el **servidor compilado** en modo simulado con `PORT=0` y `DATA_DIR` temporal, crea un operador con la CLI `operador:crear`, y `vite preview` sirve la interfaz compilada; la prueba inicia sesión, comprueba «Simulado» en la barra y en la pantalla de llamada, recibe una llamada por `/sim`, pulsa Contestar, toma una captura de los dos canvas en silencio (ambos quietos durante 500 ms), hace hablar al pasajero y comprueba que **el canvas del pasajero cambia y el del operador no**, que aparecen el texto y la traducción, responde con «Dices tú» (el pasajero simulado oye > 20 kB de voz traducida; el carril del operador sigue plano porque sin micrófono muestra silencio digital), cuelga (`hangup_operator` en el teléfono simulado, «Has colgado» en pantalla) y encuentra la llamada en el historial con grabación. Más: tema oscuro/claro, sin desbordamiento a 360 px y mensaje claro con un servidor inalcanzable.

### `@tw/simulador` (75 pruebas + ejecución manual)

- Cliente de `/sim`, guiones JSON con validación en español, intérprete (pausas de silencio, espera de la respuesta traducida), canal de control local para `colgar`, comandos `llamar`, `escuchar`, `colgar`, `cargar-prueba` contra un servidor `/sim` falso, CLI.
- **Ejecución manual contra el servidor real del repositorio** (`npm run dev:server` con `PROVIDERS=mock CHANNEL=mock`, puerto libre, `DATA_DIR` temporal, operador creado con `OPERATORS` y conectado por `/operator` desde un script desechable que contestaba y respondía con `debug.say`): `npm run sim -- llamar --guion cambio-de-idioma` terminó con **código 0**: contestada, **9 líneas dichas**, el pasajero oyó **27,4 s de audio sintético en 5 ráfagas**, duró 1 min 20 s y colgó el pasajero; en el historial quedó la llamada con `passengerLang: "en"`, grabación de 78 s (`passenger.pcm` 2,5 MB, `operator.pcm` 0,9 MB) y las transcripciones. Detección observada: `pt` tentativo tras la 1.ª frase, `pt` confirmado tras la 2.ª, las respuestas del operador salieron en portugués (`follow`), la 3.ª frase (inglés largo) todavía se tradujo con el pasajero oyendo portugués, las tres líneas cortas («Ok.», «Yes, yes.», «Hm, right.») se tradujeron con origen `?` (el traductor simulado no pudo identificar el idioma) **sin que apareciera el aviso «idioma incierto»** en esta ejecución, y el cambio a `en` confirmado con aviso `changed` llegó en la última frase larga en inglés (la respuesta siguiente del operador ya salió en inglés). Al terminar no quedó ningún proceso.

## Sin verificar contra servicios reales

Marcado `UNVERIFIED` en el código o por su naturaleza. Nada de esto se ha contrastado con el servicio real:

- **ElevenLabs STT (Scribe v2 Realtime)**: ruta `/v1/speech-to-text/realtime` y sus parámetros (`model_id`, `language_code`, `audio_format`, `commit_strategy`, `include_timestamps`, `include_language_detection`, `vad_silence_threshold_secs`), mensaje de cliente `{message_type:'input_audio_chunk', audio_base_64, commit, sample_rate}`, tipos `session_started` / `partial_transcript` / `committed_transcript(_with_timestamps)`, lista de errores y la política asignada a cada uno, formas de los timestamps, `language_probability` (`SttFinal.langProbability`), cabecera `xi-api-key` en el upgrade.
- **ElevenLabs TTS (stream-input por WebSocket)**: ruta `/v1/text-to-speech/{voice_id}/stream-input`, `model_id` y `output_format` en la query, primer mensaje con `voice_settings` y `generation_config.chunk_length_schedule`, `{text, try_trigger_generation}`, `flush`, `{text:''}` como cierre, `' '` como keepalive, respuestas `{audio, isFinal}`, cierre por inactividad (~20 s), código 1008 para auth/cuota y, sobre todo, **que `pcm_16000` sea un `output_format` aceptado** (los documentados son `mp3_44100_128`, `ulaw_8000`, `alaw_8000`, `pcm_44100`). La decisión «una conexión por frase + standby» depende de que `isFinal` solo llegue tras el cierre.
- **`GET /v1/models`** de ElevenLabs (prueba de conexión y catálogo en vivo): de memoria, forma de la respuesta supuesta.
- **Lista de idiomas** (`documentationCatalog`): los 32 idiomas de Flash v2.5 salen de un resumen; el STT se da por válido solo para esos mismos idiomas.
- **SDK de Anthropic contra la API real**: ninguna llamada a `api.anthropic.com`. `speedTuningFor` (thinking desactivado + esfuerzo bajo en Haiku 5.5; esfuerzo bajo en la familia 5.x) sale de la documentación del SDK instalado. El `cache_control` del prompt de sistema no tiene efecto por tamaño. El SDK 1.1.0 instalado envía la clave como `Authorization: Bearer` (comprobado en su código), mientras que la prueba de conexión del servidor (`connection-tester.ts`) usa `x-api-key` en crudo: **conviene verificar cuál acepta la API** y unificar.
- **Electron**: `src/main` y `src/preload` compilan pero **nunca se han ejecutado** (el binario no se puede descargar aquí): carga con `file://`, permiso del micrófono (`setPermissionRequestHandler`), `window.telecomway.getConfig()`, `TW_SERVER_URL` / `TW_RENDERER_URL`, `npm run dev:electron`.
- **Micrófono y altavoces reales**: `getUserMedia`, `enumerateDevices` (visibilidad de nombres tras el permiso), selección de salida con `setSinkId`, reproducción sin huecos, cancelación de eco. Probado solo con dispositivos falsos en jsdom; en Chromium sin micrófono la app lo detecta.
- **Cables de audio virtuales** (VB-Cable, BlackHole): nombres, formato, captura sin procesado, y **WhatsApp Desktop** (si deja elegir salida y micrófono, si admite más de una llamada por cuenta, calidad tras sus códecs). Pasos de `docs/MODO-AUDIO-PC.md` tomados de la documentación pública de cada producto.
- **Ondas con llamadas reales**: solo verificadas con audio sintético por WebSocket; el audio real puede traer silencios sin tramas y pérdida de paquetes que el simulador no reproduce.
- **Latencia real** de ElevenLabs, Claude, reconexión y standby; **detección de idioma real** (los umbrales `LANG_*` se han ajustado con el traductor simulado).
- **Instaladores y flujo de GitHub** (`.github/workflows/construir-app.yml`, `package:win`, `package:mac`, electron-builder): escritos sin poder ejecutarlos; sin firmar.
- **Windows y Mac**: nada se ha ejecutado en esos sistemas (simulador, servidor, app). El código usa solo APIs portables de Node.
- `ELEVENLABS_STT_INCLUDE_TIMESTAMPS`, `ELEVENLABS_TTS_CHUNK_SCHEDULE` y el resto de ajustes de `.env.example` marcados UNVERIFIED.
- Con `PROVIDERS=elevenlabs` y `CHANNEL=mock` el audio sintético del teléfono simulado no es habla: el STT real no lo transcribirá; solo audio real (modo audio del PC) produce transcripciones.

## Pendiente

- **Canales reales**: Twilio y WhatsApp Business Calling (API de Meta) detrás de `CallChannel` (`docs/CANALES.md`); `COMPANY_NUMBER`, consentimiento previo para las llamadas iniciadas por la empresa (`dial_permission_required`, límite 1/día y 2/semana por pasajero). Sin acceso para probarlos.
- **Verificación con claves reales** de ElevenLabs y Anthropic: pulsar «Probar conexión», una llamada corta en el modo audio del PC, corregir `protocol.ts` y anotar aquí el resultado antes de marcar nada como funcional. Unificar la cabecera de autenticación de Anthropic (ver arriba).
- **Prueba real del modo audio del PC** con WhatsApp Desktop, VB-Cable (Windows) y BlackHole (Mac), siguiendo `docs/MODO-AUDIO-PC.md`.
- **Ejecutar Electron** en Windows y Mac: permiso de micrófono (solo para `dist/renderer/index.html`), bloqueo de navegación y de `webview`, `setSinkId`, carga `file://` con la CSP de la etiqueta `<meta>` (que sí se ha ejercitado en Chromium con `vite preview`), instaladores y el flujo de GitHub; después, **firma de las apps** (certificados de Windows y de Apple; notarización).
- **Revisión legal de la grabación y del aviso de IA**: consentimiento del pasajero y del operador, texto del aviso (`CALL_NOTICE_TEXT` se lee pero no se reproduce), conservación (`RETENTION_DAYS`), derecho de acceso y borrado.
- **Política de datos y residencia en la UE**: dónde se procesan la voz y el texto (ElevenLabs y Anthropic procesan fuera del servidor), contratos de encargo de tratamiento, cifrado en tránsito del WebSocket (`wss://` detrás de un proxy TLS), copia de seguridad de `DATA_DIR`.
- **Eleven Realtime Translation** (alfa Enterprise): pedir acceso; si se concede y se verifica el protocolo, implementar un `DirectionPipeline` que sustituya a STT + Claude + TTS (puede seguir haciendo falta un detector aparte del idioma del pasajero).
- **Gestión de operadores desde Ajustes** (hoy solo con `operador:crear` o `OPERATORS`), cambio de contraseña, cierre de sesión remoto.
- **Elegir «Tu idioma» por llamada desde el Marcador** (hoy se toma de las preferencias y se puede cambiar en directo en la pantalla de llamada).
- Aviso «idioma incierto» con líneas muy cortas: en la ejecución manual del escenario `cambio-de-idioma` no apareció; revisar las reglas de racha débil del `LanguageController` con proveedores reales.
- `ListCallsQuery` de `@tw/shared` no declara `from`/`to`/`q` aunque el servidor los acepta (la interfaz amplía el tipo localmente).
- `npm audit` informa de avisos en dependencias **de desarrollo** (vitest 3.x/tinypool y electron-builder). No se han actualizado para no cambiar de versión mayor sin necesidad; revisar antes de distribuir.

## Corregido en la revisión (seguridad y corrección/honestidad)

Cada punto se verificó primero leyendo el código o reproduciéndolo contra el servidor compilado, y lleva su prueba (`npm test`: 527 pruebas; `npm run build && npm run test:e2e`: 5 de navegador, ejecutadas aquí con éxito con la nueva CSP).

- **Mismo idioma = silencio** (alta): `CallSession` reenvía la voz original (0x03 al operador, micrófono al pasajero) cuando `directAudioFor` lo decide con los mismos datos que el pipeline; en Automático un pasajero hispanohablante se oye sintetizado hasta que la detección es utilizable; la app reproduce 0x03 y rotula «voz original» en cada carril; `call.languages.directAudio` (campo opcional añadido). Documentado en README y ARQUITECTURA.
- **Doble «Contestar»** → una sola sesión (`answering` en el timbre; el segundo recibe `unknown_call`); botones deshabilitados tras el primer clic.
- **Doble «Llamar»** → una sola llamada (operador reservado y línea contada antes de los `await`; `startSession` fija `currentCallId`); «Llamar» deshabilitado hasta la respuesta.
- **Cuelgue durante `recordings.open()`** → `onEnded` suscrito antes de cualquier `await`; si la llamada terminó mientras tanto, se cierra el grabador y no arranca nada.
- **Operador fantasma** → el socket que se cierra durante la verificación o el registro se da de baja al instante.
- **Caída de la conexión en mitad de una llamada** → periodo de gracia `RECONNECT_GRACE_SECONDS` (10 s), reenganche del enlace con reenvío de `call.state`/`call.languages`, motivo `connection_lost` (añadido) si no vuelve; `call.hangup` sobre una llamada inexistente responde `unknown_call`; la app cierra la pantalla de una llamada que el servidor ya no tiene (`auth.ok.operator.currentCallId`).
- **`/sim` desde páginas web** → rechazado todo `Origin` salvo los de `ALLOWED_ORIGINS`; documentado que detrás de un proxy no hay que reenviar `/sim`.
- **Estado «Conectado» con solo una clave** → nuevo estado `configured` («Clave configurada, sin comprobar»); `ok` solo tras una prueba real correcta, `down` tras una fallida; difusión de `system.status`.
- **`SESSION_SECRET`** (documentación falsa) → eliminado de la configuración y de `.env.example`; se documenta que las sesiones viven en memoria.
- **`LANGUAGE_CATALOG_LIVE`** (no se consultaba) → `catalog.refresh()` al arrancar cuando está activo.
- **Límite de intentos solo por `ip|usuario`** → además por dirección (20 fallos/5 min) y tabla acotada (10 000 entradas).
- **Tramas de audio sin límite** → cubo de fichas por tipo (1,5× tiempo real, ráfaga de 5 s), lo que sobra se descarta; el grabador respeta la contrapresión (`maxPendingBytes`).
- **HTTP en claro a otra máquina** → README y `.env.example` exigen un proxy TLS fuera de `127.0.0.1`; la pantalla de inicio avisa con `http://` hacia otra máquina.
- `decodeURIComponent` sin capturar → 400 `bad_request`.
- **Electron** → `will-navigate` y `will-attach-webview` bloqueados, permiso de micrófono solo para la ruta exacta de `dist/renderer/index.html`, CSP en `<meta>` añadida al compilar (UNVERIFIED en Electron; verificada en Chromium).
- **`SECRETS_KEY` cambiada** → valores no descifrables se informan con aviso (`warning`, campo opcional añadido a `MaskedSecret`) en vez de un 500; `resolve` cae a la variable de entorno; documentada la salvedad de `secrets.key` dentro de `DATA_DIR`.
- **Búsqueda de `.env` hasta la raíz del disco** → se detiene en la raíz del proyecto (`.git` o archivo de bloqueo).
- **Grabaciones**: cabeceras de seguridad también en el WAV y servicio **en flujo** desde disco (mezcla trozo a trozo), sin cargar la llamada entera por petición.
- **`/api/health`** → solo `{ok:true}`.
- **Traductor Claude**: `max_tokens` proporcional a la frase; respuesta cortada por `max_tokens` rechazada (antes se hablaba a medias); respuesta mucho más larga que el original rechazada (control mínimo frente a instrucciones escondidas en lo que dice el pasajero; UNVERIFIED con la API real).
- **STT que no abre (401)**: tras agotar los reintentos, retroceso creciente (5 s → 60 s) en vez de un ciclo de intentos con cada trozo de audio; un cambio de ajustes permite reintentar.
- **Flujo de GitHub**: acciones fijadas a SHA (resueltos con `git ls-remote` contra github.com: `checkout` v4.2.2, `setup-node` v4.4.0, `upload-artifact` v4.6.2).
- `ESTADO.md` decía que la API respondía 400 a `direction=local`: era falso; la interfaz ya envía ese filtro al servidor.

### Hallazgos bajos que siguen abiertos (decididos, no olvidados)

- `/sim` no exige un secreto propio (`SIM_TOKEN`): se ha optado por rechazar todo `Origin` y por documentar que el proxy no debe reenviar `/sim`. Detrás de un proxy en la misma máquina la comprobación de dirección local no vale: no hay `TRUST_PROXY`.
- Con `SECRETS_KEY` vacío la clave de cifrado sigue en `DATA_DIR/secrets.key` (documentado; recomendada una `SECRETS_KEY` fuera de la carpeta). No se cambia porque el arranque sin configuración debe seguir funcionando.
- El control de la respuesta del traductor es solo de longitud; no se comprueba el idioma de salida (haría falta un detector aparte). Las traducciones no llevan marca «dudosa» en la interfaz.
- La CSP de Electron va en `<meta>` (no como cabecera con `onHeadersReceived`); solo verificada en Chromium.
- En las transiciones de idioma puede haber una frase en la que la sesión reenvíe la voz original y el pipeline la sintetice (o al revés), porque cada uno decide con el estado del momento en que le llega el audio o la frase. Asumido y documentado en ARQUITECTURA.
- Las sesiones de operador siguen en memoria (un reinicio cierra todas); no se han implementado tokens persistidos.

## Corte de voz y recuperación (añadido; probado contra simuladores)

- Al terminar la llamada por cualquier motivo (cuelga el pasajero, cuelga el operador, se rechaza, se pierde la conexión más de 10 s), la voz traducida se corta al instante en los auriculares del operador y en el cable del modo audio del PC; el servidor cancela la síntesis pendiente y nada que llegue tarde se reproduce.
- Si el operador pierde la conexión, la llamada se mantiene 10 s (RECONNECT_GRACE_SECONDS) para que la app vuelva a engancharse; pasado ese tiempo se cierra con motivo «connection_lost».
- Si el micrófono se desconecta a mitad de llamada, la app avisa y lo intenta recuperar 3 veces (cada 1,5 s); si no lo consigue, lo dice.
- Al arrancar, el servidor cierra en el historial las llamadas que una ejecución anterior dejó abiertas (motivo «server_shutdown»).
- Sin verificar: todo lo anterior con micrófonos, auriculares, cables y WhatsApp reales (solo audio simulado).

## Servidor integrado en la app de escritorio (añadido)

- Probado: `dist/embedded/server.cjs` (servidor + pipeline + shared en un solo archivo) arranca con Node, sirve la página
  compilada con su CSP, crea el administrador local, contesta sola una llamada simulada y la transcribe (prueba
  automática `embedded.test.ts` y comprobación manual con Node). La interfaz entra sola con el usuario local y muestra
  el botón «Recibir llamada de prueba» (pruebas `app/embedded.test.tsx`).
- Sin verificar: el arranque dentro de Electron real (ventana, permiso de micrófono, `before-quit`), el instalador
  `.dmg`/`.exe` abriéndose en un Mac o Windows reales, y el micrófono real. El audio de la llamada de prueba es sintético.
