import { join } from 'node:path';
import {
  DEFAULT_OPERATOR_PREFERENCES,
  OperatorPreferencesSchema,
  type OperatorPreferences,
  type PreferencesStore,
} from '@tw/shared';
import { readJsonFile, writePrivateFile } from '../files.js';

/** Per-operator language preferences in one JSON file. Invalid saved entries fall back to the defaults. */
export class FilePreferencesStore implements PreferencesStore {
  private data: Record<string, OperatorPreferences> | null = null;
  private readonly path: string;

  constructor(
    dataDir: string,
    private readonly defaults: OperatorPreferences = DEFAULT_OPERATOR_PREFERENCES,
  ) {
    this.path = join(dataDir, 'preferences.json');
  }

  async get(operatorId: string): Promise<OperatorPreferences> {
    const data = await this.load();
    const parsed = OperatorPreferencesSchema.safeParse(data[operatorId]);
    return parsed.success ? parsed.data : { ...this.defaults };
  }

  async set(operatorId: string, preferences: OperatorPreferences): Promise<void> {
    const parsed = OperatorPreferencesSchema.parse(preferences);
    const data = await this.load();
    data[operatorId] = parsed;
    await writePrivateFile(this.path, JSON.stringify(data, null, 2));
  }

  private async load(): Promise<Record<string, OperatorPreferences>> {
    this.data ??= (await readJsonFile<Record<string, OperatorPreferences>>(this.path)) ?? {};
    return this.data;
  }
}
