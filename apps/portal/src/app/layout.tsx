import type { Metadata } from 'next';
import type { ReactNode } from 'react';

import { corporateBrand } from '@munaxa/ui';

import './globals.css';

export const metadata: Metadata = {
  title: { default: 'Munaxa Control', template: '%s · Munaxa Control' },
  description: 'Munaxa Group subscription and licensing administration.',
  icons: { icon: corporateBrand.assets.favicon.src },
  // An internal console: never indexed, never followed.
  robots: { index: false, follow: false },
};

// Rendered per request, every page: each response carries its own CSP nonce (middleware.ts),
// which a page prerendered at build time could not.
export const dynamic = 'force-dynamic';

export default function RootLayout({ children }: { children: ReactNode }): ReactNode {
  return (
    <html lang="en" dir="ltr">
      <body className="bg-background text-foreground">{children}</body>
    </html>
  );
}
