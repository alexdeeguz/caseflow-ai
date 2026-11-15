'use client';

import { useEffect, useId, useRef, type ReactNode } from 'react';
import { Button } from './button';
import styles from './feedback.module.css';

export function ConfirmDialog({
  open,
  title,
  children,
  confirmLabel,
  cancelLabel = 'Keep working',
  busy = false,
  confirmDisabled = false,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  children: ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  busy?: boolean;
  confirmDisabled?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const id = useId();

  useEffect(() => {
    const element = dialog.current;
    if (open && !element?.open) {
      element?.showModal();
      cancel.current?.focus();
    } else if (!open && element?.open) {
      element.close();
    }
    return () => {
      element?.close();
    };
  }, [open]);

  return (
    <dialog
      ref={dialog}
      className={styles.dialog}
      aria-labelledby={`${id}-title`}
      aria-describedby={`${id}-description`}
      aria-busy={busy}
      onKeyDown={(event) => {
        if (event.key !== 'Tab') {
          return;
        }
        const buttons =
          event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)');
        const first = buttons[0];
        const last = buttons[buttons.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first?.focus();
        }
      }}
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) {
          onCancel();
        }
      }}
    >
      <p className={styles.eyebrow}>Confirm action</p>
      <h2 id={`${id}-title`} className={styles.title}>
        {title}
      </h2>
      <div id={`${id}-description`} className={styles.description}>
        {children}
      </div>
      <div className={styles.dialogActions}>
        <Button ref={cancel} variant="secondary" onClick={onCancel} disabled={busy}>
          {cancelLabel}
        </Button>
        <Button onClick={onConfirm} disabled={busy || confirmDisabled}>
          {busy ? 'Working…' : confirmLabel}
        </Button>
      </div>
    </dialog>
  );
}
