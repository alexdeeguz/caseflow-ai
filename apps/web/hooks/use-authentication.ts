'use client';

import { useEffect, useState } from 'react';
import { AuthError, InteractionRequiredAuthError, type AccountInfo } from '@azure/msal-browser';
import { getAuthClient } from '../lib/auth';
import { getPublicConfig } from '../lib/config';
import { fetchIdentity, type DemoIdentity } from '../lib/api';

function errorMessage(error: unknown) {
  if (error instanceof AuthError)
    return `Microsoft sign-in could not finish (${error.errorCode}). Please try again.`;
  return error instanceof Error ? error.message : 'Something went wrong. Please try again.';
}

export function useAuthentication() {
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [account, setAccount] = useState<AccountInfo | null>(null);
  const [identity, setIdentity] = useState<DemoIdentity | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void getAuthClient()
      .then((client) => {
        if (active) {
          setAccount(client.getActiveAccount());
          setReady(true);
        }
      })
      .catch((error: unknown) => {
        if (active) setError(errorMessage(error));
      });
    return () => {
      active = false;
    };
  }, []);

  async function signIn() {
    setBusy(true);
    setError(null);
    try {
      const client = await getAuthClient();
      await client.loginRedirect({
        scopes: [getPublicConfig().apiScope],
        prompt: 'select_account',
      });
    } catch (error) {
      setError(errorMessage(error));
      setBusy(false);
    }
  }

  async function verifyAccess() {
    if (!account) return;
    setBusy(true);
    setError(null);
    setIdentity(null);
    try {
      const client = await getAuthClient();
      try {
        const result = await client.acquireTokenSilent({
          account,
          scopes: [getPublicConfig().apiScope],
        });
        setIdentity(await fetchIdentity(result.accessToken));
      } catch (error) {
        if (error instanceof InteractionRequiredAuthError) {
          await client.acquireTokenRedirect({ account, scopes: [getPublicConfig().apiScope] });
        } else {
          throw error;
        }
      }
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  async function signOut() {
    setBusy(true);
    setError(null);
    setIdentity(null);
    try {
      const client = await getAuthClient();
      await client.logoutRedirect({ account });
    } catch (error) {
      setError(errorMessage(error));
      setBusy(false);
    }
  }

  return { ready, busy, account, identity, error, signIn, verifyAccess, signOut };
}
