import {
  CaseArchiveFilter,
  CaseLimits,
  CaseStatus,
  caseArchiveLabels,
  caseStatusLabels,
} from '@caseflow/schemas';
import type { WorkspaceNavigate } from '../../../hooks/use-workspace-navigation';
import type { WorkspaceLocation } from '../../../lib/workspace-location';
import { Button } from '../../ui/button';
import styles from './cases.module.css';

const searchDebounceMs = 300;

type Filters = Pick<WorkspaceLocation, 'search' | 'status' | 'archive'>;

export function CaseFilters({
  location,
  navigate,
}: {
  location: WorkspaceLocation;
  navigate: WorkspaceNavigate;
}) {
  const filtered = Boolean(
    location.search || location.status || location.archive !== CaseArchiveFilter.Current,
  );

  function apply(changes: Partial<Filters>, debounceMs = 0) {
    void navigate({ ...location, ...changes, page: 1 }, { replace: true, debounceMs });
  }

  return (
    <form
      className={styles.filters}
      role="search"
      aria-label="Filter cases"
      onSubmit={(event) => {
        event.preventDefault();
        apply({});
      }}
    >
      <label className={styles.searchField}>
        Search cases
        <input
          className={styles.input}
          name="search"
          value={location.search}
          onChange={(event) => apply({ search: event.target.value }, searchDebounceMs)}
          maxLength={CaseLimits.Search}
          placeholder="Case number, title, or client"
          type="search"
        />
      </label>
      <label className={styles.statusField}>
        Status
        <select
          className={styles.input}
          name="status"
          value={location.status ?? ''}
          onChange={(event) =>
            apply({ status: (event.target.value || undefined) as CaseStatus | undefined })
          }
        >
          <option value="">All statuses</option>
          {Object.values(CaseStatus).map((status) => (
            <option key={status} value={status}>
              {caseStatusLabels[status]}
            </option>
          ))}
        </select>
      </label>
      <label className={styles.statusField}>
        Show cases
        <select
          className={styles.input}
          name="archive"
          value={location.archive}
          onChange={(event) => apply({ archive: event.target.value as CaseArchiveFilter })}
        >
          {Object.values(CaseArchiveFilter).map((archive) => (
            <option key={archive} value={archive}>
              {caseArchiveLabels[archive]}
            </option>
          ))}
        </select>
      </label>
      {filtered && (
        <Button
          variant="secondary"
          onClick={() =>
            apply({ search: '', status: undefined, archive: CaseArchiveFilter.Current })
          }
        >
          Clear filters
        </Button>
      )}
    </form>
  );
}
