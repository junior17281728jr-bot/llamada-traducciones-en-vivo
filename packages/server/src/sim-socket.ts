import type { IncomingMessage } from 'node:http';
import { WebSocket, type RawData } from 'ws';
import { encodeMessage, parseSimClientMessage, pcm16ToBase64, base64ToPcm16, type Logger, type SimServerMessage } from '@tw/shared';
import type { MockCallChannel } from './channel/mock-channel.js';

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

export function isLoopback(address: string | undefined): boolean {
  return address !== undefined && LOOPBACK.has(address);
}

/** One socket = one simulated passenger phone. Only reachable from the same machine. */
export function handleSimSocket(ws: WebSocket, req: IncomingMessage, channel: MockCallChannel, logger: Logger): void {
  if (!isLoopback(req.socket.remoteAddress)) {
    ws.close(1008, 'simulator is local only');
    return;
  }
  const phone = channel.createPhone();
  const send = (message: SimServerMessage): void => {
    if (ws.readyState === WebSocket.OPEN) ws.send(encodeMessage(message));
  };
  phone.onHeard((pcm) => send({ type: 'sim.audio', audio: pcm16ToBase64(pcm) }));
  phone.onState((state) =>
    send({
      type: 'sim.state',
      state: state.state === 'idle' ? 'ended' : state.state,
      callId: state.callId,
      ...(state.direction ? { direction: state.direction } : {}),
      ...(state.remoteNumber ? { remoteNumber: state.remoteNumber } : {}),
      ...(state.reason ? { reason: state.reason } : {}),
    }),
  );

  ws.on('message', (data: RawData, isBinary: boolean) => {
    if (isBinary) return;
    const text = Array.isArray(data) ? Buffer.concat(data).toString('utf8') : Buffer.from(data as Buffer).toString('utf8');
    const parsed = parseSimClientMessage(text);
    if (!parsed.ok) {
      logger.warn('Mensaje del simulador no válido', { error: parsed.error });
      return;
    }
    const message = parsed.value;
    try {
      switch (message.type) {
        case 'sim.incoming':
          phone.incoming(message.from, message.lang);
          break;
        case 'sim.listen':
          phone.listen(message.lang);
          break;
        case 'sim.answer':
          phone.answer();
          break;
        case 'sim.say':
          phone.say(message.text, message.lang, message.audio ? base64ToPcm16(message.audio) : undefined);
          break;
        case 'sim.audio':
          phone.pushAudio(base64ToPcm16(message.audio));
          break;
        case 'sim.hangup':
          void phone.hangup();
          break;
      }
    } catch (error) {
      logger.warn('El simulador envió algo que no se puede hacer ahora', { type: message.type, error: String(error) });
      send({ type: 'sim.state', state: 'ended', callId: null, reason: 'failed' });
    }
  });
  ws.on('close', () => void phone.dispose());
  ws.on('error', (error) => logger.warn('Error en un socket del simulador', { error: error.message }));
}
