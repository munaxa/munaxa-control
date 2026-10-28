'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';

import {
  AppShell,
  AppShellProvider,
  type NavigationGroup,
  type RenderNavigationLink,
  Sidebar,
  SidebarCollapseToggle,
  SidebarNav,
  SidebarTrigger,
  TopBar,
  UserMenu,
} from '@munaxa/ui';
import {
  Building2,
  ChartColumn,
  FileKey,
  House,
  KeyRound,
  Layers,
  ScrollText,
  Server,
} from '@munaxa/icons';

export interface Destination {
  readonly href: string;
  readonly label: string;
  readonly icon:
    | 'home'
    | 'customers'
    | 'plans'
    | 'subscriptions'
    | 'deployments'
    | 'activations'
    | 'reports'
    | 'audit';
}

const ICONS = {
  home: <House aria-hidden />,
  customers: <Building2 aria-hidden />,
  plans: <Layers aria-hidden />,
  subscriptions: <FileKey aria-hidden />,
  deployments: <Server aria-hidden />,
  activations: <KeyRound aria-hidden />,
  reports: <ChartColumn aria-hidden />,
  audit: <ScrollText aria-hidden />,
} as const;

const renderLink: RenderNavigationLink = ({ href, className, children, ...rest }) => (
  <Link href={href} className={className} {...rest}>
    {children}
  </Link>
);

/**
 * The console frame: the platform's `AppShell`, `Sidebar` and `TopBar`, nothing drawn here.
 * The destinations are decided on the server from the operator's permissions; the API still
 * refuses anything the operator does not hold.
 */
export function ConsoleShell({
  destinations,
  operator,
  children,
}: {
  destinations: readonly Destination[];
  operator: string;
  children: ReactNode;
}): ReactNode {
  const pathname = usePathname();
  const groups: NavigationGroup[] = [
    {
      id: 'control',
      items: destinations.map((d) => ({
        id: d.href,
        href: d.href,
        label: d.label,
        icon: ICONS[d.icon],
        active: d.href === '/' ? pathname === '/' : pathname.startsWith(d.href),
      })),
    },
  ];

  return (
    <AppShellProvider>
      <AppShell
        sidebar={
          <Sidebar
            variant="flush"
            brand={(collapsed) => (
              <span className="font-display text-lg font-semibold">
                {collapsed ? 'm.' : 'munaxa. control'}
              </span>
            )}
          >
            <SidebarNav
              groups={groups}
              label="Control plane"
              renderLink={renderLink}
              variant="indicator"
            />
          </Sidebar>
        }
        topBar={
          <TopBar
            actions={
              <form action="/api/auth/logout" method="post">
                <UserMenu
                  name={operator}
                  description="Munaxa Group"
                  actions={[
                    {
                      id: 'sign-out',
                      label: 'Sign out',
                      destructive: true,
                      onSelect: () => {
                        (
                          document.getElementById('sign-out-form') as HTMLFormElement | null
                        )?.requestSubmit();
                      },
                    },
                  ]}
                />
              </form>
            }
          >
            <SidebarTrigger />
            <SidebarCollapseToggle />
          </TopBar>
        }
      >
        {children}
        {/* Identity ends the session; the portal holds nothing to clear. */}
        <form id="sign-out-form" action="/api/auth/logout" method="post" hidden />
      </AppShell>
    </AppShellProvider>
  );
}
