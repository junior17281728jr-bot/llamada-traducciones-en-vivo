/**
 * Claude as the call translator (`TextTranslator`), through the official `@anthropic-ai/sdk`.
 *
 * Built for speed: a short cached system prompt, one compact user message with the last turns as
 * context, a small `max_tokens`, no sampling parameters, no extended thinking, a hard timeout and a
 * single retry on transient failures. The answer is `{"t":"...","s":"xx"}`; `s` is the second
 * language-detection signal of the pipeline. Any failure surfaces as a Spanish `TranslatorError`
 * and the pipeline keeps the original text on screen.
 *
 * UNVERIFIED: no call has been made to the real API from this environment. Request shapes follow the
 * installed SDK's types; the per-model speed settings follow its documentation (see `speedTuningFor`).
 */
import Anthropic, {
  APIConnectionError,
  APIConnectionTimeoutError,
  APIError,
  APIUserAbortError,
  AuthenticationError,
  BadRequestError,
  InternalServerError,
  NotFoundError,
  PermissionDeniedError,
  RateLimitError,
} from '@anthropic-ai/sdk';
import type { AbortSignalLike, Logger, TextTranslator, TranslateRequest, TranslateResult } from '@tw/shared';
import { TRANSLATOR_DEFAULT_MODEL, resolveApiKey, type ApiKeySource } from '../elevenlabs/settings.js';
import { TRANSLATOR_SYSTEM_PROMPT, buildTranslatorUserPrompt, parseTranslatorOutput } from './prompt.js';

export type TranslatorErrorKind = 'config' | 'auth' | 'refusal' | 'timeout' | 'network' | 'rate_limited' | 'server' | 'request' | 'response' | 'cancelled';

export class TranslatorError extends Error {
  readonly kind: TranslatorErrorKind;
  /** True when the same request may succeed a moment later. */
  readonly retryable: boolean;
  readonly status: number | null;

  constructor(kind: TranslatorErrorKind, message: string, options: { retryable?: boolean; status?: number | null; cause?: unknown } = {}) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'TranslatorError';
    this.kind = kind;
    this.retryable = options.retryable ?? false;
    this.status = options.status ?? null;
  }
}

export const MISSING_ANTHROPIC_KEY_MESSAGE =
  'Falta la clave de Anthropic (ANTHROPIC_API_KEY): introdúcela en Ajustes o en el entorno del servidor.';

export interface ClaudeTranslatorOptions {
  /** Resolved on every call (cheap), so a key changed in Settings applies at once. */
  getApiKey: ApiKeySource;
  /** Defaults to `claude-haiku-5-5` (`TRANSLATOR_MODEL`). */
  model?: string;
  maxTokens?: number;
  timeoutMs?: number;
  /** Retries after a transient failure (timeout, network, 429, 5xx). */
  retries?: number;
  retryDelayMs?: number;
  /** Earlier turns included as context (the pipeline already caps what it passes). */
  contextTurns?: number;
  /** Marks the system prompt as a cache breakpoint (a no-op below the model's minimum cacheable size). */
  cacheSystemPrompt?: boolean;
  /** Builds the SDK client for a key; tests inject one with a fake `fetch`. */
  createClient?: (apiKey: string) => Anthropic;
  logger?: Logger;
}

/**
 * UNVERIFIED against the live API: the fields that keep latency down per model family, taken from the
 * SDK documentation available while writing. Haiku 5.5 accepts `thinking: disabled` at effort `low`;
 * the 5.x Opus/Sonnet/Fable family rejects `disabled`, so only `effort: low` is sent; older models get
 * nothing (omitting `thinking` already means no thinking, and some reject `effort`).
 */
export function speedTuningFor(model: string): Pick<Anthropic.MessageCreateParamsNonStreaming, 'thinking' | 'output_config'> {
  if (/^claude-haiku-5-5/.test(model)) return { thinking: { type: 'disabled' }, output_config: { effort: 'low' } };
  if (/^claude-(opus|sonnet)-5-5|^claude-(fable|mythos)-5|^claude-opus-5|^claude-sonnet-5|^claude-opus-4-[678]|^claude-sonnet-4-6/.test(model)) {
    return { output_config: { effort: 'low' } };
  }
  return {};
}

/**
 * Output budget for one phrase: translations seldom exceed the original by much, so a share of its length plus a
 * margin for the JSON wrapper and longer scripts keeps every answer whole without paying for unused tokens.
 */
export function maxTokensFor(text: string, floor: number): number {
  return Math.min(2048, Math.max(floor, Math.ceil(text.length * 0.7) + 60));
}

/** Longest answer accepted for an original of `originalLength` characters; anything beyond is not a translation. */
export function maxTranslationLength(originalLength: number): number {
  return Math.max(120, originalLength * 4);
}

/** Real translator (Anthropic API). Not simulated: every `translate()` is one Messages request. */
export class ClaudeTranslator implements TextTranslator {
  readonly simulated = false;
  readonly model: string;
  private readonly maxTokens: number;
  private readonly timeoutMs: number;
  private readonly retries: number;
  private readonly retryDelayMs: number;
  private readonly contextTurns: number;
  private readonly cacheSystemPrompt: boolean;
  private readonly createClient: (apiKey: string) => Anthropic;
  private readonly logger: Logger | undefined;
  private cached: { apiKey: string; client: Anthropic } | null = null;

  constructor(private readonly options: ClaudeTranslatorOptions) {
    this.model = options.model?.trim() || TRANSLATOR_DEFAULT_MODEL;
    this.maxTokens = options.maxTokens ?? 300;
    this.timeoutMs = options.timeoutMs ?? 6000;
    this.retries = options.retries ?? 1;
    this.retryDelayMs = options.retryDelayMs ?? 250;
    this.contextTurns = options.contextTurns ?? 6;
    this.cacheSystemPrompt = options.cacheSystemPrompt ?? true;
    this.createClient = options.createClient ?? ((apiKey) => new Anthropic({ apiKey, maxRetries: 0, timeout: this.timeoutMs }));
    this.logger = options.logger;
  }

  /** Exact request body for `request`, so tests and reviewers see what goes out. */
  requestParams(request: TranslateRequest): Anthropic.MessageCreateParamsNonStreaming {
    const system: Anthropic.TextBlockParam = { type: 'text', text: TRANSLATOR_SYSTEM_PROMPT };
    if (this.cacheSystemPrompt) system.cache_control = { type: 'ephemeral' };
    return {
      model: this.model,
      max_tokens: maxTokensFor(request.text, this.maxTokens),
      system: [system],
      messages: [{ role: 'user', content: buildTranslatorUserPrompt(request, this.contextTurns) }],
      ...speedTuningFor(this.model),
    };
  }

  async translate(request: TranslateRequest, options?: { signal?: AbortSignalLike }): Promise<TranslateResult> {
    const apiKey = await resolveApiKey(this.options.getApiKey);
    if (!apiKey) throw new TranslatorError('config', MISSING_ANTHROPIC_KEY_MESSAGE);
    const client = this.clientFor(apiKey);
    const params = this.requestParams(request);
    const external = options?.signal;

    for (let attempt = 0; ; attempt++) {
      const controller = new AbortController();
      const onAbort = (): void => controller.abort();
      external?.addEventListener('abort', onAbort, { once: true });
      if (external?.aborted) controller.abort();
      const timer = setTimeout(onAbort, this.timeoutMs);
      const started = Date.now();
      try {
        const message = await client.messages.create(params, { signal: controller.signal, timeout: this.timeoutMs, maxRetries: 0 });
        this.logger?.debug('Traducción completada', {
          model: message.model,
          ms: Date.now() - started,
          inputTokens: message.usage.input_tokens,
          outputTokens: message.usage.output_tokens,
          cacheRead: message.usage.cache_read_input_tokens,
        });
        return this.interpret(message, request.text);
      } catch (error) {
        const failure = this.mapError(error, external?.aborted ?? false);
        if (!failure.retryable || attempt >= this.retries) throw failure;
        this.logger?.warn('Fallo transitorio del traductor; se reintenta', { kind: failure.kind, message: failure.message });
        await new Promise((resolve) => setTimeout(resolve, this.retryDelayMs));
      } finally {
        clearTimeout(timer);
        external?.removeEventListener('abort', onAbort);
      }
    }
  }

  private clientFor(apiKey: string): Anthropic {
    if (this.cached?.apiKey === apiKey) return this.cached.client;
    const client = this.createClient(apiKey);
    this.cached = { apiKey, client };
    return client;
  }

  private interpret(message: Anthropic.Message, original: string): TranslateResult {
    if (message.stop_reason === 'refusal') {
      const why = message.stop_details?.explanation;
      throw new TranslatorError('refusal', `El traductor rechazó esta frase${why ? ` (${why})` : ''}; se mantiene el texto original.`);
    }
    // A cut answer must never be spoken as if it were the whole phrase.
    if (message.stop_reason === 'max_tokens') {
      throw new TranslatorError('response', 'La traducción se cortó antes de terminar (límite de tokens); se mantiene el texto original.');
    }
    const text = message.content
      .filter((block): block is Anthropic.TextBlock => block.type === 'text')
      .map((block) => block.text)
      .join('')
      .trim();
    if (!text) throw new TranslatorError('response', 'El traductor devolvió una respuesta vacía.');
    const parsed = parseTranslatorOutput(text);
    if (!parsed.text) throw new TranslatorError('response', 'El traductor devolvió una respuesta vacía.');
    // Minimal guard against an answer that is not a translation (e.g. the model followed instructions hidden in
    // the passenger's words and wrote something else): it is never spoken; the original text stays on screen.
    if (parsed.text.length > maxTranslationLength(original.length)) {
      throw new TranslatorError('response', 'La respuesta del traductor no parece una traducción (es mucho más larga que el original); se mantiene el texto original.');
    }
    return parsed.detectedFrom ? { text: parsed.text, detectedFrom: parsed.detectedFrom } : { text: parsed.text };
  }

  private mapError(error: unknown, cancelled: boolean): TranslatorError {
    if (error instanceof TranslatorError) return error;
    if (cancelled) return new TranslatorError('cancelled', 'Traducción cancelada.', { cause: error });
    if (error instanceof APIUserAbortError || error instanceof APIConnectionTimeoutError) {
      return new TranslatorError('timeout', `El traductor no respondió en ${Math.round(this.timeoutMs / 1000)} s.`, { retryable: true, cause: error });
    }
    if (error instanceof AuthenticationError || error instanceof PermissionDeniedError) {
      return new TranslatorError('auth', 'Anthropic rechazó la clave de API (ANTHROPIC_API_KEY): revísala en Ajustes.', { status: error.status, cause: error });
    }
    if (error instanceof RateLimitError) {
      return new TranslatorError('rate_limited', 'La API de Anthropic está limitando las peticiones (429); se reintentará.', { retryable: true, status: 429, cause: error });
    }
    if (error instanceof NotFoundError) {
      return new TranslatorError('request', `La API de Anthropic no encuentra el modelo "${this.model}" (404): revisa TRANSLATOR_MODEL.`, { status: 404, cause: error });
    }
    if (error instanceof BadRequestError) {
      return new TranslatorError('request', `La API de Anthropic rechazó la petición (400): ${error.message}`, { status: 400, cause: error });
    }
    if (error instanceof InternalServerError) {
      return new TranslatorError('server', `La API de Anthropic no está disponible ahora mismo (${error.status}).`, { retryable: true, status: error.status, cause: error });
    }
    if (error instanceof APIConnectionError) {
      return new TranslatorError('network', `No se pudo conectar con la API de Anthropic (${error.message}).`, { retryable: true, cause: error });
    }
    if (error instanceof APIError) {
      return new TranslatorError('request', `La API de Anthropic respondió con un error${error.status ? ` (${error.status})` : ''}: ${error.message}`, {
        status: error.status ?? null,
        cause: error,
      });
    }
    const message = error instanceof Error ? error.message : String(error);
    return new TranslatorError('network', `Fallo inesperado del traductor: ${message}`, { retryable: true, cause: error });
  }
}
