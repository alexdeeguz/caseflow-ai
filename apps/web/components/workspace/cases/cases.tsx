'use client';

import { CaseLimits, CaseStatus, Role, caseStatusLabels, type User } from '@caseflow/schemas';
import type { AuthRequest } from '../../../hooks/use-authentication';
import { useResource } from '../../../hooks/use-resource';
import { Button } from '../../ui/button';
import { StatusMessage } from '../../ui/status-message';
import { LoadState } from '../../ui/load-state';
import { Pagination } from '../../ui/pagination';
import { CaseDetail } from './case-detail';
import { CaseForm } from './case-form';
import { CaseList } from './case-list';
import { caseListResource } from '../../../lib/workspace-resources';
import { CaseView } from '../../../lib/constants/navigation';
import type { WorkspaceLocation } from '../../../lib/workspace-location';
import styles from './cases.module.css';

type Navigate = (location: WorkspaceLocation, replace?: boolean) => Promise<void>;

interface CasesProps {
  request: AuthRequest;
  user: User;
  location: WorkspaceLocation;
  navigate: Navigate;
}

export function Cases({ request, user, location, navigate }: CasesProps) {
  const onBack = () => {
    void navigate({ ...location, case: null });
  };

  if (location.case === CaseView.New) {
    return user.role === Role.Staff ? (
      <StatusMessage tone="error">Only administrators can create cases.</StatusMessage>
    ) : (
      <CaseForm
        request={request}
        onCancel={onBack}
        onCreated={(record) => {
          void navigate({ ...location, case: record.id }, true);
        }}
      />
    );
  }

  if (location.case) {
    return (
      <CaseDetail
        key={location.case}
        id={location.case}
        user={user}
        request={request}
        onBack={onBack}
      />
    );
  }

  return <CaseBrowser request={request} user={user} location={location} navigate={navigate} />;
}

function CaseBrowser({ request, user, location, navigate }: CasesProps) {
  const { data, error } = useResource(request, caseListResource(location));
  const filtered = Boolean(location.search || location.status);

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
          <Button onClick={() => void navigate({ ...location, case: CaseView.New })}>
            Create case
          </Button>
        )}
      </header>
      <form
        key={`${location.search}:${location.status ?? ''}`}
        className={styles.filters}
        onSubmit={(event) => {
          event.preventDefault();
          const values = new FormData(event.currentTarget);
          void navigate({
            ...location,
            search: String(values.get('search') ?? '').trim(),
            status: (values.get('status') || undefined) as CaseStatus | undefined,
            page: 1,
          });
        }}
      >
        <label className={styles.searchField}>
          Search cases
          <input
            className={styles.input}
            name="search"
            defaultValue={location.search}
            maxLength={CaseLimits.Search}
            placeholder="Case number, title, or client"
            type="search"
          />
        </label>
        <label className={styles.statusField}>
          Status
          <select className={styles.input} name="status" defaultValue={location.status ?? ''}>
            <option value="">All statuses</option>
            {Object.values(CaseStatus).map((status) => (
              <option key={status} value={status}>
                {caseStatusLabels[status]}
              </option>
            ))}
          </select>
        </label>
        <Button type="submit" variant="secondary">
          Search
        </Button>
        {filtered && (
          <Button
            variant="secondary"
            onClick={() => void navigate({ ...location, search: '', status: undefined, page: 1 })}
          >
            Clear filters
          </Button>
        )}
      </form>
      {!data ? (
        <LoadState error={error} />
      ) : (
        <>
          {!data.items.length ? (
            <StatusMessage>
              {filtered
                ? 'No cases match your search. Try another search or clear the filters.'
                : location.page > 1
                  ? 'No cases on this page. Return to an earlier page.'
                  : user.role === Role.Staff
                    ? 'No cases assigned yet. An administrator can assign you a case.'
                    : 'No cases yet. Create a case to get started.'}
            </StatusMessage>
          ) : (
            <CaseList items={data.items} location={location} />
          )}
          <Pagination {...data} onPage={(page) => void navigate({ ...location, page })} />
        </>
      )}
    </section>
  );
}
