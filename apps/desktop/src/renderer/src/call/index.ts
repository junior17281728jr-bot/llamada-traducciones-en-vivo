/**
 * Join point owned by the call team (src/core/** and src/call/**).
 * Base phase: placeholders. Replace them, keeping these two exports:
 * - `createCallClient(session)`: the real `CallClientApi` (WebSocket, mic, playback, level buffers).
 * - `CallScreen`: the call screen with both lanes (Pasajero / Operador), chips and transcript.
 */
import { createEmptyCallClient } from '../core/CallContext';
import type { CallClientFactory } from '../core/CallContext';

export const createCallClient: CallClientFactory = () => createEmptyCallClient();

export { CallScreen } from './CallScreen';
