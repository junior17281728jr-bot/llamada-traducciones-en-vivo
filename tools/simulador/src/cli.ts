#!/usr/bin/env node
/** Entry point of `tw-sim` / `npm run sim -w @tw/simulador`. */
import { runCli } from './cli-main.js';

const controller = new AbortController();
let interrupts = 0;
const interrupt = (): void => {
  interrupts += 1;
  if (interrupts === 1) {
    console.error('\nInterrumpido: se cuelga y se cierra la conexión (pulsa otra vez para salir ya).');
    controller.abort();
    return;
  }
  process.exit(130);
};
process.on('SIGINT', interrupt);
process.on('SIGTERM', interrupt);

runCli(process.argv.slice(2), { signal: controller.signal })
  .then((code) => {
    const exitCode = controller.signal.aborted && code === 0 ? 130 : code;
    process.exitCode = exitCode;
    // Nothing should keep the loop alive by now; if a stray handle does, leave anyway.
    setTimeout(() => process.exit(exitCode), 500).unref();
  })
  .catch((error: unknown) => {
    console.error('Error inesperado:', error);
    process.exitCode = 1;
  });
