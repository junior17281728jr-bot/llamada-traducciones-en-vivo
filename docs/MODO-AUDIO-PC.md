# Modo audio del PC (WhatsApp sin la API de Meta)

## Qué es

El operador atiende la llamada en **WhatsApp Desktop, WhatsApp Web o cualquier otro programa** de su ordenador y Telecomway se pone en medio **solo con el audio del equipo**, mediante dos cables de audio virtuales:

- La **salida** de WhatsApp va al **cable A**; Telecomway captura el cable A como «voz del pasajero», la transcribe, la traduce y reproduce la traducción en los auriculares del operador.
- El operador habla por su **micrófono normal**; Telecomway traduce su voz y la reproduce en el **cable B**; WhatsApp usa el cable B como micrófono, así que el pasajero oye la voz traducida.

No hace falta la API de WhatsApp Business, ni número de empresa, ni permisos de Meta. Tampoco hace falta cambiar la configuración del servidor: el modo está disponible junto a cualquier canal (`CHANNEL=mock`, y en el futuro `twilio` o `whatsapp`). Con `CHANNEL=desktop-audio` el servidor arranca **sin línea telefónica**: solo este modo (no entran llamadas, el Marcador no puede llamar y el simulador `/sim` no existe).

En la pantalla de llamada una sesión de este modo aparece como **«Audio del PC»** con la etiqueta elegida (por defecto «WhatsApp»), el botón «Colgar» pasa a ser **«Terminar traducción»** y se muestra el aviso de auriculares. En el historial se guarda con dirección `local` y la etiqueta en lugar del número.

## Limitaciones honestas

- **La llamada se contesta y se cuelga en WhatsApp.** WhatsApp no avisa a otros programas, así que Telecomway la reconoce **por el sonido**: con la **entrada automática** (activada por defecto) la app escucha el cable A sin llamada y, cuando llega ~0,6 s de timbre o de voz, la llamada entra sola; cuando el cable queda en silencio el tiempo elegido (30 s por defecto), avisa 10 s y cierra la traducción. Sin entrada automática, el operador pulsa «Empezar traducción» y «Terminar traducción». La app no puede contestar ni colgar en WhatsApp por el operador.
- **Este modo no está probado todavía con WhatsApp real ni con cables de audio reales.** Lo único probado es el recorrido completo con audio sintético: la app envía tramas `PassengerLocal` (0x04) por el WebSocket del operador, el servidor las mide (carril «Pasajero»), las transcribe y traduce con proveedores simulados, y la voz traducida del operador vuelve en tramas `TranslatedToPassenger` (0x05). Todo lo relativo a VB-Cable, BlackHole, la captura sin procesado y la selección de salida con `setSinkId` dentro de Electron es **UNVERIFIED**.
- **UNVERIFIED: si una cuenta de WhatsApp admite más de una llamada a la vez.** Probablemente solo una. Con tres operadores, cada uno necesita su propio ordenador, sus propios cables y, salvo que WhatsApp permita varias llamadas simultáneas por cuenta, su propia cuenta de WhatsApp. El límite de 3 llamadas simultáneas del servidor se aplica igual (una sesión local cuenta como una llamada).
- **Cada PC necesita los cables instalados y auriculares.** Con altavoces, la traducción que oye el operador vuelve a entrar por su micrófono y se traduce otra vez (eco de traducción).
- **La calidad depende de WhatsApp y de los cables.** El audio pasa por los códecs de WhatsApp, por el cable y por el remuestreo a 16 kHz; la transcripción real (cuando haya proveedores reales) puede ser peor que con una línea telefónica directa.
- **El audio del cable no se procesa** (sin cancelación de eco, sin supresión de ruido, sin control automático de ganancia): es el sonido tal cual lo entrega el otro programa. El micrófono del operador sí lleva el procesado habitual.
- **Si el servidor no admite el modo** (`auth.ok.server.localAudio` falso) la tarjeta aparece deshabilitada; si **faltan los dispositivos** en Ajustes o el equipo **no permite elegir la salida de audio** (`AudioContext.setSinkId` ausente), la sesión **no arranca** y la app lo dice en español.
- **Un solo pasajero por sesión y un solo sentido por cable.** No hay mezcla de varias llamadas en el mismo PC.

## Instalación de los cables virtuales

Cada operador instala **dos** cables (uno por sentido). Instala con permisos de administrador y reinicia si el instalador lo pide. Los nombres exactos de los dispositivos dependen del fabricante y de la versión (UNVERIFIED: tomados de la documentación pública de cada producto, no comprobados aquí).

### Windows: VB-Cable (VB-Audio)

1. Descarga **VB-CABLE Virtual Audio Device** de la web de VB-Audio e instálalo (`VBCABLE_Setup_x64.exe`, «Install Driver», reinicia). Crea el par **CABLE Input** (dispositivo de reproducción) / **CABLE Output** (dispositivo de grabación). Ese es el **cable A**.
2. Para el segundo cable, instala **VB-CABLE A+B** (donación) o **VB-CABLE C+D**: añade pares como **CABLE-A Input / CABLE-A Output**. Ese segundo par es el **cable B**. Alternativa gratuita: **Virtual Audio Cable (VAC)** o **VoiceMeeter** también crean varios cables, pero no se han probado con Telecomway.
3. En *Configuración de Windows > Sistema > Sonido*, comprueba que los cuatro dispositivos (dos Input, dos Output) aparecen y **no** los pongas como predeterminados del sistema: los predeterminados siguen siendo tu micrófono y tus auriculares.
4. En las propiedades de cada cable, fija el formato a **1 canal, 16 bits, 48000 Hz** (o 16000 Hz) y desactiva «Permitir que las aplicaciones tomen el control exclusivo».

### Mac: BlackHole (Existential Audio)

1. Hacen falta dos dispositivos BlackHole distintos (no se puede instalar el mismo dos veces): instala **BlackHole 2ch** (será el **cable A**) y **BlackHole 16ch** (será el **cable B**), con `brew install blackhole-2ch blackhole-16ch` o con los instaladores `.pkg` de la web. macOS pedirá permiso en *Ajustes del Sistema > Privacidad y seguridad* y quizá reiniciar.
2. Abre **Configuración de Audio MIDI** (`/Aplicaciones/Utilidades`) y comprueba que «BlackHole 2ch» y «BlackHole 16ch» aparecen como dispositivos de entrada y salida a la vez (cada BlackHole es entrada y salida del mismo cable).
3. Para que el operador **también** oiga el sonido de WhatsApp en sus auriculares (opcional, útil para supervisar), crea un **Dispositivo de salida múltiple** con «BlackHole 2ch» + tus auriculares y úsalo como salida de WhatsApp. Si no lo necesitas, WhatsApp saca el audio solo por BlackHole 2ch.
4. Da a WhatsApp y a Telecomway permiso de **micrófono** en *Privacidad y seguridad* (BlackHole se ve como un micrófono más).

## Configuración paso a paso del enrutado

Cuatro ajustes, dos en WhatsApp y dos en Telecomway. El micrófono y los auriculares del operador siguen siendo los normales.

| Dónde | Ajuste | Dispositivo |
| --- | --- | --- |
| WhatsApp Desktop > Ajustes > Llamadas (o Audio) | **Altavoz / salida** | **Cable A** (Windows: *CABLE Input*; Mac: *BlackHole 2ch*) |
| Telecomway > Ajustes > Audio > Modo audio del PC | **Entrada con la voz del pasajero** | **Cable A** (Windows: *CABLE Output*; Mac: *BlackHole 2ch*) |
| Telecomway > Ajustes > Audio > Modo audio del PC | **Salida hacia el micrófono del otro programa** | **Cable B** (Windows: *CABLE-A Input*; Mac: *BlackHole 16ch*) |
| WhatsApp Desktop > Ajustes > Llamadas (o Audio) | **Micrófono / entrada** | **Cable B** (Windows: *CABLE-A Output*; Mac: *BlackHole 16ch*) |
| Telecomway > Ajustes > Audio > Tu micrófono y tus auriculares | **Micrófono** | Tu micrófono real |
| Telecomway > Ajustes > Audio > Tu micrófono y tus auriculares | **Altavoz o auriculares** | Tus auriculares |

Notas:

- En Windows, cada cable VB tiene dos caras: **Input** es donde se *reproduce* (lo elige quien emite) y **Output** es donde se *captura* (lo elige quien escucha). En Mac, BlackHole usa el mismo nombre para las dos caras.
- Si WhatsApp Web (navegador) en vez de Desktop: la salida se elige en el sistema (el navegador no siempre deja elegir altavoz) y el micrófono en el selector del navegador o del sistema. Es más cómodo WhatsApp Desktop.
- Los nombres de los dispositivos solo se ven en Telecomway después de conceder el permiso del micrófono (botón «Permitir micrófono» en Ajustes > Audio).
- La tarjeta «Modo audio del PC» de la pestaña **Llamada** muestra los dos dispositivos elegidos; si falta alguno, lo dice y el botón «Empezar traducción» se deshabilita.

## Cómo probarlo

### Sin WhatsApp ni cables (lo único probado hoy)

- Pruebas automáticas: `npx vitest run` en `packages/server` (`server.test.ts`, bloque «modo audio del PC», y `call-manager.test.ts`, bloque «modo audio del PC (local calls)») y en `apps/desktop` (`call-client.test.ts`, bloque «modo audio del PC», `local-call-start.test.tsx` y `call-screen.test.tsx`). Cubren: `call.startLocal` → `call.state` activa con dirección `local`; las tramas 0x04 mueven el carril del pasajero y se transcriben (texto por `debug.say` + señal sintética); la voz traducida del operador sale en 0x05 y **nunca** en 0x02; colgar; historial con dirección `local` y etiqueta; en el cliente, captura del cable A sin procesado, reproducción de 0x05 solo en el cable B y errores claros si faltan dispositivos o `setSinkId`.
- A mano con el servidor simulado (`PROVIDERS=mock`): arranca el servidor y la app, elige en Ajustes > Audio cualquier micrófono como «Entrada con la voz del pasajero» y cualquier salida como «Salida hacia el micrófono del otro programa», pulsa «Empezar traducción» y usa la caja «Probar con voz simulada» con «Dice el pasajero»: el texto se encola y se transcribe en cuanto llega sonido por la entrada elegida (habla cerca de ese micrófono). «Dices tú» prueba el sentido operador → cable B.

### Con WhatsApp real y cables reales (pendiente, UNVERIFIED)

1. Configura el enrutado de la tabla anterior en un PC con los cables instalados.
2. Llama desde un móvil al WhatsApp del operador y contesta en WhatsApp Desktop.
3. En Telecomway, pestaña Llamada, pulsa «Empezar traducción» (etiqueta «WhatsApp», idioma del pasajero en «Detección automática» o fijo).
4. Comprueba, por este orden: el carril «Pasajero» se mueve cuando habla el móvil (si no, WhatsApp no saca el audio por el cable A o Telecomway no captura ese cable); aparece la transcripción; el operador oye la traducción en sus auriculares; el carril «Operador» se mueve al hablar; el móvil oye la voz traducida (si no, WhatsApp no usa el cable B como micrófono).
5. Anota el resultado en `docs/ESTADO.md` (qué versión de WhatsApp, qué cables, qué sistema) antes de marcar nada como funcional.

## Qué hacer si hay eco

- **El pasajero oye su propia voz traducida o doble voz**: la salida de WhatsApp (cable A) está llegando también al micrófono de WhatsApp (cable B). Revisa que WhatsApp use el cable B como micrófono y **no** el micrófono real ni «mezcla estéreo»; en Windows desactiva «Escuchar este dispositivo» en las propiedades de los cables.
- **El operador se oye a sí mismo con retraso**: el operador tiene altavoces en vez de auriculares, o eligió el cable B como «Altavoz o auriculares» en Telecomway. Usa auriculares y comprueba que la salida del operador son sus auriculares.
- **Se traduce dos veces la misma frase del pasajero**: la voz traducida que oye el operador vuelve a entrar por el cable A (WhatsApp está sacando audio por los auriculares del operador y el micrófono real lo recoge, o hay un dispositivo de salida múltiple mal montado). Deja la salida de WhatsApp solo en el cable A o baja el volumen de la voz traducida en Ajustes > Audio.
- **Se traduce la voz del operador como si fuera del pasajero**: el micrófono real del operador está también enrutado al cable A (por ejemplo, un dispositivo agregado en Mac). El cable A solo debe llevar la salida de WhatsApp.
- **El carril «Pasajero» no se mueve nunca**: WhatsApp no está sacando el audio por el cable A (cámbialo mientras la llamada está activa; algunos programas solo aplican el cambio en la siguiente llamada), o el dispositivo elegido en Telecomway es la cara equivocada del cable (en Windows, para capturar se elige *Output*).
- **Hay ruido o cortes**: iguala la frecuencia de muestreo de los cables (48000 Hz) con la del sistema y cierra programas que usen el control exclusivo del dispositivo.
