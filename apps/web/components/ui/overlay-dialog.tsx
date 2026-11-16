'use client';

import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { CloseIcon } from './icon';
import styles from './overlay-dialog.module.css';

const focusableSelector =
  'button:not(:disabled), input:not(:disabled):not([tabindex="-1"]), select:not(:disabled), textarea:not(:disabled), a[href], summary, [tabindex="0"]';

interface OverlayDialogProps {
  open: boolean;
  title: string;
  description?: ReactNode;
  /** Controls shown in the header, before the close button. */
  actions?: ReactNode;
  /** Sticky footer, typically the primary action. */
  footer?: ReactNode;
  closeLabel?: string;
  onClose: () => void;
  /** Called after the exit animation, once the dialog has left the screen. */
  onExited?: () => void;
  children: ReactNode;
}

/**
 * Shared behavior for overlay dialogs: backdrop, Escape and backdrop-click to close, focus trap,
 * focus return, page scroll lock and enter/exit animations. Rendered as an aria-modal dialog in a
 * portal rather than the native top layer, so app toasts stay visible above it; nested
 * ConfirmDialogs (native modals) still stack on top.
 */
function OverlayDialog({
  placement,
  open,
  title,
  description,
  actions,
  footer,
  closeLabel = 'Close',
  onClose,
  onExited,
  children,
}: OverlayDialogProps & { placement: 'right' | 'center' }) {
  const id = useId();
  const panel = useRef<HTMLDivElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  // Stay mounted while the exit animation plays.
  const [present, setPresent] = useState(open);
  if (open && !present) {
    setPresent(true);
  }

  useEffect(() => {
    if (!open) {
      return;
    }
    opener.current = document.activeElement as HTMLElement | null;
    closeButton.current?.focus();
    // Keep the page behind the backdrop from scrolling (matters where the document scrolls).
    const { overflow } = document.body.style;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = overflow;
    };
  }, [open]);

  if (!present) {
    return null;
  }

  // Events from a nested dialog (e.g. a confirmation) belong to that dialog, not this one.
  const ownsEvent = (target: EventTarget) =>
    (target as Element).closest('[role="dialog"], dialog') === panel.current;

  return createPortal(
    <div className={styles.root} data-placement={placement} data-state={open ? 'open' : 'closing'}>
      <div className={styles.backdrop} aria-hidden="true" onClick={onClose} />
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${id}-title`}
        className={styles.panel}
        onAnimationEnd={(event) => {
          if (!open && event.target === event.currentTarget) {
            setPresent(false);
            onExited?.();
            opener.current?.focus();
          }
        }}
        onKeyDown={(event) => {
          if (!ownsEvent(event.target)) {
            return;
          }
          if (event.key === 'Escape') {
            event.preventDefault();
            onClose();
            return;
          }
          if (event.key !== 'Tab') {
            return;
          }
          const focusable = event.currentTarget.querySelectorAll<HTMLElement>(focusableSelector);
          const first = focusable[0];
          const last = focusable[focusable.length - 1];
          if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last?.focus();
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first?.focus();
          }
        }}
      >
        <header className={styles.header}>
          <div className={styles.heading}>
            <h2 id={`${id}-title`}>{title}</h2>
            {description && <p>{description}</p>}
          </div>
          <div className={styles.headerActions}>
            {actions}
            <button
              ref={closeButton}
              type="button"
              className={styles.close}
              aria-label={closeLabel}
              onClick={onClose}
            >
              <CloseIcon />
            </button>
          </div>
        </header>
        <div className={styles.body}>{children}</div>
        {footer && <footer className={styles.footer}>{footer}</footer>}
      </div>
    </div>,
    document.body,
  );
}

/** Right-hand slide-over for inspecting a record alongside its list. */
export function Drawer(props: OverlayDialogProps) {
  return <OverlayDialog placement="right" closeLabel="Close details" {...props} />;
}

/** Centered dialog for focused tasks such as uploading. */
export function Modal(props: OverlayDialogProps) {
  return <OverlayDialog placement="center" {...props} />;
}
