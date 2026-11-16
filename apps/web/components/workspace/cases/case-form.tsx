'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { caseSchema, type Case, type CaseCreate } from '@caseflow/schemas';
import type { AuthRequest } from '../../../hooks/use-authentication';
import { emptyCaseValues, type CaseFormValues } from '../../../lib/case-drafts';
import { Button } from '../../ui/button';
import { ConfirmDialog } from '../../ui/confirm-dialog';
import { Modal } from '../../ui/overlay-dialog';
import { useToast } from '../../ui/toast-provider';
import { CaseFieldsForm } from './case-fields-form';
import styles from './cases.module.css';

const isEmpty = (values: CaseFormValues) =>
  (Object.keys(emptyCaseValues) as (keyof CaseFormValues)[]).every(
    (key) => values[key] === emptyCaseValues[key],
  );

/** Create-case form in a modal over the case list. Closing with entered details asks first. */
export function CreateCaseModal({
  open,
  request,
  onCreated,
  onClose,
}: {
  open: boolean;
  request: AuthRequest;
  onCreated: (record: Case) => void;
  onClose: () => void;
}) {
  const formId = useId();
  const notify = useToast();
  const [values, setValues] = useState(emptyCaseValues);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const submitting = useRef(false);
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);

  function reset() {
    setValues(emptyCaseValues);
    setError('');
    setConfirmDiscard(false);
  }

  function requestClose() {
    if (busy) {
      return;
    }
    if (isEmpty(values)) {
      onClose();
    } else {
      setConfirmDiscard(true);
    }
  }

  async function submit(input: CaseCreate) {
    if (submitting.current) {
      return;
    }
    submitting.current = true;
    setBusy(true);
    setError('');
    try {
      const record = await request('/cases', caseSchema, {
        method: 'POST',
        body: JSON.stringify(input),
      });
      notify('Case created.');
      if (live.current) {
        reset();
        onCreated(record);
      }
    } catch (cause) {
      if (live.current) {
        setError(cause instanceof Error ? cause.message : 'The case could not be created.');
      }
    } finally {
      submitting.current = false;
      if (live.current) {
        setBusy(false);
      }
    }
  }

  return (
    <>
      <Modal
        open={open}
        title="Create case"
        description="Start with the essentials. Use fictional client information for this demo."
        closeLabel="Close create case"
        onClose={requestClose}
        onExited={reset}
        footer={
          <>
            <Button variant="secondary" disabled={busy} onClick={requestClose}>
              Cancel
            </Button>
            <Button type="submit" form={formId} disabled={busy}>
              {busy ? 'Creating case…' : 'Create case'}
            </Button>
          </>
        }
      >
        <div className={styles.modalForm}>
          <CaseFieldsForm
            id={formId}
            inlineActions={false}
            values={values}
            onChange={setValues}
            onSubmit={submit}
            onCancel={requestClose}
            busy={busy}
            error={error}
            submitLabel="Create case"
            busyLabel="Creating case…"
          />
        </div>
      </Modal>
      <ConfirmDialog
        open={confirmDiscard}
        title="Discard this new case?"
        confirmLabel="Discard"
        onCancel={() => setConfirmDiscard(false)}
        onConfirm={() => {
          setConfirmDiscard(false);
          onClose();
        }}
      >
        <p>The details you entered haven’t been saved.</p>
      </ConfirmDialog>
    </>
  );
}
