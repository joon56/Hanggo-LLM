import { getConsultation } from '../coaching-api';
import type { OutgoingSignal, SignalChannel, SignalHandler, SignalMessage } from './call-session';

const MAX_BACKOFF_MS = 8000;
// 1000 means the consultation ended, 4001 means a newer tab took over. Reconnecting would fight either one.
const FINAL_CLOSE_CODES = new Set([1000, 4001]);
const CONSULTATION_ENDED = 1000;
const CHECK_AFTER_FAILURES = 2;
const isConsultationOver = (id: string) => getConsultation(id).then(consultation => consultation.state !== 'live', () => false);

/** Reconnects through network blips. The `call` id tells the server this is still the same RTCPeerConnection. */
export function openSignal(consultationId: string, call: string, handler: SignalHandler, onClosedForGood?: (code: number) => void, isOver: () => Promise<boolean> = () => isConsultationOver(consultationId)): SignalChannel {
  const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
  const url = `${scheme}://${location.host}/api/coaching/consultations/${consultationId}/signal?call=${encodeURIComponent(call)}`;
  let socket: WebSocket | undefined;
  let closed = false; let attempts = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const pending: OutgoingSignal[] = [];

  function connect() {
    const current = new WebSocket(url);
    socket = current;
    current.onopen = () => { attempts = 0; for (const message of pending.splice(0)) current.send(JSON.stringify(message)); };
    current.onmessage = event => handler(JSON.parse(String(event.data)) as SignalMessage);
    current.onclose = event => {
      if (closed) return;
      if (FINAL_CLOSE_CODES.has(event.code)) { closed = true; onClosedForGood?.(event.code); return; }
      const retry = () => { timer = setTimeout(connect, Math.min(MAX_BACKOFF_MS, 500 * 2 ** attempts++)); };
      if (attempts < CHECK_AFTER_FAILURES) { retry(); return; }
      // A refused reconnect looks like any other network failure, and the trainer may have ended the consultation meanwhile.
      void isOver().then(over => {
        if (closed) return;
        if (!over) { retry(); return; }
        closed = true; onClosedForGood?.(CONSULTATION_ENDED);
      });
    };
  }
  connect();

  return {
    send(message) {
      if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
      else pending.push(message);
    },
    close() { closed = true; clearTimeout(timer); socket?.close(1000); },
  };
}
