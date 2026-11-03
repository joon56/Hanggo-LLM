import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer } from 'ws';
import { z } from 'zod';
import { captionOf } from '../../src/domain/coaching.ts';
import type { Consultation, Speaker, SpeechStatus } from '../../src/domain/coaching.ts';
import { can } from '../../src/domain/permissions.ts';
import type { Actor } from '../../src/domain/permissions.ts';
import type { CoachingStore } from './store.ts';

const MAX_MESSAGE_BYTES = 64 * 1024;
const MAX_MESSAGES_PER_SECOND = 50;
const REPLACED = 4001;
const PATH = /^\/api\/coaching\/consultations\/([^/]+)\/signal$/;

const ClientMessage = z.discriminatedUnion('type', [
  z.object({ type: z.literal('ping'), at: z.number() }).strict(),
  z.object({ type: z.enum(['offer', 'answer']), sdp: z.string().min(1) }).strict(),
  z.object({ type: z.literal('candidate'), candidate: z.record(z.string(), z.unknown()).nullable() }).strict(),
  z.object({ type: z.literal('media'), camera: z.boolean(), microphone: z.boolean(), screen: z.boolean() }).strict(),
]);

type Member = { socket: WebSocket; call: string };
type Room = { members: Partial<Record<Speaker, Member>>; lastCall: Partial<Record<Speaker, string>> };
type Deps = { store: CoachingStore; allowedOrigins: Set<string>; resolveActor: (headers: { cookie?: string }) => Promise<Actor | null>; speechStatus?: () => SpeechStatus; now?: () => number };

const other = (role: Speaker): Speaker => role === 'trainer' ? 'guardian' : 'trainer';

/** Relays negotiation and consultation state. Media never passes through this server. */
export function attachSignal(server: Server, { store, allowedOrigins, resolveActor, speechStatus = () => 'off', now = Date.now }: Deps) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES });
  const rooms = new Map<string, Room>();
  const roomFor = (id: string) => { let room = rooms.get(id); if (!room) { room = { members: {}, lastCall: {} }; rooms.set(id, room); } return room; };
  const send = (socket: WebSocket | undefined, message: unknown) => { if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message)); };
  const stateMessage = (consultation: Consultation, room: Room, role: Speaker) => ({ type: 'state', consent: consultation.consent, recording: consultation.recording, recordingStartedAt: consultation.recordingStartedAt, state: consultation.state, peerOnline: !!room.members[other(role)] });

  function refuse(socket: Duplex, status: number) {
    socket.end(`HTTP/1.1 ${status} ${status === 401 ? 'Unauthorized' : status === 403 ? 'Forbidden' : status === 404 ? 'Not Found' : 'Conflict'}\r\nConnection: close\r\n\r\n`);
  }

  async function authorize(request: IncomingMessage, id: string): Promise<{ role: Speaker } | { status: number }> {
    if (!request.headers.origin || !allowedOrigins.has(request.headers.origin)) return { status: 403 };
    const actor = await resolveActor(request.headers);
    if (!actor) return { status: 401 };
    const consultation = await store.getConsultation(id).catch(() => null);
    if (!consultation) return { status: 404 };
    if (!can(actor, 'call:join', consultation.caseId)) return { status: 403 };
    if (consultation.state !== 'live') return { status: 409 };
    return { role: actor.role };
  }

  function join(socket: WebSocket, id: string, role: Speaker, call: string) {
    const room = roomFor(id);
    const previous = room.members[role];
    const isRejoin = room.lastCall[role] !== undefined && room.lastCall[role] !== call;
    const isFirst = room.lastCall[role] === undefined;
    room.members[role] = { socket, call }; room.lastCall[role] = call;
    if (previous) previous.socket.close(REPLACED, 'Replaced by a newer connection.');
    const peer = room.members[other(role)];
    send(socket, { type: 'hello', role, serverNow: now(), peerOnline: !!peer });
    // A new call means a new RTCPeerConnection, so the peer must rebuild. A socket reconnect keeps the media path alive.
    if (peer && (isFirst || isRejoin)) send(peer.socket, { type: 'peer-joined' });
    void store.getConsultation(id).then(consultation => {
      send(socket, stateMessage(consultation, room, role));
      send(peer?.socket, stateMessage(consultation, room, other(role)));
      send(socket, { type: 'speech', status: speechStatus() });
      const settled = consultation.segments.filter(segment => segment.state !== 'queued');
      if (settled.length) send(socket, { type: 'caption', replay: true, segments: settled.map(captionOf) });
    }, () => {});

    let windowStart = now(); let count = 0;
    socket.on('message', raw => {
      if (now() - windowStart >= 1000) { windowStart = now(); count = 0; }
      if (++count > MAX_MESSAGES_PER_SECOND) { socket.close(1008, 'Too many messages.'); return; }
      let parsed: unknown;
      try { parsed = JSON.parse(String(raw)); } catch { send(socket, { type: 'error', code: 'INPUT' }); return; }
      const message = ClientMessage.safeParse(parsed);
      if (!message.success) { send(socket, { type: 'error', code: 'INPUT' }); return; }
      if (message.data.type === 'ping') send(socket, { type: 'pong', at: message.data.at, serverNow: now() });
      else send(room.members[other(role)]?.socket, message.data);
    });
    // ws closes the socket itself with the matching status code. Without a listener the error would crash the process.
    socket.on('error', () => {});
    socket.on('close', () => {
      if (room.members[role]?.socket !== socket) return;
      delete room.members[role];
      const remaining = room.members[other(role)];
      if (!remaining) return;
      void store.getConsultation(id).then(consultation => send(remaining.socket, stateMessage(consultation, room, other(role))), () => {});
    });
  }

  const onUpgrade = (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    const id = PATH.exec(url.pathname)?.[1];
    if (!id) { refuse(socket, 404); return; }
    const call = url.searchParams.get('call');
    if (!call || call.length > 100) { refuse(socket, 403); return; }
    void authorize(request, id).then(result => {
      if ('status' in result) { refuse(socket, result.status); return; }
      wss.handleUpgrade(request, socket, head, client => join(client, id, result.role, call));
    }, () => refuse(socket, 403));
  };
  server.on('upgrade', onUpgrade);

  return {
    broadcast(consultationId: string, message: unknown) {
      const room = rooms.get(consultationId);
      for (const role of ['trainer', 'guardian'] as const) send(room?.members[role]?.socket, message);
    },
    notify(consultation: Consultation) {
      const room = rooms.get(consultation.id);
      if (!room) return;
      for (const role of ['trainer', 'guardian'] as const) {
        const member = room.members[role];
        send(member?.socket, stateMessage(consultation, room, role));
        if (consultation.state !== 'live') member?.socket.close(1000, 'Consultation ended.');
      }
      if (consultation.state !== 'live') rooms.delete(consultation.id);
    },
    close() {
      server.off('upgrade', onUpgrade);
      for (const client of wss.clients) client.terminate();
      wss.close();
    },
  };
}
