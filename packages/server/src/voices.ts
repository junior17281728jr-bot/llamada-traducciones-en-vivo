import { VOICE_ID_PATTERN, type Logger, type VoiceOption, type VoicesResponse } from '@tw/shared';
import type { FetchLike } from './catalog.js';

export interface VoiceListerDeps {
  getApiKey: () => Promise<string | undefined>;
  fetch: FetchLike;
  logger: Logger;
  baseUrl?: string;
}

/**
 * The voices of the ElevenLabs account behind the saved key (GET /v1/voices: UNVERIFIED, from memory), so the
 * operator can pick one in Ajustes instead of typing an id. Anything that does not look like a voice is skipped.
 */
export async function listElevenLabsVoices(deps: VoiceListerDeps): Promise<VoicesResponse> {
  const key = await deps.getApiKey();
  if (!key) return { source: 'unavailable', voices: [], message: 'Primero guarda la clave de ElevenLabs.' };
  try {
    const response = await deps.fetch(`${deps.baseUrl ?? 'https://api.elevenlabs.io'}/v1/voices`, {
      headers: { 'xi-api-key': key },
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) {
      const reason = response.status === 401 || response.status === 403 ? 'la clave no es válida o no tiene permiso' : `respuesta ${response.status}`;
      return { source: 'unavailable', voices: [], message: `ElevenLabs no dio la lista de voces: ${reason}.` };
    }
    const body = (await response.json()) as { voices?: unknown };
    const voices: VoiceOption[] = [];
    for (const raw of Array.isArray(body.voices) ? body.voices : []) {
      const entry = raw as { voice_id?: unknown; name?: unknown; labels?: unknown };
      if (typeof entry.voice_id !== 'string' || !VOICE_ID_PATTERN.test(entry.voice_id)) continue;
      const name = typeof entry.name === 'string' && entry.name.trim() ? entry.name.trim().slice(0, 80) : entry.voice_id;
      const labels = entry.labels && typeof entry.labels === 'object' ? (entry.labels as Record<string, unknown>) : {};
      const description = ['gender', 'accent', 'age', 'use_case']
        .map((field) => labels[field])
        .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
        .map((value) => value.trim().slice(0, 40))
        .join(' · ');
      voices.push({ id: entry.voice_id, name, description: description || null });
      if (voices.length >= 500) break;
    }
    voices.sort((a, b) => a.name.localeCompare(b.name, 'es'));
    return { source: 'elevenlabs', voices, message: voices.length === 0 ? 'Tu cuenta de ElevenLabs no tiene voces disponibles.' : null };
  } catch (error) {
    deps.logger.warn('No se pudo pedir la lista de voces', { error: String(error) });
    return { source: 'unavailable', voices: [], message: 'No se pudo conectar con ElevenLabs para ver las voces.' };
  }
}
