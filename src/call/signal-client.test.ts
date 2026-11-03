import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openSignal } from './signal-client';

class FakeSocket {
  static instances: FakeSocket[] = [];
  static readonly OPEN = 1;
  readyState = 0;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  constructor(readonly url: string) { FakeSocket.instances.push(this); }
  send(message: string) { this.sent.push(message); }
  close = vi.fn();
  open() { this.readyState = 1; this.onopen?.(); }
  drop(code = 1006) { this.readyState = 3; this.onclose?.({ code }); }
}
const latest = () => FakeSocket.instances.at(-1)!;
const flush = async () => { for (let index = 0; index < 8; index++) await Promise.resolve(); };

beforeEach(() => { FakeSocket.instances = []; vi.useFakeTimers(); vi.stubGlobal('WebSocket', FakeSocket); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

function open(isOver: () => Promise<boolean> = async () => false) {
  const handler = vi.fn(); const closedForGood = vi.fn();
  const channel = openSignal('consultation-1', 'call-1', handler, closedForGood, isOver);
  return { handler, closedForGood, channel };
}

describe('openSignal', () => {
  it('carries the call id, so the server can tell a reconnect from a new call', () => {
    open();
    expect(latest().url).toContain('/api/coaching/consultations/consultation-1/signal?call=call-1');
  });
  it('holds messages until the socket opens', () => {
    const { channel } = open();
    channel.send({ type: 'ping', at: 1 });
    expect(latest().sent).toEqual([]);
    latest().open();
    expect(latest().sent).toEqual([JSON.stringify({ type: 'ping', at: 1 })]);
  });
  it('reconnects with growing delays after a network drop', async () => {
    open();
    latest().drop(); await flush();
    expect(FakeSocket.instances).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(500);
    expect(FakeSocket.instances).toHaveLength(2);
    latest().drop(); await flush();
    await vi.advanceTimersByTimeAsync(500);
    expect(FakeSocket.instances).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(500);
    expect(FakeSocket.instances).toHaveLength(3);
  });
  for (const code of [1000, 4001]) it(`stops for good on close code ${code}`, async () => {
    const { closedForGood } = open();
    latest().drop(code); await flush();
    await vi.advanceTimersByTimeAsync(60000);
    expect(closedForGood).toHaveBeenCalledWith(code);
    expect(FakeSocket.instances).toHaveLength(1);
  });
  it('stops when reconnects keep failing because the consultation ended meanwhile', async () => {
    const isOver = vi.fn(async () => true);
    const { closedForGood } = open(isOver);
    latest().drop(); await flush();
    expect(isOver).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(500);
    latest().drop(); await flush();
    await vi.advanceTimersByTimeAsync(1000);
    latest().drop(); await flush();
    expect(closedForGood).toHaveBeenCalledWith(1000);
    const attempts = FakeSocket.instances.length;
    await vi.advanceTimersByTimeAsync(60000);
    expect(FakeSocket.instances).toHaveLength(attempts);
  });
  it('keeps trying when the consultation is still live or cannot be checked', async () => {
    const isOver = vi.fn(async () => false);
    const { closedForGood } = open(isOver);
    for (const wait of [500, 1000, 2000]) { latest().drop(); await flush(); await vi.advanceTimersByTimeAsync(wait); }
    expect(isOver).toHaveBeenCalled();
    expect(closedForGood).not.toHaveBeenCalled();
    expect(FakeSocket.instances).toHaveLength(4);
  });
  it('resets the delay once connected again', async () => {
    open();
    latest().drop(); await flush();
    await vi.advanceTimersByTimeAsync(500);
    latest().open();
    latest().drop(); await flush();
    await vi.advanceTimersByTimeAsync(500);
    expect(FakeSocket.instances).toHaveLength(3);
  });
  it('does not reconnect or report after being closed by the participant', async () => {
    const isOver = vi.fn(async () => true);
    const { channel, closedForGood } = open(isOver);
    channel.close();
    expect(latest().close).toHaveBeenCalledWith(1000);
    latest().drop(); await flush();
    await vi.advanceTimersByTimeAsync(60000);
    expect(closedForGood).not.toHaveBeenCalled();
    expect(FakeSocket.instances).toHaveLength(1);
  });
  it('forgets a pending check when the participant leaves during it', async () => {
    let answer!: (over: boolean) => void;
    const isOver = vi.fn(() => new Promise<boolean>(resolve => { answer = resolve; }));
    const { channel, closedForGood } = open(isOver);
    latest().drop(); await flush();
    await vi.advanceTimersByTimeAsync(500);
    latest().drop(); await flush();
    await vi.advanceTimersByTimeAsync(1000);
    latest().drop(); await flush();
    channel.close();
    answer(true); await flush();
    expect(closedForGood).not.toHaveBeenCalled();
  });
});
