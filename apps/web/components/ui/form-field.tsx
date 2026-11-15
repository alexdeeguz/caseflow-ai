import type { ReactNode } from 'react';

export function FormField({
  id,
  label,
  error,
  hint,
  required = false,
  children,
}: {
  id: string;
  label: string;
  error?: string;
  hint?: string;
  required?: boolean;
  children: ReactNode;
}) {
  return (
    <div className="grid gap-2">
      <label className="font-semibold text-sm" htmlFor={id}>
        {label}
        {required && (
          <span className="text-[var(--brand-danger)]" aria-hidden="true">
            {' *'}
          </span>
        )}
      </label>
      {children}
      {hint && (
        <p id={`${id}-hint`} className="text-sm text-muted">
          {hint}
        </p>
      )}
      {error && (
        <p id={`${id}-error`} className="text-sm text-[var(--brand-danger)]">
          {error}
        </p>
      )}
    </div>
  );
}
