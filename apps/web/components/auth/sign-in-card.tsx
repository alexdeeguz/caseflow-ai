'use client';

import { Suspense } from 'react';

import { useAuthentication } from '../../hooks/use-authentication';
import { Button } from '../ui/button';
import { StatusMessage } from '../ui/status-message';
import { AuthShell } from './auth-shell';
import { Workspace } from '../workspace/workspace';
import { AuthPanel } from './auth-panel';
import { SessionLoading } from './session-loading';

export function SignInCard() {
  const {
    ready,
    restoring,
    busy,
    account,
    identity,
    error,
    signIn,
    refreshProfile,
    signOut,
    request,
  } = useAuthentication();

  if (restoring) {
    return <SessionLoading />;
  }

  if (identity) {
    return (
      <Suspense fallback={<SessionLoading />}>
        <Workspace
          key={`${identity.id}:${identity.role}`}
          user={identity}
          request={request}
          signOut={signOut}
          refreshProfile={refreshProfile}
        />
      </Suspense>
    );
  }

  return (
    <AuthShell>
      <AuthPanel
        eyebrow="MICROSOFT SIGN-IN"
        title={account ? 'Welcome back.' : 'Welcome to CaseFlow.'}
        description={
          account
            ? 'Loading your workspace. If it does not open, retry below.'
            : 'Use your work, school or personal Microsoft account to get started.'
        }
      >
        {!ready && !error && <StatusMessage>Preparing sign-in…</StatusMessage>}
        {account && (
          <p className="break-words text-sm leading-6 text-ink-soft">
            Signed in as <strong className="text-ink">{account.name ?? account.username}</strong>
          </p>
        )}
        {account ? (
          <>
            <Button disabled={busy} onClick={() => void refreshProfile()}>
              {busy ? 'Please wait…' : 'Retry access'}
            </Button>
            <Button variant="secondary" disabled={busy} onClick={() => void signOut()}>
              Sign out
            </Button>
          </>
        ) : (
          <Button disabled={!ready || busy} onClick={() => void signIn()}>
            <svg aria-hidden="true" width="18" height="18" viewBox="0 0 18 18" fill="currentColor">
              <path d="M0 0h8v8H0zM10 0h8v8h-8zM0 10h8v8H0zM10 10h8v8h-8z" />
            </svg>
            {busy ? 'Redirecting…' : 'Sign in with Microsoft'}
          </Button>
        )}
        {error && <StatusMessage tone="error">{error}</StatusMessage>}
      </AuthPanel>
    </AuthShell>
  );
}
