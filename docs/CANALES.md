# Canales de llamada

Un **canal** es lo que entrega y recibe las llamadas: el simulador, Twilio, WhatsApp u otro canal de audio. El servidor solo conoce la interfaz `CallChannel` de `@tw/shared`; añadir un canal no toca el resto del sistema.

## Interfaz

```ts
interface CallChannel {
  readonly kind: 'mock' | 'twilio' | 'whatsapp' | 'desktop-audio';
  readonly simulated: boolean;                    // true => la interfaz muestra «Simulado»
  start(): Promise<void>;
  stop(): Promise<void>;
  onIncoming(handler: (call: ChannelCall) => void): Unsubscribe;
  canDial(number: string): Promise<CanDialResult>;
  dial(number: string): Promise<ChannelCall>;
}

interface ChannelCall {
  readonly id: string;
  readonly direction: 'inbound' | 'outbound' | 'local';   // local = modo audio del PC
  readonly remoteNumber: string;
  readonly langHint?: string;
  answer(): Promise<void>;
  reject(): Promise<void>;
  hangup(): Promise<void>;
  sendAudio(pcm: Uint8Array): void;               // hacia el pasajero
  onAudio(handler: (pcm: Uint8Array) => void): Unsubscribe;   // desde el pasajero
  onAnswered(handler: () => void): Unsubscribe;
  onEnded(handler: (end: ChannelCallEnd) => void): Unsubscribe;
}
```

Reglas para quien implemente un canal:

1. **Audio en el formato interno**: PCM16 mono little-endian a 16 000 Hz. Convierte en el borde con `WireToInternal` / `InternalToWire` (por ejemplo `ulaw_8000` para telefonía; el formato real de cada proveedor es UNVERIFIED hasta probarlo).
2. **`onAudio` es el único punto donde se mide la onda del pasajero.** El servidor calcula los niveles ahí, igual para el canal simulado y para los reales. No calcules niveles dentro del canal.
3. **Todas las llamadas usan el mismo número de la empresa** (`COMPANY_NUMBER`).
4. `onEnded` se dispara exactamente una vez, termine quien termine la llamada.
5. `canDial` no marca: solo dice si se puede (`permission_required` para canales que exigen consentimiento previo, como las llamadas iniciadas por la empresa en WhatsApp).
6. Si el canal es simulado, `simulated` es `true`. Nunca marques como funcional un canal que no ha hablado con el servicio real.

## Canales

| Canal | Estado | Notas |
| --- | --- | --- |
| `mock` | Implementado; **simulado** (`simulated: true`, la interfaz dice «Simulado») | `packages/server/src/channel/mock-channel.ts`. Pasajeros simulados por WebSocket `/sim` (`sim.incoming`, `sim.listen`, `sim.answer`, `sim.say`, `sim.audio`, `sim.hangup`, `sim.state`), solo desde la misma máquina; la CLI `tools/simulador` lo usa. El servidor sintetiza audio parecido a voz (duración acorde al texto) y silencio digital cuando el pasajero no habla. Probado por red en `server.test.ts` y en Chromium (`apps/desktop/e2e`). |
| `twilio` | No implementado | Credenciales `TWILIO_ACCOUNT_SID` y `TWILIO_AUTH_TOKEN` (nombres UNVERIFIED). Sin verificar. |
| `whatsapp` | No implementado | Credenciales `META_ACCESS_TOKEN` y `META_PHONE_NUMBER_ID` (nombres UNVERIFIED). Sin verificar. |
| `desktop-audio` | Implementado; probado solo con audio sintético | «Modo audio del PC»: sin línea telefónica. Disponible siempre junto al canal principal; como `CHANNEL=desktop-audio` es el único canal. Ver abajo y [`MODO-AUDIO-PC.md`](MODO-AUDIO-PC.md). |

El botón «Probar conexión» de un canal solo comprueba que la configuración esté completa; no lo marca como funcional por validar el formato de las claves.

## Modo audio del PC (`desktop-audio`)

`packages/server/src/channel/desktop-audio.ts`. No es una línea: es la forma de traducir una llamada que **ya está en otro programa** del ordenador del operador (WhatsApp Desktop sin la API de Meta, o cualquier otro) usando dos cables de audio virtuales. El servidor construye siempre un `DesktopAudioChannel` y se lo pasa al `CallManager` como `localChannel`, además del canal principal; con `CHANNEL=desktop-audio` ese mismo canal es también el principal (sin entrantes, `canDial` devuelve `unsupported`, no se expone `/sim`).

Recorrido:

1. La app envía `call.startLocal {label, langHint?, languages?}`. El `CallManager` comprueba que el operador está libre y que hay línea (cuenta para el máximo de 3), crea un `DesktopAudioCall` (`direction: 'local'`, `remoteNumber` = etiqueta, `answer()` inmediato) y arranca la `CallSession` normal con los ajustes de idioma de las preferencias más `languages`.
2. La app captura el cable A **sin procesado** y lo envía en tramas `PassengerLocal` (0x04). `CallManager.pushPassengerLocalAudio` solo las acepta si la llamada actual del operador es local; `DesktopAudioCall.pushPassengerAudio` las emite por `onAudio`, que sigue siendo el único punto donde se mide el carril «Pasajero».
3. La voz traducida del operador sale por `ChannelCall.sendAudio` → `onToPassenger` → trama `TranslatedToPassenger` (0x05) al operador, que la reproduce en el cable B. Nunca va en 0x02 (la voz que oye el operador).
4. `call.hangup` termina la sesión (`hangup_operator`); el operador cuelga también en el otro programa. El historial guarda la llamada con `direction: 'local'` y la etiqueta.

`auth.ok.server.localAudio` dice a la app si el servidor admite el modo. Con proveedores simulados, `debug.say {as:'passenger'}` en una llamada local mete el texto en el `UtteranceBus` y es el audio real del cable el que marca el ritmo de la transcripción.

Limitaciones y lo no verificado (detalle en `MODO-AUDIO-PC.md`): la llamada se contesta y cuelga a mano en el otro programa; UNVERIFIED con WhatsApp real y con cables reales (VB-Cable, BlackHole); UNVERIFIED si una cuenta de WhatsApp admite más de una llamada a la vez (probablemente una); cada PC necesita sus cables y auriculares.
