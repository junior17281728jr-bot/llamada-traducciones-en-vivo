/**
 * Crea un operador (o administrador) desde la línea de comandos:
 *   npm run operador:crear -w @tw/server -- <usuario> [--rol admin|operator] [--nombre "Marta"]
 * La contraseña se lee de la variable TW_NEW_PASSWORD (así no queda en el historial del terminal).
 */
import { loadConfig } from '../config.js';
import { OperatorStore } from '../auth.js';

async function run(): Promise<void> {
  const args = process.argv.slice(2);
  const username = args[0];
  const option = (name: string): string | undefined => {
    const index = args.indexOf(name);
    return index >= 0 ? args[index + 1] : undefined;
  };
  const password = process.env.TW_NEW_PASSWORD;
  if (!username || username.startsWith('--') || !password) {
    console.error('Uso: TW_NEW_PASSWORD=<contraseña> npm run operador:crear -w @tw/server -- <usuario> [--rol admin|operator] [--nombre "Nombre"]');
    process.exitCode = 1;
    return;
  }
  const role = option('--rol') === 'admin' ? 'admin' : 'operator';
  const store = OperatorStore.inDataDir(loadConfig().dataDir);
  const account = await store.create({ username, password, role, ...(option('--nombre') ? { name: option('--nombre')! } : {}) });
  console.log(`Creado ${account.role === 'admin' ? 'administrador' : 'operador'} "${account.username}".`);
}

run().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
