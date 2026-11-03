export type ClockSample = { sentAt: number; receivedAt: number; serverNow: number };

/** Server time minus browser time. The fastest round trip has the least room for delay on one side. */
export function estimateOffset(samples: ClockSample[]) {
  const fastest = samples.reduce((best, sample) => sample.receivedAt - sample.sentAt < best.receivedAt - best.sentAt ? sample : best);
  return fastest.serverNow - (fastest.sentAt + fastest.receivedAt) / 2;
}
