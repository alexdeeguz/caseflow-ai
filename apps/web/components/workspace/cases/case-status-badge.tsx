import { caseStatusLabels, type CaseStatus } from '@caseflow/schemas';
import styles from './cases.module.css';

export function CaseStatusBadge({ status }: { status: CaseStatus }) {
  return <span className={`${styles.badge} ${styles[status]}`}>{caseStatusLabels[status]}</span>;
}
