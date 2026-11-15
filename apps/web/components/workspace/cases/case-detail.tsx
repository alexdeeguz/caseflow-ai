'use client';

import { useState } from 'react';
import type { User } from '@caseflow/schemas';
import type { AuthRequest } from '../../../hooks/use-authentication';
import type { WorkspaceNavigate } from '../../../hooks/use-workspace-navigation';
import type { WorkspaceLocation } from '../../../lib/workspace-location';
import { useResource } from '../../../hooks/use-resource';
import { caseDetailResource } from '../../../lib/workspace-resources';
import { CaseSection, caseSectionLabels } from '../../../lib/constants/navigation';
import { Button } from '../../ui/button';
import { StatusMessage } from '../../ui/status-message';
import { LoadState } from '../../ui/load-state';
import { DocumentLibrary } from '../documents/document-library';
import { CaseOverview } from './case-overview';
import { CaseStatusBadge } from './case-status-badge';
import styles from './cases.module.css';

export function CaseDetail({
  id,
  user,
  request,
  onBack,
  onEdit,
  location,
  navigate,
  pendingLocation,
}: {
  id: string;
  user: User;
  request: AuthRequest;
  onBack: () => void;
  onEdit: () => void;
  location: WorkspaceLocation;
  navigate: WorkspaceNavigate;
  pendingLocation: WorkspaceLocation | null;
}) {
  const { data, error } = useResource(request, caseDetailResource(id));
  const [accessError, setAccessError] = useState<string | null>(null);

  return (
    <section>
      <Button variant="secondary" onClick={onBack}>
        Back to cases
      </Button>
      {!data || accessError ? (
        <LoadState error={accessError ?? error} />
      ) : (
        <>
          <header className="mt-8">
            <p className={styles.eyebrow}>{data.case.caseNumber}</p>
            <div className="flex flex-wrap items-center gap-4">
              <h1 className="break-words min-w-0">{data.case.title}</h1>
              <CaseStatusBadge status={data.case.status} />
            </div>
          </header>
          {data.case.archivedAt && (
            <StatusMessage>
              Archived on{' '}
              <time dateTime={data.case.archivedAt}>
                {new Date(data.case.archivedAt).toLocaleString()}
              </time>
              . Case details are read-only until restored. Data and assignments are retained.
            </StatusMessage>
          )}
          <nav aria-label="Case sections" className={styles.sections}>
            {Object.values(CaseSection).map((section) => (
              <button
                key={section}
                type="button"
                aria-current={location.section === section ? 'page' : undefined}
                aria-busy={pendingLocation?.section === section && location.section !== section}
                onClick={() => void navigate({ ...location, section })}
              >
                {caseSectionLabels[section]}
              </button>
            ))}
          </nav>
          {location.section === CaseSection.Documents ? (
            <DocumentLibrary
              key={id}
              caseId={id}
              caseLabel={data.case.caseNumber}
              archived={data.case.archivedAt !== null}
              role={user.role}
              request={request}
              location={location}
              navigate={navigate}
              pendingLocation={pendingLocation}
              onAccessRejected={setAccessError}
            />
          ) : (
            <CaseOverview data={data} user={user} request={request} onEdit={onEdit} />
          )}
        </>
      )}
    </section>
  );
}
