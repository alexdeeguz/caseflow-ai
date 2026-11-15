import { createRemoteJWKSet, decodeJwt, errors, jwtVerify, type RemoteJWKSet } from 'jose';
import type { ApiConfig } from './config.js';

export interface Identity {
  subject: string;
  tenantId: string;
  name: string | null;
}

export class AuthError extends Error {
  constructor(public readonly statusCode: 401 | 403 | 503) {
    super(
      statusCode === 503
        ? 'Authentication service unavailable.'
        : statusCode === 403
          ? 'Required permission is missing.'
          : 'A valid access token is required.',
    );
  }
}

export function microsoftKeys() {
  return createRemoteJWKSet(
    new URL('https://login.microsoftonline.com/common/discovery/v2.0/keys'),
    {
      timeoutDuration: 5000,
      cooldownDuration: 30000,
      cacheMaxAge: 600000,
    },
  );
}

// The resolver is injectable for signed-token tests; production always uses Microsoft's fixed URL.
export function createTokenVerifier(config: ApiConfig, keys: RemoteJWKSet = microsoftKeys()) {
  return async (token: string): Promise<Identity> => {
    try {
      // Unverified tid only selects an expected issuer, never a network destination or identity.
      const { tid } = decodeJwt(token);

      if (
        typeof tid !== 'string' ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(tid)
      ) {
        throw new AuthError(401);
      }

      const issuer = `https://login.microsoftonline.com/${tid}/v2.0`;
      const { payload } = await jwtVerify(
        token,
        async (header, input) => {
          const key = await keys(header, input);

          // Entra's common JWKS includes tenant-scoped keys: signature alone is insufficient.
          const candidates = keys
            .jwks()
            ?.keys.filter(
              (candidate) =>
                candidate.kid === header.kid &&
                candidate.kty === 'RSA' &&
                (!candidate.use || candidate.use === 'sig') &&
                (!candidate.alg || candidate.alg === header.alg),
            );

          const candidate = candidates?.[0];

          if (
            candidates?.length !== 1 ||
            !candidate ||
            !('issuer' in candidate) ||
            typeof candidate.issuer !== 'string' ||
            candidate.issuer.replace('{tenantid}', tid) !== issuer
          ) {
            throw new AuthError(401);
          }

          return key;
        },
        {
          algorithms: ['RS256'],
          audience: config.clientId,
          issuer,
          requiredClaims: ['exp', 'iat', 'nbf', 'sub', 'tid', 'ver', 'azp'],
          clockTolerance: 5,
        },
      );

      if (
        payload.ver !== '2.0' ||
        payload.azp !== config.webClientId ||
        typeof payload.sub !== 'string' ||
        !payload.sub
      ) {
        throw new AuthError(401);
      }

      if (typeof payload.scp !== 'string' || !payload.scp.split(' ').includes('access_as_user')) {
        throw new AuthError(403);
      }

      return {
        subject: payload.sub,
        tenantId: tid,
        name: typeof payload.name === 'string' ? payload.name : null,
      };
    } catch (error) {
      if (error instanceof AuthError) {
        throw error;
      }

      if (
        error instanceof errors.JOSEError &&
        !(error instanceof errors.JWKSTimeout) &&
        !(error instanceof errors.JWKSInvalid)
      ) {
        throw new AuthError(401);
      }

      // Fail closed on network/provider errors without disclosing token contents.
      throw new AuthError(503);
    }
  };
}
