import Link from 'next/link';
import type { ReactNode } from 'react';

import {
  Badge,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Field,
  Input,
  Page,
  PageHeader,
  Select,
  Table,
  TBody,
  TD,
  TH,
  THead,
  TR,
} from '@munaxa/ui';

import { ActionForm } from '@/components/action-form';
import { apiGet } from '@/lib/api';
import { productName } from '@/lib/format';
import type { Plan } from '@/lib/types';

import { createPlan } from '../../actions';

export const metadata = { title: 'Plans' };

export default async function PlansPage(): Promise<ReactNode> {
  const plans = await apiGet<Plan[]>('/admin/plans', '/plans');
  return (
    <Page>
      <PageHeader
        title="Plans"
        description="Each product's packages. Terms live in versions; a published version never changes."
      />
      <Card>
        <CardContent>
          <Table>
            <THead>
              <TR>
                <TH>Plan</TH>
                <TH>Product</TH>
                <TH>Code</TH>
                <TH>Versions</TH>
              </TR>
            </THead>
            <TBody>
              {plans.map((p) => (
                <TR key={p.id}>
                  <TD>
                    <Link
                      href={`/plans/${p.id}`}
                      className="font-medium underline-offset-4 hover:underline"
                    >
                      {p.name}
                    </Link>
                  </TD>
                  <TD>{productName(p.product)}</TD>
                  <TD className="font-mono">{p.code}</TD>
                  <TD className="flex gap-1">
                    {p.versions.map((v) => (
                      <Badge key={v.id} tone={v.state === 'PUBLISHED' ? 'success' : 'muted'}>
                        v{v.version} {v.state.toLowerCase()}
                      </Badge>
                    ))}
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>New plan</CardTitle>
        </CardHeader>
        <CardContent>
          <ActionForm action={createPlan} submitLabel="Create plan">
            <Field label="Product" htmlFor="product" required>
              <Select id="product" name="product" required>
                <option value="school">Munaxa School</option>
                <option value="work">Munaxa Work</option>
                <option value="docs">Munaxa Docs</option>
              </Select>
            </Field>
            <Field label="Code" htmlFor="code" hint="Lowercase, e.g. business" required>
              <Input id="code" name="code" required pattern="[a-z][a-z0-9._\-]*" maxLength={64} />
            </Field>
            <Field label="Name" htmlFor="name" required>
              <Input id="name" name="name" required maxLength={200} />
            </Field>
            <Field label="Description" htmlFor="description">
              <Input id="description" name="description" maxLength={2000} />
            </Field>
          </ActionForm>
        </CardContent>
      </Card>
    </Page>
  );
}
