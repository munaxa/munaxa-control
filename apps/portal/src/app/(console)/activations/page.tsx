import type { ReactNode } from 'react';

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Field,
  Page,
  PageHeader,
  Textarea,
} from '@munaxa/ui';

import { ActionForm } from '@/components/action-form';

import { activate } from '../../actions';

export const metadata = { title: 'Activations' };

export default function ActivationsPage(): ReactNode {
  return (
    <Page width="content">
      <PageHeader
        title="Activations"
        description="Turn an on-premises installation's activation request into a licence bound to it."
      />
      <Card>
        <CardHeader>
          <CardTitle>Activation request</CardTitle>
          <CardDescription>
            Paste the code the customer&apos;s administrator sent. It names the installation, the
            licence it holds and why: first activation, renewal, or a replaced server. A replaced
            server retires the old installation, so the old licence stops working there.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ActionForm action={activate} submitLabel="Issue licence">
            <Field label="Code" htmlFor="code" required>
              <Textarea id="code" name="code" rows={5} required className="font-mono" />
            </Field>
          </ActionForm>
        </CardContent>
      </Card>
    </Page>
  );
}
