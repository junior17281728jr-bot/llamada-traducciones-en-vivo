import {
  normalizeLanguageCode,
  type AbortSignalLike,
  type TextTranslator,
  type TranslateRequest,
  type TranslateResult,
} from '@tw/shared';

/** Words that mostly belong to one language; enough to tell the demo phrases apart. Not a real detector. */
const MARKERS: Record<string, readonly string[]> = {
  en: ['the', 'and', 'is', 'my', 'i', 'need', 'was', 'to', 'you', 'hello', 'thanks', 'flight', 'hotel', 'please', 'where', 'what', 'have', 'been', 'charged'],
  es: ['el', 'los', 'las', 'que', 'y', 'en', 'voy', 'mi', 'para', 'por', 'con', 'necesito', 'hola', 'gracias', 'vuelo', 'buenos', 'dias', 'días', 'usted', 'comprobar'],
  fr: ['le', 'les', 'des', 'est', 'je', 'vous', 'mon', 'ma', 'pour', 'et', 'dans', 'bonjour', 'merci', 'où', 'mon', 'navette', 'voudrais', 'savoir'],
  it: ['il', 'che', 'di', 'per', 'sono', 'mio', 'mia', 'non', 'ho', 'vorrei', 'buongiorno', 'grazie', 'volo', 'addebito', 'ricevuto', 'pagato'],
  pt: ['os', 'um', 'uma', 'para', 'com', 'meu', 'minha', 'não', 'obrigado', 'olá', 'estou', 'preciso', 'voo', 'você', 'bom', 'dia'],
};

/** Crude language guess from marker words, for the SIMULATED translator only. Null when nothing matches. */
export function guessLanguage(text: string): string | null {
  const words = text.toLowerCase().split(/[^\p{L}]+/u).filter(Boolean);
  let best: string | null = null;
  let bestScore = 0;
  for (const [lang, markers] of Object.entries(MARKERS)) {
    const score = words.filter((word) => markers.includes(word)).length;
    if (score > bestScore) {
      best = lang;
      bestScore = score;
    }
  }
  return best;
}

const normalizePhrase = (text: string): string => text.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, '').replace(/\s+/g, ' ').trim();

const PHRASES: Record<string, string> = {
  'es|my flight was cancelled and i need a hotel': 'Mi vuelo fue cancelado y necesito un hotel.',
  'es|hello': 'Hola.',
  'en|voy a comprobar las opciones de alojamiento disponibles': 'I will check the available accommodation options.',
  'en|buenos días le atiende telecomway': 'Good morning, you are speaking with Telecomway.',
  'pt|voy a comprobar las opciones de alojamiento disponibles': 'Vou verificar as opções de alojamento disponíveis.',
  'fr|voy a comprobar las opciones de alojamiento disponibles': "Je vais vérifier les options d'hébergement disponibles.",
  'it|voy a comprobar las opciones de alojamiento disponibles': 'Verificherò le opzioni di alloggio disponibili.',
};

export interface MockTranslatorOptions {
  /** Simulated delay per call. */
  latencyMs?: number;
  /** Replaces the heuristic that fills `detectedFrom`. Return null for "cannot tell". */
  detect?: (text: string) => string | null;
  /** Makes a call fail, to test error paths. */
  failWhen?: (request: TranslateRequest) => boolean;
}

/** SIMULATED translator: a few known phrases, otherwise "[origen>destino] texto". Never contacts a service. */
export class MockTextTranslator implements TextTranslator {
  readonly simulated = true;
  readonly calls: TranslateRequest[] = [];

  constructor(private readonly options: MockTranslatorOptions = {}) {}

  async translate(request: TranslateRequest, options?: { signal?: AbortSignalLike }): Promise<TranslateResult> {
    this.calls.push(request);
    if (this.options.latencyMs) await delay(this.options.latencyMs, options?.signal);
    if (options?.signal?.aborted) throw new Error('Traducción cancelada');
    if (this.options.failWhen?.(request)) throw new Error('Fallo simulado del traductor');

    const to = normalizeLanguageCode(request.to) ?? request.to;
    const detected = (this.options.detect ?? guessLanguage)(request.text);
    const known = PHRASES[`${to}|${normalizePhrase(request.text)}`];
    const from = normalizeLanguageCode(request.from) ?? detected ?? '?';
    // Like the real prompt: a phrase already in the target language comes back unchanged.
    const text = known ?? (from === to ? request.text : `[${from}>${to}] ${request.text}`);
    return detected ? { text, detectedFrom: detected } : { text };
  }
}

function delay(ms: number, signal?: AbortSignalLike): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done(): void {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }
    function onAbort(): void {
      clearTimeout(timer);
      done();
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
