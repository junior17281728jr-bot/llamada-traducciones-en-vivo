import {
  DOCUMENTED_TTS_LANGUAGES,
  documentationCatalog,
  normalizeLanguageCode,
  type LanguageCatalog,
  type LanguageCatalogProvider,
  type Logger,
} from '@tw/shared';

export type FetchLike = (url: string, init?: { headers?: Record<string, string>; method?: string; body?: string; signal?: AbortSignal }) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}>;

export interface CatalogDeps {
  /** Resolves the ElevenLabs key, or undefined when none is configured. */
  getApiKey: () => Promise<string | undefined>;
  fetch: FetchLike;
  logger: Logger;
  /** TTS model whose languages decide the voice languages. */
  ttsModelId?: string;
  baseUrl?: string;
  now?: () => number;
}

interface ModelEntry {
  model_id?: unknown;
  languages?: unknown;
}

/**
 * Language catalogue: the built-in documentation list, optionally refreshed by asking ElevenLabs which
 * languages the TTS model supports (GET /v1/models: UNVERIFIED, from memory). Only the voice side is
 * refreshed; speech-to-text stays on the documentation list because no queryable list was confirmed.
 * Anything the query does not confirm stays out of the catalogue.
 */
export class ElevenLabsCatalogProvider implements LanguageCatalogProvider {
  private current: LanguageCatalog = documentationCatalog();

  constructor(private readonly deps: CatalogDeps) {}

  getCatalog(): Promise<LanguageCatalog> {
    return Promise.resolve(this.current);
  }

  async refresh(): Promise<LanguageCatalog> {
    const key = await this.deps.getApiKey();
    if (!key) return this.current;
    try {
      const response = await this.deps.fetch(`${this.deps.baseUrl ?? 'https://api.elevenlabs.io'}/v1/models`, {
        headers: { 'xi-api-key': key },
        signal: AbortSignal.timeout(8000),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = (await response.json()) as unknown;
      const voiceLanguages = extractModelLanguages(body, this.deps.ttsModelId ?? 'eleven_flash_v2_5');
      if (voiceLanguages.size === 0) throw new Error('La respuesta no lista idiomas para el modelo de voz');
      const base = documentationCatalog();
      this.current = {
        source: 'live',
        fetchedAt: (this.deps.now ?? Date.now)(),
        // Only the voice side is confirmed live; STT and translation keep the documentation values.
        languages: base.languages.map((entry) => ({ ...entry, tts: voiceLanguages.has(entry.code) })),
      };
    } catch (error) {
      this.deps.logger.warn('No se pudo actualizar el catálogo de idiomas; se mantiene la lista anterior', { error: String(error) });
    }
    return this.current;
  }
}

/** Codes (normalised) listed by the named model; empty when the shape is not what we expect. */
export function extractModelLanguages(body: unknown, modelId: string): Set<string> {
  const out = new Set<string>();
  if (!Array.isArray(body)) return out;
  const model = (body as ModelEntry[]).find((entry) => entry?.model_id === modelId);
  if (!model || !Array.isArray(model.languages)) return out;
  for (const item of model.languages as unknown[]) {
    const raw = typeof item === 'string' ? item : (item as { language_id?: unknown })?.language_id;
    const code = typeof raw === 'string' ? normalizeLanguageCode(raw) : null;
    if (code) out.add(code);
  }
  return out;
}

export { DOCUMENTED_TTS_LANGUAGES };
