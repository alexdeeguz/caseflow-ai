'use client';

import { ErrorCode, userSchema, type DemoSession, type User } from '@caseflow/schemas';
import { useCallback, useEffect, useRef, useState } from 'react';
import { InteractionRequiredAuthError, type AccountInfo } from '@azure/msal-browser';

import { getAuthClient } from '../lib/auth';
import { getPublicConfig } from '../lib/config';
import { apiRequest, ApiError, type Parser, type ApiRequestOptions } from '../lib/api';
import { isAccessRejected } from '../lib/auth-errors';
import { rememberWorkspaceShell } from '../lib/session-presentation';
import {
  clearDemoSession,
  isDemoSessionUsable,
  readDemoSession,
  saveDemoSession,
  startDemoSession,
} from '../lib/demo-session';

const permissionsChangedEvent = 'caseflow:permissions';

export type AuthRequest = <T>(
  path: string,
  schema: Parser<T>,
  options?: ApiRequestOptions,
) => Promise<T>;

export function useAuthentication() {
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [account, setAccount] = useState<AccountInfo | null>(null);
  // Shared demo Admin session (from /demo); used instead of Microsoft tokens while present.
  const [demo, setDemo] = useState<DemoSession | null>(null);
  const [identity, setIdentity] = useState<User | null>(null);
  const [error, setError] = useState<string | null>(null);
  const lifecycle = useRef({ generation: 0, profileRequest: 0 });

  useEffect(() => {
    let live = true;
    const state = lifecycle.current;
    const stored = readDemoSession();

    // A demo session needs no Microsoft client; Microsoft sign-in initializes on demand later.
    void (stored ? Promise.resolve(null) : getAuthClient())
      .then((client) => {
        if (live && stored) {
          setDemo(stored);
          setReady(true);
          return;
        }
        if (!client) {
          return;
        }
        if (live) {
          setAccount(client.getActiveAccount());
          setReady(true);
        }
      })
      .catch(() => {
        if (live) {
          rememberWorkspaceShell(false);
          setError('Microsoft sign-in could not initialize. Please reload.');
        }
      });

    return () => {
      live = false;
      state.generation++;
    };
  }, [lifecycle]);

  const request: AuthRequest = useCallback(
    async <T>(path: string, schema: Parser<T>, options: ApiRequestOptions = {}) => {
      const version = lifecycle.current.generation;

      if (demo) {
        if (!isDemoSessionUsable(demo)) {
          lifecycle.current.generation++;
          clearDemoSession();
          rememberWorkspaceShell(false);
          setDemo(null);
          setIdentity(null);
          setError('Your demo session has ended. Start a new one to keep exploring.');
          throw new Error('Your demo session has ended.');
        }

        try {
          const data = await apiRequest(demo.accessToken, path, schema, options);

          if (version !== lifecycle.current.generation) {
            throw new DOMException('Request cancelled', 'AbortError');
          }
          return data;
        } catch (error) {
          if (
            error instanceof ApiError &&
            (error.status === 401 || error.code === ErrorCode.AccountDisabled)
          ) {
            lifecycle.current.generation++;
            clearDemoSession();
            rememberWorkspaceShell(false);
            setDemo(null);
            setIdentity(null);
            setError(
              error.status === 401 ? 'Your demo session has ended.' : 'Demo access is turned off.',
            );
          } else if (error instanceof ApiError && error.status === 403 && path !== '/me') {
            window.dispatchEvent(new Event(permissionsChangedEvent));
          }
          throw error;
        }
      }

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
            rememberWorkspaceShell(false);
            setIdentity(null);
            setError(error.message);
          } else if (error.status === 403 && path !== '/me') {
            window.dispatchEvent(new Event(permissionsChangedEvent));
          }
        }

        throw error;
      }
    },
    [account, demo, lifecycle],
  );

  const refreshProfile = useCallback(() => {
    if (!account && !demo) {
      return Promise.resolve();
    }

    const sequence = ++lifecycle.current.profileRequest;

    setError(null);

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
          if (isAccessRejected(error)) {
            rememberWorkspaceShell(false);
            setIdentity(null);
          }
          setError(error.message);
        }
      },
    );
  }, [account, demo, request, lifecycle]);

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

      rememberWorkspaceShell(true);
      await client.loginRedirect({
        scopes: [getPublicConfig().apiScope],
        prompt: 'select_account',
      });
    } catch {
      rememberWorkspaceShell(false);
      setError('Microsoft sign-in could not finish. Please try again.');
      setBusy(false);
    }
  }

  /** Starts a shared demo Admin session; only offered on the /demo page. Resolves to success. */
  async function signInDemo(): Promise<boolean> {
    setBusy(true);
    setError(null);

    try {
      const session = await startDemoSession();

      saveDemoSession(session);
      rememberWorkspaceShell(true);
      lifecycle.current.generation++;
      setDemo(session);
      setReady(true);
      return true;
    } catch (issue) {
      rememberWorkspaceShell(false);
      setError(issue instanceof Error ? issue.message : 'The demo could not start.');
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function signOut() {
    rememberWorkspaceShell(false);
    lifecycle.current.generation++;
    setIdentity(null);
    setBusy(true);

    if (demo) {
      clearDemoSession();
      setDemo(null);
      // Full navigation, like Microsoft sign-out: leaves no workspace state behind.
      window.location.replace(new URL('/demo', window.location.origin));
      return;
    }

    try {
      const client = await getAuthClient();

      await client.logoutRedirect({ account });
    } catch {
      setError('Sign-out could not finish. Please try again.');
      setBusy(false);
    }
  }

  const hasIdentity = identity !== null;
  const hasAccount = account !== null || demo !== null;

  useEffect(() => {
    if (hasIdentity) {
      rememberWorkspaceShell(true);
    } else if (ready && !hasAccount) {
      rememberWorkspaceShell(false);
    }
  }, [hasIdentity, hasAccount, ready]);

  const restoring = !error && (!ready || (hasAccount && identity === null));

  return {
    ready,
    restoring,
    busy,
    account,
    demo: demo !== null,
    identity,
    error,
    signIn,
    signInDemo,
    signOut,
    request,
    refreshProfile,
  };
}
