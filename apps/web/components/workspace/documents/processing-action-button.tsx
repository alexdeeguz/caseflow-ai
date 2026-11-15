import type { DocumentListItem, Role } from '@caseflow/schemas';
import { processingAction, processingActionLabels } from '../../../lib/processing/presentation';
import styles from './documents.module.css';

export function ProcessingActionButton({
  document,
  role,
  archived,
  disabled,
  busy,
  onProcess,
}: {
  document: DocumentListItem;
  role: Role;
  archived: boolean;
  disabled: boolean;
  busy: boolean;
  onProcess: (document: DocumentListItem) => void;
}) {
  const action = processingAction(document, role, archived);
  if (!action) {
    return null;
  }
  return (
    <button
      type="button"
      className={styles.actionButton}
      disabled={disabled}
      onClick={() => onProcess(document)}
    >
      {busy ? 'Queuing…' : processingActionLabels[action]}
      <span className="sr-only"> {document.filename}</span>
    </button>
  );
}
