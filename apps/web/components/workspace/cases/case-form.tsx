'use client';

import { useEffect, useRef, useState } from 'react';
import { caseSchema, type Case, type CaseCreate } from '@caseflow/schemas';
import type { AuthRequest } from '../../../hooks/use-authentication';
import { emptyCaseValues } from '../../../lib/case-drafts';
import { useToast } from '../../ui/toast-provider';
import { CaseFieldsForm } from './case-fields-form';
import styles from './cases.module.css';

export function CaseForm({
  request,
  onCreated,
  onCancel,
}: {
  request: AuthRequest;
  onCreated: (record: Case) => void;
  onCancel: () => void;
}) {
  const notify = useToast();
  const [values, setValues] = useState(emptyCaseValues);
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
        onCreated(record);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The case could not be created.');
      submitting.current = false;
      setBusy(false);
    }
  }

  return (
    <section className={styles.formPage}>
      <p className={styles.eyebrow}>CASE MANAGEMENT</p>
      <h1>Create case</h1>
      <p className="text-ink-soft mt-2">
        Start with the essentials. Use fictional client information for this demo.
      </p>
      <CaseFieldsForm
        values={values}
        onChange={setValues}
        onSubmit={submit}
        onCancel={onCancel}
        busy={busy}
        error={error}
        submitLabel="Create case"
        busyLabel="Creating case…"
      />
    </section>
  );
}
