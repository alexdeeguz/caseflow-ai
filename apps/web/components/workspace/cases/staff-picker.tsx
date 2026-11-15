'use client';

import { useState } from 'react';
import { Role } from '@caseflow/schemas';

import type { AuthRequest } from '../../../hooks/use-authentication';
import { useResource } from '../../../hooks/use-resource';
import { Button } from '../../ui/button';
import { LoadState } from '../../ui/load-state';
import { Pagination } from '../../ui/pagination';
import { userListResource } from '../../../lib/workspace-resources';

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
    <div className="mt-8">
      <h2>Assign Staff</h2>
      <form
        className="flex flex-wrap gap-3 my-4"
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
        <Button type="submit">Search</Button>
      </form>
      {!data ? (
        <LoadState error={error} />
      ) : (
        <>
          {data.items.map((person) => (
            <div className="flex flex-wrap gap-4 items-center py-3" key={person.id}>
              <div>
                <strong>{person.displayName}</strong>
                <p className="text-xs text-muted break-all">{person.id}</p>
              </div>
              <Button
                variant="secondary"
                disabled={busy || !person.active || assigned.includes(person.id)}
                onClick={() => onAssign(person.id)}
              >
                {assigned.includes(person.id) ? 'Assigned' : !person.active ? 'Disabled' : 'Assign'}
              </Button>
            </div>
          ))}
          {!data.items.length && <p>No matching Staff.</p>}
          <Pagination {...data} onPage={setPage} />
        </>
      )}
    </div>
  );
}
