/**
 * The real `@anthropic-ai/sdk` client runs here with a fake `fetch`, so the request body, headers and
 * the SDK's own error classes are the ones the live API would see. No request leaves the process.
 */
import Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it } from 'vitest';
import { buildTranslatorUserPrompt, parseTranslatorOutput } from './prompt.js';
import { ClaudeTranslator, TranslatorError, maxTokensFor, speedTuningFor } from './translator.js';

type Body = Record<string, unknown> & { messages: { role: string; content: string }[]; system: { type: string; text: string; cache_control?: unknown }[] };

interface Call {
  body: Body;
  headers: Headers;
  url: string;
}

/** The installed SDK (1.x) sends the key as `Authorization: Bearer`; older ones used `x-api-key`. Accept both. */
function keyOf(headers: Headers): string | null {
  return headers.get('x-api-key') ?? headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? null;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'request-id': 'req_test' } });
}

function messageResponse(text: string, extra: Record<string, unknown> = {}): Response {
  return jsonResponse(200, {
    id: 'msg_test',
    type: 'message',
    role: 'assistant',
    model: 'claude-haiku-5-5',
    content: [{ type: 'text', text, citations: null }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    stop_details: null,
    usage: { input_tokens: 40, output_tokens: 12, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    ...extra,
  });
}

function apiError(status: number, type: string, message: string): Response {
  return jsonResponse(status, { type: 'error', error: { type, message } });
}

function rig(respond: (call: Call, index: number) => Response | Promise<Response>, options: Partial<ConstructorParameters<typeof ClaudeTranslator>[0]> = {}) {
  const calls: Call[] = [];
  const createdClients: string[] = [];
  // Like the real fetch: rejects with an AbortError when the SDK aborts the request (its timeout or ours).
  const fetch = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const call: Call = { body: JSON.parse(String(init?.body)) as Body, headers: new Headers(init?.headers), url: String(input) };
    calls.push(call);
    return new Promise<Response>((resolve, reject) => {
      const abort = (): void => reject(new DOMException('aborted', 'AbortError'));
      if (init?.signal?.aborted) {
        abort();
        return;
      }
      init?.signal?.addEventListener('abort', abort, { once: true });
      Promise.resolve()
        .then(() => respond(call, calls.length - 1))
        .then(resolve, reject);
    });
  };
  const translator = new ClaudeTranslator({
    getApiKey: () => 'sk-ant-test-key',
    createClient: (apiKey) => {
      createdClients.push(apiKey);
      return new Anthropic({ apiKey, fetch, maxRetries: 0 });
    },
    retryDelayMs: 1,
    ...options,
  });
  return { translator, calls, createdClients };
}

const REQUEST = { text: 'My flight was cancelled and I need a hotel', to: 'es', context: [{ speaker: 'operator' as const, text: 'Buenos días, le atiende Telecomway' }] };

describe('ClaudeTranslator request', () => {
  it('sends a compact, speed-oriented request and parses the JSON answer', async () => {
    const r = rig(() => messageResponse('{"t":"Mi vuelo fue cancelado y necesito un hotel.","s":"en"}'));
    const result = await r.translator.translate(REQUEST);
    expect(result).toEqual({ text: 'Mi vuelo fue cancelado y necesito un hotel.', detectedFrom: 'en' });

    expect(r.calls).toHaveLength(1);
    const { body, headers, url } = r.calls[0]!;
    expect(url).toBe('https://api.anthropic.com/v1/messages');
    expect(keyOf(headers)).toBe('sk-ant-test-key');
    expect(body.model).toBe('claude-haiku-5-5');
    expect(body.max_tokens).toBeLessThanOrEqual(300);
    expect(body).not.toHaveProperty('temperature');
    expect(body).not.toHaveProperty('top_p');
    expect(body).not.toHaveProperty('top_k');
    expect(body.thinking).toEqual({ type: 'disabled' });
    expect(body.output_config).toEqual({ effort: 'low' });
    expect(body.system[0]!.cache_control).toEqual({ type: 'ephemeral' });
    expect(body.system[0]!.text).toContain('Telecomway');
    expect(body.messages).toHaveLength(1);
    const prompt = body.messages[0]!.content;
    expect(prompt).toContain('Target language: es (Español).');
    expect(prompt).toContain('Source language: unknown; identify it.');
    expect(prompt).toContain('- operator: Buenos días, le atiende Telecomway');
    expect(prompt).toContain('<utterance>My flight was cancelled and I need a hotel</utterance>');
  });

  it('names the source language when the request fixes it and caps the context', () => {
    const prompt = buildTranslatorUserPrompt(
      { text: 'hola', from: 'es', to: 'fr', context: [1, 2, 3, 4].map((n) => ({ speaker: 'passenger' as const, text: `turn ${n}` })) },
      2,
    );
    expect(prompt).toContain('Source language: es (Español).');
    expect(prompt).not.toContain('turn 1');
    expect(prompt).toContain('turn 3');
    expect(prompt).toContain('turn 4');
  });

  it('reuses the client while the key is the same and rebuilds it when the key changes', async () => {
    let key = 'key-one';
    const r = rig(() => messageResponse('{"t":"x","s":"en"}'), { getApiKey: () => key });
    await r.translator.translate(REQUEST);
    await r.translator.translate(REQUEST);
    key = 'key-two';
    await r.translator.translate(REQUEST);
    expect(r.createdClients).toEqual(['key-one', 'key-two']);
    expect(keyOf(r.calls[2]!.headers)).toBe('key-two');
  });

  it('fails in Spanish without calling the API when the key is missing', async () => {
    const r = rig(() => messageResponse('{"t":"x"}'), { getApiKey: () => Promise.resolve(undefined) });
    await expect(r.translator.translate(REQUEST)).rejects.toMatchObject({ kind: 'config', message: expect.stringContaining('ANTHROPIC_API_KEY') });
    expect(r.calls).toHaveLength(0);
  });

  it('picks per-model speed settings and nothing for unknown models', () => {
    expect(speedTuningFor('claude-haiku-5-5')).toEqual({ thinking: { type: 'disabled' }, output_config: { effort: 'low' } });
    expect(speedTuningFor('claude-sonnet-5-5')).toEqual({ output_config: { effort: 'low' } });
    expect(speedTuningFor('claude-opus-5-5')).toEqual({ output_config: { effort: 'low' } });
    expect(speedTuningFor('claude-haiku-4-5')).toEqual({});
    expect(speedTuningFor('some-future-model')).toEqual({});
  });
});

describe('ClaudeTranslator answers', () => {
  it('uses the raw text when the answer is not JSON', async () => {
    const r = rig(() => messageResponse('Mi vuelo fue cancelado.'));
    expect(await r.translator.translate(REQUEST)).toEqual({ text: 'Mi vuelo fue cancelado.' });
  });

  it('tolerates fences, surrounding prose, truncated JSON and unknown language codes', () => {
    expect(parseTranslatorOutput('```json\n{"t":"Hola","s":"en"}\n```')).toEqual({ text: 'Hola', detectedFrom: 'en' });
    expect(parseTranslatorOutput('Sure: {"t":"Hola","s":"English"} done')).toEqual({ text: 'Hola' });
    expect(parseTranslatorOutput('{"t":"Mi vuelo fue cancelado y necesito un ho')).toEqual({ text: 'Mi vuelo fue cancelado y necesito un ho' });
    expect(parseTranslatorOutput('{"t":"Dijo \\"hola\\"","s":"pt-BR"}')).toEqual({ text: 'Dijo "hola"', detectedFrom: 'pt' });
    expect(parseTranslatorOutput('{"s":"en"}')).toEqual({ text: '{"s":"en"}' });
  });

  it('treats a refusal as a non-retryable Spanish error', async () => {
    const r = rig(() => messageResponse('', { content: [], stop_reason: 'refusal', stop_details: { type: 'refusal', category: null, explanation: 'policy' } }));
    const error = await r.translator.translate(REQUEST).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TranslatorError);
    expect(error).toMatchObject({ kind: 'refusal', retryable: false, message: expect.stringContaining('rechazó') });
    expect(r.calls).toHaveLength(1);
  });

  it('sizes max_tokens with the phrase and refuses an answer cut by that limit instead of speaking half a sentence', async () => {
    expect(maxTokensFor('hola', 300)).toBe(300);
    expect(maxTokensFor('x'.repeat(2000), 300)).toBeGreaterThan(1000);
    expect(maxTokensFor('x'.repeat(20_000), 300)).toBe(2048);
    const long = rig(() => messageResponse('{"t":"ok","s":"en"}'));
    expect(long.translator.requestParams({ text: 'palabra '.repeat(250), to: 'es' }).max_tokens).toBe(maxTokensFor('palabra '.repeat(250), 300));

    const cut = rig(() => messageResponse('{"t":"Mi vuelo fue cancelado y nece', { stop_reason: 'max_tokens' }));
    await expect(cut.translator.translate(REQUEST)).rejects.toMatchObject({ kind: 'response', message: expect.stringContaining('se cortó') });
    expect(cut.calls).toHaveLength(1);
  });

  it('refuses an answer far longer than the original (not a translation) and keeps the original text', async () => {
    const r = rig(() => messageResponse(JSON.stringify({ t: 'Claro, aquí tiene un resumen muy largo. '.repeat(40), s: 'en' })));
    await expect(r.translator.translate(REQUEST)).rejects.toMatchObject({ kind: 'response', message: expect.stringContaining('no parece una traducción') });
    expect(r.calls).toHaveLength(1);
  });

  it('rejects an empty answer', async () => {
    const r = rig(() => messageResponse('   '));
    await expect(r.translator.translate(REQUEST)).rejects.toMatchObject({ kind: 'response' });
  });
});

describe('ClaudeTranslator failures', () => {
  it('times out, retries once and then reports a timeout in Spanish', async () => {
    // The server never answers; the translator's own timeout aborts each attempt.
    const slow = rig(() => new Promise<Response>(() => undefined), { timeoutMs: 40, retries: 1 });
    const started = Date.now();
    const error = await slow.translator.translate(REQUEST).catch((e: unknown) => e);
    expect(error).toMatchObject({ kind: 'timeout', retryable: true, message: expect.stringContaining('no respondió') });
    expect(slow.calls).toHaveLength(2);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('maps authentication failures without retrying', async () => {
    const r = rig(() => apiError(401, 'authentication_error', 'invalid x-api-key'));
    const error = await r.translator.translate(REQUEST).catch((e: unknown) => e);
    expect(error).toMatchObject({ kind: 'auth', retryable: false, status: 401, message: expect.stringContaining('ANTHROPIC_API_KEY') });
    expect((error as Error).message).not.toContain('sk-ant-test-key');
    expect(r.calls).toHaveLength(1);
  });

  it('retries rate limits and server errors once, then succeeds or gives up', async () => {
    const recovered = rig((_call, index) => (index === 0 ? apiError(429, 'rate_limit_error', 'slow down') : messageResponse('{"t":"ok","s":"en"}')));
    expect(await recovered.translator.translate(REQUEST)).toEqual({ text: 'ok', detectedFrom: 'en' });
    expect(recovered.calls).toHaveLength(2);

    const down = rig(() => apiError(529, 'overloaded_error', 'overloaded'));
    await expect(down.translator.translate(REQUEST)).rejects.toMatchObject({ kind: 'server', retryable: true });
    expect(down.calls).toHaveLength(2);
  });

  it('explains a wrong model and a bad request without retrying', async () => {
    const missing = rig(() => apiError(404, 'not_found_error', 'model not found'), { model: 'claude-nope' });
    await expect(missing.translator.translate(REQUEST)).rejects.toMatchObject({ kind: 'request', message: expect.stringContaining('claude-nope') });
    expect(missing.calls).toHaveLength(1);

    const bad = rig(() => apiError(400, 'invalid_request_error', 'max_tokens too large'));
    await expect(bad.translator.translate(REQUEST)).rejects.toMatchObject({ kind: 'request', status: 400 });
  });

  it('reports a network failure as retryable', async () => {
    const r = rig(() => {
      throw new TypeError('fetch failed');
    });
    await expect(r.translator.translate(REQUEST)).rejects.toMatchObject({ kind: 'network', retryable: true });
    expect(r.calls).toHaveLength(2);
  });

  it('honours an external abort signal as a cancellation', async () => {
    const controller = new AbortController();
    const r = rig(() => new Promise<Response>(() => undefined));
    const pending = r.translator.translate(REQUEST, { signal: controller.signal });
    setTimeout(() => controller.abort(), 10);
    await expect(pending).rejects.toMatchObject({ kind: 'cancelled' });
    expect(r.calls).toHaveLength(1);
  });
});
