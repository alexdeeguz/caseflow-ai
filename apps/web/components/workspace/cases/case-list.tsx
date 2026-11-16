'use client';

import type { Case } from '@caseflow/schemas';
import Link from 'next/link';
import type { MouseEvent as ReactMouseEvent } from 'react';
import { CaseStatusBadge } from './case-status-badge';
import { formatIncidentDate } from '../../../lib/case-dates';
import { workspaceHref, type WorkspaceLocation } from '../../../lib/workspace-location';
import styles from './cases.module.css';

// A click anywhere on a row or card opens its case. The click is forwarded to the
// case link, so client-side navigation and Cmd/Ctrl-click to a new tab still work,
// and keyboard users keep the single link as the row's one tab stop.
function openCaseFromRow(event: ReactMouseEvent<HTMLElement>) {
  if ((event.target as HTMLElement).closest('a, button, input, select, textarea, label')) {
    return;
  }
  if (window.getSelection()?.toString()) {
    return; // the user was selecting text, not clicking
  }
  const link = event.currentTarget.querySelector<HTMLAnchorElement>('a[href]');
  link?.dispatchEvent(
    new MouseEvent('click', {
      bubbles: true,
      cancelable: true,
      view: window,
      ctrlKey: event.ctrlKey,
      metaKey: event.metaKey,
      shiftKey: event.shiftKey,
      altKey: event.altKey,
    }),
  );
}

export function CaseList({ items, location }: { items: Case[]; location: WorkspaceLocation }) {
  const href = (id: string) => workspaceHref({ ...location, case: id, mode: undefined });

  return (
    <>
      <div className={styles.desktopList}>
        <table className={styles.table}>
          <caption className="sr-only">Accessible cases</caption>
          <thead>
            <tr>
              <th scope="col">Case</th>
              <th scope="col">Client</th>
              <th scope="col">Incident date</th>
              <th scope="col">Status</th>
            </tr>
          </thead>
          <tbody>
            {items.map((item) => (
              <tr key={item.id} className={styles.clickableRow} onClick={openCaseFromRow}>
                <td>
                  <span className={styles.caseNumber}>{item.caseNumber}</span>
                  <Link href={href(item.id)} scroll={false} className={styles.caseLink}>
                    {item.title}
                  </Link>
                </td>
                <td>{item.clientName}</td>
                <td>{formatIncidentDate(item.incidentDate)}</td>
                <td>
                  <CaseStatusBadge status={item.status} />
                  {item.archivedAt && <span className="text-sm text-muted ml-2">Archived</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className={styles.mobileList}>
        {items.map((item) => (
          <article
            key={item.id}
            className={`${styles.card} ${styles.clickableRow}`}
            onClick={openCaseFromRow}
          >
            <div className="flex flex-wrap justify-between gap-3">
              <span className={styles.caseNumber}>{item.caseNumber}</span>
              <CaseStatusBadge status={item.status} />
              {item.archivedAt && <span className="text-sm text-muted ml-2">Archived</span>}
            </div>
            <h2>
              <Link href={href(item.id)} scroll={false} className={styles.caseLink}>
                {item.title}
              </Link>
            </h2>
            <p className="mt-3 text-sm">{item.clientName}</p>
            <p className="text-sm text-muted mt-1">
              Incident date: {formatIncidentDate(item.incidentDate)}
            </p>
          </article>
        ))}
      </div>
    </>
  );
}
