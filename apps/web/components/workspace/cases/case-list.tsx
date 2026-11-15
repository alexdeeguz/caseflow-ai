import type { Case } from '@caseflow/schemas';
import Link from 'next/link';
import { CaseStatusBadge } from './case-status-badge';
import { formatIncidentDate } from '../../../lib/case-dates';
import { workspaceHref, type WorkspaceLocation } from '../../../lib/workspace-location';
import styles from './cases.module.css';

export function CaseList({ items, location }: { items: Case[]; location: WorkspaceLocation }) {
  const href = (id: string) => workspaceHref({ ...location, case: id });

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
              <tr key={item.id}>
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
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className={styles.mobileList}>
        {items.map((item) => (
          <article key={item.id} className={styles.card}>
            <div className="flex flex-wrap justify-between gap-3">
              <span className={styles.caseNumber}>{item.caseNumber}</span>
              <CaseStatusBadge status={item.status} />
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
