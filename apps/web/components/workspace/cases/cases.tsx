'use client';

import { CaseArchiveFilter, Role, type User } from '@caseflow/schemas';
import type { AuthRequest } from '../../../hooks/use-authentication';
import { useResource } from '../../../hooks/use-resource';
import { Button } from '../../ui/button';
import { StatusMessage } from '../../ui/status-message';
import { LoadState } from '../../ui/load-state';
import { LoadingRegion } from '../../ui/loading-region';
import { Pagination } from '../../ui/pagination';
import { CaseDetail } from './case-detail';
import { CreateCaseModal } from './case-form';
import { CaseEditor } from './case-editor';
import { CaseList } from './case-list';
import { caseListResource } from '../../../lib/workspace-resources';
import { CaseMode, CaseView } from '../../../lib/constants/navigation';
import type { WorkspaceLocation } from '../../../lib/workspace-location';
import type { WorkspaceNavigate } from '../../../hooks/use-workspace-navigation';
import { CaseFilters } from './case-filters';
import styles from './cases.module.css';

interface CasesProps {
  request: AuthRequest;
  user: User;
  location: WorkspaceLocation;
  navigate: WorkspaceNavigate;
  pendingLocation: WorkspaceLocation | null;
}

export function Cases({ request, user, location, navigate, pendingLocation }: CasesProps) {
  const onBack = () => {
    void navigate({ ...location, case: null, mode: undefined });
  };

  if (location.case === CaseView.New && user.role === Role.Staff) {
    return <StatusMessage tone="error">Only administrators can create cases.</StatusMessage>;
  }

  if (location.case && location.case !== CaseView.New && location.mode === CaseMode.Edit) {
    return user.role === Role.Staff ? (
      <StatusMessage tone="error">Only administrators can edit cases.</StatusMessage>
    ) : (
      <CaseEditor
        key={location.case}
        id={location.case}
        request={request}
        onDone={() => {
          void navigate({ ...location, mode: undefined }, { replace: true });
        }}
      />
    );
  }

  if (location.case && location.case !== CaseView.New) {
    return (
      <CaseDetail
        key={location.case}
        id={location.case}
        location={location}
        navigate={navigate}
        pendingLocation={pendingLocation?.case === location.case ? pendingLocation : null}
        user={user}
        request={request}
        onBack={onBack}
        onEdit={() => {
          void navigate({ ...location, mode: CaseMode.Edit });
        }}
      />
    );
  }

  return (
    <CaseBrowser
      request={request}
      user={user}
      location={location}
      navigate={navigate}
      pendingLocation={pendingLocation}
    />
  );
}

/** Case list; `case=new` opens the create-case modal over it. */
function CaseBrowser({ request, user, location, navigate, pendingLocation }: CasesProps) {
  const { data, error } = useResource(request, caseListResource(location));
  const listLocation = { ...location, case: null, mode: undefined };
  // Only a different list query (search, filter, page) reloads the list; opening or closing the
  // create-case modal does not.
  const reloading =
    !!pendingLocation &&
    !pendingLocation.case &&
    caseListResource(pendingLocation).path !== caseListResource(location).path;
  const filtered = Boolean(
    location.search.trim() || location.status || location.archive !== CaseArchiveFilter.Current,
  );

  return (
    <section>
      <header className={styles.header}>
        <div>
          <p className={styles.eyebrow}>CASE MANAGEMENT</p>
          <h1>Cases</h1>
          <p className="mt-2 text-ink-soft">
            {user.role === Role.Staff
              ? 'Your assigned cases, in one place.'
              : 'Manage access and explore your fictional case workspace.'}
          </p>
        </div>
        {user.role !== Role.Staff && (
          <Button
            onClick={() => void navigate({ ...location, case: CaseView.New, mode: undefined })}
          >
            Create case
          </Button>
        )}
      </header>
      <CaseFilters
        location={pendingLocation && !pendingLocation.case ? pendingLocation : listLocation}
        navigate={navigate}
      />
      {!data ? (
        <LoadState error={error} />
      ) : (
        <LoadingRegion loading={reloading}>
          {!data.items.length ? (
            <StatusMessage>
              {filtered
                ? 'No cases match your search. Try another search or clear the filters.'
                : location.page > 1
                  ? 'No cases on this page. Return to an earlier page.'
                  : user.role === Role.Staff
                    ? 'No current cases assigned. Check Archived or ask an administrator to assign a case.'
                    : 'No current cases. Create a case or check Archived.'}
            </StatusMessage>
          ) : (
            <CaseList items={data.items} location={listLocation} />
          )}
          <Pagination {...data} onPage={(page) => void navigate({ ...listLocation, page })} />
        </LoadingRegion>
      )}
      {user.role !== Role.Staff && (
        <CreateCaseModal
          open={location.case === CaseView.New}
          request={request}
          onClose={() => void navigate(listLocation, { replace: true })}
          onCreated={(record) =>
            void navigate({ ...listLocation, case: record.id }, { replace: true })
          }
        />
      )}
    </section>
  );
}
