import { useEffect, useRef, type ReactNode } from 'react';
import type { Speaker, TranscriptSegment } from '@tw/shared';
import type { ActiveCall, LevelSource } from '../core/types';
import { StageChips } from './StageChips';
import { Waveform } from './Waveform';
import { langName } from './labels';

interface SegmentRowProps {
  segment: TranscriptSegment;
}

function SegmentRow({ segment }: SegmentRowProps) {
  const sameLanguage = segment.translatedLang !== null && segment.translatedLang === segment.originalLang;
  return (
    <li className={`segment${segment.final ? '' : ' segment--partial'}`} data-final={segment.final}>
      <p className="segment__original">
        {segment.originalLang ? <span className="segment__lang">{segment.originalLang.toUpperCase()}</span> : null}
        {segment.originalText}
      </p>
      {segment.final ? (
        segment.translatedText === null ? (
          <p className="segment__translation segment__translation--missing">No se pudo traducir; se muestra el original.</p>
        ) : sameLanguage ? (
          <p className="segment__translation segment__translation--same">Mismo idioma ({langName(segment.translatedLang)}): no hace falta traducir.</p>
        ) : (
          <p className="segment__translation">
            <span className="segment__lang segment__lang--target">→ {segment.translatedLang?.toUpperCase()}</span>
            {segment.translatedText}
          </p>
        )
      ) : null}
    </li>
  );
}

interface LaneProps {
  speaker: Speaker;
  name: string;
  call: ActiveCall;
  source: LevelSource;
  colorToken: string;
  /** Language line under the name. */
  subtitle: ReactNode;
  /** Extra notice for the lane (e.g. microphone problems). */
  warning?: string | null;
}

/**
 * One person of the call: name, language, "speaking" mark, translation stage, the live waveform of REAL
 * audio and the transcript (original and translation) of what that person says. Colour is never the
 * only cue: every lane also has its name, an icon-like marker and the word "Hablando".
 */
/**
 * What the lane says when the server relays the ORIGINAL voice of this direction: same language on both ends, or
 * plan B while a service is down (then it says so instead of "mismo idioma").
 */
export function directAudioLabel(call: ActiveCall, speaker: Speaker): string | null {
  const direct = call.directAudio;
  if (!direct) return null;
  const planB = speaker === 'passenger' ? call.fallback?.passengerToOperator.originalVoice : call.fallback?.operatorToPassenger.originalVoice;
  const reason = planB ? 'plan B: sin traducir' : 'mismo idioma';
  if (speaker === 'passenger') return direct.passengerToOperator ? `Oyes su voz original (${reason})` : null;
  return direct.operatorToPassenger ? `El pasajero oye tu voz original (${reason})` : null;
}

export function Lane({ speaker, name, call, source, colorToken, subtitle, warning }: LaneProps) {
  const lane = call.lanes[speaker];
  const direct = directAudioLabel(call, speaker);
  const segments = call.segments.filter((segment) => segment.speaker === speaker);
  const listRef = useRef<HTMLOListElement | null>(null);
  useEffect(() => {
    const list = listRef.current;
    if (list) list.scrollTop = list.scrollHeight;
  }, [segments.length, segments.at(-1)?.final, segments.at(-1)?.originalText]);

  return (
    <section
      className={`lane lane--${speaker}${lane.speaking ? ' lane--speaking' : ''}`}
      aria-label={name}
      data-speaker={speaker}
      data-speaking={lane.speaking}
    >
      <header className="lane__header">
        <span className="lane__marker" aria-hidden="true">
          {speaker === 'passenger' ? '◐' : '◑'}
        </span>
        <h2 className="lane__name">{name}</h2>
        <p className="lane__subtitle">{subtitle}</p>
        {call.simulated ? <span className="badge badge--simulated">Simulado</span> : null}
        {direct ? (
          <span className="chip chip--accent" data-testid={`direct-audio-${speaker}`} title="Los dos habláis el mismo idioma: se reproduce la voz tal cual, sin sintetizarla.">
            {direct}
          </span>
        ) : null}
        <span className={`lane__speaking${lane.speaking ? ' lane__speaking--on' : ''}`} role="status" aria-live="polite">
          {lane.speaking ? 'Hablando' : ''}
        </span>
      </header>
      <StageChips stage={lane.stage} detail={lane.stageDetail} />
      <Waveform source={source} colorToken={colorToken} label={`Onda de voz de ${name}`} />
      {!lane.levelsFlowing ? (
        <p className="notice notice--warn" role="status">
          No llega el audio de {name.toLowerCase()}: la conexión con el servidor se ha interrumpido.
        </p>
      ) : null}
      {warning ? (
        <p className="notice notice--warn" role="status">
          {warning}
        </p>
      ) : null}
      <ol className="transcript" ref={listRef} aria-label={`Transcripción de ${name}`}>
        {segments.length === 0 ? <li className="transcript__empty">Aquí aparecerá lo que diga {name.toLowerCase()}.</li> : null}
        {segments.map((segment) => (
          <SegmentRow key={segment.id} segment={segment} />
        ))}
      </ol>
    </section>
  );
}
