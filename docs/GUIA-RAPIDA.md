# Guía rápida: Telecomway Traductor

Para el operador que atiende pasajeros extranjeros por WhatsApp en su ordenador. Tú hablas en español; el pasajero
te oye en su idioma y tú le oyes en español.

## Lo que necesitas (una sola vez)

- La app **Telecomway Traductor** instalada (Mac o Windows).
- **WhatsApp Desktop** instalado y con tu cuenta abierta.
- **Auriculares** (con altavoces, la traducción vuelve a entrar por el micrófono).
- Una **clave de ElevenLabs** (elevenlabs.io > Developers > API Keys) y una **clave de Anthropic**
  (console.anthropic.com > API Keys, con saldo).
- Dos **cables de audio virtuales** gratuitos:
  - Mac: **BlackHole 2ch** y **BlackHole 16ch** (existential.audio/blackhole).
  - Windows: **VB-CABLE** y **VB-CABLE A+B** (vb-audio.com/Cable).

## Primera vez: 3 pasos (la pantalla de inicio te los marca)

1. **Claves.** Ajustes > Claves: pega las dos claves, pulsa «Guardar» y luego «Probar conexión» en cada una.
2. **Cables.** Instala los dos cables y reinicia si te lo pide. Después:

   | Dónde | Qué eliges | Mac | Windows |
   | --- | --- | --- | --- |
   | WhatsApp > Ajustes > Llamadas | Altavoz | BlackHole 2ch | CABLE Input |
   | WhatsApp > Ajustes > Llamadas | Micrófono | BlackHole 16ch | CABLE-A Output |
   | Telecomway > Ajustes > Audio y WhatsApp | Voz de WhatsApp (cable A) | BlackHole 2ch | CABLE Output |
   | Telecomway > Ajustes > Audio y WhatsApp | Hacia el micrófono de WhatsApp (cable B) | BlackHole 16ch | CABLE-A Input |
   | Telecomway > Ajustes > Audio y WhatsApp | Micrófono y auriculares | Los tuyos de siempre | Los tuyos de siempre |

3. **Entrada automática.** Déjala activada (interruptor de la tarjeta azul de inicio).

Cuando los tres pasos están hechos, la pantalla de inicio dice «Todo listo» y la tarjeta azul dice
«Esperando llamadas de WhatsApp».

**Prueba la primera vez** con una llamada corta a alguien de confianza: comprueba que te oye traducido y que tú le oyes.

## Cada día

1. Abre Telecomway Traductor y WhatsApp.
2. Contesta (o llama) en WhatsApp como siempre. En cuanto suena o alguien habla, **la llamada entra sola** en
   Telecomway y empieza a traducir.
3. Habla con normalidad por tu micrófono. Verás dos ondas: **Pasajero** (azul) y **Operador** (naranja), con lo que
   dice cada uno y su traducción.
4. Cuelga en WhatsApp. La traducción se cierra sola tras unos segundos de silencio (verás un aviso de 10 s con el
   botón «Sigo en la llamada» por si el pasajero solo estaba callado). También puedes pulsar «Terminar traducción».

## Si algo falla

- **«Plan B activo»** en la llamada: ElevenLabs o la traducción no responden. La app lee la traducción con la voz
  del ordenador, o, si no se puede traducir, os oís con la voz original (sin traducir). Vuelve sola cuando el servicio
  responde. Puedes cambiarlo en Ajustes > Voz y plan B.
- **La tarjeta dice «Falta conectar WhatsApp» o «Revisa los cables»**: revisa la tabla de arriba.
- **La barra de arriba dice «Traducción: Faltan claves» o «Revisa tus claves»**: Ajustes > Claves > «Probar conexión».
- **El pasajero no te oye**: en WhatsApp, el micrófono debe ser el cable B.
- **No oyes al pasajero**: en WhatsApp, el altavoz debe ser el cable A, y en Telecomway «Voz de WhatsApp» el cable A.
- **Oyes eco o frases repetidas**: usa auriculares y comprueba que el cable A solo lleva el sonido de WhatsApp.
- **Para ver cómo funciona sin llamar a nadie**: «Recibir llamada de prueba» en el inicio (simulada, no gasta saldo).
