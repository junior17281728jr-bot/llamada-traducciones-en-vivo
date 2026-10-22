/**
 * React side of `CallClientApi`: a provider that owns the client's lifetime and the `useCall()` hook.
 * `createEmptyCallClient` is the Base-phase placeholder: it is disconnected, does nothing and
 * never reports a call. The real client replaces it through `createCallClient` in src/call.
 */
import { createContext, useContext, useEffect, useMemo, useSyncExternalStore, type ReactNode } from 'react';
import type { Speaker } from '@tw/shared';
import { useSession, type Session } from './session';
import {
  INITIAL_CALL_CLIENT_STATE,
  type CallActions,
  type CallClientApi,
  type CallClientState,
  type LevelSource,
} from './types';

const EMPTY_LEVELS: LevelSource = {
  capacity: 0,
  snapshot: () => [],
  subscribe: () => () => undefined,
  lastWindowAt: () => null,
};

const NOOP_ACTIONS: CallActions = {
  connect: () => undefined,
  disconnect: () => undefined,
  accept: () => undefined,
  reject: () => undefined,
  hangup: () => undefined,
  dial: () => undefined,
  setLanguages: () => undefined,
  setMode: () => undefined,
  mute: () => undefined,
  debugSay: () => undefined,
  dismissEndedCall: () => undefined,
};

/** Placeholder client: always disconnected, no calls, no audio. */
export function createEmptyCallClient(): CallClientApi {
  return {
    getState: () => INITIAL_CALL_CLIENT_STATE,
    subscribe: () => () => undefined,
    levels: { passenger: EMPTY_LEVELS, operator: EMPTY_LEVELS } satisfies Record<Speaker, LevelSource>,
    actions: NOOP_ACTIONS,
  };
}

const CallContext = createContext<CallClientApi | null>(null);

export type CallClientFactory = (session: Session) => CallClientApi;

interface CallProviderProps {
  /** Builds the client for a logged-in session. Defaults to the empty placeholder. */
  factory?: CallClientFactory;
  children: ReactNode;
}

/**
 * Creates one client per login session, connects it while mounted and disconnects it on logout.
 * Without a session the empty client is provided, so `useCall()` always works.
 */
export function CallProvider({ factory = createEmptyCallClient, children }: CallProviderProps) {
  const session = useSession();
  const token = session?.token ?? null;
  const client = useMemo<CallClientApi>(
    () => (session ? factory(session) : createEmptyCallClient()),
    // A new client only when the login changes (token), not on every session object identity change.
    [token, factory],
  );

  useEffect(() => {
    if (!token) return undefined;
    client.actions.connect();
    return () => client.actions.disconnect();
  }, [client, token]);

  return <CallContext.Provider value={client}>{children}</CallContext.Provider>;
}

export interface UseCall {
  state: CallClientState;
  levels: CallClientApi['levels'];
  actions: CallActions;
}

/** State, level sources and actions of the call client. */
export function useCall(): UseCall {
  const client = useContext(CallContext);
  if (!client) throw new Error('useCall() must be used inside <CallProvider>');
  const state = useSyncExternalStore(client.subscribe, client.getState, client.getState);
  return useMemo(() => ({ state, levels: client.levels, actions: client.actions }), [state, client]);
}
