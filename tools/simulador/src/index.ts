/**
 * @tw/simulador: passenger simulator for the Telecomway server (WebSocket `/sim`).
 * Everything here is SIMULATED: synthetic speech-like audio, no real telephony, no real providers.
 */
export const SIMULADOR_PACKAGE = '@tw/simulador' as const;

export { SimClient, SimClientError, normalizeServerUrl } from './sim-client.js';
export type { HeardBurst, HeardChunk, SimClientEvents, SimClientOptions, SimState } from './sim-client.js';
export {
  BUNDLED_SCENARIOS_DIR,
  DEFAULT_REPLY_TIMEOUT_MS,
  MAX_LINE_CHARS,
  MAX_PAUSE_MS,
  ScriptError,
  estimateScriptMs,
  listBundledScenarios,
  loadScript,
  parseScript,
  resolveScriptPath,
} from './script.js';
export type { ResolveScriptPathOptions, ScriptLine, SimScript } from './script.js';
export { runScript, sleepUnless, stopSignal } from './script-runner.js';
export type { RunScriptOptions, RunScriptResult } from './script-runner.js';
export {
  CONTROL_DIR_ENV,
  ControlServer,
  defaultControlDir,
  hangupPhones,
  listRegisteredPhones,
  requestHangup,
} from './control.js';
export type { HangupPhonesOptions, HangupPhonesOutcome, HangupRequestResult, PhoneRegistration, RegisteredPhone } from './control.js';
export { DEFAULT_LOAD_PHONES, EXIT, PhoneSession, cargarPrueba, colgar, defaultLoadPhones, escuchar, llamar } from './commands.js';
export type {
  AnswerOutcome,
  CargarPruebaOptions,
  CargarPruebaResult,
  ColgarOptions,
  ColgarResult,
  CommandContext,
  EscucharOptions,
  EscucharResult,
  FourthCallOutcome,
  LlamarOptions,
  LlamarResult,
  LoadPhone,
  PhoneSummary,
} from './commands.js';
export { Log, consoleReporter, endReasonEs, formatClock, formatDuration, formatReportLine, memoryReporter, shortId } from './output.js';
export type { ConsoleReporterOptions, ReportLevel, ReportLine, Reporter } from './output.js';
export { BOOLEAN_FLAGS, UsageError, flagBoolean, flagNumber, flagString, parseArgs, rejectUnknownFlags } from './args.js';
export type { NumberFlagOptions, ParsedArgs } from './args.js';
export { DEFAULT_SERVER, SERVER_ENV, helpText, runCli } from './cli-main.js';
export type { CliDeps } from './cli-main.js';
export { FakePhone, FakeSimServer } from './testing/fake-sim-server.js';
export type { FakeCall, FakeSimServerOptions, FakeUtterance } from './testing/fake-sim-server.js';
