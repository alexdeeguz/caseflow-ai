interface PublicConfigInput {
  clientId?: string;
  apiScope?: string;
  apiOrigin?: string;
}

export function validatePublicConfig(input: PublicConfigInput) {
  const guid = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
  if (!input.clientId || !new RegExp(`^${guid}$`, 'i').test(input.clientId)) {
    throw new Error(
      'Microsoft sign-in is not configured correctly. Please contact the demo owner.',
    );
  }
  if (!input.apiScope || !new RegExp(`^api://${guid}/access_as_user$`, 'i').test(input.apiScope)) {
    throw new Error(
      'The API permission is not configured correctly. Please contact the demo owner.',
    );
  }
  let origin: URL;
  try {
    origin = new URL(input.apiOrigin ?? '');
  } catch {
    throw new Error('The API address is not configured correctly. Please contact the demo owner.');
  }
  if (
    origin.username ||
    origin.password ||
    origin.search ||
    origin.hash ||
    origin.pathname !== '/' ||
    (origin.protocol !== 'https:' &&
      !(origin.protocol === 'http:' && origin.hostname === 'localhost'))
  ) {
    throw new Error('The API must use HTTPS, or HTTP localhost for local development.');
  }
  return { clientId: input.clientId, apiScope: input.apiScope, apiOrigin: origin.origin };
}

export function getPublicConfig() {
  // Explicit property access is required for Next.js build-time public environment replacement.
  return validatePublicConfig({
    clientId: process.env.NEXT_PUBLIC_ENTRA_WEB_CLIENT_ID,
    apiScope: process.env.NEXT_PUBLIC_ENTRA_API_SCOPE,
    apiOrigin: process.env.NEXT_PUBLIC_API_ORIGIN,
  });
}
