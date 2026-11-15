'use client';

import { ErrorCode, userSchema, type User } from '@caseflow/schemas';
import { useCallback, useEffect, useRef, useState } from 'react';
import { InteractionRequiredAuthError, type AccountInfo } from '@azure/msal-browser';

import { getAuthClient } from '../lib/auth';
import { getPublicConfig } from '../lib/config';
import { apiRequest, ApiError, type Parser } from '../lib/api';

const permissionsChangedEvent = 'caseflow:permissions';

export type AuthRequest = <T>(path: string, schema: Parser<T>, options?: RequestInit) => Promise<T>;

export function useAuthentication() {
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [account, setAccount] = useState<AccountInfo | null>(null);
  const [identity, setIdentity] = useState<User | null>(null);
  const [error, setError] = useState<string | null>(null);
  const lifecycle = useRef({ generation: 0, profileRequest: 0 });

  useEffect(() => {
    let live = true;
    const state = lifecycle.current;

    void getAuthClient()
      .then((client) => {
        if (live) {
          setAccount(client.getActiveAccount());
          setReady(true);
        }
      })
      .catch(() => {
        if (live) {
          setError('Microsoft sign-in could not initialize. Please reload.');
        }
      });

    return () => {
      live = false;
      state.generation++;
    };
  }, [lifecycle]);

  const request: AuthRequest = useCallback(
    async <T>(path: string, schema: Parser<T>, options: RequestInit = {}) => {
      const version = lifecycle.current.generation;

      if (!account) {
        throw new Error('Sign in to continue.');
      }

      const client = await getAuthClient();

      try {
        const token = await client.acquireTokenSilent({
          account,
          scopes: [getPublicConfig().apiScope],
        });

        if (version !== lifecycle.current.generation) {
          throw new DOMException('Request cancelled', 'AbortError');
        }

        const data = await apiRequest(token.accessToken, path, schema, options);

        if (version !== lifecycle.current.generation) {
          throw new DOMException('Request cancelled', 'AbortError');
        }

        return data;
      } catch (error) {
        if (version !== lifecycle.current.generation) {
          throw new DOMException('Request cancelled', 'AbortError');
        }

        if (error instanceof InteractionRequiredAuthError) {
          lifecycle.current.generation++;
          setIdentity(null);
          await client.acquireTokenRedirect({ account, scopes: [getPublicConfig().apiScope] });
        }

        if (error instanceof ApiError) {
          if (error.status === 401 || error.code === ErrorCode.AccountDisabled) {
            lifecycle.current.generation++;
            setIdentity(null);
            setError(error.message);
          } else if (error.status === 403 && path !== '/me') {
            window.dispatchEvent(new Event(permissionsChangedEvent));
          }
        }

        throw error;
      }
    },
    [account, lifecycle],
  );

  const refreshProfile = useCallback(() => {
    if (!account) {
      return Promise.resolve();
    }

    const sequence = ++lifecycle.current.profileRequest;

    return request('/me', userSchema).then(
      (user) => {
        if (sequence === lifecycle.current.profileRequest) {
          setIdentity(user);
          setError(null);
        }
      },
      (error) => {
        if (
          sequence === lifecycle.current.profileRequest &&
          error instanceof Error &&
          error.name !== 'AbortError'
        ) {
          setIdentity(null);
          setError(error.message);
        }
      },
    );
  }, [account, request, lifecycle]);

  useEffect(() => {
    let active = true;

    // Coalesce Strict Mode setup/cleanup before beginning the network request.
    queueMicrotask(() => {
      if (active) {
        void refreshProfile();
      }
    });

    const refresh = () => void refreshProfile();

    window.addEventListener('focus', refresh);
    window.addEventListener(permissionsChangedEvent, refresh);

    return () => {
      active = false;
      window.removeEventListener('focus', refresh);
      window.removeEventListener(permissionsChangedEvent, refresh);
    };
  }, [refreshProfile]);

  async function signIn() {
    setBusy(true);
    setError(null);

    try {
      const client = await getAuthClient();

      await client.loginRedirect({
        scopes: [getPublicConfig().apiScope],
        prompt: 'select_account',
      });
    } catch {
      setError('Microsoft sign-in could not finish. Please try again.');
      setBusy(false);
    }
  }

  async function signOut() {
    lifecycle.current.generation++;
    setIdentity(null);
    setBusy(true);

    try {
      const client = await getAuthClient();

      await client.logoutRedirect({ account });
    } catch {
      setError('Sign-out could not finish. Please try again.');
      setBusy(false);
    }
  }

  return {
    ready,
    busy,
    account,
    identity,
    error,
    signIn,
    signOut,
    request,
    refreshProfile,
  };
}
