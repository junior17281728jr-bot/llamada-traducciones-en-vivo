# Telecomway: llamadas con traducción de voz en vivo

Software de escritorio (Windows y Mac) para llamadas **entrantes y salientes** con traducción de voz en ambos sentidos. Los operadores hablan español; los pasajeros hablan inglés, francés, italiano, portugués y otros idiomas. Hasta 3 operadores y 3 llamadas a la vez, todos con el mismo número.

La idea central: **si llaman, la llamada entra al software y ya funciona.** Una llamada entrante se asigna sola a un operador libre, suena en su programa, se contesta (o se contesta sola) y la transcripción y la traducción arrancan solas, detectando el idioma del pasajero, sin configurar nada por llamada. En las salientes, el operador marca un número y elige el idioma del pasajero (o deja la detección automática).

La pantalla de llamada muestra dos ondas de audio en tiempo real, «Pasajero» (azul) y «Operador» (naranja), con el estado de cada sentido (recibiendo voz, transcribiendo, traduciendo, reproduciendo traducción) y, debajo, el texto original y su traducción.

## Estado

**Fase Base: esqueleto y contratos.** Existen los tipos, el protocolo, el audio y los idiomas compartidos (con pruebas), la estructura del monorepo y los puntos de unión de la interfaz. El servidor, los proveedores de voz/traducción, el simulador de pasajeros y las pantallas están **por implementar**.

**Nada de lo que hay aquí se ha probado contra ElevenLabs, Anthropic, Twilio, Meta ni una llamada real.** Todo lo que dependa de esos servicios se prueba contra servidores simulados locales y la interfaz lo etiqueta como **«Simulado»**. El detalle de lo probado, lo no verificado y lo pendiente está en [`docs/ESTADO.md`](docs/ESTADO.md).

## Requisitos

- Node 22 y npm 10.
- Para ejecutar la app Electron hace falta el binario de Electron (no se descarga durante la instalación en este entorno). La interfaz se puede ver y probar en un navegador con Vite.

## Comandos

```bash
npm install                 # instala todos los workspaces (ELECTRON_SKIP_BINARY_DOWNLOAD=1 PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 si no quieres binarios)
npm run build               # compila paquetes, proceso principal de Electron y la interfaz (Vite)
npm run typecheck           # TypeScript estricto en todos los workspaces
npm test                    # vitest run (no interactivo)
npm run dev:server          # servidor (aún no implementado)
npm run dev:desktop         # interfaz en el navegador con Vite: http://127.0.0.1:5173
npm run test:e2e -w @tw/desktop   # pruebas de navegador (Chromium de PLAYWRIGHT_BROWSERS_PATH)
```

Copia `.env.example` a `.env` para configurar el servidor. Las claves de ElevenLabs y Anthropic se pueden guardar desde Ajustes (cifradas en reposo); nunca van en el código ni en git.

## Estructura

| Carpeta | Paquete | Contenido |
| --- | --- | --- |
| `packages/shared` | `@tw/shared` | Tipos, protocolo del operador, audio (PCM, remuestreo, G.711, envolventes de onda), idiomas e interfaces |
| `packages/pipeline` | `@tw/pipeline` | Voz a texto, traducción, voz, ElevenLabs, control de idiomas y proveedores simulados |
| `packages/server` | `@tw/server` | Servidor puente: llamadas, operadores por WebSocket, ajustes, claves, historial, grabaciones |
| `apps/desktop` | `@tw/desktop` | App de escritorio: `src/main` y `src/preload` (Electron), `src/renderer` (React + Vite) |
| `tools/simulador` | `@tw/simulador` | CLI que simula pasajeros que llaman |

## Documentación

- [`docs/ARQUITECTURA.md`](docs/ARQUITECTURA.md): flujo de la llamada, decisiones y reparto de trabajo.
- [`docs/ESTADO.md`](docs/ESTADO.md): probado contra simuladores, sin verificar contra servicios reales y pendiente.
- [`docs/CANALES.md`](docs/CANALES.md): la interfaz `CallChannel` y cómo conectar WhatsApp u otros canales de audio.
