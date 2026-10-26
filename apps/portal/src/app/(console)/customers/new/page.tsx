import type { ReactNode } from 'react';

import { Card, CardContent, Field, Input, Page, PageHeader } from '@munaxa/ui';

import { ActionForm } from '@/components/action-form';

import { createCustomer } from '../../../actions';

export const metadata = { title: 'New customer' };

export default function NewCustomerPage(): ReactNode {
  return (
    <Page width="content">
      <PageHeader
        title="New customer"
        description="One contracting organisation. Product tenants and subscriptions are added on its page."
      />
      <Card>
        <CardContent>
          <ActionForm action={createCustomer} submitLabel="Create customer">
            <Field label="Name" htmlFor="name" required>
              <Input id="name" name="name" required maxLength={200} />
            </Field>
            <Field label="Legal name" htmlFor="legalName">
              <Input id="legalName" name="legalName" maxLength={300} />
            </Field>
            <Field label="Country" htmlFor="country" hint="ISO 3166-1 alpha-2, for example JO">
              <Input id="country" name="country" maxLength={2} pattern="[A-Za-z]{2}" />
            </Field>
            <Field label="Contact email" htmlFor="contactEmail">
              <Input id="contactEmail" name="contactEmail" type="email" />
            </Field>
          </ActionForm>
        </CardContent>
      </Card>
    </Page>
  );
}
