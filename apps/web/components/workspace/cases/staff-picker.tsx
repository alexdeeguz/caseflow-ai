'use client';

import { useState } from 'react';
import { Role } from '@caseflow/schemas';

import type { AuthRequest } from '../../../hooks/use-authentication';
import { useResource } from '../../../hooks/use-resource';
import { Button } from '../../ui/button';
import { LoadState } from '../../ui/load-state';
import { Pagination } from '../../ui/pagination';
import { userListResource } from '../../../lib/workspace-resources';
import styles from './cases.module.css';

export function StaffPicker({
  request,
  assigned,
  busy,
  onAssign,
}: {
  request: AuthRequest;
  assigned: string[];
  busy: boolean;
  onAssign: (id: string) => void;
}) {
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(1);
  const { data, error } = useResource(
    request,
    userListResource({ page, search: query, role: Role.Staff }),
  );

  return (
    <div className={styles.staffPicker}>
      <h4 className={styles.pickerTitle}>Assign Staff</h4>
      <form
        className={styles.pickerSearch}
        onSubmit={(e) => {
          e.preventDefault();
          setPage(1);
          setQuery(search);
        }}
      >
        <label htmlFor="staff-search" className="sr-only">
          Find Staff
        </label>
        <input
          id="staff-search"
          placeholder="Find Staff by display name"
          maxLength={100}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <Button type="submit" className={styles.compactButton}>
          Search
        </Button>
      </form>
      {!data ? (
        <LoadState error={error} label="Loading Staff…" size="md" />
      ) : (
        <>
          <ul className={styles.people}>
            {data.items.map((person) => (
              <li key={person.id}>
                <div className={styles.personText}>
                  <span className={styles.personName}>{person.displayName}</span>
                  <span className={styles.personId}>{person.id}</span>
                </div>
                <Button
                  variant="secondary"
                  className={styles.compactButton}
                  disabled={busy || !person.active || assigned.includes(person.id)}
                  onClick={() => onAssign(person.id)}
                >
                  {assigned.includes(person.id)
                    ? 'Assigned'
                    : !person.active
                      ? 'Disabled'
                      : 'Assign'}
                  <span className="sr-only"> {person.displayName}</span>
                </Button>
              </li>
            ))}
          </ul>
          {!data.items.length && <p className={styles.railEmpty}>No matching Staff.</p>}
          <Pagination {...data} onPage={setPage} />
        </>
      )}
    </div>
  );
}
