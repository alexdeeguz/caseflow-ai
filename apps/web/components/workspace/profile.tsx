'use client';

import { useState } from 'react';
import { userSchema, type User } from '@caseflow/schemas';
import type { AuthRequest } from '../../hooks/use-authentication';
import { Button } from '../ui/button';
import { StatusMessage } from '../ui/status-message';
import { RoleBadge } from './role-badge';

export function Profile({
  user,
  request,
  onSaved,
}: {
  user: User;
  request: AuthRequest;
  onSaved: () => Promise<void>;
}) {
  const [name, setName] = useState(user.displayName);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [failed, setFailed] = useState(false);

  return (
    <section>
      <h1>My profile</h1>
      <p>Your Microsoft account identifies you. Your CaseFlow role controls access.</p>
      <RoleBadge role={user.role} />
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setMessage('');

          try {
            await request('/me', userSchema, {
              method: 'PATCH',
              body: JSON.stringify({ displayName: name }),
            });
            await onSaved();
            setFailed(false);
            setMessage('Profile saved.');
          } catch (error) {
            setFailed(true);
            setMessage((error as Error).message);
          } finally {
            setBusy(false);
          }
        }}
        className="mt-6 grid max-w-lg gap-4"
      >
        <label htmlFor="display-name">Display name</label>
        <input
          id="display-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
          maxLength={100}
        />
        <Button type="submit" disabled={busy || !name.trim()}>
          {busy ? 'Saving…' : 'Save name'}
        </Button>
      </form>
      <p className="mt-5 text-sm text-muted break-all">User ID: {user.id}</p>
      {message && <StatusMessage tone={failed ? 'error' : 'success'}>{message}</StatusMessage>}
    </section>
  );
}
