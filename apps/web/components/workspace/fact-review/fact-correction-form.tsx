'use client';
import { useId, useRef, useState, type FormEvent } from 'react';
import {
  FactCategory,
  factCategoryLabels,
  factCorrectionSchema,
  FactReviewLimits,
  type FactValues,
} from '@caseflow/schemas';
import type { FactDraft } from '../../../lib/fact-review/drafts';
import { FormField } from '../../ui/form-field';
import { Button } from '../../ui/button';
import styles from './review.module.css';

export function FactCorrectionForm({
  draft,
  disabled,
  busy,
  onChange,
  onSave,
  onCancel,
}: {
  draft: FactDraft;
  disabled: boolean;
  busy: boolean;
  onChange: (patch: Partial<Pick<FactDraft, 'values' | 'reason'>>) => void;
  onSave: () => void;
  onCancel: () => void;
}) {
  const id = useId();
  const summary = useRef<HTMLDivElement>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const values = draft.values;

  function update<K extends keyof FactValues>(key: K, value: FactValues[K]) {
    onChange({ values: { ...values, [key]: value } });
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    const parsed = factCorrectionSchema.safeParse({
      expectedVersion: draft.expectedVersion,
      values,
      reason: draft.reason,
    });
    if (!parsed.success) {
      const next: Record<string, string> = {};
      parsed.error.issues.forEach((issue) => {
        next[String(issue.path.at(-1) ?? 'category')] = issue.message;
      });
      setErrors(next);
      requestAnimationFrame(() => summary.current?.focus());

      return;
    }

    setErrors({});
    onSave();
  }

  function textField(
    key: 'value' | 'qualifier' | 'dateValue' | 'dateMeaning',
    label: string,
    required = false,
    maxLength = 1000,
    hint?: string,
  ) {
    const fieldId = `${id}-${key}`;

    return (
      <FormField id={fieldId} label={label} required={required} error={errors[key]} hint={hint}>
        <input
          id={fieldId}
          value={values[key] ?? ''}
          required={required}
          maxLength={maxLength}
          aria-invalid={!!errors[key]}
          aria-describedby={
            [errors[key] ? `${fieldId}-error` : '', hint ? `${fieldId}-hint` : '']
              .filter(Boolean)
              .join(' ') || undefined
          }
          onChange={(event) =>
            update(key, key === 'value' ? event.target.value : event.target.value || null)
          }
        />
      </FormField>
    );
  }

  return (
    <form onSubmit={submit} noValidate className={styles.form}>
      {!!Object.keys(errors).length && (
        <div ref={summary} tabIndex={-1} role="alert" className={styles.error}>
          <p>Check the correction before saving.</p>
          <ul>
            {Object.entries(errors).map(([key, message]) => (
              <li key={key}>
                <a href={`#${id}-${key === 'values' ? 'category' : key}`}>{message}</a>
              </li>
            ))}
          </ul>
        </div>
      )}
      <fieldset disabled={disabled}>
        <legend>Correct structured values</legend>
        <p className={styles.muted}>
          Source quotations stay unchanged. A correction returns this fact to Unreviewed.
        </p>
        <div className={styles.fields}>
          <FormField id={`${id}-category`} label="Category" required>
            <select
              required
              id={`${id}-category`}
              value={values.category}
              onChange={(event) => {
                const category = event.target.value as FactCategory;
                onChange({
                  values: {
                    ...values,
                    category,
                    dateValue: null,
                    dateMeaning: null,
                    datePrecision: category === FactCategory.Date ? 'day' : null,
                    treatmentStatus: category === FactCategory.Treatment ? 'unspecified' : null,
                    findingStatus: category === FactCategory.Finding ? 'unspecified' : null,
                  },
                });
              }}
            >
              {Object.values(FactCategory).map((category) => (
                <option key={category} value={category}>
                  {factCategoryLabels[category]}
                </option>
              ))}
            </select>
          </FormField>
          {textField('value', 'Fact', true)}
          {textField('qualifier', 'Qualifier')}
          {values.category === FactCategory.Date && (
            <>
              <FormField id={`${id}-datePrecision`} label="Date precision" required>
                <select
                  required
                  id={`${id}-datePrecision`}
                  value={values.datePrecision ?? 'day'}
                  onChange={(event) =>
                    update('datePrecision', event.target.value as FactValues['datePrecision'])
                  }
                >
                  <option value="year">Year</option>
                  <option value="month">Month</option>
                  <option value="day">Day</option>
                </select>
              </FormField>
              {textField(
                'dateValue',
                'Date',
                true,
                10,
                'Use YYYY, YYYY-MM, or YYYY-MM-DD. Keep only the precision in the source.',
              )}
              {textField('dateMeaning', 'Date meaning', true, 200)}
            </>
          )}
          {values.category === FactCategory.Treatment && (
            <FormField id={`${id}-treatmentStatus`} label="Treatment status" required>
              <select
                required
                id={`${id}-treatmentStatus`}
                value={values.treatmentStatus ?? 'unspecified'}
                onChange={(event) =>
                  update('treatmentStatus', event.target.value as FactValues['treatmentStatus'])
                }
              >
                <option value="recommended">Recommended</option>
                <option value="performed">Performed</option>
                <option value="unspecified">Unspecified</option>
              </select>
            </FormField>
          )}
          {values.category === FactCategory.Finding && (
            <FormField id={`${id}-findingStatus`} label="Finding status" required>
              <select
                required
                id={`${id}-findingStatus`}
                value={values.findingStatus ?? 'unspecified'}
                onChange={(event) =>
                  update('findingStatus', event.target.value as FactValues['findingStatus'])
                }
              >
                <option value="suspected">Suspected</option>
                <option value="confirmed">Confirmed</option>
                <option value="unspecified">Unspecified</option>
              </select>
            </FormField>
          )}
        </div>
        <label className={styles.checkbox}>
          <input
            type="checkbox"
            checked={values.negated}
            onChange={(event) => update('negated', event.target.checked)}
          />{' '}
          Explicitly negated in the source
        </label>
        <FormField id={`${id}-reason`} label="Reason for correction" required error={errors.reason}>
          <textarea
            id={`${id}-reason`}
            value={draft.reason}
            maxLength={FactReviewLimits.ReasonLength}
            required
            rows={3}
            aria-invalid={!!errors.reason}
            aria-describedby={errors.reason ? `${id}-reason-error` : undefined}
            onChange={(event) => onChange({ reason: event.target.value })}
          />
        </FormField>
      </fieldset>
      <div className={styles.actions}>
        <Button type="submit" disabled={disabled}>
          Save correction
        </Button>
        <Button type="button" variant="secondary" disabled={busy} onClick={onCancel}>
          Cancel correction
        </Button>
      </div>
    </form>
  );
}
