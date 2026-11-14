import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import '@fontsource-variable/inter';
import './globals.css';

export const metadata: Metadata = {
  title: 'CaseFlow AI',
  description: 'CaseFlow AI — an independent case-management portfolio demo',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
