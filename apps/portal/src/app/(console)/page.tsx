import type { ReactNode } from 'react';

import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Grid,
  Page,
  PageHeader,
  StatCard,
  Table,
  TBody,
  TD,
  TR,
} from '@munaxa/ui';

import { StatusBadge } from '@/components/status-badge';
import { SubscriptionTable } from '@/components/subscription-table';
import { apiGet } from '@/lib/api';
import { productName } from '@/lib/format';
import type { Dashboard, SubscriptionSummary } from '@/lib/types';

export const metadata = { title: 'Dashboard' };

export default async function DashboardPage(): Promise<ReactNode> {
  const [summary, expiring] = await Promise.all([
    apiGet<Dashboard>('/admin/dashboard', '/'),
    apiGet<SubscriptionSummary[]>('/admin/reports/expiring?days=30', '/'),
  ]);
  const live = ['TRIAL', 'ACTIVE', 'PAST_DUE', 'GRACE_PERIOD'].reduce(
    (n, s) => n + (summary.subscriptionsByStatus[s] ?? 0),
    0,
  );

  return (
    <Page>
      <PageHeader
        title="Dashboard"
        description="Customers, subscriptions and licences across Munaxa School, Work and Docs."
      />
      <Grid cols={{ base: 1, md: 2, xl: 4 }}>
        <StatCard label="Active customers" value={summary.activeCustomers} />
        <StatCard label="Live subscriptions" value={live} />
        <StatCard
          label="Ending within 30 days"
          value={summary.expiringWithin30Days}
          tone={summary.expiringWithin30Days > 0 ? 'warning' : 'default'}
        />
        <StatCard
          label="Licences ending within 30 days"
          value={summary.licencesExpiringWithin30Days}
          tone={summary.licencesExpiringWithin30Days > 0 ? 'warning' : 'default'}
        />
      </Grid>
      <Grid cols={{ base: 1, md: 2 }}>
        <Card>
          <CardHeader>
            <CardTitle>Subscriptions by status</CardTitle>
          </CardHeader>
          <CardContent>
            <Table>
              <TBody>
                {Object.entries(summary.subscriptionsByStatus).map(([status, count]) => (
                  <TR key={status}>
                    <TD>
                      <StatusBadge status={status} />
                    </TD>
                    <TD className="text-end">{count}</TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Tenants by product</CardTitle>
          </CardHeader>
          <CardContent>
            <Table>
              <TBody>
                {Object.entries(summary.tenantsByProduct).map(([product, count]) => (
                  <TR key={product}>
                    <TD>{productName(product)}</TD>
                    <TD className="text-end">{count}</TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          </CardContent>
        </Card>
      </Grid>
      <Card>
        <CardHeader>
          <CardTitle>Ending within 30 days</CardTitle>
        </CardHeader>
        <CardContent>
          <SubscriptionTable rows={expiring} />
        </CardContent>
      </Card>
    </Page>
  );
}
