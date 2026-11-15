'use client';

import { useState } from 'react';
import { userSchema, type User } from '@caseflow/schemas';
import type { AuthRequest } from '../../hooks/use-authentication';
import { useToast } from '../ui/toast-provider';
import { Button } from '../ui/button';
import { FormField } from '../ui/form-field';
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
  const notify = useToast();
  const [name, setName] = useState(user.displayName);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');

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
            notify('Profile saved.');
          } catch (error) {
            setMessage((error as Error).message);
          } finally {
            setBusy(false);
          }
        }}
        className="mt-6 grid max-w-lg gap-4"
      >
        <FormField id="display-name" label="Display name" required>
          <input
            id="display-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            maxLength={100}
          />
        </FormField>
        <Button type="submit" disabled={busy || !name.trim()}>
          {busy ? 'Saving…' : 'Save name'}
        </Button>
      </form>
      <p className="mt-5 text-sm text-muted break-all">User ID: {user.id}</p>
      {message && <StatusMessage tone="error">{message}</StatusMessage>}
    </section>
  );
}
