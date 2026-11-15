'use client';

import { useState } from 'react';
import { Role, successSchema, type User } from '@caseflow/schemas';

import type { AuthRequest } from '../../../hooks/use-authentication';
import { useResource } from '../../../hooks/use-resource';
import { Button } from '../../ui/button';
import { StatusMessage } from '../../ui/status-message';
import { LoadState } from '../../ui/load-state';
import { RoleBadge } from '../role-badge';
import { StaffPicker } from './staff-picker';
import { caseDetailResource } from '../../../lib/workspace-resources';

export function CaseDetail({
  id,
  user,
  request,
  onBack,
}: {
  id: string;
  user: User;
  request: AuthRequest;
  onBack: () => void;
}) {
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const { data, error: loadError } = useResource(request, caseDetailResource(id));

  async function assign(userId: string, assigned: boolean) {
    setBusy(true);
    setError('');

    try {
      await request(`/admin/cases/${id}/assignments/${userId}`, successSchema, {
        method: assigned ? 'PUT' : 'DELETE',
      });
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section>
      <Button variant="secondary" onClick={onBack}>
        Back to cases
      </Button>
      {!data ? (
        <LoadState error={loadError} />
      ) : (
        <>
          <h1 className="mt-6">{data.case.title}</h1>
          <p>{data.case.summary}</p>
          {user.role !== Role.Staff && (
            <>
              <h2 className="mt-8">Assigned people</h2>
              {data.assignedUsers.map((person) => (
                <div className="flex flex-wrap items-center gap-4 py-3" key={person.id}>
                  <span>{person.displayName}</span>
                  <RoleBadge role={person.role} />
                  {!person.active && <span>Disabled</span>}
                  {person.role === Role.Staff ? (
                    <Button
                      disabled={busy}
                      variant="secondary"
                      onClick={() => void assign(person.id, false)}
                    >
                      Remove assignment
                    </Button>
                  ) : (
                    <span className="text-sm text-muted">
                      Assignment retained; currently has all-case access.
                    </span>
                  )}
                </div>
              ))}
              {!data.assignedUsers.length && <p>No assignments yet.</p>}
              <StaffPicker
                request={request}
                assigned={data.assignedUsers.map((u) => u.id)}
                busy={busy}
                onAssign={(id) => void assign(id, true)}
              />
            </>
          )}
        </>
      )}
      {error && <StatusMessage tone="error">{error}</StatusMessage>}
    </section>
  );
}
