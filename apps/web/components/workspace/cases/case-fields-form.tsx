'use client';

import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import {
  CaseLimits,
  CaseStatus,
  caseStatusLabels,
  caseFieldsSchema,
  type CaseCreate,
} from '@caseflow/schemas';
import type { CaseFormValues } from '../../../lib/case-drafts';
import { Button } from '../../ui/button';
import { FormField } from '../../ui/form-field';
import { StatusMessage } from '../../ui/status-message';
import styles from './cases.module.css';

type FieldErrors = Partial<Record<keyof CaseFormValues, string>>;

export function CaseFieldsForm({
  id,
  inlineActions = true,
  values,
  onChange,
  onSubmit,
  onCancel,
  busy,
  blocked = false,
  readOnly = false,
  submitLabel,
  busyLabel,
  error,
  children,
}: {
  /** Lets buttons outside the form (e.g. a modal footer) submit it. */
  id?: string;
  /** Render Submit/Cancel below the fields; turn off when the container provides them. */
  inlineActions?: boolean;
  values: CaseFormValues;
  onChange: (values: CaseFormValues) => void;
  onSubmit: (values: CaseCreate) => Promise<void>;
  onCancel: () => void;
  busy: boolean;
  blocked?: boolean;
  readOnly?: boolean;
  submitLabel: string;
  busyLabel: string;
  error: string;
  children?: ReactNode;
}) {
  const [errors, setErrors] = useState<FieldErrors>({});
  const errorSummary = useRef<HTMLDivElement>(null);
  const requestError = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (Object.keys(errors).length) {
      errorSummary.current?.focus();
    } else if (error) {
      requestError.current?.focus();
    }
  }, [errors, error]);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || blocked) {
      return;
    }
    const result = caseFieldsSchema.safeParse({
      ...values,
      incidentDate: values.incidentDate || null,
    });
    if (!result.success) {
      const next: FieldErrors = {};
      for (const issue of result.error.issues) {
        next[issue.path[0] as keyof FieldErrors] ??= issue.message;
      }
      setErrors(next);
      return;
    }
    setErrors({});
    void onSubmit(result.data);
  }

  function accessibility(field: keyof FieldErrors) {
    return {
      'aria-invalid': Boolean(errors[field]),
      'aria-describedby': errors[field] ? `case-${field}-error` : undefined,
    };
  }

  return (
    <form id={id} onSubmit={submit} noValidate className={inlineActions ? 'mt-8' : undefined}>
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
      <fieldset disabled={busy || readOnly} className={styles.fields}>
        <FormField id="case-title" label="Case title" required error={errors.title}>
          <input
            className={styles.input}
            id="case-title"
            name="title"
            value={values.title}
            onChange={(event) => onChange({ ...values, title: event.target.value })}
            required
            maxLength={CaseLimits.Title}
            autoComplete="off"
            {...accessibility('title')}
          />
        </FormField>
        <FormField
          id="case-clientName"
          label="Fictional client name"
          required
          error={errors.clientName}
        >
          <input
            className={styles.input}
            id="case-clientName"
            name="clientName"
            value={values.clientName}
            onChange={(event) => onChange({ ...values, clientName: event.target.value })}
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
              value={values.incidentDate}
              onChange={(event) => onChange({ ...values, incidentDate: event.target.value })}
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
              value={values.status}
              onChange={(event) => onChange({ ...values, status: event.target.value })}
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
            value={values.summary}
            onChange={(event) => onChange({ ...values, summary: event.target.value })}
            rows={5}
            maxLength={CaseLimits.Summary}
            {...accessibility('summary')}
            aria-describedby={
              errors.summary ? 'case-summary-error case-summary-hint' : 'case-summary-hint'
            }
          />
        </FormField>
      </fieldset>

      {error && (
        <div ref={requestError} tabIndex={-1}>
          <StatusMessage tone="error">{error}</StatusMessage>
        </div>
      )}
      {children}
      {inlineActions && (
        <div className="flex flex-wrap gap-3 mt-8">
          <Button type="submit" disabled={busy || blocked}>
            {busy ? busyLabel : submitLabel}
          </Button>
          <Button variant="secondary" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
        </div>
      )}
    </form>
  );
}
