import { act, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { OperatorInfo } from '@tw/shared';
import { App } from '../App';
import { CallProvider, createEmptyCallClient, useCall } from './CallContext';
import { clearSession, resetSessionForTests, setSession } from './session';
import { INITIAL_CALL_CLIENT_STATE, type CallClientApi } from './types';

const operator: OperatorInfo = {
  id: 'op1',
  name: 'Ana',
  role: 'operator',
  status: 'available',
  currentCallId: null,
  autoAccept: false,
};

function Probe() {
  const { state } = useCall();
  return <p data-testid="probe">{`${state.connection}|${state.call ? 'call' : 'idle'}`}</p>;
}

describe('empty call client', () => {
  it('is disconnected, has no call and flat level sources', () => {
    const client = createEmptyCallClient();
    expect(client.getState()).toEqual(INITIAL_CALL_CLIENT_STATE);
    for (const lane of [client.levels.passenger, client.levels.operator]) {
      expect(lane.snapshot()).toEqual([]);
      expect(lane.lastWindowAt()).toBeNull();
    }
    expect(() => client.actions.hangup()).not.toThrow();
  });
});

describe('<CallProvider> / useCall()', () => {
  beforeEach(() => resetSessionForTests());

  it('provides the empty client when nobody is logged in', () => {
    render(
      <CallProvider>
        <Probe />
      </CallProvider>,
    );
    expect(screen.getByTestId('probe')).toHaveTextContent('disconnected|idle');
  });

  it('refuses to be used outside the provider', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(() => render(<Probe />)).toThrow(/CallProvider/);
    error.mockRestore();
  });

  it('builds one client per login, connects it and disconnects it on logout', () => {
    const connect = vi.fn();
    const disconnect = vi.fn();
    const factory = vi.fn((): CallClientApi => ({ ...createEmptyCallClient(), actions: { ...createEmptyCallClient().actions, connect, disconnect } }));
    render(
      <CallProvider factory={factory}>
        <Probe />
      </CallProvider>,
    );
    expect(factory).not.toHaveBeenCalled();

    act(() => setSession({ serverUrl: 'http://srv', token: 't1', expiresAt: Date.now() + 60_000, operator }));
    expect(factory).toHaveBeenCalledTimes(1);
    expect(connect).toHaveBeenCalledTimes(1);

    act(() => clearSession());
    expect(disconnect).toHaveBeenCalledTimes(1);
  });
});

describe('<App>', () => {
  beforeEach(() => resetSessionForTests());

  it('mounts the shell: without a session it asks the operator to log in', () => {
    render(<App />);
    expect(screen.getByRole('heading', { name: 'Telecomway' })).toBeInTheDocument();
    expect(screen.getByTestId('login-screen')).toBeInTheDocument();
  });
});
