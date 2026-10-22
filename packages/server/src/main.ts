/** Entry point of the server process (`npm run dev:server`). */
import { ConfigError, loadConfig } from './config.js';
import { createApplication } from './application.js';
import { NotConfiguredError } from './providers.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const app = await createApplication(config);
  const port = await app.start();
  const simulated = config.providers === 'mock' || config.channel === 'mock';

  console.log(`Servidor de Telecomway escuchando en http://${config.host}:${port}`);
  if (simulated) {
    console.log('MODO SIMULADO: voz, traducción y llamadas son simuladas. No se contacta ningún servicio real.');
    console.log(`Simulador de pasajeros: ws://${config.host}:${port}/sim (usa "npm run simulador -w @tw/simulador")`);
  }
  console.log(`Carpeta de datos: ${config.dataDir}`);
  if (app.generatedAdminPassword) {
    console.log('');
    console.log('Se ha creado el administrador inicial. Guarda esta contraseña, no se volverá a mostrar:');
    console.log(`  usuario: ${config.adminUsername}`);
    console.log(`  contraseña: ${app.generatedAdminPassword}`);
  }

  let stopping = false;
  const shutdown = async (): Promise<void> => {
    if (stopping) return;
    stopping = true;
    console.log('Cerrando el servidor...');
    await app.stop();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

main().catch((error: unknown) => {
  if (error instanceof ConfigError || error instanceof NotConfiguredError) {
    console.error(`No se pudo arrancar: ${error.message}`);
  } else {
    console.error('No se pudo arrancar el servidor:', error);
  }
  process.exitCode = 1;
});
