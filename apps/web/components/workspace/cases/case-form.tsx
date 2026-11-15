'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import {
  CaseLimits,
  CaseStatus,
  caseStatusLabels,
  caseCreateSchema,
  caseSchema,
  type Case,
} from '@caseflow/schemas';
import type { AuthRequest } from '../../../hooks/use-authentication';
import { Button } from '../../ui/button';
import { FormField } from '../../ui/form-field';
import { StatusMessage } from '../../ui/status-message';
import styles from './cases.module.css';

type FieldErrors = Partial<
  Record<'title' | 'clientName' | 'incidentDate' | 'status' | 'summary', string>
>;

export function CaseForm({
  request,
  onCreated,
  onCancel,
}: {
  request: AuthRequest;
  onCreated: (record: Case) => void;
  onCancel: () => void;
}) {
  const [errors, setErrors] = useState<FieldErrors>({});
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const submitting = useRef(false);
  const live = useRef(true);
  const errorSummary = useRef<HTMLDivElement>(null);

  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);

  useEffect(() => {
    if (Object.keys(errors).length) {
      errorSummary.current?.focus();
    }
  }, [errors]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting.current) {
      return;
    }

    const values = new FormData(event.currentTarget);
    const result = caseCreateSchema.safeParse({
      title: values.get('title'),
      clientName: values.get('clientName'),
      incidentDate: values.get('incidentDate') || null,
      status: values.get('status'),
      summary: values.get('summary'),
    });

    setError('');
    if (!result.success) {
      const next: FieldErrors = {};
      for (const issue of result.error.issues) {
        const field = issue.path[0] as keyof FieldErrors;
        next[field] ??= issue.message;
      }
      setErrors(next);
      return;
    }

    setErrors({});
    submitting.current = true;
    setBusy(true);

    let saved = false;

    try {
      const created = await request('/cases', caseSchema, {
        method: 'POST',
        body: JSON.stringify(result.data),
      });
      saved = true;
      if (live.current) {
        onCreated(created);
      }
    } catch (cause) {
      if (live.current) {
        setError(cause instanceof Error ? cause.message : 'The case could not be created.');
      }
    } finally {
      if (!saved) {
        submitting.current = false;
        if (live.current) {
          setBusy(false);
        }
      }
    }
  }

  function accessibility(field: keyof FieldErrors) {
    return {
      'aria-invalid': Boolean(errors[field]),
      'aria-describedby': errors[field] ? `case-${field}-error` : undefined,
    };
  }

  return (
    <section className={styles.formPage}>
      <p className={styles.eyebrow}>CASE MANAGEMENT</p>
      <h1>Create case</h1>
      <p className="text-ink-soft mt-2">
        Start with the essentials. Use fictional client information for this demo.
      </p>
      <form onSubmit={(event) => void submit(event)} noValidate className="mt-8">
        {Object.keys(errors).length > 0 && (
          <div ref={errorSummary} tabIndex={-1} role="alert" className={styles.errorSummary}>
            <h2 className="font-semibold">Check the following fields</h2>
            <ul>
              {Object.entries(errors).map(([field, message]) => (
                <li key={field}>
                  <a className="underline" href={`#case-${field}`}>
                    {message}
                  </a>
                </li>
              ))}
            </ul>
          </div>
        )}
        <fieldset disabled={busy} className={styles.fields}>
          <FormField id="case-title" label="Case title (required)" error={errors.title}>
            <input
              className={styles.input}
              id="case-title"
              name="title"
              required
              maxLength={CaseLimits.Title}
              autoComplete="off"
              {...accessibility('title')}
            />
          </FormField>
          <FormField
            id="case-clientName"
            label="Fictional client name (required)"
            error={errors.clientName}
          >
            <input
              className={styles.input}
              id="case-clientName"
              name="clientName"
              required
              maxLength={CaseLimits.ClientName}
              autoComplete="off"
              {...accessibility('clientName')}
            />
          </FormField>
          <div className={styles.fieldPair}>
            <FormField
              id="case-incidentDate"
              label="Incident date (optional)"
              error={errors.incidentDate}
            >
              <input
                className={styles.input}
                id="case-incidentDate"
                name="incidentDate"
                type="date"
                min="0001-01-01"
                max="9999-12-31"
                {...accessibility('incidentDate')}
              />
            </FormField>
            <FormField id="case-status" label="Status" error={errors.status}>
              <select
                className={styles.input}
                id="case-status"
                name="status"
                defaultValue={CaseStatus.Intake}
                {...accessibility('status')}
              >
                {Object.values(CaseStatus).map((status) => (
                  <option key={status} value={status}>
                    {caseStatusLabels[status]}
                  </option>
                ))}
              </select>
            </FormField>
          </div>
          <FormField
            id="case-summary"
            label="Summary (optional)"
            error={errors.summary}
            hint="Up to 2,000 characters."
          >
            <textarea
              className={styles.input}
              id="case-summary"
              name="summary"
              rows={5}
              maxLength={CaseLimits.Summary}
              {...accessibility('summary')}
              aria-describedby={
                errors.summary ? 'case-summary-error case-summary-hint' : 'case-summary-hint'
              }
            />
          </FormField>
        </fieldset>
        {error && <StatusMessage tone="error">{error}</StatusMessage>}
        <div className="flex flex-wrap gap-3 mt-8">
          <Button type="submit" disabled={busy}>
            {busy ? 'Creating case…' : 'Create case'}
          </Button>
          <Button variant="secondary" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
        </div>
      </form>
    </section>
  );
}
