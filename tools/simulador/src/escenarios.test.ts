import { join } from 'node:path';
import { SimClientMessageSchema, speechSignalDurationMs } from '@tw/shared';
import { describe, expect, it } from 'vitest';
import { BUNDLED_SCENARIOS_DIR, loadScript } from './script.js';

const names = ['ingles-vuelo-cancelado', 'frances-traslado', 'italiano-reclamacion', 'cambio-de-idioma'] as const;

describe('bundled scenarios', () => {
  it.each(names)('%s is a valid script whose caller number the protocol accepts', async (name) => {
    const script = await loadScript(join(BUNDLED_SCENARIOS_DIR, `${name}.json`));
    expect(script.lineas.length).toBeGreaterThanOrEqual(4);
    expect(script.desde).toBeDefined();
    expect(script.idioma).toBeDefined();
    const incoming = SimClientMessageSchema.safeParse({ type: 'sim.incoming', from: script.desde, lang: script.idioma });
    expect(incoming.success).toBe(true);
    for (const line of script.lineas) {
      expect(SimClientMessageSchema.safeParse({ type: 'sim.say', text: line.texto, lang: line.idioma }).success).toBe(true);
      expect(speechSignalDurationMs(line.texto)).toBeGreaterThan(0);
    }
    expect(script.lineas.some((line) => line.esperarRespuesta)).toBe(true);
  });

  it('the three load-test scenarios speak three different languages about different problems', async () => {
    const [en, fr, it] = await Promise.all(
      ['ingles-vuelo-cancelado', 'frances-traslado', 'italiano-reclamacion'].map((name) => loadScript(join(BUNDLED_SCENARIOS_DIR, `${name}.json`))),
    );
    expect([en!.idioma, fr!.idioma, it!.idioma]).toEqual(['en', 'fr', 'it']);
    expect(en!.lineas.map((line) => line.texto).join(' ')).toMatch(/hotel/i);
    expect(fr!.lineas.map((line) => line.texto).join(' ')).toMatch(/transfert/i);
    expect(it!.lineas.map((line) => line.texto).join(' ')).toMatch(/addebit|rimborso/i);
    expect(new Set([en!.desde, fr!.desde, it!.desde]).size).toBe(3);
  });

  it('cambio-de-idioma starts in Portuguese, switches to English, has weak-evidence lines and a long silence', async () => {
    const script = await loadScript(join(BUNDLED_SCENARIOS_DIR, 'cambio-de-idioma.json'));
    const langs = script.lineas.map((line) => line.idioma);
    expect(langs[0]).toBe('pt');
    expect(langs.at(-1)).toBe('en');
    const firstEnglish = langs.indexOf('en');
    expect(firstEnglish).toBeGreaterThan(0);
    expect(langs.slice(0, firstEnglish).every((lang) => lang === 'pt')).toBe(true);
    expect(langs.slice(firstEnglish).every((lang) => lang === 'en')).toBe(true);
    // Weak evidence for the language controller: fewer than 3 words and fewer than 12 characters, three in a row.
    const weak = script.lineas.map((line) => line.texto.split(/\s+/).length < 3 && line.texto.trim().length < 12);
    expect(weak.join('')).toContain('truetruetrue');
    expect(Math.max(...script.lineas.map((line) => line.pausaMs))).toBeGreaterThanOrEqual(5000);
  });
});
