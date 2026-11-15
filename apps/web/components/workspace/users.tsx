'use client';

import { Role, userSchema, roleLabels, type User } from '@caseflow/schemas';
import { useState } from 'react';

import type { AuthRequest } from '../../hooks/use-authentication';
import { useResource } from '../../hooks/use-resource';
import { ConfirmDialog } from '../ui/confirm-dialog';
import { useToast } from '../ui/toast-provider';
import { Button } from '../ui/button';
import { StatusMessage } from '../ui/status-message';
import { LoadState } from '../ui/load-state';
import { Pagination } from '../ui/pagination';
import { RoleBadge } from './role-badge';
import { userListResource } from '../../lib/workspace-resources';

const UserChange = {
  Role: 'role',
  Access: 'access',
} as const;

type UserChange = (typeof UserChange)[keyof typeof UserChange];

export function Users({ user, request }: { user: User; request: AuthRequest }) {
  const notify = useToast();
  const [confirmation, setConfirmation] = useState<{ target: User; kind: UserChange } | null>(null);
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(1);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const { data, error: loadError } = useResource(
    request,
    userListResource({ page, search: query }),
  );

  async function change(target: User, kind: UserChange) {
    const nextRole = target.role === Role.Staff ? Role.Admin : Role.Staff;
    setBusy(true);
    setError('');

    try {
      await request(`/admin/users/${target.id}/${kind}`, userSchema, {
        method: 'PATCH',
        body: JSON.stringify(
          kind === UserChange.Role ? { role: nextRole } : { active: !target.active },
        ),
      });
      notify(kind === UserChange.Role ? 'User role updated.' : 'User access updated.');
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setBusy(false);
      setConfirmation(null);
    }
  }

  return (
    <section>
      <h1>Users</h1>
      <p>People appear here after their first sign-in. Assign cases to give Staff access.</p>
      <form
        className="flex flex-wrap gap-3 my-6"
        onSubmit={(e) => {
          e.preventDefault();
          setPage(1);
          setQuery(search);
        }}
      >
        <label className="sr-only" htmlFor="user-search">
          Search display names
        </label>
        <input
          id="user-search"
          placeholder="Search display names"
          maxLength={100}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <Button type="submit">Search</Button>
      </form>
      <ConfirmDialog
        open={confirmation !== null}
        title={
          confirmation?.kind === UserChange.Role ? 'Change user role?' : 'Change account access?'
        }
        confirmLabel="Confirm change"
        cancelLabel="Cancel"
        busy={busy}
        onCancel={() => setConfirmation(null)}
        onConfirm={() => {
          if (confirmation) {
            void change(confirmation.target, confirmation.kind);
          }
        }}
      >
        {confirmation && (
          <p>
            {confirmation.kind === UserChange.Role
              ? `Change ${confirmation.target.displayName} to ${roleLabels[confirmation.target.role === Role.Staff ? Role.Admin : Role.Staff]}?`
              : `${confirmation.target.active ? 'Disable' : 'Enable'} access for ${confirmation.target.displayName}?`}
          </p>
        )}
      </ConfirmDialog>
      {error && <StatusMessage tone="error">{error}</StatusMessage>}
      {!data ? (
        <LoadState error={loadError} />
      ) : (
        <>
          <div className="grid gap-4">
            {data.items.map((target) => (
              <article className="rounded-xl border border-line p-5" key={target.id}>
                <div className="flex flex-wrap items-center gap-3">
                  <strong>{target.displayName}</strong>
                  <RoleBadge role={target.role} />
                  <span>{target.active ? 'Active' : 'Disabled'}</span>
                </div>
                <p className="text-xs text-muted break-all">{target.id}</p>
                <div className="flex flex-wrap gap-3 mt-4">
                  {target.id !== user.id &&
                    target.role !== Role.SuperAdmin &&
                    (user.role === Role.SuperAdmin || target.role === Role.Staff) && (
                      <Button
                        variant="secondary"
                        disabled={busy}
                        onClick={() => setConfirmation({ target, kind: UserChange.Access })}
                      >
                        {target.active ? 'Disable access' : 'Enable access'}
                      </Button>
                    )}
                  {user.role === Role.SuperAdmin && target.role !== Role.SuperAdmin && (
                    <Button
                      variant="secondary"
                      disabled={busy}
                      onClick={() => setConfirmation({ target, kind: UserChange.Role })}
                    >
                      {target.role === Role.Staff ? 'Make Admin' : 'Make Staff'}
                    </Button>
                  )}
                </div>
              </article>
            ))}
            {!data.items.length && <p>No users match your search.</p>}
          </div>
          <Pagination {...data} onPage={setPage} />
        </>
      )}
    </section>
  );
}
