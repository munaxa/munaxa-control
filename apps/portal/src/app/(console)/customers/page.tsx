import Link from 'next/link';
import type { ReactNode } from 'react';

import {
  Badge,
  Button,
  Card,
  CardContent,
  EmptyState,
  Input,
  Page,
  PageHeader,
  Table,
  TBody,
  TD,
  TH,
  THead,
  TR,
  buttonVariants,
} from '@munaxa/ui';

import { apiGet } from '@/lib/api';
import type { Customer } from '@/lib/types';

export const metadata = { title: 'Customers' };

export default async function CustomersPage({
  searchParams,
}: {
  searchParams: Promise<{ search?: string; offset?: string }>;
}): Promise<ReactNode> {
  const { search = '', offset = '0' } = await searchParams;
  const query = new URLSearchParams({ limit: '50', offset, ...(search !== '' && { search }) });
  const page = await apiGet<{ items: Customer[]; total: number; offset: number }>(
    `/admin/customers?${query.toString()}`,
    '/customers',
  );
  const next = page.offset + page.items.length;

  return (
    <Page>
      <PageHeader
        title="Customers"
        description="Every Munaxa Group customer, across all products. Search by name, legal name, email or a product tenant id."
        actions={
          <Link href="/customers/new" className={buttonVariants()}>
            New customer
          </Link>
        }
      />
      <form className="flex gap-2" role="search">
        <Input
          name="search"
          defaultValue={search}
          placeholder="Search customers"
          aria-label="Search customers"
        />
        <Button type="submit" variant="outline">
          Search
        </Button>
      </form>
      <Card>
        <CardContent>
          {page.items.length === 0 ? (
            <EmptyState
              title="No customers found"
              description={search === '' ? 'Create the first customer.' : 'Try another search.'}
            />
          ) : (
            <Table>
              <THead>
                <TR>
                  <TH>Name</TH>
                  <TH>Country</TH>
                  <TH>Contact</TH>
                  <TH>Tenants</TH>
                  <TH>Status</TH>
                </TR>
              </THead>
              <TBody>
                {page.items.map((c) => (
                  <TR key={c.id}>
                    <TD>
                      <Link
                        href={`/customers/${c.id}`}
                        className="font-medium underline-offset-4 hover:underline"
                      >
                        {c.name}
                      </Link>
                    </TD>
                    <TD>{c.country ?? '—'}</TD>
                    <TD>{c.contactEmail ?? '—'}</TD>
                    <TD>{c._count?.tenants ?? 0}</TD>
                    <TD>
                      <Badge tone={c.status === 'ACTIVE' ? 'success' : 'muted'}>
                        {c.status === 'ACTIVE' ? 'Active' : 'Closed'}
                      </Badge>
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          )}
        </CardContent>
      </Card>
      <p className="text-sm text-muted-foreground">
        {page.total} customer{page.total === 1 ? '' : 's'}
        {next < page.total && (
          <>
            {' · '}
            <Link
              href={`/customers?${new URLSearchParams({ search, offset: String(next) }).toString()}`}
              className="underline"
            >
              Next page
            </Link>
          </>
        )}
      </p>
    </Page>
  );
}
