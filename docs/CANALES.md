# Canales de llamada

Un **canal** es lo que entrega y recibe las llamadas: el simulador, Twilio, WhatsApp u otro canal de audio. El servidor solo conoce la interfaz `CallChannel` de `@tw/shared`; añadir un canal no toca el resto del sistema.

## Interfaz

```ts
interface CallChannel {
  readonly kind: 'mock' | 'twilio' | 'whatsapp';
  readonly simulated: boolean;                    // true => la interfaz muestra «Simulado»
  start(): Promise<void>;
  stop(): Promise<void>;
  onIncoming(handler: (call: ChannelCall) => void): Unsubscribe;
  canDial(number: string): Promise<CanDialResult>;
  dial(number: string): Promise<ChannelCall>;
}

interface ChannelCall {
  readonly id: string;
  readonly direction: 'inbound' | 'outbound';
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
| `mock` | Por implementar (fase siguiente) | Pasajeros simulados por WebSocket `/sim` (`sim.incoming`, `sim.say`, `sim.audio`, `sim.hangup`, `sim.state`). El simulador sintetiza audio real parecido a voz (duración acorde al texto) y silencio digital cuando no habla. |
| `twilio` | No implementado | Credenciales `TWILIO_ACCOUNT_SID` y `TWILIO_AUTH_TOKEN` (nombres UNVERIFIED). Sin verificar. |
| `whatsapp` | No implementado | Credenciales `META_ACCESS_TOKEN` y `META_PHONE_NUMBER_ID` (nombres UNVERIFIED). Sin verificar. |

El botón «Probar conexión» de un canal solo comprueba que la configuración esté completa; no lo marca como funcional por validar el formato de las claves.
