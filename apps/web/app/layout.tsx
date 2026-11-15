import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import '@fontsource-variable/inter';
import './globals.css';
import { sessionPresentationScript } from '../lib/session-presentation';

export const metadata: Metadata = {
  title: 'CaseFlow AI',
  description: 'CaseFlow AI — an independent case-management portfolio demo',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" data-workspace-shell="false" suppressHydrationWarning>
      <head>
        <script
          id="session-presentation"
          dangerouslySetInnerHTML={{ __html: sessionPresentationScript }}
        />
      </head>
      <body>{children}</body>
    </html>
  );
}
