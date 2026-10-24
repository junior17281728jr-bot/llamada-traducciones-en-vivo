import { join } from 'node:path';
import { AppSettingsSchema, DEFAULT_APP_SETTINGS, type AppSettings } from '@tw/shared';
import { readJsonFile, writePrivateFile } from '../files.js';

/**
 * Settings of the whole server that are not secrets: the ElevenLabs voice and the plan B. One JSON file;
 * a damaged file falls back to the defaults (plan B on). `current` is synchronous so the voice clients can
 * read it when each session opens.
 */
export class FileAppSettingsStore {
  private value: AppSettings = { ...DEFAULT_APP_SETTINGS };
  private readonly path: string;

  constructor(dataDir: string) {
    this.path = join(dataDir, 'app-settings.json');
  }

  async load(): Promise<AppSettings> {
    let saved: unknown = null;
    try {
      saved = await readJsonFile<unknown>(this.path);
    } catch {
      saved = null;
    }
    const parsed = AppSettingsSchema.safeParse({ ...DEFAULT_APP_SETTINGS, ...(saved && typeof saved === 'object' ? saved : {}) });
    this.value = parsed.success ? parsed.data : { ...DEFAULT_APP_SETTINGS };
    return this.current;
  }

  get current(): AppSettings {
    return { ...this.value };
  }

  async set(settings: AppSettings): Promise<AppSettings> {
    const parsed = AppSettingsSchema.parse(settings);
    await writePrivateFile(this.path, JSON.stringify(parsed, null, 2));
    this.value = parsed;
    return this.current;
  }
}
