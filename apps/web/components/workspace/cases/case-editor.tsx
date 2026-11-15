'use client';

import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { caseSchema, type Case, type CaseCreate } from '@caseflow/schemas';
import type { AuthRequest } from '../../../hooks/use-authentication';
import { useResource } from '../../../hooks/use-resource';
import { ApiError } from '../../../lib/api';
import { caseDetailResource } from '../../../lib/workspace-resources';
import { caseFormValues } from '../../../lib/case-drafts';
import { ConfirmDialog } from '../../ui/confirm-dialog';
import { useToast } from '../../ui/toast-provider';
import { Button } from '../../ui/button';
import { LoadState } from '../../ui/load-state';
import { StatusMessage } from '../../ui/status-message';
import { CaseFieldsForm } from './case-fields-form';
import { useCaseDrafts } from './case-draft-provider';
import styles from './cases.module.css';

const EditConfirmation = { Discard: 'discard', Reload: 'reload' } as const;
type EditConfirmation = (typeof EditConfirmation)[keyof typeof EditConfirmation];

export function CaseEditor({
  id,
  request,
  onDone,
}: {
  id: string;
  request: AuthRequest;
  onDone: (saved: boolean) => void;
}) {
  const { data, error } = useResource(request, caseDetailResource(id));
  return !data ? (
    <LoadState error={error} />
  ) : (
    <LoadedEditor record={data.case} request={request} onDone={onDone} />
  );
}

function LoadedEditor({
  record,
  request,
  onDone,
}: {
  record: Case;
  request: AuthRequest;
  onDone: (saved: boolean) => void;
}) {
  const client = useQueryClient();
  const notify = useToast();
  const [confirmation, setConfirmation] = useState<EditConfirmation | null>(null);
  const { store, drafts } = useCaseDrafts();
  const draft = drafts.get(record.id);
  const values = draft?.values ?? caseFormValues(record);
  const conflict = Boolean(draft && (draft.conflict || draft.expectedVersion !== record.version));
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const submitting = useRef(false);
  const live = useRef(true);

  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);

  async function save(input: CaseCreate) {
    if (submitting.current || !draft || draft.saving || conflict || record.archivedAt) {
      return;
    }
    submitting.current = true;
    store.setSaving(record.id, true);
    setBusy(true);
    setError('');
    try {
      await request(`/cases/${record.id}`, caseSchema, {
        method: 'PATCH',
        body: JSON.stringify({ ...input, expectedVersion: draft.expectedVersion }),
      });
      store.remove(record.id);
      notify('Case saved.');
      if (live.current) {
        onDone(true);
      }
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 409) {
        store.markConflict(record.id);
      }
      if (live.current) {
        setError(cause instanceof Error ? cause.message : 'The case could not be saved.');
      }
    } finally {
      store.setSaving(record.id, false);
      submitting.current = false;
      if (live.current) {
        setConfirmation(null);
      }
      if (live.current) {
        setBusy(false);
      }
    }
  }

  async function reload() {
    if (submitting.current || draft?.saving) {
      return;
    }
    submitting.current = true;
    store.setSaving(record.id, true);
    setBusy(true);
    setError('');
    try {
      const resource = caseDetailResource(record.id);
      const latest = await request(resource.path, resource.schema);
      client.setQueryData([resource.path], latest);
      store.remove(record.id);
      if (latest.case.archivedAt && live.current) {
        onDone(false);
      }
    } catch (cause) {
      if (live.current) {
        setError(cause instanceof Error ? cause.message : 'The case could not be loaded.');
      }
    } finally {
      store.setSaving(record.id, false);
      submitting.current = false;
      if (live.current) {
        setConfirmation(null);
      }
      if (live.current) {
        setBusy(false);
      }
    }
  }

  function discard() {
    store.remove(record.id);
    setConfirmation(null);
    onDone(false);
  }

  function cancel() {
    if (draft) {
      setConfirmation(EditConfirmation.Discard);
    } else {
      onDone(false);
    }
  }

  return (
    <section className={styles.formPage}>
      <p className={styles.eyebrow}>{record.caseNumber}</p>
      <h1>Edit case</h1>
      <p className="mt-2 text-ink-soft">
        Unsaved edits stay here while you move around this workspace. Save before leaving the app.
      </p>
      {record.archivedAt && (
        <StatusMessage>
          This case is archived. Its details are read-only until restored.
        </StatusMessage>
      )}
      <CaseFieldsForm
        values={values}
        onChange={(next) => store.update(record, next)}
        onSubmit={save}
        onCancel={cancel}
        busy={busy || Boolean(draft?.saving)}
        readOnly={Boolean(record.archivedAt)}
        blocked={!draft || conflict || Boolean(record.archivedAt)}
        error={
          conflict
            ? 'This case changed since you started editing. Your draft is retained. Reload the latest saved case to discard this draft and review the changes.'
            : error
        }
        submitLabel="Save changes"
        busyLabel="Saving…"
      >
        {conflict && (
          <Button
            variant="secondary"
            disabled={busy}
            onClick={() => setConfirmation(EditConfirmation.Reload)}
          >
            Reload latest saved case
          </Button>
        )}
      </CaseFieldsForm>
      <ConfirmDialog
        open={confirmation !== null}
        title={
          confirmation === EditConfirmation.Reload
            ? 'Reload the latest case?'
            : 'Discard your edits?'
        }
        confirmLabel={
          confirmation === EditConfirmation.Reload ? 'Discard and reload' : 'Discard edits'
        }
        busy={busy}
        onCancel={() => setConfirmation(null)}
        onConfirm={() => {
          if (confirmation === EditConfirmation.Reload) {
            void reload();
          } else {
            discard();
          }
        }}
      >
        <p>
          Your unsaved edits to <strong>{record.caseNumber}</strong> will be discarded.
        </p>
        {confirmation === EditConfirmation.Reload && (
          <p className="mt-3">
            The form will show the latest saved details. Review them before making new changes.
          </p>
        )}
      </ConfirmDialog>
    </section>
  );
}
