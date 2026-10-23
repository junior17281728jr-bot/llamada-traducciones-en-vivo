import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import { join } from 'node:path';
import {
  SECRET_KEY_NAMES,
  type MaskedSecret,
  type SecretKeyName,
  type SecretsStore,
} from '@tw/shared';
import { readJsonFile, writePrivateFile } from '../files.js';

interface EncryptedValue {
  iv: string;
  tag: string;
  data: string;
  savedAt: number;
}

interface SecretsFile {
  version: 1;
  /** Salt for deriving the key from SECRETS_KEY (unused when the key comes from the key file). */
  salt: string;
  values: Partial<Record<SecretKeyName, EncryptedValue>>;
}

/** Shows at most the last 4 characters, and only when the secret is long enough that this reveals little. */
export function maskedLast4(value: string): string | null {
  return value.length >= 12 ? value.slice(-4) : null;
}

export const UNDECRYPTABLE_WARNING =
  'No se puede descifrar la clave guardada (¿ha cambiado SECRETS_KEY o el archivo secrets.key?). Hasta que se guarde de nuevo no se usa; si hay una en el entorno, se usa esa.';

/**
 * API keys encrypted at rest (AES-256-GCM). The key comes from SECRETS_KEY (derived with scrypt) or, when
 * that is empty, from a random key file with 0600 permissions next to the data. Whoever can read both
 * files on the server can decrypt the keys: protect the data folder like the keys themselves (in
 * production keep SECRETS_KEY out of DATA_DIR, so a copy of the folder alone reveals nothing).
 * Values only come out of `resolve`, for server code; nothing here returns a value to a client.
 * A value that no longer decrypts (the key changed) is reported as configured-but-unusable, never thrown.
 */
export class FileSecretsStore implements SecretsStore {
  private readonly path: string;
  private readonly keyPath: string;
  private file: SecretsFile | null = null;
  private key: Buffer | null = null;

  constructor(
    dataDir: string,
    private readonly passphrase: string | null,
    private readonly env: Record<string, string | undefined> = process.env,
  ) {
    this.path = join(dataDir, 'secrets.enc.json');
    this.keyPath = join(dataDir, 'secrets.key');
  }

  async set(name: SecretKeyName, value: string): Promise<void> {
    assertName(name);
    const trimmed = value.trim();
    if (!trimmed) return this.delete(name);
    const file = await this.load();
    const key = await this.getKey(file);
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const data = Buffer.concat([cipher.update(trimmed, 'utf8'), cipher.final()]);
    file.values[name] = {
      iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
      data: data.toString('base64'),
      savedAt: Date.now(),
    };
    await this.save(file);
  }

  async delete(name: SecretKeyName): Promise<void> {
    assertName(name);
    const file = await this.load();
    if (!(name in file.values)) return;
    delete file.values[name];
    await this.save(file);
  }

  async getMasked(name: SecretKeyName): Promise<MaskedSecret> {
    assertName(name);
    const saved = await this.readSaved(name);
    if (saved && 'undecryptable' in saved) return { configured: true, last4: null, savedAt: saved.savedAt, source: 'settings', warning: UNDECRYPTABLE_WARNING };
    if (saved) return { configured: true, last4: maskedLast4(saved.value), savedAt: saved.savedAt, source: 'settings' };
    const fromEnv = this.env[name]?.trim();
    if (fromEnv) return { configured: true, last4: maskedLast4(fromEnv), savedAt: null, source: 'env' };
    return { configured: false, last4: null, savedAt: null, source: 'none' };
  }

  async listMasked(): Promise<Record<SecretKeyName, MaskedSecret>> {
    const entries = await Promise.all(SECRET_KEY_NAMES.map(async (name) => [name, await this.getMasked(name)] as const));
    return Object.fromEntries(entries) as Record<SecretKeyName, MaskedSecret>;
  }

  async resolve(name: SecretKeyName): Promise<string | undefined> {
    assertName(name);
    const saved = await this.readSaved(name);
    if (saved && 'value' in saved) return saved.value;
    return this.env[name]?.trim() || undefined;
  }

  /** True when a saved value exists but cannot be decrypted with the current key. */
  async isUndecryptable(name: SecretKeyName): Promise<boolean> {
    assertName(name);
    const saved = await this.readSaved(name);
    return saved !== null && 'undecryptable' in saved;
  }

  private async readSaved(name: SecretKeyName): Promise<{ value: string; savedAt: number } | { undecryptable: true; savedAt: number } | null> {
    const file = await this.load();
    const entry = file.values[name];
    if (!entry) return null;
    try {
      const key = await this.getKey(file);
      const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(entry.iv, 'base64'));
      decipher.setAuthTag(Buffer.from(entry.tag, 'base64'));
      const value = Buffer.concat([decipher.update(Buffer.from(entry.data, 'base64')), decipher.final()]).toString('utf8');
      return { value, savedAt: entry.savedAt };
    } catch {
      return { undecryptable: true, savedAt: entry.savedAt };
    }
  }

  private async load(): Promise<SecretsFile> {
    this.file ??=
      (await readJsonFile<SecretsFile>(this.path)) ?? { version: 1, salt: randomBytes(16).toString('base64'), values: {} };
    return this.file;
  }

  private save(file: SecretsFile): Promise<void> {
    return writePrivateFile(this.path, JSON.stringify(file, null, 2));
  }

  private async getKey(file: SecretsFile): Promise<Buffer> {
    if (this.key) return this.key;
    if (this.passphrase) {
      this.key = scryptSync(this.passphrase, Buffer.from(file.salt, 'base64'), 32);
      return this.key;
    }
    const existing = await readJsonFile<{ key: string }>(this.keyPath);
    if (existing?.key) {
      this.key = Buffer.from(existing.key, 'base64');
    } else {
      this.key = randomBytes(32);
      await writePrivateFile(this.keyPath, JSON.stringify({ key: this.key.toString('base64') }));
    }
    return this.key;
  }
}

function assertName(name: string): asserts name is SecretKeyName {
  if (!(SECRET_KEY_NAMES as readonly string[]).includes(name)) throw new Error('Nombre de clave desconocido');
}
