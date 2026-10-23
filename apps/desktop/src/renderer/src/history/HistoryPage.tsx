import './history.css';
import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from 'react';
import type { CallRecord, Direction, ListCallsQuery } from '@tw/shared';
import { describeApiError, logoutIfSessionExpired } from '../app/errors';
import { callDurationSeconds, dateInputToEpoch, formatDateTime, formatDuration } from '../app/format';
import { DIRECTION_LABELS, langName } from '../app/labels';
import { useCall } from '../core/CallContext';
import { api } from '../core/http';
import { useSession } from '../core/session';
import { CallDetail } from './CallDetail';

type DirectionFilter = 'all' | Direction;

export interface HistoryFilters {
  from: string;
  to: string;
  q: string;
  direction: DirectionFilter;
  /** Admin only: restrict to one operator. */
  operatorId: string;
}

const EMPTY_FILTERS: HistoryFilters = { from: '', to: '', q: '', direction: 'all', operatorId: '' };

/**
 * Query for `GET /api/calls`. The server also understands `from`, `to` and `q` (not yet in the shared
 * `ListCallsQuery`) and every direction, `local` ("Audio del PC") included; `applyFilters` repeats the
 * filters on the client so the list is right even if a server ignores one.
 */
export function buildQuery(filters: HistoryFilters): ListCallsQuery & { from?: number; to?: number; q?: string } {
  const query: ListCallsQuery & { from?: number; to?: number; q?: string } = { limit: 200 };
  if (filters.direction !== 'all') query.direction = filters.direction;
  const from = dateInputToEpoch(filters.from, 'start');
  const to = dateInputToEpoch(filters.to, 'end');
  if (from !== undefined) query.from = from;
  if (to !== undefined) query.to = to;
  const q = filters.q.trim();
  if (q) query.q = q;
  if (filters.operatorId) query.operatorId = filters.operatorId;
  return query;
}

/** Client-side pass so the list is right even when the server ignores a filter. */
export function applyFilters(calls: CallRecord[], filters: HistoryFilters): CallRecord[] {
  const from = dateInputToEpoch(filters.from, 'start');
  const to = dateInputToEpoch(filters.to, 'end');
  const q = filters.q.trim().toLowerCase().replace(/\s/g, '');
  return calls.filter((call) => {
    if (filters.direction !== 'all' && call.direction !== filters.direction) return false;
    if (from !== undefined && call.createdAt < from) return false;
    if (to !== undefined && call.createdAt > to) return false;
    if (q && !call.id.toLowerCase().includes(q) && !call.remoteNumber.toLowerCase().replace(/\s/g, '').includes(q)) return false;
    return true;
  });
}

/** Call history: filters, list and the detail of the chosen call. Operators only see their own calls. */
export function HistoryPage() {
  const session = useSession();
  const { state } = useCall();
  const ids = { from: useId(), to: useId(), q: useId(), direction: useId(), operator: useId() };
  const [draft, setDraft] = useState<HistoryFilters>(EMPTY_FILTERS);
  const [filters, setFilters] = useState<HistoryFilters>(EMPTY_FILTERS);
  const [calls, setCalls] = useState<CallRecord[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const detailRef = useRef<HTMLDivElement | null>(null);
  const isAdmin = session?.operator.role === 'admin';

  const load = useCallback((active: HistoryFilters) => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    api
      .listCalls(buildQuery(active))
      .then((response) => {
        if (!cancelled) setCalls(applyFilters(response.calls, active));
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        if (logoutIfSessionExpired(cause)) return;
        setError(describeApiError(cause, 'No se pudo cargar el historial'));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => load(filters), [filters, load]);

  // A call that just ended shows up in the list without touching the filters.
  const lastEndedCallId = state.call?.state === 'ended' ? state.call.callId : null;
  useEffect(() => {
    if (lastEndedCallId) setFilters((current) => ({ ...current }));
  }, [lastEndedCallId]);

  useEffect(() => {
    if (selectedId && detailRef.current && typeof detailRef.current.scrollIntoView === 'function') {
      detailRef.current.scrollIntoView({ block: 'start', behavior: 'smooth' });
    }
  }, [selectedId]);

  function submit(event: FormEvent): void {
    event.preventDefault();
    setFilters(draft);
  }

  function reset(): void {
    setDraft(EMPTY_FILTERS);
    setFilters(EMPTY_FILTERS);
  }

  const operators = state.presence?.operators ?? [];

  return (
    <section className="page history" aria-labelledby="history-title" data-testid="history">
      <header className="page__header">
        <h2 className="page__title" id="history-title">
          Historial
        </h2>
        <p className="muted small" data-testid="history-scope">
          {isAdmin ? 'Como administrador ves las llamadas de todos los operadores.' : 'Solo ves tus propias llamadas.'}
        </p>
      </header>

      <form className="card history__filters" onSubmit={submit} aria-label="Filtros del historial">
        <div className="form-grid">
          <label className="field" htmlFor={ids.from}>
            <span className="field__label">Desde</span>
            <input id={ids.from} type="date" value={draft.from} max={draft.to || undefined} onChange={(event) => setDraft({ ...draft, from: event.target.value })} />
          </label>
          <label className="field" htmlFor={ids.to}>
            <span className="field__label">Hasta</span>
            <input id={ids.to} type="date" value={draft.to} min={draft.from || undefined} onChange={(event) => setDraft({ ...draft, to: event.target.value })} />
          </label>
          <label className="field" htmlFor={ids.q}>
            <span className="field__label">Buscar por número o identificador</span>
            <input id={ids.q} type="search" value={draft.q} placeholder="+34 600… o id" onChange={(event) => setDraft({ ...draft, q: event.target.value })} />
          </label>
          <label className="field" htmlFor={ids.direction}>
            <span className="field__label">Dirección</span>
            <select id={ids.direction} value={draft.direction} onChange={(event) => setDraft({ ...draft, direction: event.target.value as DirectionFilter })}>
              <option value="all">Todas</option>
              <option value="inbound">{DIRECTION_LABELS.inbound}</option>
              <option value="outbound">{DIRECTION_LABELS.outbound}</option>
              <option value="local">{DIRECTION_LABELS.local}</option>
            </select>
          </label>
          {isAdmin && operators.length > 0 ? (
            <label className="field" htmlFor={ids.operator}>
              <span className="field__label">Operador</span>
              <select id={ids.operator} value={draft.operatorId} onChange={(event) => setDraft({ ...draft, operatorId: event.target.value })}>
                <option value="">Todos</option>
                {operators.map((operator) => (
                  <option key={operator.id} value={operator.id}>
                    {operator.name}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
        </div>
        <div className="form-actions">
          <button type="submit" className="button button--primary">
            Buscar
          </button>
          <button type="button" className="button button--ghost" onClick={reset}>
            Quitar filtros
          </button>
          <button type="button" className="button button--ghost" onClick={() => setFilters({ ...filters })} disabled={loading}>
            Actualizar
          </button>
          {loading ? <span className="loading">Cargando…</span> : null}
        </div>
      </form>

      {error ? (
        <p className="notice notice--danger" role="alert">
          {error}{' '}
          <button type="button" className="button button--small" onClick={() => setFilters({ ...filters })}>
            Reintentar
          </button>
        </p>
      ) : null}

      {calls && calls.length === 0 && !loading ? <p className="empty">No hay llamadas que coincidan con los filtros.</p> : null}

      {calls && calls.length > 0 ? (
        <div className="card history__list">
          <table className="table table--responsive" data-testid="history-table">
            <thead>
              <tr>
                <th scope="col">Fecha</th>
                <th scope="col">Duración</th>
                <th scope="col">Número o etiqueta</th>
                <th scope="col">Dirección</th>
                <th scope="col">Idioma del pasajero</th>
                <th scope="col">Grabación</th>
                <th scope="col">
                  <span className="sr-only">Acciones</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {calls.map((call) => {
                const duration = callDurationSeconds(call);
                const selected = call.id === selectedId;
                return (
                  <tr key={call.id} aria-selected={selected} data-testid="history-row">
                    <td data-label="Fecha">{formatDateTime(call.createdAt)}</td>
                    <td data-label="Duración" className="mono">
                      {duration === null ? '—' : formatDuration(duration)}
                    </td>
                    <td data-label="Número o etiqueta" className="mono">
                      {call.remoteNumber}
                    </td>
                    <td data-label="Dirección">{DIRECTION_LABELS[call.direction]}</td>
                    <td data-label="Idioma del pasajero">{call.passengerLang ? langName(call.passengerLang) : '—'}</td>
                    <td data-label="Grabación">{call.recorded ? 'Sí' : 'No'}</td>
                    <td className="table__actions">
                      <button type="button" className="button button--small" aria-pressed={selected} onClick={() => setSelectedId(selected ? null : call.id)}>
                        {selected ? 'Ocultar' : 'Ver'}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : null}

      <div ref={detailRef}>{selectedId ? <CallDetail id={selectedId} onClose={() => setSelectedId(null)} /> : null}</div>
    </section>
  );
}
