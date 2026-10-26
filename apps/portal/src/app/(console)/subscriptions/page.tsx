import type { ReactNode } from 'react';

import { Button, Card, CardContent, Page, PageHeader, Select } from '@munaxa/ui';

import { SubscriptionTable } from '@/components/subscription-table';
import { apiGet } from '@/lib/api';
import type { SubscriptionSummary } from '@/lib/types';

export const metadata = { title: 'Subscriptions' };

const STATUSES = [
  'TRIAL',
  'ACTIVE',
  'PAST_DUE',
  'GRACE_PERIOD',
  'EXPIRED',
  'SUSPENDED',
  'CANCELLED',
];

export default async function SubscriptionsPage({
  searchParams,
}: {
  searchParams: Promise<{ product?: string; status?: string }>;
}): Promise<ReactNode> {
  const { product = '', status = '' } = await searchParams;
  const query = new URLSearchParams({
    limit: '200',
    ...(product !== '' && { product }),
    ...(status !== '' && { status }),
  });
  const rows = await apiGet<SubscriptionSummary[]>(
    `/admin/subscriptions?${query.toString()}`,
    '/subscriptions',
  );

  return (
    <Page>
      <PageHeader
        title="Subscriptions"
        description="Every subscription, by product and status. Start one from the customer's page."
      />
      <form className="flex flex-wrap gap-2">
        <Select name="product" defaultValue={product} aria-label="Product">
          <option value="">All products</option>
          <option value="school">Munaxa School</option>
          <option value="work">Munaxa Work</option>
          <option value="docs">Munaxa Docs</option>
        </Select>
        <Select name="status" defaultValue={status} aria-label="Status">
          <option value="">All statuses</option>
          {STATUSES.map((s) => (
            <option key={s} value={s}>
              {s.replace('_', ' ').toLowerCase()}
            </option>
          ))}
        </Select>
        <Button type="submit" variant="outline">
          Filter
        </Button>
      </form>
      <Card>
        <CardContent>
          <SubscriptionTable rows={rows} />
        </CardContent>
      </Card>
    </Page>
  );
}
