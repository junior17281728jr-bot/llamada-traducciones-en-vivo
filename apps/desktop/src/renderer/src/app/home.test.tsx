import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NO_FALLBACK, type ServiceStatus } from '@tw/shared';
import { CallBanners } from '../call/CallBanners';
import { INITIAL_WATCH_STATE, type CallActions, type CallClientState, type WatchState } from '../core/types';
import { resetSessionForTests } from '../core/session';
import { HomePanel } from './HomePanel';
import { TopBar } from './TopBar';
import { ADMIN, fakeClient, loginAs, makeActiveCall, renderWithClient } from './test-utils';

const DESKTOP_SERVER = { providers: 'auto' as const, channel: 'mock' as const, debug: true, maxCalls: 3, localAudio: true };

function status(elevenlabs: ServiceStatus, translator: ServiceStatus): CallClientState['systemStatus'] {
  return { elevenlabs, translator, channel: 'simulated', detail: {} };
}

function home(watch: Partial<WatchState>, keys: [ServiceStatus, ServiceStatus] = ['unconfigured', 'unconfigured']) {
  const fake = fakeClient({ server: DESKTOP_SERVER, watch: { ...INITIAL_WATCH_STATE, ...watch }, systemStatus: status(...keys) });
  const onOpenSettings = vi.fn();
  renderWithClient(<HomePanel state={fake.client.getState()} onOpenSettings={onOpenSettings} />, fake);
  return { fake, onOpenSettings };
}

beforeEach(() => {
  resetSessionForTests();
  loginAs(ADMIN);
});

describe('home screen of the desktop app', () => {
  it('says it is waiting for WhatsApp calls and shows the cable meter', () => {
    home({ status: 'listening', enabled: true, level: 0.05 });
    expect(screen.getByTestId('whatsapp-card')).toHaveAttribute('data-status', 'listening');
    expect(screen.getByRole('heading', { name: 'Esperando llamadas de WhatsApp' })).toBeInTheDocument();
    expect(screen.getByRole('meter')).toHaveAttribute('aria-valuenow', '20');
  });

  it('guides the setup in three steps and sends each button to the right place', () => {
    const { fake, onOpenSettings } = home({ status: 'needs_setup', enabled: false });
    expect(screen.getByRole('heading', { name: 'Falta conectar WhatsApp' })).toBeInTheDocument();
    expect(screen.getByText('Te faltan 3 pasos.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Poner claves' }));
    expect(onOpenSettings).toHaveBeenCalledWith('ajustes-claves');
    fireEvent.click(screen.getByRole('button', { name: 'Conectar' }));
    expect(onOpenSettings).toHaveBeenCalledWith('ajustes-audio');
    fireEvent.click(screen.getByRole('button', { name: 'Activar' }));
    expect(fake.actions.setAutoWhatsapp).toHaveBeenCalledWith(true);
    fireEvent.click(screen.getByTestId('home-auto-switch'));
    expect(fake.actions.setAutoWhatsapp).toHaveBeenCalledTimes(2);
  });

  it('collapses the guide into one green line once everything is ready, and warns about a key that failed', () => {
    home({ status: 'listening', enabled: true }, ['ok', 'configured']);
    expect(screen.getByTestId('setup-ready')).toHaveTextContent('Todo listo');
    expect(screen.queryByTestId('setup-guide')).toBeNull();
  });

  it('shows a failed key as a pending step', () => {
    home({ status: 'listening', enabled: true }, ['down', 'ok']);
    expect(screen.getByText('Una clave falló al probarla. Revísala en Ajustes.')).toBeInTheDocument();
  });

  it('the top bar says, in two chips, whether the translation is ready and what WhatsApp is doing', () => {
    const fake = fakeClient({ server: DESKTOP_SERVER, watch: { ...INITIAL_WATCH_STATE, status: 'listening' }, systemStatus: status('configured', 'unconfigured') });
    renderWithClient(<TopBar session={{ serverUrl: 'http://x', token: 't', expiresAt: 0, operator: ADMIN }} state={fake.client.getState()} loggingOut={false} onLogout={() => undefined} />, fake);
    expect(screen.getByTestId('service-translation')).toHaveTextContent('Traducción: Faltan claves');
    expect(screen.getByTestId('service-whatsapp')).toHaveTextContent('WhatsApp: Esperando llamadas');
    expect(screen.queryByRole('button', { name: 'Salir' })).toBeNull();
  });
});

describe('call banners', () => {
  const actions = { keepCall: vi.fn(), hangup: vi.fn() } as unknown as CallActions;

  it('counts down before closing a silent WhatsApp call, and lets the operator keep it', () => {
    render(<CallBanners call={makeActiveCall({ direction: 'local', autoEndAt: Date.now() + 8_000 })} actions={actions} />);
    expect(screen.getByTestId('auto-end-banner')).toHaveTextContent('La traducción se cerrará en 8 s');
    fireEvent.click(screen.getByRole('button', { name: 'Sigo en la llamada' }));
    expect(actions.keepCall).toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Terminar ya' }));
    expect(actions.hangup).toHaveBeenCalled();
  });

  it('explains the plan B in use from the operator side', () => {
    const fallback = {
      passengerToOperator: { systemVoice: false, originalVoice: true, detail: 'La traducción no responde: se oye la voz original, sin traducir.' },
      operatorToPassenger: { systemVoice: true, originalVoice: false, detail: null },
    };
    render(<CallBanners call={makeActiveCall({ fallback })} actions={actions} />);
    const banner = screen.getByTestId('fallback-banner');
    expect(banner).toHaveTextContent('Oyes la voz original del pasajero, sin traducir.');
    expect(banner).toHaveTextContent('El pasajero oye la traducción con la voz del ordenador.');
  });

  it('shows nothing while everything works', () => {
    const { container } = render(
      <CallBanners call={makeActiveCall({ fallback: { passengerToOperator: NO_FALLBACK, operatorToPassenger: NO_FALLBACK }, autoEndAt: null })} actions={actions} />,
    );
    expect(container).toBeEmptyDOMElement();
  });
});
