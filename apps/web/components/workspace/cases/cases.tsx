'use client';

import { useState } from 'react';
import { Role, type User } from '@caseflow/schemas';

import type { AuthRequest } from '../../../hooks/use-authentication';
import { useResource } from '../../../hooks/use-resource';
import { Button } from '../../ui/button';
import { StatusMessage } from '../../ui/status-message';
import { LoadState } from '../../ui/load-state';
import { Pagination } from '../../ui/pagination';
import { CaseDetail } from './case-detail';
import { caseListResource } from '../../../lib/workspace-resources';

export function Cases({ request, user }: { request: AuthRequest; user: User }) {
  const [selected, setSelected] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const { data, error } = useResource(request, caseListResource(page));

  if (selected) {
    return (
      <CaseDetail
        key={selected}
        id={selected}
        user={user}
        request={request}
        onBack={() => setSelected(null)}
      />
    );
  }

  return (
    <section>
      <h1>Cases</h1>
      <p>Fictional case stubs for exploring access and assignments.</p>
      {!data ? (
        <LoadState error={error} />
      ) : (
        <>
          {!data.items.length ? (
            <StatusMessage>
              {user.role === Role.Staff
                ? 'No cases assigned yet. An administrator can assign you a fictional case.'
                : 'No cases are available.'}
            </StatusMessage>
          ) : (
            <div className="grid gap-4 mt-6">
              {data.items.map((item) => (
                <article key={item.id} className="rounded-xl border border-line p-6">
                  <h2>{item.title}</h2>
                  <p>{item.summary}</p>
                  <Button variant="secondary" onClick={() => setSelected(item.id)}>
                    View case
                  </Button>
                </article>
              ))}
            </div>
          )}
          <Pagination {...data} onPage={setPage} />
        </>
      )}
    </section>
  );
}
