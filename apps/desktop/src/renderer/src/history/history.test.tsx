import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../core/http', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../core/http')>();
  return { ...actual, api: { listCalls: vi.fn(), getCall: vi.fn(), getCallAudio: vi.fn() } };
});

import { ApiError, api } from '../core/http';
import { resetSessionForTests } from '../core/session';
import { ADMIN, OPERATOR, fakeClient, loginAs, makeCallRecord, makeSegment, readBlobText, renderWithClient } from '../app/test-utils';
import { transcriptFileName, transcriptToText } from './export';
import { HistoryPage, applyFilters, buildQuery } from './HistoryPage';

const inbound = makeCallRecord();
const local = makeCallRecord({
  id: 'call-2',
  direction: 'local',
  remoteNumber: 'WhatsApp - Sra. Dubois',
  passengerLang: 'fr',
  recorded: false,
  createdAt: inbound.createdAt - 3_600_000,
  answeredAt: null,
  endedAt: null,
  endReason: 'cancelled',
});
const segments = [
  makeSegment(),
  makeSegment({ id: 'seg-2', speaker: 'operator', originalLang: 'es', originalText: 'voy a comprobarlo', translatedLang: 'en', translatedText: 'I will check it', startMs: 6_000 }),
  makeSegment({ id: 'seg-3', originalText: 'thank', translatedText: null, translatedLang: null, final: false, startMs: 9_000 }),
];

const objectUrls: string[] = [];

beforeEach(() => {
  resetSessionForTests();
  vi.clearAllMocks();
  objectUrls.length = 0;
  vi.mocked(api.listCalls).mockResolvedValue({ calls: [inbound, local] });
  vi.mocked(api.getCall).mockImplementation(async (id) => {
    if (id === inbound.id) return { call: inbound, segments };
    if (id === local.id) return { call: local, segments: [] };
    throw new ApiError(404, 'not_found', 'No se encuentra esa llamada');
  });
  vi.mocked(api.getCallAudio).mockResolvedValue(new Blob(['RIFF'], { type: 'audio/wav' }));
  let counter = 0;
  URL.createObjectURL = vi.fn(() => {
    const url = `blob:mock-${++counter}`;
    objectUrls.push(url);
    return url;
  });
  URL.revokeObjectURL = vi.fn();
  loginAs(OPERATOR);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('filters', () => {
  it('sends the server only what it understands and filters the rest locally', () => {
    const base = { from: '', to: '', q: '', direction: 'all' as const, operatorId: '' };
    expect(buildQuery(base)).toEqual({ limit: 200 });
    expect(buildQuery({ ...base, direction: 'inbound' })).toEqual({ limit: 200, direction: 'inbound' });
    // "Audio del PC" calls are a direction the server filters too.
    expect(buildQuery({ ...base, direction: 'local' })).toEqual({ limit: 200, direction: 'local' });
    const dated = buildQuery({ ...base, from: '2026-10-20', to: '2026-10-20', q: ' 1234 ' });
    expect(dated.q).toBe('1234');
    expect(dated.from).toBe(new Date(2026, 9, 20).getTime());
    expect(dated.to).toBe(new Date(2026, 9, 20, 23, 59, 59, 999).getTime());

    expect(applyFilters([inbound, local], { ...base, direction: 'local' })).toEqual([local]);
    expect(applyFilters([inbound, local], { ...base, q: '44 1234' })).toEqual([inbound]);
    expect(applyFilters([inbound, local], { ...base, q: 'call-2' })).toEqual([local]);
  });
});

describe('<HistoryPage>', () => {
  it('lists the calls with readable direction, language, duration and recording', async () => {
    renderWithClient(<HistoryPage />, fakeClient());
    const rows = await screen.findAllByTestId('history-row');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent('Entrante');
    expect(rows[0]).toHaveTextContent('02:05');
    expect(rows[0]).toHaveTextContent('Inglés');
    expect(rows[0]).toHaveTextContent('Sí');
    expect(rows[1]).toHaveTextContent('Audio del PC');
    expect(rows[1]).toHaveTextContent('WhatsApp - Sra. Dubois');
    expect(rows[1]).toHaveTextContent('Francés');
    expect(rows[1]).toHaveTextContent('No');
    expect(screen.getByTestId('history-scope')).toHaveTextContent('Solo ves tus propias llamadas.');
    expect(api.listCalls).toHaveBeenCalledWith({ limit: 200 });
  });

  it('applies the filters and tells an admin the wider scope', async () => {
    resetSessionForTests();
    loginAs(ADMIN);
    renderWithClient(<HistoryPage />, fakeClient({ operator: ADMIN, presence: { operators: [OPERATOR, ADMIN], activeCalls: 0, maxCalls: 3 } }));
    await screen.findAllByTestId('history-row');
    expect(screen.getByTestId('history-scope')).toHaveTextContent('todos los operadores');

    fireEvent.change(screen.getByLabelText('Dirección'), { target: { value: 'local' } });
    fireEvent.change(screen.getByLabelText('Operador'), { target: { value: OPERATOR.id } });
    fireEvent.click(screen.getByRole('button', { name: 'Buscar' }));
    await waitFor(() => expect(api.listCalls).toHaveBeenLastCalledWith({ limit: 200, direction: 'local', operatorId: OPERATOR.id }));
    await waitFor(() => expect(screen.getAllByTestId('history-row')).toHaveLength(1));
    expect(screen.getByTestId('history-row')).toHaveTextContent('Audio del PC');

    fireEvent.change(screen.getByLabelText('Dirección'), { target: { value: 'outbound' } });
    fireEvent.click(screen.getByRole('button', { name: 'Buscar' }));
    await waitFor(() => expect(api.listCalls).toHaveBeenLastCalledWith({ limit: 200, direction: 'outbound', operatorId: OPERATOR.id }));
    expect(await screen.findByText('No hay llamadas que coincidan con los filtros.')).toBeInTheDocument();
  });

  it('opens the detail with the transcript in two columns and the audio of the chosen leg', async () => {
    renderWithClient(<HistoryPage />, fakeClient());
    const rows = await screen.findAllByTestId('history-row');
    fireEvent.click(within(rows[0]!).getByRole('button', { name: 'Ver' }));

    const detail = await screen.findByTestId('call-detail');
    await waitFor(() => expect(within(detail).getByTestId('transcript')).toBeInTheDocument());
    const transcript = within(detail).getByTestId('transcript');
    expect(transcript).toHaveTextContent('Pasajero');
    expect(transcript).toHaveTextContent('Operador');
    const transcriptRows = transcript.querySelectorAll('.transcript2__row');
    expect(transcriptRows).toHaveLength(3);
    expect(transcriptRows[0]!.getAttribute('data-speaker')).toBe('passenger');
    expect(transcriptRows[0]!.children[0]!.textContent).toContain('my flight was cancelled');
    expect(transcriptRows[0]!.children[0]!.textContent).toContain('mi vuelo fue cancelado');
    expect(transcriptRows[0]!.children[1]!.textContent).toBe('');
    expect(transcriptRows[1]!.getAttribute('data-speaker')).toBe('operator');
    expect(transcriptRows[1]!.children[0]!.textContent).toBe('');
    expect(transcriptRows[1]!.children[1]!.textContent).toContain('I will check it');
    expect(transcript).toHaveTextContent('Inglés');
    expect(transcript).toHaveTextContent('→ Español');
    expect(transcript).toHaveTextContent('provisional');
    expect(detail).toHaveTextContent('02:05');
    expect(detail).toHaveTextContent('Colgó el pasajero');

    const audio = await within(detail).findByTestId('audio-element');
    expect(api.getCallAudio).toHaveBeenCalledWith(inbound.id, 'mixed');
    expect(audio).toHaveAttribute('src', 'blob:mock-1');

    fireEvent.click(within(detail).getByRole('radio', { name: 'Pasajero' }));
    await waitFor(() => expect(api.getCallAudio).toHaveBeenCalledWith(inbound.id, 'passenger'));
    await waitFor(() => expect(within(detail).getByTestId('audio-element')).toHaveAttribute('src', 'blob:mock-2'));
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:mock-1');
  });

  it('says when there is no recording, both from the record and from a 404', async () => {
    renderWithClient(<HistoryPage />, fakeClient());
    const rows = await screen.findAllByTestId('history-row');
    fireEvent.click(within(rows[1]!).getByRole('button', { name: 'Ver' }));
    const detail = await screen.findByTestId('call-detail');
    expect(await within(detail).findByTestId('audio-missing')).toHaveTextContent('Esta llamada no tiene grabación.');
    expect(within(detail).getByText('Esta llamada no tiene transcripción.')).toBeInTheDocument();
    expect(detail).toHaveTextContent('No contestada');
    expect(api.getCallAudio).not.toHaveBeenCalled();

    vi.mocked(api.getCallAudio).mockRejectedValue(new ApiError(404, 'no_recording', 'Esta llamada no tiene grabación'));
    fireEvent.click(within(rows[0]!).getByRole('button', { name: 'Ver' }));
    await waitFor(() => expect(api.getCallAudio).toHaveBeenCalledWith(inbound.id, 'mixed'));
    expect(await screen.findByTestId('audio-missing')).toHaveTextContent('Esta llamada no tiene grabación.');
  });

  it('explains a 404 on the detail as "not yours"', async () => {
    vi.mocked(api.listCalls).mockResolvedValue({ calls: [makeCallRecord({ id: 'ajena' })] });
    renderWithClient(<HistoryPage />, fakeClient());
    fireEvent.click(within((await screen.findAllByTestId('history-row'))[0]!).getByRole('button', { name: 'Ver' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Un operador solo puede ver sus propias llamadas');
  });

  it('exports the transcript as a .txt download', async () => {
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    const blobs: Blob[] = [];
    vi.mocked(URL.createObjectURL).mockImplementation((blob) => {
      blobs.push(blob as Blob);
      return `blob:export-${blobs.length}`;
    });
    renderWithClient(<HistoryPage />, fakeClient());
    fireEvent.click(within((await screen.findAllByTestId('history-row'))[0]!).getByRole('button', { name: 'Ver' }));
    const button = await screen.findByTestId('export-transcript');
    await waitFor(() => expect(api.getCallAudio).toHaveBeenCalled());
    blobs.length = 0;
    fireEvent.click(button);

    expect(click).toHaveBeenCalledTimes(1);
    expect(blobs).toHaveLength(1);
    const text = await readBlobText(blobs[0]!);
    expect(text).toContain('Telecomway - Transcripción de llamada');
    expect(text).toContain(`Identificador: ${inbound.id}`);
    expect(text).toContain('Dirección: Entrante');
    expect(text).toContain('[00:01] Pasajero: [en] my flight was cancelled');
    expect(text).toContain('    -> [es] mi vuelo fue cancelado');
    expect(text).toContain('[00:06] Operador: [es] voy a comprobarlo');
    expect(text).not.toContain('thank'); // partials are not exported
  });
});

describe('export helpers', () => {
  it('names the file after the date and the number', () => {
    expect(transcriptFileName(inbound)).toMatch(/^telecomway-\d{8}-\d{4}-\+44_1234_567890\.txt$/);
  });

  it('writes a header and one line per final utterance', () => {
    const text = transcriptToText(local, []);
    expect(text).toContain('Etiqueta: WhatsApp - Sra. Dubois');
    expect(text).toContain('Duración: no contestada');
    expect(text).toContain('Idioma del pasajero: Francés (fr)');
    expect(text).toContain('(Sin transcripción)');
  });
});
