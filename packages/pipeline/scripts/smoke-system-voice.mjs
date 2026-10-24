// Prueba REAL de la voz del ordenador (plan B) en el Mac o Windows donde se ejecuta: lista las voces y
// sintetiza una frase en español y otra en inglés. Falla si ninguna de las dos produce sonido.
// Uso (después de `npm run build`): node packages/pipeline/scripts/smoke-system-voice.mjs
import { createSystemVoiceEngine } from '@tw/pipeline';
import { pcm16Rms } from '@tw/shared';

const engine = createSystemVoiceEngine();
console.log(`Plataforma: ${process.platform} -> motor ${engine.platform}`);
if (engine.platform === 'none') {
  console.log('Este sistema no tiene voz del ordenador; nada que probar.');
  process.exit(0);
}
let worked = 0;
try {
  const voices = await engine.voices();
  console.log(`Voces instaladas: ${voices.length}`);
  for (const voice of voices.slice(0, 40)) console.log(`  - ${voice.locale}  ${voice.name}`);
  for (const [lang, text] of [
    ['es', '¿Hola, en qué puedo ayudarle? Su vuelo sale a las ocho.'],
    ['en', 'Hello, how can I help you? Your flight leaves at eight.'],
  ]) {
    const started = Date.now();
    try {
      const pcm = await engine.synthesize(text, lang);
      const seconds = pcm.byteLength / 32000;
      const rms = pcm16Rms(pcm);
      console.log(`[${lang}] ${seconds.toFixed(2)} s de audio, nivel ${rms.toFixed(4)}, en ${Date.now() - started} ms`);
      if (seconds > 0.5 && rms > 0.001) worked += 1;
    } catch (error) {
      console.log(`[${lang}] sin voz: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
} finally {
  await engine.close();
}
if (worked === 0) {
  console.error('La voz del ordenador no produjo sonido en ningún idioma.');
  process.exit(1);
}
console.log(`La voz del ordenador funciona (${worked} de 2 idiomas).`);
