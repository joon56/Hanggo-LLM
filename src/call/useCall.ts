import { useEffect, useRef, useSyncExternalStore } from 'react';
import type { Speaker } from '../domain/coaching';
import { CallSession } from './call-session';
import { openSignal } from './signal-client';

type Options = { consultationId: string; role: Speaker; iceServers: RTCIceServer[]; localStream: MediaStream; forceRelay?: boolean; onClosedForGood?: (code: number) => void };

export function useCall(options: Options) {
  const session = useRef<CallSession | null>(null);
  const listeners = useRef(new Set<() => void>());
  if (!session.current) {
    const call = crypto.randomUUID();
    session.current = new CallSession({ ...options,
      openSignal: handler => openSignal(options.consultationId, call, handler, options.onClosedForGood),
      onChange: () => listeners.current.forEach(listener => listener()) });
    session.current.start();
  }
  const current = session.current;
  useEffect(() => () => current.leave(), [current]);
  const snapshot = useSyncExternalStore(listener => { listeners.current.add(listener); return () => listeners.current.delete(listener); }, () => current.snapshot());
  return { ...snapshot, session: current };
}
