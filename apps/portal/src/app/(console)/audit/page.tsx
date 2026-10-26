import Link from 'next/link';
import type { ReactNode } from 'react';

import { Card, CardContent, Page, PageHeader, Table, TBody, TD, TH, THead, TR } from '@munaxa/ui';

import { apiGet } from '@/lib/api';
import { formatDateTime } from '@/lib/format';
import type { AuditEvent } from '@/lib/types';

export const metadata = { title: 'Audit' };

export default async function AuditPage({
  searchParams,
}: {
  searchParams: Promise<{ before?: string }>;
}): Promise<ReactNode> {
  const { before } = await searchParams;
  const events = await apiGet<AuditEvent[]>(
    `/admin/audit?limit=100${before !== undefined ? `&before=${encodeURIComponent(before)}` : ''}`,
    '/audit',
  );
  const last = events.at(-1);
  return (
    <Page>
      <PageHeader
        title="Audit"
        description="Every privileged action in the control plane, newest first. Append-only: nothing here can be edited or removed."
      />
      <Card>
        <CardContent>
          <Table>
            <THead>
              <TR>
                <TH>When</TH>
                <TH>Who</TH>
                <TH>Action</TH>
                <TH>Product</TH>
                <TH>Detail</TH>
              </TR>
            </THead>
            <TBody>
              {events.map((e) => (
                <TR key={e.id}>
                  <TD className="whitespace-nowrap">{formatDateTime(e.at)}</TD>
                  <TD className="font-mono">{e.actor}</TD>
                  <TD className="font-mono">{e.action}</TD>
                  <TD>{e.product ?? '—'}</TD>
                  <TD className="font-mono text-xs">{JSON.stringify(e.payload)}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
        </CardContent>
      </Card>
      {events.length === 100 && last !== undefined && (
        <Link href={`/audit?before=${last.id}`} className="underline">
          Older
        </Link>
      )}
    </Page>
  );
}
