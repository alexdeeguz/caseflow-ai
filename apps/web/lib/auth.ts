import { PublicClientApplication } from '@azure/msal-browser';
import { getPublicConfig } from './config';

let initialization: Promise<PublicClientApplication> | undefined;

export function getAuthClient(): Promise<PublicClientApplication> {
  initialization ??= (async () => {
    const { clientId } = getPublicConfig();
    const client = new PublicClientApplication({
      auth: {
        clientId,
        authority: 'https://login.microsoftonline.com/common',
        redirectUri: `${window.location.origin}/auth/callback`,
        postLogoutRedirectUri: `${window.location.origin}/`,
      },
      cache: { cacheLocation: 'sessionStorage' },
    });

    await client.initialize();

    const response = await client.handleRedirectPromise();

    if (response?.account) {
      client.setActiveAccount(response.account);
    }

    // Do not silently select among multiple cached identities.
    const accounts = client.getAllAccounts();
    const onlyAccount = accounts.length === 1 ? accounts[0] : undefined;

    if (!client.getActiveAccount() && onlyAccount) {
      client.setActiveAccount(onlyAccount);
    }

    return client;
  })().catch((error: unknown) => {
    initialization = undefined;

    throw error;
  });

  return initialization;
}
