type Options<T> = {
  send: (item: T) => Promise<unknown>;
  retryDelaysMs: number[];
  limit: number;
  isPermanent: (error: unknown) => boolean;
  onLost: (item: T) => void;
};

/** Keeps recordings moving over a shaky connection. A lost item is reported rather than blocking everything after it. */
export class UploadQueue<T> {
  private items: T[] = [];
  private running: Promise<void> | undefined;
  private generation = 0;
  private wake: (() => void) | undefined;
  private readonly options: Options<T>;
  constructor(options: Options<T>) { this.options = options; }

  add(item: T) {
    if (this.items.length >= this.options.limit) { this.options.onLost(item); return; }
    this.items.push(item);
    this.running ??= this.run().finally(() => { this.running = undefined; });
  }

  async drain() { await this.running; }

  /** Consent was withdrawn, so anything not yet sent must not leave this browser. */
  clear() { this.generation += 1; this.items = []; this.wake?.(); }

  private async run() {
    while (this.items.length) {
      const generation = this.generation;
      const item = this.items[0];
      const sent = await this.deliver(item, generation);
      if (generation !== this.generation) continue;
      this.items.shift();
      if (!sent) this.options.onLost(item);
    }
  }

  private async deliver(item: T, generation: number) {
    for (let attempt = 0; ; attempt += 1) {
      try { await this.options.send(item); return true; }
      catch (error) {
        const delay = this.options.retryDelaysMs[attempt];
        if (delay === undefined || this.options.isPermanent(error)) return false;
        await new Promise<void>(resolve => { const timer = setTimeout(resolve, delay); this.wake = () => { clearTimeout(timer); resolve(); }; });
        if (generation !== this.generation) return false;
      }
    }
  }
}
