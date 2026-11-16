'use client';

import { useState } from 'react';
import { Role, successSchema, type User, type caseDetailSchema } from '@caseflow/schemas';

import type { AuthRequest } from '../../../hooks/use-authentication';
import { useToast } from '../../ui/toast-provider';
import { DetailList, Panel } from '../../ui/panel';
import { CaseSectionLayout } from '../case-section-layout';
import { CaseStatusBadge } from './case-status-badge';
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
  navigating = false,
}: {
  data: ReturnType<typeof caseDetailSchema.parse>;
  user: User;
  request: AuthRequest;
  onEdit: () => void;
  /** An in-case navigation (e.g. switching tabs) is loading. */
  navigating?: boolean;
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

  const admin = user.role !== Role.Staff;

  return (
    <CaseSectionLayout
      id="overview-heading"
      title="Overview"
      loading={navigating}
      actions={admin && <CaseActions record={data.case} request={request} onEdit={onEdit} />}
    >
      {error && <StatusMessage tone="error">{error}</StatusMessage>}
      <div className={styles.overviewGrid}>
        <Panel title="Summary" className={styles.summaryPanel}>
          <p className={data.case.summary ? styles.summaryText : styles.summaryEmpty}>
            {data.case.summary || 'No summary provided.'}
          </p>
        </Panel>
        <div className={styles.overviewRail}>
          <Panel title="Details">
            <DetailList
              items={[
                { label: 'Client', value: data.case.clientName },
                { label: 'Incident date', value: formatIncidentDate(data.case.incidentDate) },
                { label: 'Status', value: <CaseStatusBadge status={data.case.status} /> },
                {
                  label: 'Created',
                  value: (
                    <time dateTime={data.case.createdAt}>
                      {new Date(data.case.createdAt).toLocaleString()}
                    </time>
                  ),
                },
                {
                  label: 'Last updated',
                  value: (
                    <time dateTime={data.case.updatedAt}>
                      {new Date(data.case.updatedAt).toLocaleString()}
                    </time>
                  ),
                },
              ]}
            />
          </Panel>
          {admin && (
            <Panel title="Assigned people">
              {data.assignedUsers.length ? (
                <ul className={styles.people}>
                  {data.assignedUsers.map((person) => (
                    <li key={person.id}>
                      <div className={styles.person}>
                        <span className={styles.personName}>{person.displayName}</span>
                        <RoleBadge role={person.role} />
                        {!person.active && <span className={styles.disabledTag}>Disabled</span>}
                      </div>
                      {person.role === Role.Staff ? (
                        <button
                          type="button"
                          className={styles.textAction}
                          disabled={busy}
                          onClick={() => void assign(person.id, false)}
                        >
                          Remove assignment
                          <span className="sr-only"> for {person.displayName}</span>
                        </button>
                      ) : (
                        <span className={styles.personNote}>
                          Assignment retained; currently has all-case access.
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className={styles.railEmpty}>No assignments yet.</p>
              )}
              <StaffPicker
                request={request}
                assigned={data.assignedUsers.map((u) => u.id)}
                busy={busy}
                onAssign={(id) => void assign(id, true)}
              />
            </Panel>
          )}
        </div>
      </div>
    </CaseSectionLayout>
  );
}
