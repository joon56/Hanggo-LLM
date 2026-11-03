// @vitest-environment node
import { expect, it } from 'vitest';
import { iceConfig, readTurn } from './turn.ts';

const account = { TURN_USERNAME: 'test-user', TURN_CREDENTIAL: 'test-pass' };
it('needs all three values', () => {
  expect(readTurn({})).toBeNull();
  expect(readTurn({ TURN_URLS: 'turn:relay.example:3478' })).toBeNull();
  expect(readTurn({ TURN_URLS: 'turn:relay.example:3478', TURN_USERNAME: 'test-user' })).toBeNull();
  expect(readTurn({ TURN_URLS: '  ', ...account })).toBeNull();
});
it('keeps full URLs and splits a comma-separated list', () => {
  expect(readTurn({ TURN_URLS: 'turn:relay.example:3478, turns:relay.example:443?transport=tcp', ...account })?.urls).toEqual(['turn:relay.example:3478', 'turns:relay.example:443?transport=tcp']);
});
it('accepts a dashboard address copied without the scheme', () => {
  expect(readTurn({ TURN_URLS: 'relay.example:3478', ...account })?.urls).toEqual(['turn:relay.example:3478']);
});
it('always offers STUN and adds the relay only when configured', () => {
  expect(iceConfig(null)).toEqual({ iceServers: [{ urls: 'stun:stun.cloudflare.com:3478' }], relayAvailable: false });
  const turn = { urls: ['turn:relay.example:3478'], username: 'test-user', credential: 'test-pass' };
  expect(iceConfig(turn)).toEqual({ iceServers: [{ urls: 'stun:stun.cloudflare.com:3478' }, turn], relayAvailable: true });
});
