import { useEffect, useState } from 'react';
import { RECORDING_LEGS, type CallDetailResponse, type RecordingLeg, type TranscriptSegment } from '@tw/shared';
import { asApiFailure, describeApiError, logoutIfSessionExpired } from '../app/errors';
import { callDurationSeconds, formatDateTime, formatDuration, formatOffset } from '../app/format';
import { DIRECTION_LABELS, langName } from '../app/labels';
import { api } from '../core/http';
import { downloadTextFile, transcriptFileName, transcriptToText } from './export';

const LEG_LABELS: Record<RecordingLeg, string> = {
  mixed: 'Mezcla',
  passenger: 'Pasajero',
  operator: 'Operador',
};

const END_REASON_LABELS = {
  hangup_operator: 'Colgó el operador',
  hangup_passenger: 'Colgó el pasajero',
  rejected: 'Rechazada',
  no_answer: 'Sin respuesta',
  busy: 'Líneas ocupadas',
  failed: 'Fallida',
  cancelled: 'Cancelada',
  server_shutdown: 'El servidor se cerró',
  connection_lost: 'Se perdió la conexión del operador',
} as const;

type AudioStatus = { kind: 'idle' } | { kind: 'loading' } | { kind: 'ready'; url: string } | { kind: 'missing' } | { kind: 'error'; message: string };

interface AudioPlayerProps {
  callId: string;
  recorded: boolean;
}

/** One `<audio>` per chosen leg; the blob URL of the previous leg is revoked when another is chosen. */
function AudioPlayer({ callId, recorded }: AudioPlayerProps) {
  const [leg, setLeg] = useState<RecordingLeg>('mixed');
  const [status, setStatus] = useState<AudioStatus>({ kind: 'idle' });

  useEffect(() => {
    if (!recorded) {
      setStatus({ kind: 'missing' });
      return undefined;
    }
    let cancelled = false;
    let url: string | null = null;
    setStatus({ kind: 'loading' });
    api
      .getCallAudio(callId, leg)
      .then((blob) => {
        if (cancelled) return;
        url = URL.createObjectURL(blob);
        setStatus({ kind: 'ready', url });
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        if (logoutIfSessionExpired(cause)) return;
        const failure = asApiFailure(cause);
        if (failure.status === 404) setStatus({ kind: 'missing' });
        else setStatus({ kind: 'error', message: describeApiError(cause, 'No se pudo cargar el audio') });
      });
    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [callId, leg, recorded]);

  return (
    <div className="stack stack--tight" data-testid="audio-player">
      <div className="row">
        <span className="field__label">Grabación</span>
        <div role="radiogroup" aria-label="Tramo de la grabación" className="segmented">
          {RECORDING_LEGS.map((candidate) => (
            <button
              key={candidate}
              type="button"
              role="radio"
              aria-checked={leg === candidate}
              className={`segmented__option${leg === candidate ? ' segmented__option--on' : ''}`}
              disabled={!recorded}
              onClick={() => setLeg(candidate)}
            >
              {LEG_LABELS[candidate]}
            </button>
          ))}
        </div>
      </div>
      {status.kind === 'loading' ? <p className="loading">Cargando audio…</p> : null}
      {status.kind === 'ready' ? (
        <audio controls preload="metadata" src={status.url} className="history__audio" data-testid="audio-element" aria-label={`Grabación: ${LEG_LABELS[leg]}`} />
      ) : null}
      {status.kind === 'missing' ? (
        <p className="muted small" data-testid="audio-missing">
          Esta llamada no tiene grabación.
        </p>
      ) : null}
      {status.kind === 'error' ? (
        <p className="notice notice--danger" role="alert">
          {status.message}
        </p>
      ) : null}
    </div>
  );
}

interface SegmentCellProps {
  segment: TranscriptSegment;
}

function SegmentCell({ segment }: SegmentCellProps) {
  const sameLanguage = segment.translatedLang !== null && segment.translatedLang === segment.originalLang;
  return (
    <div className={`transcript2__bubble transcript2__bubble--${segment.speaker}`}>
      <p className="transcript2__meta">
        <span className="mono">{formatOffset(segment.startMs)}</span>
        {segment.originalLang ? (
          <span className="chip chip--neutral" title={langName(segment.originalLang)}>
            {langName(segment.originalLang)}
          </span>
        ) : null}
        {!segment.final ? <span className="chip">provisional</span> : null}
      </p>
      <p className="transcript2__original">{segment.originalText}</p>
      {segment.translatedText === null ? (
        <p className="transcript2__translation transcript2__translation--missing">Sin traducción.</p>
      ) : sameLanguage ? (
        <p className="transcript2__translation transcript2__translation--missing">Ya estaba en {langName(segment.translatedLang)}.</p>
      ) : (
        <p className="transcript2__translation">
          <span className="chip chip--neutral">→ {langName(segment.translatedLang)}</span> {segment.translatedText}
        </p>
      )}
    </div>
  );
}

interface CallDetailProps {
  id: string;
  onClose: () => void;
}

/** Summary, recording player, two-column transcript (Pasajero / Operador) and the .txt export of one call. */
export function CallDetail({ id, onClose }: CallDetailProps) {
  const [detail, setDetail] = useState<CallDetailResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setDetail(null);
    setError(null);
    api
      .getCall(id)
      .then((response) => {
        if (!cancelled) setDetail(response);
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        if (logoutIfSessionExpired(cause)) return;
        const failure = asApiFailure(cause);
        setError(
          failure.status === 404
            ? 'No se encuentra esa llamada. Un operador solo puede ver sus propias llamadas.'
            : describeApiError(cause, 'No se pudo cargar la llamada'),
        );
      });
    return () => {
      cancelled = true;
    };
  }, [id]);

  if (error) {
    return (
      <section className="card" aria-label="Detalle de la llamada" data-testid="call-detail">
        <p className="notice notice--danger" role="alert">
          {error}
        </p>
        <div className="card__footer">
          <button type="button" className="button" onClick={onClose}>
            Cerrar
          </button>
        </div>
      </section>
    );
  }
  if (!detail) {
    return (
      <section className="card" aria-label="Detalle de la llamada" aria-busy="true" data-testid="call-detail">
        <p className="loading">Cargando la llamada…</p>
      </section>
    );
  }

  const { call, segments } = detail;
  const duration = callDurationSeconds(call);
  const ordered = [...segments].sort((a, b) => a.startMs - b.startMs || a.createdAt - b.createdAt);

  return (
    <section className="card history__detail" aria-labelledby="call-detail-title" data-testid="call-detail">
      <header className="card__header">
        <div>
          <h3 className="card__title" id="call-detail-title">
            {call.direction === 'local' ? 'Audio del PC' : DIRECTION_LABELS[call.direction]} · <span className="mono">{call.remoteNumber}</span>
          </h3>
          <p className="card__subtitle">{formatDateTime(call.createdAt)}</p>
        </div>
        <div className="row">
          <button
            type="button"
            className="button"
            onClick={() => downloadTextFile(transcriptFileName(call), transcriptToText(call, segments))}
            data-testid="export-transcript"
          >
            Exportar transcripción (.txt)
          </button>
          <button type="button" className="button button--ghost" onClick={onClose}>
            Cerrar
          </button>
        </div>
      </header>

      <dl className="kv">
        <dt>Duración</dt>
        <dd>{duration === null ? 'No contestada' : formatDuration(duration)}</dd>
        <dt>Idioma del pasajero</dt>
        <dd>{call.passengerLang ? langName(call.passengerLang) : 'Desconocido'}</dd>
        <dt>Fin</dt>
        <dd>{call.endReason ? END_REASON_LABELS[call.endReason] : call.state === 'ended' ? '—' : 'En curso'}</dd>
        <dt>Identificador</dt>
        <dd className="mono">{call.id}</dd>
      </dl>

      <AudioPlayer callId={call.id} recorded={call.recorded} />

      <div className="transcript2" data-testid="transcript">
        <div className="transcript2__head transcript2__head--passenger">Pasajero</div>
        <div className="transcript2__head transcript2__head--operator">Operador</div>
        {ordered.length === 0 ? <p className="empty transcript2__empty">Esta llamada no tiene transcripción.</p> : null}
        {ordered.map((segment) => (
          <div key={segment.id} className="transcript2__row" data-speaker={segment.speaker}>
            <div className="transcript2__cell" aria-label={segment.speaker === 'passenger' ? 'Pasajero' : undefined}>
              {segment.speaker === 'passenger' ? <SegmentCell segment={segment} /> : null}
            </div>
            <div className="transcript2__cell" aria-label={segment.speaker === 'operator' ? 'Operador' : undefined}>
              {segment.speaker === 'operator' ? <SegmentCell segment={segment} /> : null}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
