import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LanguageCatalog } from '@tw/shared';

/** Only English and French are confirmed for every service; German lacks translation, Spanish lacks STT. */
const SMALL_CATALOG: LanguageCatalog = {
  source: 'live',
  fetchedAt: Date.UTC(2026, 9, 23),
  languages: [
    { code: 'en', stt: true, tts: true, translate: true },
    { code: 'fr', stt: true, tts: true, translate: true },
    { code: 'de', stt: true, tts: true, translate: false },
    { code: 'es', stt: false, tts: true, translate: true },
  ],
};

vi.mock('../core/http', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../core/http')>();
  return { ...actual, api: { getLanguages: vi.fn(async () => SMALL_CATALOG) } };
});

import { resetCatalogCache } from '../core/catalog';
import { resetSessionForTests } from '../core/session';
import { Dialer, dialErrorHelp, dialLanguages, validatePhoneNumber } from './Dialer';
import { fakeClient, loginAs, makeActiveCall, renderWithClient } from './test-utils';

beforeEach(() => {
  resetSessionForTests();
  resetCatalogCache();
  loginAs();
});

const optionTexts = (select: HTMLElement): string[] => within(select).getAllByRole('option').map((option) => option.textContent ?? '');

describe('phone number validation', () => {
  it('accepts the formats the server accepts and rejects the rest', () => {
    expect(validatePhoneNumber('+34 600 000 000')).toBeNull();
    expect(validatePhoneNumber('(555) 010-0100')).toBeNull();
    expect(validatePhoneNumber('')).toMatch(/Escribe/);
    expect(validatePhoneNumber('12')).toMatch(/corto/);
    expect(validatePhoneNumber('+34 abc')).toMatch(/dígitos/);
    expect(validatePhoneNumber('+()')).toMatch(/tres dígitos/);
    expect(validatePhoneNumber('1'.repeat(33))).toMatch(/largo/);
  });
});

describe('language settings per mode', () => {
  it('builds the settings the server expects for each mode', () => {
    expect(dialLanguages('auto', 'fr', 'en')).toEqual({ passengerSpeaks: { mode: 'auto' }, passengerHears: { mode: 'follow' } });
    expect(dialLanguages('manual', 'fr', 'en')).toEqual({ passengerSpeaks: { mode: 'fixed', lang: 'fr' }, passengerHears: { mode: 'fixed', lang: 'en' } });
    expect(dialLanguages('manual', 'fr', null)).toEqual({ passengerSpeaks: { mode: 'fixed', lang: 'fr' }, passengerHears: { mode: 'fixed', lang: 'fr' } });
    expect(dialLanguages('mixed', null, 'fr')).toEqual({ passengerSpeaks: { mode: 'auto' }, passengerHears: { mode: 'fixed', lang: 'fr' } });
  });
});

describe('<Dialer>', () => {
  it('offers only the languages the catalogue confirms for each role', async () => {
    renderWithClient(<Dialer />, fakeClient());
    fireEvent.click(screen.getByRole('radio', { name: 'Manual' }));
    const speaks = await screen.findByLabelText('El pasajero habla');
    // Spoken language needs STT + translation: Spanish (no STT) and German (no translation) are out.
    await waitFor(() => expect(optionTexts(speaks)).toEqual(['Inglés', 'Francés']));
    expect(within(speaks).queryByRole('option', { name: 'Español' })).toBeNull();
    // Voice language needs TTS + translation: Spanish qualifies, German still does not.
    expect(optionTexts(screen.getByLabelText('El pasajero te oye en'))).toEqual(['Español', 'Inglés', 'Francés']);
    expect(screen.queryByRole('option', { name: 'Alemán' })).toBeNull();

    fireEvent.click(screen.getByRole('radio', { name: 'Mixto' }));
    expect(screen.queryByLabelText('El pasajero habla')).toBeNull();
    expect(screen.getByLabelText('El pasajero te oye en')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('radio', { name: 'Automático' }));
    expect(screen.queryByLabelText('El pasajero te oye en')).toBeNull();
  });

  it('dials with the number and the chosen languages', async () => {
    const fake = fakeClient();
    renderWithClient(<Dialer />, fake);
    fireEvent.change(screen.getByLabelText('Número del pasajero'), { target: { value: '+34 600 000 000' } });
    fireEvent.click(screen.getByRole('radio', { name: 'Manual' }));
    const speaks = await screen.findByLabelText('El pasajero habla');
    await waitFor(() => expect(optionTexts(speaks).length).toBe(2));
    fireEvent.change(speaks, { target: { value: 'fr' } });
    fireEvent.click(screen.getByRole('button', { name: 'Llamar' }));
    expect(fake.actions.dial).toHaveBeenCalledWith('+34 600 000 000', {
      passengerSpeaks: { mode: 'fixed', lang: 'fr' },
      passengerHears: { mode: 'fixed', lang: 'en' },
    });
  });

  it('dials in automatic mode with detection on', () => {
    const fake = fakeClient();
    renderWithClient(<Dialer />, fake);
    fireEvent.change(screen.getByLabelText('Número del pasajero'), { target: { value: '+44 20 7946 0000' } });
    fireEvent.click(screen.getByRole('button', { name: 'Llamar' }));
    expect(fake.actions.dial).toHaveBeenCalledWith('+44 20 7946 0000', { passengerSpeaks: { mode: 'auto' }, passengerHears: { mode: 'follow' } });
  });

  it('does not dial an invalid number and explains why', () => {
    const fake = fakeClient();
    renderWithClient(<Dialer />, fake);
    fireEvent.change(screen.getByLabelText('Número del pasajero'), { target: { value: 'hola' } });
    fireEvent.click(screen.getByRole('button', { name: 'Llamar' }));
    expect(fake.actions.dial).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent(/dígitos/);
    expect(screen.getByLabelText('Número del pasajero')).toHaveAttribute('aria-invalid', 'true');
  });

  it('dials once per click: Llamar stays disabled until the server answers with a call or an error', async () => {
    const fake = fakeClient({ connection: 'connected' });
    renderWithClient(<Dialer />, fake);
    fireEvent.change(screen.getByLabelText('Número del pasajero'), { target: { value: '+34600000000' } });
    const button = screen.getByRole('button', { name: 'Llamar' });
    fireEvent.click(button);
    expect(fake.actions.dial).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: 'Llamando…' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Llamando…' }));
    expect(fake.actions.dial).toHaveBeenCalledTimes(1);
    // The server refused: the button comes back.
    fake.set({ lastError: { code: 'dial_failed', message: 'No se pudo realizar la llamada', at: Date.now() } });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Llamar' })).toBeEnabled());
  });

  it('is disabled without a connection and during a call', () => {
    const fake = fakeClient({ connection: 'disconnected' });
    renderWithClient(<Dialer />, fake);
    expect(screen.getByRole('button', { name: 'Llamar' })).toBeDisabled();
    expect(screen.getByTestId('dialer-blocked')).toHaveTextContent('Sin conexión con el servidor');

    fake.set({ connection: 'connected', call: makeActiveCall() });
    expect(screen.getByRole('button', { name: 'Llamar' })).toBeDisabled();
    expect(screen.getByTestId('dialer-blocked')).toHaveTextContent('Ya tienes una llamada en curso');

    fake.set({ call: null, presence: { operators: [], activeCalls: 3, maxCalls: 3 } });
    expect(screen.getByTestId('dialer-blocked')).toHaveTextContent('Todas las líneas están ocupadas (3 de 3)');
  });

  it('explains the WhatsApp permission rule, the call limit and a busy operator', () => {
    const fake = fakeClient({
      presence: { operators: [], activeCalls: 3, maxCalls: 3 },
      lastError: { code: 'dial_permission_required', message: 'El pasajero no ha dado permiso', at: Date.now() },
    });
    renderWithClient(<Dialer />, fake);
    const error = screen.getByTestId('dialer-error');
    expect(error).toHaveTextContent('El pasajero no ha dado permiso');
    const help = within(error).getByTestId('dialer-error-help');
    expect(help).toHaveTextContent(/WhatsApp solo permite llamar a un pasajero que haya dado permiso antes/);
    expect(help).toHaveTextContent('1 llamada al día y 2 por semana por pasajero');
    fireEvent.click(within(error).getByRole('button', { name: 'Entendido' }));
    expect(fake.actions.dismissError).toHaveBeenCalled();

    fake.set({ lastError: { code: 'max_calls_reached', message: 'Límite alcanzado', at: Date.now() } });
    expect(screen.getByTestId('dialer-error-help')).toHaveTextContent('Ya hay 3 llamadas en curso, el máximo del sistema');

    fake.set({ lastError: { code: 'operator_busy', message: 'Ocupado', at: Date.now() } });
    expect(screen.getByTestId('dialer-error-help')).toHaveTextContent('Cuélgala antes de marcar otra');

    expect(dialErrorHelp({ code: 'internal_error', message: 'x', at: 0 }, 3)).toBeNull();
  });
});
