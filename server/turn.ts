const STUN_SERVER = { urls: 'stun:stun.cloudflare.com:3478' };
export type TurnConfig = { urls: string[]; username: string; credential: string } | null;

/** All three values are required. A partial setting means no relay rather than a relay that fails at call time. */
export function readTurn(env: NodeJS.ProcessEnv): TurnConfig {
  const urls = (env.TURN_URLS ?? '').split(',').map(url => url.trim()).filter(Boolean);
  return urls.length && env.TURN_USERNAME && env.TURN_CREDENTIAL ? { urls, username: env.TURN_USERNAME, credential: env.TURN_CREDENTIAL } : null;
}

export function iceConfig(turn: TurnConfig) {
  return { iceServers: turn ? [STUN_SERVER, turn] : [STUN_SERVER], relayAvailable: !!turn };
}
