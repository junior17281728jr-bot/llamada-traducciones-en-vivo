import type { PipelineStage } from '@tw/shared';

const LABELS: Record<PipelineStage, string> = {
  idle: 'Inactivo',
  receiving: 'Recibiendo voz',
  transcribing: 'Transcribiendo',
  translating: 'Traduciendo',
  speaking: 'Reproduciendo traducción',
  error: 'Error',
};

const ORDER: PipelineStage[] = ['receiving', 'transcribing', 'translating', 'speaking'];

interface StageChipsProps {
  stage: PipelineStage;
  detail?: string | null;
}

/** Four steps in order; the current one is lit. `Error` and `Inactivo` replace the row of steps. */
export function StageChips({ stage, detail }: StageChipsProps) {
  if (stage === 'error') {
    return (
      <p className="stage stage--error" role="status" data-stage="error">
        <span className="chip chip--danger">{LABELS.error}</span>
        {detail ? <span className="stage__detail">{detail}</span> : null}
      </p>
    );
  }
  return (
    <ul className="stage" aria-label="Estado de la traducción" data-stage={stage}>
      {stage === 'idle' ? (
        <li className="chip chip--idle" aria-current="true">
          {LABELS.idle}
        </li>
      ) : (
        ORDER.map((step) => (
          <li key={step} className={`chip${step === stage ? ' chip--on' : ''}`} aria-current={step === stage ? 'true' : undefined}>
            {LABELS[step]}
          </li>
        ))
      )}
    </ul>
  );
}

export { LABELS as STAGE_LABELS };
