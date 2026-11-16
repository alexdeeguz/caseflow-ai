import type { ReactNode } from 'react';

/** Shared stroke-icon frame. Icons are decorative; pair them with visible or sr-only text. */
export function Icon({ children, size = 20 }: { children: ReactNode; size?: number }) {
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {children}
    </svg>
  );
}

export function AlertIcon({ size = 16 }: { size?: number }) {
  return (
    <Icon size={size}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7.5v5.5m0 3.2v.1" />
    </Icon>
  );
}

export function InfoIcon({ size = 16 }: { size?: number }) {
  return (
    <Icon size={size}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v5.5m0-8.7v.1" />
    </Icon>
  );
}

export function CloseIcon() {
  return (
    <Icon>
      <path d="m6 6 12 12M6 18 18 6" />
    </Icon>
  );
}
