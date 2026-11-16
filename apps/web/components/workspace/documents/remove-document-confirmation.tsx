import { ConfirmDialog } from '../../ui/confirm-dialog';
import { StatusMessage } from '../../ui/status-message';
import type { useDocumentActions } from './use-document-actions';
import styles from './documents.module.css';

/** Confirmation before removing a document; shared by the library and standalone drawers. */
export function RemoveDocumentConfirmation({
  actions,
  canAct,
}: {
  actions: ReturnType<typeof useDocumentActions>;
  canAct: boolean;
}) {
  return (
    <ConfirmDialog
      open={actions.removing !== null}
      title="Remove document?"
      confirmLabel="Remove document"
      cancelLabel="Keep document"
      busy={actions.busy !== null}
      confirmDisabled={!canAct}
      onCancel={actions.cancel}
      onConfirm={actions.confirm}
    >
      <p>
        <strong className={styles.filename}>{actions.removing?.filename}</strong>
      </p>
      <p>
        The file and its history are retained. An administrator can restore it later. Previously
        issued download links may work for up to 60 seconds.
      </p>
      {!canAct && <p>Reconnect and refresh the documents before continuing.</p>}
      {actions.error && <StatusMessage tone="error">{actions.error}</StatusMessage>}
    </ConfirmDialog>
  );
}
