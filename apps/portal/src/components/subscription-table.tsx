import Link from 'next/link';
import type { ReactNode } from 'react';

import { Table, TBody, TD, TH, THead, TR } from '@munaxa/ui';

import { formatDate, productName } from '@/lib/format';
import type { SubscriptionSummary } from '@/lib/types';

import { StatusBadge } from './status-badge';

/** Subscriptions as a table, wherever a list of them is shown. */
export function SubscriptionTable({ rows }: { rows: readonly SubscriptionSummary[] }): ReactNode {
  if (rows.length === 0) return <p className="text-muted-foreground">Nothing to show.</p>;
  return (
    <Table>
      <THead>
        <TR>
          <TH>Customer</TH>
          <TH>Product</TH>
          <TH>Plan</TH>
          <TH>Status</TH>
          <TH>Ends</TH>
        </TR>
      </THead>
      <TBody>
        {rows.map((s) => (
          <TR key={s.id}>
            <TD>
              <Link href={`/subscriptions/${s.id}`} className="underline-offset-4 hover:underline">
                {s.tenant?.customer.name ?? s.id}
              </Link>
            </TD>
            <TD>{productName(s.tenant?.product ?? '')}</TD>
            <TD>
              {s.planVersion.plan.name} v{s.planVersion.version}
            </TD>
            <TD>
              <StatusBadge status={s.status} />
            </TD>
            <TD>{formatDate(s.expiresAt ?? s.trialEndsAt)}</TD>
          </TR>
        ))}
      </TBody>
    </Table>
  );
}
