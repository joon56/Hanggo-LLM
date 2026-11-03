import { useEffect, useRef, useSyncExternalStore } from 'react';
import type { Speaker } from '../domain/coaching';
import { ApiError } from '../api';
import { uploadAudio, uploadFrame } from '../coaching-api';
import { CallRecorder } from './call-recorder';
import { CallSession } from './call-session';
import { createGrabber, tapMicrophone } from './media-tools';
import { openSignal } from './signal-client';

const REPLACED_BY_NEWER_TAB = 4001;
type Options = { consultationId: string; role: Speaker; iceServers: RTCIceServer[]; localStream: MediaStream; forceRelay?: boolean; onClosedForGood?: (code: number) => void };

/** Refused requests come back the same however often they are sent. A busy server may have room later. */
const isPermanent = (error: unknown) => error instanceof ApiError && error.status >= 400 && error.status < 500 && error.status !== 429;

export function useCall(options: Options) {
  const session = useRef<CallSession | null>(null);
  const listeners = useRef(new Set<() => void>());
  if (!session.current) {
    const call = crypto.randomUUID();
    const { consultationId, role, localStream } = options;
    const recorder = new CallRecorder({ role, localStream, tapMicrophone, createGrabber, isPermanent,
      uploadAudio: window => uploadAudio(consultationId, window),
      uploadFrame: (frame, momentId) => uploadFrame(consultationId, frame, momentId),
      onLost: () => session.current?.noteUploadLost() });
    session.current = new CallSession({ ...options, recorder,
      openSignal: handler => openSignal(consultationId, call, handler, code => {
        // A newer tab now owns this seat, so this one must let go of the microphone and stop recording.
        if (code === REPLACED_BY_NEWER_TAB) session.current?.leave();
        options.onClosedForGood?.(code);
      }),
      onChange: () => listeners.current.forEach(listener => listener()) });
    session.current.start();
  }
  const current = session.current;
  useEffect(() => () => current.leave(), [current]);
  const snapshot = useSyncExternalStore(listener => { listeners.current.add(listener); return () => listeners.current.delete(listener); }, () => current.snapshot());
  return { ...snapshot, session: current };
}
