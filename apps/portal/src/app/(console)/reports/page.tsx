import type { ReactNode } from 'react';

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Page,
  PageHeader,
} from '@munaxa/ui';

import { SubscriptionTable } from '@/components/subscription-table';
import { apiGet } from '@/lib/api';
import type { SubscriptionSummary } from '@/lib/types';

export const metadata = { title: 'Reports' };

export default async function ReportsPage(): Promise<ReactNode> {
  const [expiring, overdue] = await Promise.all([
    apiGet<SubscriptionSummary[]>('/admin/reports/expiring?days=60', '/reports'),
    apiGet<SubscriptionSummary[]>('/admin/reports/overdue', '/reports'),
  ]);
  return (
    <Page>
      <PageHeader
        title="Reports"
        description="Renewals to chase, and subscriptions already behind."
      />
      <Card>
        <CardHeader>
          <CardTitle>Overdue</CardTitle>
          <CardDescription>
            Past due, in grace, or past their term end and not renewed or cancelled.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <SubscriptionTable rows={overdue} />
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Ending within 60 days</CardTitle>
        </CardHeader>
        <CardContent>
          <SubscriptionTable rows={expiring} />
        </CardContent>
      </Card>
    </Page>
  );
}
