import type { DocumentListItem, Role } from '@caseflow/schemas';
import { factExtractionAction } from '../../../lib/fact-extraction/presentation';
import { ArrowRightIcon } from './document-icons';
import styles from './documents.module.css';

export function FactExtractionActionButton({
  document,
  role,
  archived,
  disabled,
  onExtract,
}: {
  document: DocumentListItem;
  role: Role;
  archived: boolean;
  disabled: boolean;
  onExtract: (document: DocumentListItem) => void;
}) {
  const action = factExtractionAction(document, role, archived);

  if (!action) {
    return null;
  }

  return (
    <button
      type="button"
      className={styles.nextAction}
      disabled={disabled}
      onClick={() => onExtract(document)}
    >
      {action}
      <ArrowRightIcon />
      <span className="sr-only"> for {document.filename}</span>
    </button>
  );
}
