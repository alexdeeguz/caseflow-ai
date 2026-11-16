import type { Role } from '@caseflow/schemas';
import { ConfirmDialog } from '../../ui/confirm-dialog';
import { StatusMessage } from '../../ui/status-message';
import { factExtractionAction } from '../../../lib/fact-extraction/presentation';
import type { useFactExtractionAction } from './use-fact-extraction-action';

export function FactExtractionConfirmation({
  action,
  role,
  archived,
  enabled,
}: {
  action: ReturnType<typeof useFactExtractionAction>;
  role: Role;
  archived: boolean;
  enabled: boolean;
}) {
  const label = action.selected ? factExtractionAction(action.selected, role, archived) : null;
  return (
    <ConfirmDialog
      open={action.selected !== null}
      title={`${label ?? 'Extract facts'}?`}
      confirmLabel={label ?? 'Extract facts'}
      busy={action.busy}
      confirmDisabled={!enabled || !label}
      onCancel={action.cancel}
      onConfirm={action.confirm}
    >
      <p>
        <strong>{action.selected?.filename}</strong>
      </p>
      <p>
        The saved document text will be sent to OpenAI to extract dates, providers, treatments, and
        findings. Results remain unreviewed and include source quotations.
      </p>
      <p>
        Extraction uses the shared $1 daily application allowance. It may stop when that allowance
        is reached.
      </p>
      {!enabled && <p>Reconnect and refresh documents before continuing.</p>}
      {action.error && <StatusMessage tone="error">{action.error}</StatusMessage>}
    </ConfirmDialog>
  );
}
