import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { UploadQueue } from './upload-queue';

const flush = async () => { for (let index = 0; index < 10; index++) await Promise.resolve(); };
beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

function build(send: (item: string) => Promise<unknown>, options: { limit?: number; isPermanent?: (error: unknown) => boolean } = {}) {
  const lost: string[] = [];
  const queue = new UploadQueue<string>({ send, retryDelaysMs: [10, 20], limit: options.limit ?? 10, isPermanent: options.isPermanent ?? (() => false), onLost: item => lost.push(item) });
  return { queue, lost };
}

describe('UploadQueue', () => {
  it('sends one item at a time in order', async () => {
    const started: string[] = []; const finish: (() => void)[] = [];
    const { queue } = build(item => { started.push(item); return new Promise<void>(resolve => finish.push(resolve)); });
    queue.add('a'); queue.add('b'); await flush();
    expect(started).toEqual(['a']);
    finish[0](); await flush();
    expect(started).toEqual(['a', 'b']);
  });
  it('retries a failed item before moving on', async () => {
    const send = vi.fn<(item: string) => Promise<unknown>>().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(undefined);
    const { queue, lost } = build(send);
    queue.add('a'); queue.add('b'); await flush();
    expect(send.mock.calls.map(call => call[0])).toEqual(['a']);
    await vi.advanceTimersByTimeAsync(10);
    expect(send.mock.calls.map(call => call[0])).toEqual(['a', 'a', 'b']);
    expect(lost).toEqual([]);
  });
  it('gives up after the last retry and continues with the next item', async () => {
    const send = vi.fn(async (item: string) => { if (item === 'a') throw new Error('offline'); });
    const { queue, lost } = build(send);
    queue.add('a'); queue.add('b');
    await vi.advanceTimersByTimeAsync(30);
    expect(send.mock.calls.map(call => call[0])).toEqual(['a', 'a', 'a', 'b']);
    expect(lost).toEqual(['a']);
  });
  it('does not retry an error the server will repeat', async () => {
    const send = vi.fn(async (item: string) => { if (item === 'a') throw new Error('refused'); });
    const { queue, lost } = build(send, { isPermanent: () => true });
    queue.add('a'); queue.add('b'); await flush();
    expect(send.mock.calls.map(call => call[0])).toEqual(['a', 'b']);
    expect(lost).toEqual(['a']);
  });
  it('reports what it cannot hold rather than growing without limit', async () => {
    const { queue, lost } = build(() => new Promise(() => {}), { limit: 2 });
    queue.add('a'); queue.add('b'); queue.add('c'); await flush();
    expect(lost).toEqual(['c']);
  });
  it('drops waiting items when cleared, even mid-retry', async () => {
    const send = vi.fn(async () => { throw new Error('offline'); });
    const { queue, lost } = build(send);
    queue.add('a'); queue.add('b'); await flush();
    queue.clear();
    await vi.advanceTimersByTimeAsync(100);
    expect(send).toHaveBeenCalledTimes(1);
    expect(lost).toEqual([]);
  });
  it('resolves drain once everything is sent', async () => {
    const send = vi.fn(async () => {});
    const { queue } = build(send);
    queue.add('a'); queue.add('b');
    await queue.drain();
    expect(send).toHaveBeenCalledTimes(2);
  });
});
