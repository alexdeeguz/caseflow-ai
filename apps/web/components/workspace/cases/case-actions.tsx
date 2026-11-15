'use client';

import { useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { caseSchema, type Case } from '@caseflow/schemas';
import type { AuthRequest } from '../../../hooks/use-authentication';
import { ApiError } from '../../../lib/api';
import { Button } from '../../ui/button';
import { ConfirmDialog } from '../../ui/confirm-dialog';
import { useToast } from '../../ui/toast-provider';
import { StatusMessage } from '../../ui/status-message';

export function CaseActions({
  record,
  request,
  onEdit,
}: {
  record: Case;
  request: AuthRequest;
  onEdit: () => void;
}) {
  const client = useQueryClient();
  const [error, setError] = useState('');
  const notify = useToast();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const submitting = useRef(false);
  const archived = Boolean(record.archivedAt);

  async function changeArchive() {
    if (submitting.current) {
      return;
    }
    submitting.current = true;
    setBusy(true);
    setError('');
    try {
      await request(`/cases/${record.id}/${archived ? 'restore' : 'archive'}`, caseSchema, {
        method: 'POST',
        body: JSON.stringify({ expectedVersion: record.version }),
      });
      notify(archived ? 'Case restored.' : 'Case archived. Data and assignments are retained.');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The case could not be updated.');
      if (cause instanceof ApiError && cause.status === 409) {
        await client.invalidateQueries();
      }
    } finally {
      submitting.current = false;
      setBusy(false);
      setConfirming(false);
    }
  }

  return (
    <div className="mt-6">
      <div className="flex flex-wrap gap-3">
        {!archived && (
          <Button onClick={onEdit} disabled={busy}>
            Edit case
          </Button>
        )}
        <Button
          variant="secondary"
          onClick={() => {
            if (archived) {
              void changeArchive();
            } else {
              setConfirming(true);
            }
          }}
          disabled={busy}
        >
          {busy ? 'Updating…' : archived ? 'Restore case' : 'Archive case'}
        </Button>
      </div>
      {error && <StatusMessage tone="error">{error}</StatusMessage>}
      <ConfirmDialog
        open={confirming}
        title="Archive this case?"
        confirmLabel="Archive case"
        cancelLabel="Keep current"
        busy={busy}
        onCancel={() => setConfirming(false)}
        onConfirm={() => void changeArchive()}
      >
        <p className="font-semibold text-ink">
          {record.caseNumber} · {record.title}
        </p>
        <p className="mt-3">
          Its data and assignments will remain available. Restore the case to edit its details
          again.
        </p>
      </ConfirmDialog>
    </div>
  );
}
