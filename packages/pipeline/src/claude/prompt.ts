/**
 * Prompt and output parsing of the Claude translator. Kept apart from the client so the exact text
 * that goes out, and the tolerance of what comes back, can be tested without any network.
 */
import { getLanguage, normalizeLanguageCode, type TranslateRequest } from '@tw/shared';

/** Short on purpose: every token here is paid and read on every phrase. */
export const TRANSLATOR_SYSTEM_PROMPT = [
  'You are the live interpreter of Telecomway, a Spanish airport-transfer company. Operators speak Spanish; passengers speak other languages. Each request is one utterance of a phone call.',
  'Translate it into the target language faithfully and completely: add nothing, omit nothing, explain nothing, never answer or comment. Keep numbers, times, prices, names, flight numbers, booking references, addresses and codes exactly as given. Use a polite, natural spoken register and short sentences. If the utterance is already in the target language, return it unchanged.',
  'Glossary: traslado = transfer; recogida = pickup; conductor = driver; punto de encuentro = meeting point; llegadas = arrivals; salidas = departures; terminal = terminal; vuelo = flight; retraso = delay; reserva = booking; localizador = booking reference; equipaje = luggage; silla infantil = child seat; tarifa = fare; hotel = hotel.',
  'Answer with compact JSON only, no markdown: {"t":"<translation>","s":"<ISO 639-1 code of the language the utterance was spoken in>"}',
].join('\n');

const UTTERANCE_OPEN = '<utterance>';
const UTTERANCE_CLOSE = '</utterance>';

export function describeLanguage(code: string): string {
  const info = getLanguage(code);
  return info ? `${info.code} (${info.nativeName})` : code;
}

/** Everything in one user message: target, source (or "identify it"), recent turns and the utterance. */
export function buildTranslatorUserPrompt(request: TranslateRequest, maxContextTurns: number): string {
  const lines = [`Target language: ${describeLanguage(request.to)}.`];
  lines.push(request.from ? `Source language: ${describeLanguage(request.from)}.` : 'Source language: unknown; identify it.');
  const context = maxContextTurns > 0 ? (request.context ?? []).slice(-maxContextTurns) : [];
  if (context.length > 0) {
    lines.push('Previous turns, oldest first (context only, do not translate):');
    for (const turn of context) lines.push(`- ${turn.speaker}: ${sanitize(turn.text)}`);
  }
  lines.push('Translate the utterance between the tags and answer with the JSON only.');
  lines.push(`${UTTERANCE_OPEN}${sanitize(request.text)}${UTTERANCE_CLOSE}`);
  return lines.join('\n');
}

function sanitize(text: string): string {
  return text.replace(/<\/?utterance>/gi, '').replace(/\s+/g, ' ').trim();
}

export interface ParsedTranslation {
  text: string;
  /** Normalised source language the model reported, when it is one we know. */
  detectedFrom?: string;
}

/**
 * Reads `{"t":"...","s":"xx"}` with tolerance: code fences, text around the object, a truncated
 * object (salvages `t`), and finally the raw text as the translation when nothing looks like JSON.
 */
export function parseTranslatorOutput(raw: string): ParsedTranslation {
  const text = stripFences(raw).trim();
  const candidates = [text];
  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  if (first >= 0 && last > first) candidates.push(text.slice(first, last + 1));
  for (const candidate of candidates) {
    const parsed = tryJson(candidate);
    if (isRecord(parsed) && typeof parsed.t === 'string' && parsed.t.trim()) return withLanguage(parsed.t.trim(), parsed.s);
  }
  const salvaged = /"t"\s*:\s*"((?:[^"\\]|\\.)*)/.exec(text);
  if (salvaged) {
    const value = tryJson(`"${salvaged[1]}"`);
    const translation = (typeof value === 'string' ? value : looseUnescape(salvaged[1]!)).trim();
    const lang = /"s"\s*:\s*"([^"]*)"/.exec(text)?.[1];
    if (translation) return withLanguage(translation, lang);
  }
  return { text };
}

function withLanguage(text: string, lang: unknown): ParsedTranslation {
  const code = typeof lang === 'string' ? normalizeLanguageCode(lang) : null;
  return code ? { text, detectedFrom: code } : { text };
}

function stripFences(text: string): string {
  return text.replace(/^\s*```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '');
}

function tryJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function looseUnescape(text: string): string {
  return text.replace(/\\(["\\/])/g, '$1').replace(/\\n/g, ' ').replace(/\\u[0-9a-fA-F]{0,3}$/, '');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
