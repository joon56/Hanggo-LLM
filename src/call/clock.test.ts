import { expect, it } from 'vitest';
import { estimateOffset } from './clock';

it('takes the middle of the round trip as the moment the server read its clock', () => {
  expect(estimateOffset([{ sentAt: 1000, receivedAt: 1100, serverNow: 5050 }])).toBe(4000);
});
it('trusts the fastest round trip, which has the least room for delay on one side', () => {
  expect(estimateOffset([
    { sentAt: 1000, receivedAt: 1900, serverNow: 5800 },
    { sentAt: 2000, receivedAt: 2020, serverNow: 6010 },
    { sentAt: 3000, receivedAt: 3400, serverNow: 7000 },
  ])).toBe(4000);
});
it('handles a browser clock ahead of the server', () => {
  expect(estimateOffset([{ sentAt: 9000, receivedAt: 9010, serverNow: 1005 }])).toBe(-8000);
});
