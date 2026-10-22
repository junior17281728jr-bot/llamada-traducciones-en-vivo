import { useCall } from '../core/CallContext';

/** Placeholder: the real screen (two lanes with live waveforms) is built by the call team. */
export function CallScreen() {
  const { state } = useCall();
  return (
    <section aria-label="Llamada" data-testid="call-screen-placeholder">
      <p>{state.call ? `Llamada con ${state.call.remoteNumber}` : 'Sin llamada activa'}</p>
    </section>
  );
}
