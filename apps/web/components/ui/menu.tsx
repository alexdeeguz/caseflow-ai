'use client';

import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from './icon';
import styles from './menu.module.css';

export interface MenuItem {
  id: string;
  label: string;
  icon?: ReactNode;
  destructive?: boolean;
  disabled?: boolean;
  onSelect: () => void;
}

/**
 * "⋯" actions menu. The list is portaled with fixed positioning so scroll containers and clipped
 * lists can't cut it off; it closes on outside press, Escape, Tab, scroll and resize.
 */
export function Menu({ label, items }: { label: string; items: MenuItem[] }) {
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<{ top: number; right: number } | null>(null);

  const close = (refocus = true) => {
    setOpen(false);
    if (refocus) {
      trigger.current?.focus();
    }
  };

  useLayoutEffect(() => {
    if (!open || !trigger.current) {
      return;
    }
    const rect = trigger.current.getBoundingClientRect();
    const height = list.current?.offsetHeight ?? 0;
    const below = rect.bottom + 4;
    setPosition({
      top: below + height > window.innerHeight - 8 ? rect.top - height - 4 : below,
      right: window.innerWidth - rect.right,
    });
  }, [open]);

  useEffect(() => {
    if (!open) {
      return;
    }
    list.current?.querySelector<HTMLElement>('[role="menuitem"]:not(:disabled)')?.focus();
    const onPointer = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!list.current?.contains(target) && !trigger.current?.contains(target)) {
        setOpen(false);
      }
    };
    const dismiss = () => setOpen(false);
    document.addEventListener('pointerdown', onPointer);
    window.addEventListener('scroll', dismiss, true);
    window.addEventListener('resize', dismiss);
    return () => {
      document.removeEventListener('pointerdown', onPointer);
      window.removeEventListener('scroll', dismiss, true);
      window.removeEventListener('resize', dismiss);
    };
  }, [open]);

  const enabled = items.filter((item) => !item.disabled);

  return (
    <>
      <button
        ref={trigger}
        type="button"
        className={styles.trigger}
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? `${id}-menu` : undefined}
        disabled={!enabled.length}
        onClick={() => setOpen((value) => !value)}
      >
        <Icon size={18}>
          <circle cx="5" cy="12" r="1" />
          <circle cx="12" cy="12" r="1" />
          <circle cx="19" cy="12" r="1" />
        </Icon>
      </button>
      {open &&
        createPortal(
          <div
            ref={list}
            id={`${id}-menu`}
            role="menu"
            aria-label={label}
            className={styles.menu}
            style={position ?? { visibility: 'hidden' }}
            onKeyDown={(event) => {
              const buttons = Array.from(
                event.currentTarget.querySelectorAll<HTMLElement>(
                  '[role="menuitem"]:not(:disabled)',
                ),
              );
              const index = buttons.indexOf(document.activeElement as HTMLElement);
              const move = (next: number) =>
                buttons[(next + buttons.length) % buttons.length]?.focus();
              if (event.key === 'ArrowDown') {
                event.preventDefault();
                move(index + 1);
              } else if (event.key === 'ArrowUp') {
                event.preventDefault();
                move(index - 1);
              } else if (event.key === 'Home') {
                event.preventDefault();
                move(0);
              } else if (event.key === 'End') {
                event.preventDefault();
                move(buttons.length - 1);
              } else if (event.key === 'Escape') {
                event.preventDefault();
                close();
              } else if (event.key === 'Tab') {
                close(false);
              }
            }}
          >
            {items.map((item) => (
              <button
                key={item.id}
                type="button"
                role="menuitem"
                tabIndex={-1}
                className={`${styles.item} ${item.destructive ? styles.destructive : ''}`}
                disabled={item.disabled}
                onClick={() => {
                  close();
                  item.onSelect();
                }}
              >
                {item.icon}
                {item.label}
              </button>
            ))}
          </div>,
          document.body,
        )}
    </>
  );
}
