# Simulador de pasajeros (`@tw/simulador`)

CLI que hace de **pasajero simulado** contra el servidor de Telecomway por el WebSocket `/sim`. Sirve para probar la app del operador sin teléfono: llamadas entrantes y salientes, ondas, etapas, cambio de idioma en directo, reparto entre operadores y el límite de 3 llamadas simultáneas.

> **Todo lo que hace este paquete es simulado.**
>
> - El **audio es sintético**: el servidor genera, con `synthesizeSpeechSignal` de `@tw/shared`, tonos parecidos a voz (palabras moduladas y silencio digital entre ellas) con una duración acorde al texto. No son palabras: ningún reconocedor de voz podría entenderlos. Por eso el texto de cada frase viaja aparte, en el mensaje `sim.say`.
> - Lo que el pasajero «oye» es la voz sintética del **proveedor simulado** del servidor (o del servidor falso de las pruebas), nunca una síntesis de voz real.
> - **No demuestra nada** sobre ElevenLabs, Anthropic/Claude, Twilio, WhatsApp ni ninguna línea telefónica. Que una llamada simulada funcione no dice nada de una llamada real.

## Requisitos

- Servidor arrancado en **modo simulado** (`CHANNEL=mock`, que es el valor por defecto): `npm run dev:server`. El WebSocket `/sim` solo acepta conexiones **desde la misma máquina**.
- Para que una llamada entrante llegue a «contestada» hace falta **un operador conectado y libre** que la coja (app de escritorio o `npm run dev:desktop`), o bien `AUTO_ACCEPT=true` en el servidor (o la preferencia equivalente del operador).
- Para `cargar-prueba` hacen falta **tres operadores** conectados y libres, uno por llamada.
- Para `escuchar` el operador tiene que **marcar** una llamada saliente desde su app.

## Comandos

```bash
npm run sim -w @tw/simulador -- <comando> [opciones]
# alias: npm run simulador -w @tw/simulador -- ...
# compilado (tras npm run build): node tools/simulador/dist/cli.js <comando> [opciones]
```

| Comando | Qué hace |
| --- | --- |
| `llamar --desde +447700900123 --idioma en [--guion <ruta o nombre>] [--espera 60]` | Llamada **entrante**: anuncia la llamada, espera a que un operador la conteste, recita el guion (respetando pausas y esperando la respuesta traducida cuando el guion lo pide) y cuelga al final. Sin `--guion`, la llamada queda abierta hasta que el operador cuelgue, se ejecute `colgar` o se pulse Ctrl+C. `--desde` e `--idioma` pueden venir del guion. |
| `escuchar --idioma pt [--guion <ruta>] [--contestar-tras 1500] [--colgar-al-terminar] [--repetir] [--espera <s>]` | Teléfono **libre**: contesta la próxima llamada **saliente** que marque un operador (tras sonar `--contestar-tras` ms), recita el guion si lo hay y sigue al teléfono hasta que el operador cuelgue (o cuelga él con `--colgar-al-terminar`). Con `--repetir` vuelve a quedar libre después de cada llamada. |
| `colgar [--numero +44...]` | Cuelga los teléfonos simulados en marcha **en este equipo** (todos, o solo los de ese número). |
| `cargar-prueba [--sin-cuarta] [--espera 60]` | **3 llamadas a la vez** desde 3 teléfonos con 3 guiones distintos (inglés, francés, italiano); comprueba que las 3 llegan a activa y, después, que una **4.ª** llamada es rechazada por el servidor. Falla si alguna no llega a activa o si la 4.ª se acepta. |
| `escenarios` | Lista los guiones incluidos. |

Opciones comunes: `--servidor ws://127.0.0.1:8787` (también la variable `TW_SIM_SERVIDOR`; la ruta `/sim` se añade sola), `--sin-hora` (sin marca de tiempo por línea), `--velocidad N` (divide las esperas; **solo para pruebas** contra un servidor acelerado: el servidor real reproduce el audio en tiempo real), `--ayuda`.

`--guion` admite una ruta (relativa a la carpeta desde la que se lanzó `npm run`, gracias a `INIT_CWD`) o el nombre de un escenario incluido (`--guion ingles-vuelo-cancelado`).

Ejemplos:

```bash
npm run sim -w @tw/simulador -- llamar --guion tools/simulador/escenarios/ingles-vuelo-cancelado.json
npm run sim -w @tw/simulador -- llamar --desde +34600000000 --idioma de --guion mi-guion.json --servidor ws://127.0.0.1:8787
npm run sim -w @tw/simulador -- escuchar --idioma pt --guion cambio-de-idioma
npm run sim -w @tw/simulador -- colgar
npm run sim -w @tw/simulador -- cargar-prueba
```

Códigos de salida: `0` bien; `1` argumentos o guion incorrectos; `2` llamada rechazada o sin contestar, o prueba de carga fallida; `3` no se pudo conectar con el servidor; `130` interrumpido con Ctrl+C (antes de salir envía `sim.hangup`).

### Qué imprime

Cada línea lleva la hora y el teléfono al que pertenece. Ejemplo de `llamar` con guion:

```
[12:00:01.004] [+447700900123] Conectado al simulador del servidor (ws://127.0.0.1:8787/sim). Todo lo que ocurre aquí es simulado.
[12:00:01.005] [+447700900123] Llama desde +447700900123 hablando Inglés con el guion «Vuelo cancelado: pide hotel (inglés)».
[12:00:01.009] [+447700900123] Suena en el servidor: llamada entrante desde +447700900123 (Inglés), esperando a un operador.
[12:00:03.120] [+447700900123] Contestada: un operador ha cogido la llamada 3f9a1c2e.
[12:00:03.121] [+447700900123] Guion «Vuelo cancelado: pide hotel (inglés)»: 5 líneas.
[12:00:03.121] [+447700900123] Guarda silencio 1,5 s antes de la línea 1 (ondas del pasajero planas).
[12:00:04.622] [+447700900123] Dice (Inglés): «Hello, good evening. I'm calling because my connecting flight to Manchester has just been cancelled.»
[12:00:11.300] [+447700900123] Espera a oír la respuesta traducida del operador...
[12:00:15.812] [+447700900123] Oye audio de 3840 ms (voz traducida del operador, sintética, 192 tramas)
...
[12:00:52.000] [+447700900123] Fin del guion: cuelga.
[12:00:52.004] [+447700900123] Colgada: el pasajero colgó (duró 48,9 s).
[12:00:52.004] [+447700900123] Resumen: contestada; dijo 5 líneas; oyó 15,1 s de audio sintético en 4 ráfagas; terminó porque el pasajero colgó.
```

«Oye audio de N ms» agrupa las tramas de audio que llegan seguidas (huecos menores de 600 ms) en una sola ráfaga; mide la duración del audio PCM recibido, no el tiempo de reloj.

## Formato de guion (JSON)

```json
{
  "nombre": "Vuelo cancelado: pide hotel (inglés)",
  "descripcion": "Texto libre",
  "desde": "+447700900123",
  "idioma": "en",
  "esperaRespuestaMs": 20000,
  "lineas": [
    { "texto": "Hello, my connecting flight has just been cancelled.", "idioma": "en", "pausaMs": 1500, "esperarRespuesta": true },
    { "texto": "Thank you, goodbye.", "pausaMs": 800 }
  ]
}
```

| Campo | Obligatorio | Significado |
| --- | --- | --- |
| `lineas[].texto` | sí | Lo que dice el pasajero (1 a 2000 caracteres). El servidor sintetiza un audio de duración proporcional. |
| `lineas[].idioma` | si el guion no tiene `idioma` | Idioma de la línea (código del catálogo: `en`, `fr`, `it`, `pt`, `de`...; se aceptan variantes como `pt-BR`). Cambiar de idioma entre líneas simula a un pasajero que cambia de idioma en directo. |
| `lineas[].pausaMs` | no (0) | Silencio **antes** de decir la línea, en ms. Mientras tanto el teléfono simulado emite silencio digital: las ondas del pasajero deben quedar planas. |
| `lineas[].esperarRespuesta` | no (false) | Tras decir la línea, espera a oír la respuesta traducida del operador (una ráfaga de audio) antes de seguir. Si no llega en `esperaRespuestaMs`, lo avisa y continúa. |
| `nombre`, `descripcion` | no | Informativos. Sin `nombre` se usa el nombre del archivo. |
| `desde` | no | Número que llama por defecto para `llamar` (si no se pasa `--desde`). |
| `idioma` | no | Idioma por defecto de las líneas y de `--idioma`. |
| `esperaRespuestaMs` | no (20000) | Tiempo máximo de `esperarRespuesta`. |

Las claves desconocidas y los valores fuera de rango se rechazan con un mensaje en español que indica la línea.

## Escenarios incluidos (`escenarios/`)

| Archivo | Idioma | Situación |
| --- | --- | --- |
| `ingles-vuelo-cancelado.json` | inglés | Vuelo de conexión cancelado; pide hotel para esta noche y cómo llegar. |
| `frances-traslado.json` | francés | Acaba de aterrizar y no encuentra el conductor de su traslado. |
| `italiano-reclamacion.json` | italiano | Reclama un cobro duplicado del equipaje y pide el reembolso. |
| `cambio-de-idioma.json` | portugués → inglés | Empieza en portugués, pasa al inglés a mitad de llamada, dice **tres líneas muy cortas seguidas** («Ok.», «Yes, yes.», «Hm, right.») y guarda **un silencio de 9 s** antes de la penúltima línea. |

Sobre `cambio-de-idioma.json`: las líneas cortas tienen menos de 3 palabras y de 12 caracteres, que es el umbral de «evidencia suficiente» del control de idiomas (`DEFAULT_LANGUAGE_CONTROLLER_CONFIG` en `@tw/pipeline`); están pensadas para provocar el aviso «idioma incierto», pero que aparezca depende de las reglas del pipeline (racha de segmentos débiles) y de los proveedores que haya detrás, así que no está garantizado. El silencio largo sirve para ver las ondas planas.

## Cómo funciona `colgar`

Cada proceso de `llamar`, `escuchar` o `cargar-prueba` abre un pequeño canal de control en `127.0.0.1` (puerto aleatorio) y se registra en un archivo JSON (PID, puerto y un token aleatorio) dentro de la carpeta de control: `telecomway-simulador` en la carpeta temporal del sistema, o la que indique la variable `TW_SIM_CONTROL_DIR`. `colgar` lee esos archivos, envía la orden a cada proceso (que responde con `sim.hangup` al servidor) y borra los registros de procesos que ya no existen. Funciona igual en Windows y en Mac porque no usa señales del sistema; si un proceso muere sin limpiar, su registro se olvida en el siguiente `colgar`. Al cerrar la conexión `/sim` por cualquier otra vía (Ctrl+C dos veces, cierre del terminal) el servidor también da la llamada por colgada por el pasajero.

## Limitaciones (honestas)

- El simulador **nunca envía audio propio**: deja que el servidor sintetice la señal de cada `sim.say`. El protocolo permitiría adjuntarlo, pero un mensaje de control no puede pasar de 64 KiB (menos de 2 s de PCM), así que no tendría sentido.
- Cuando el servidor rechaza una llamada, el teléfono simulado recibe siempre el motivo `rejected`: **no puede distinguir** «todas las líneas ocupadas» de «ningún operador libre». El historial del servidor sí guarda el motivo exacto (`busy` o `no_answer`).
- Si no hay operador libre, el servidor rechaza la llamada **en el acto** (no la deja sonando). `cargar-prueba` lo explica cuando alguna de las tres no llega a activa.
- `--velocidad` acelera solo las esperas del simulador; el servidor real sigue reproduciendo el audio en tiempo real, así que con velocidades altas las frases se acumulan en la cola del teléfono simulado.
- No se ha ejecutado en Windows ni en Mac en este entorno; el código solo usa `net`, `fs` y `os.tmpdir()` de Node, que son portables.

## Pruebas

```bash
npx vitest run            # desde tools/simulador (75 pruebas)
npm run typecheck -w @tw/simulador
```

Además de las pruebas automáticas, la CLI compilada se ejecutó **una vez a mano** contra el servidor real de este repositorio en modo simulado (`PROVIDERS=mock`, `CHANNEL=mock`, `AUTO_ACCEPT=true`, tres operadores conectados por `/operator` que respondían a cada frase con `debug.say`): `llamar --guion frances-traslado` terminó con código 0 oyendo tres respuestas traducidas sintéticas; `cargar-prueba` dio «3 de 3 llamadas activas a la vez; llamada 4: rechazada (correcto)» con código 0 (el servidor registró «Llamada rechazada: todas las líneas ocupadas»); y `colgar` desde otro proceso colgó una llamada abierta sin guion (código 0). Esa ejecución no forma parte de `npm test` y, como todo lo demás, solo prueba el camino simulado.

La lógica (cliente de `/sim`, intérprete de guiones, canal de control, los cuatro comandos y la CLI) está separada de `src/cli.ts` y se prueba con vitest contra un **servidor WebSocket falso local** (`src/testing/fake-sim-server.ts`) que imita `/sim`: valida los mensajes con el mismo esquema zod de `@tw/shared`, responde `ended/failed` a operaciones no permitidas, rechaza las llamadas que superan el límite igual que el servidor real y, tras cada `sim.say`, devuelve audio sintético troceado como si el operador contestara. Ese servidor falso **no tiene pipeline**: no transcribe, no traduce ni detecta idiomas; solo sirve para probar el simulador.

Estructura de `src/`: `sim-client.ts` (WebSocket `/sim`, validación con `@tw/shared`, ráfagas de audio oído), `script.ts` (formato y carga de guiones), `script-runner.ts` (intérprete), `control.ts` (canal local para `colgar`), `commands.ts` (`llamar`, `escuchar`, `colgar`, `cargarPrueba`), `args.ts` y `cli-main.ts` (CLI probable sin procesos), `cli.ts` (entrada, Ctrl+C), `output.ts` (textos en español), `testing/fake-sim-server.ts`.
