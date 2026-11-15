'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { broadcastResponseToMainFrame } from '@azure/msal-browser/redirect-bridge';
import { AuthShell } from '../../../components/auth/auth-shell';
import { AuthPanel } from '../../../components/auth/auth-panel';
import { StatusMessage } from '../../../components/ui/status-message';

let completion: Promise<void> | undefined;

export default function AuthCallback() {
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    // Keep the bridge separate from MSAL client initialization, including in Strict Mode.
    completion ??= broadcastResponseToMainFrame();
    void completion.catch(() => setFailed(true));
  }, []);

  return (
    <AuthShell>
      <AuthPanel
        eyebrow="MICROSOFT SIGN-IN"
        title={failed ? 'Let’s try that again.' : 'One moment.'}
        description="Completing your return to CaseFlow."
      >
        <StatusMessage tone={failed ? 'error' : 'info'}>
          {failed ? (
            <>
              Sign-in could not finish.{' '}
              <Link
                className="font-semibold underline underline-offset-4 focus-visible:outline-brand"
                href="/"
              >
                Return to CaseFlow
              </Link>{' '}
              and try again.
            </>
          ) : (
            'Completing Microsoft sign-in…'
          )}
        </StatusMessage>
      </AuthPanel>
    </AuthShell>
  );
}
