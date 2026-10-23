/**
 * Join point of the call team (src/core/** and src/call/**).
 * - `createCallClient(session)`: the real `CallClientApi` (WebSocket, microphone, playback, level buffers).
 * - `CallScreen`: the call screen with both lanes (Pasajero / Operador), stage chips and transcript.
 */
import { createCallClient as createClient } from '../core/call-client';
import type { CallClientFactory } from '../core/CallContext';

export const createCallClient: CallClientFactory = (session) => createClient(session);

export { CallScreen } from './CallScreen';
export { LocalCallStart } from './LocalCallStart';
