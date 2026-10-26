import { redirect } from 'next/navigation';
import type { ReactNode } from 'react';

import { ConsoleShell, type Destination } from '@/components/console-shell';
import { accessToken, operatorFrom, signInPath } from '@/lib/session';

/** What an operator sees in the rail, from the permissions their token carries. */
const DESTINATIONS: readonly (Destination & { readonly requires: string })[] = [
  { href: '/', label: 'Dashboard', icon: 'home', requires: 'control:subscriptions:read' },
  { href: '/customers', label: 'Customers', icon: 'customers', requires: 'control:customers:read' },
  {
    href: '/subscriptions',
    label: 'Subscriptions',
    icon: 'subscriptions',
    requires: 'control:subscriptions:read',
  },
  { href: '/plans', label: 'Plans', icon: 'plans', requires: 'control:catalogue:read' },
  {
    href: '/deployments',
    label: 'Deployments',
    icon: 'deployments',
    requires: 'control:catalogue:read',
  },
  {
    href: '/activations',
    label: 'Activations',
    icon: 'activations',
    requires: 'control:licences:issue',
  },
  { href: '/reports', label: 'Reports', icon: 'reports', requires: 'control:subscriptions:read' },
  { href: '/audit', label: 'Audit', icon: 'audit', requires: 'control:audit:read' },
];

export default async function ConsoleLayout({
  children,
}: {
  children: ReactNode;
}): Promise<ReactNode> {
  // The middleware has already sent anyone without a session to sign in; this is the backstop.
  const token = await accessToken();
  if (token === undefined) redirect(signInPath('/'));
  const operator = operatorFrom(token);
  if (operator === null) redirect(signInPath('/'));
  const destinations = DESTINATIONS.filter((d) => operator.permissions.has(d.requires)).map(
    ({ requires: _r, ...d }) => d,
  );

  return (
    <ConsoleShell destinations={destinations} operator={operator.subject}>
      {children}
    </ConsoleShell>
  );
}
