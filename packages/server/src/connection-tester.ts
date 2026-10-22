import type { ConnectionTester, ConnectionTestResult, Logger, ProviderMode, SecretsStore, TestService } from '@tw/shared';
import type { FetchLike } from './catalog.js';

export interface ConnectionTesterDeps {
  providers: ProviderMode;
  secrets: SecretsStore;
  fetch: FetchLike;
  logger: Logger;
  translatorModel: string;
  now?: () => number;
}

const SIMULATED_MESSAGE = 'Modo simulado: NO se ha contactado ningún servicio real. Esta prueba no demuestra que la conexión funcione.';

/**
 * Behind each "Probar conexión" button. With simulated providers it says so explicitly; with real
 * providers it makes one small real request. Channels (Twilio, WhatsApp) are not implemented: they never
 * report success.
 */
export class DefaultConnectionTester implements ConnectionTester {
  constructor(private readonly deps: ConnectionTesterDeps) {}

  async test(service: TestService): Promise<ConnectionTestResult> {
    const testedAt = (this.deps.now ?? Date.now)();
    const result = (status: ConnectionTestResult['status'], message: string, contacted: boolean, latencyMs: number | null = null): ConnectionTestResult => ({
      service,
      status,
      message,
      contactedRealService: contacted,
      latencyMs,
      testedAt,
    });

    if (service === 'twilio' || service === 'whatsapp') {
      return result('unconfigured', 'Este canal está previsto pero todavía no está implementado: no hay nada que probar. Las claves guardadas no se han usado.', false);
    }
    if (this.deps.providers === 'mock') return result('simulated', SIMULATED_MESSAGE, false);

    if (service === 'elevenlabs') {
      const key = await this.deps.secrets.resolve('ELEVENLABS_API_KEY');
      if (!key) return result('unconfigured', 'Falta la clave de ElevenLabs.', false);
      return this.request(result, 'ElevenLabs', 'https://api.elevenlabs.io/v1/models', { headers: { 'xi-api-key': key } });
    }
    const key = await this.deps.secrets.resolve('ANTHROPIC_API_KEY');
    if (!key) return result('unconfigured', 'Falta la clave de Anthropic.', false);
    return this.request(result, 'Anthropic', 'https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: this.deps.translatorModel, max_tokens: 1, messages: [{ role: 'user', content: 'ping' }] }),
    });
  }

  private async request(
    result: (status: ConnectionTestResult['status'], message: string, contacted: boolean, latencyMs?: number | null) => ConnectionTestResult,
    name: string,
    url: string,
    init: { headers: Record<string, string>; method?: string; body?: string },
  ): Promise<ConnectionTestResult> {
    const started = Date.now();
    try {
      const response = await this.deps.fetch(url, { ...init, signal: AbortSignal.timeout(8000) });
      const latency = Date.now() - started;
      if (response.ok) return result('ok', `${name}: conexión correcta (${latency} ms).`, true, latency);
      const reason = response.status === 401 || response.status === 403 ? 'la clave no es válida o no tiene permiso' : `respuesta ${response.status}`;
      return result('fail', `${name}: ${reason}.`, true, latency);
    } catch (error) {
      this.deps.logger.warn('Fallo al probar la conexión', { service: name, error: String(error) });
      return result('fail', `${name}: no se pudo conectar (${error instanceof Error ? error.message : 'error desconocido'}).`, false);
    }
  }
}
