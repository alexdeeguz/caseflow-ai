'use client';

import { useAuthentication } from '../../hooks/use-authentication';
import { Button } from '../ui/button';
import { StatusMessage } from '../ui/status-message';
import { AuthPanel } from './auth-panel';

export function SignInCard() {
  const { ready, busy, account, identity, error, signIn, verifyAccess, signOut } =
    useAuthentication();
  return (
    <AuthPanel
      eyebrow="MICROSOFT SIGN-IN"
      title={account ? 'Welcome back.' : 'Welcome to CaseFlow.'}
      description={
        account
          ? 'Verify your sign-in to confirm access to the demo workspace.'
          : 'Use your work, school or personal Microsoft account to get started.'
      }
    >
      {!ready && !error && <StatusMessage>Preparing sign-in…</StatusMessage>}
      {account && (
        <p className="break-words text-sm leading-6 text-ink-soft">
          Signed in as <strong className="text-ink">{account.name ?? account.username}</strong>
        </p>
      )}
      {identity && (
        <StatusMessage tone="success">
          Your sign-in is verified. Demo access is ready.
        </StatusMessage>
      )}
      {account ? (
        <>
          <Button disabled={busy} onClick={() => void verifyAccess()}>
            {busy ? 'Please wait…' : 'Verify demo access'}
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
  );
}
