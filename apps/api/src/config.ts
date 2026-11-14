export interface ApiConfig {
  clientId: string;
  webClientId: string;
  webOrigin: string;
}

const guid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function readConfig(env: NodeJS.ProcessEnv = process.env): ApiConfig {
  const clientId = env.ENTRA_API_CLIENT_ID;
  const webClientId = env.ENTRA_WEB_CLIENT_ID;
  if (!clientId || !guid.test(clientId) || !webClientId || !guid.test(webClientId)) {
    throw new Error('Set ENTRA_API_CLIENT_ID and ENTRA_WEB_CLIENT_ID to valid application IDs.');
  }
  const origin = new URL(env.WEB_ORIGIN ?? 'http://localhost:3000');
  if (
    origin.origin !== origin.href.replace(/\/$/, '') ||
    origin.username ||
    origin.password ||
    (origin.protocol !== 'https:' &&
      !(origin.protocol === 'http:' && origin.hostname === 'localhost'))
  ) {
    throw new Error(
      'WEB_ORIGIN must be an HTTPS origin (HTTP localhost is allowed for development).',
    );
  }
  return { clientId, webClientId, webOrigin: origin.origin };
}
