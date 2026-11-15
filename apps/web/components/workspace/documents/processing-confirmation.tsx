import type { Role } from '@caseflow/schemas';
import { ProcessingAction, processingAction } from '../../../lib/processing/presentation';
import { ConfirmDialog } from '../../ui/confirm-dialog';
import { StatusMessage } from '../../ui/status-message';
import { ProcessingLimitsNote } from './processing-details';
import type { useProcessingAction } from './use-processing-action';
import styles from './documents.module.css';

export function ProcessingConfirmation({
  processing,
  role,
  archived,
  enabled,
}: {
  processing: ReturnType<typeof useProcessingAction>;
  role: Role;
  archived: boolean;
  enabled: boolean;
}) {
  const document = processing.selected;
  const action = document ? processingAction(document, role, archived) : null;

  return (
    <ConfirmDialog
      open={document !== null}
      title={document?.processing.job ? 'Retry processing?' : 'Process document?'}
      confirmLabel={action === ProcessingAction.Retry ? 'Queue retry' : 'Queue processing'}
      cancelLabel="Cancel"
      busy={processing.busy}
      confirmDisabled={!enabled || !action}
      onCancel={processing.cancel}
      onConfirm={processing.confirm}
    >
      <p>
        <strong className={styles.filename}>{document?.filename}</strong>
      </p>
      <p>
        Queue this document for text extraction. Processing runs in the background and may use OCR.
      </p>
      {document && <ProcessingLimitsNote document={document} />}
      {!enabled && <p>Reconnect and refresh the documents before continuing.</p>}
      {enabled && document && !action && <p>This document is no longer eligible for processing.</p>}
      {processing.error && <StatusMessage tone="error">{processing.error}</StatusMessage>}
    </ConfirmDialog>
  );
}
