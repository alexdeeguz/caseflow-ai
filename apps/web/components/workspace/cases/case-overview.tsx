'use client';

import { useState } from 'react';
import { Role, successSchema, type User, type caseDetailSchema } from '@caseflow/schemas';

import type { AuthRequest } from '../../../hooks/use-authentication';
import { useToast } from '../../ui/toast-provider';
import { Button } from '../../ui/button';
import { StatusMessage } from '../../ui/status-message';
import { RoleBadge } from '../role-badge';
import { StaffPicker } from './staff-picker';
import { CaseActions } from './case-actions';
import { formatIncidentDate } from '../../../lib/case-dates';
import styles from './cases.module.css';

export function CaseOverview({
  data,
  user,
  request,
  onEdit,
}: {
  data: ReturnType<typeof caseDetailSchema.parse>;
  user: User;
  request: AuthRequest;
  onEdit: () => void;
}) {
  const id = data.case.id;
  const notify = useToast();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function assign(userId: string, assigned: boolean) {
    setBusy(true);
    setError('');

    try {
      await request(`/admin/cases/${id}/assignments/${userId}`, successSchema, {
        method: assigned ? 'PUT' : 'DELETE',
      });
      notify(assigned ? 'Staff assigned to case.' : 'Assignment removed.');
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      {user.role !== Role.Staff && (
        <CaseActions record={data.case} request={request} onEdit={onEdit} />
      )}
      <dl className={styles.metadata}>
        <div>
          <dt>Client</dt>
          <dd>{data.case.clientName}</dd>
        </div>
        <div>
          <dt>Incident date</dt>
          <dd>{formatIncidentDate(data.case.incidentDate)}</dd>
        </div>
        <div>
          <dt>Created</dt>
          <dd>
            <time dateTime={data.case.createdAt}>
              {new Date(data.case.createdAt).toLocaleString()}
            </time>
          </dd>
        </div>
        <div>
          <dt>Last updated</dt>
          <dd>
            <time dateTime={data.case.updatedAt}>
              {new Date(data.case.updatedAt).toLocaleString()}
            </time>
          </dd>
        </div>
      </dl>
      <h2 className="font-semibold text-lg">Summary</h2>
      <p className="mt-3 whitespace-pre-wrap break-words text-ink-soft">
        {data.case.summary || 'No summary provided.'}
      </p>
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
      {error && <StatusMessage tone="error">{error}</StatusMessage>}
    </>
  );
}
