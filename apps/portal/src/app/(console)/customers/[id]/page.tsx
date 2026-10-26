import Link from 'next/link';
import type { ReactNode } from 'react';

import {
  Badge,
  Card,
  CardContent,
  CardDescription,
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
import { StatusBadge } from '@/components/status-badge';
import { apiGet } from '@/lib/api';
import { formatDate, formatDateTime, productName } from '@/lib/format';
import type { CustomerDetail, Deployment, Plan } from '@/lib/types';

import {
  createSubscription,
  linkTenant,
  registerInstallation,
  setCustomerStatus,
} from '../../../actions';

export const metadata = { title: 'Customer' };

export default async function CustomerPage({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<ReactNode> {
  const { id } = await params;
  const [customer, deployments, plans] = await Promise.all([
    apiGet<CustomerDetail>(`/admin/customers/${id}`, `/customers/${id}`),
    apiGet<Deployment[]>('/admin/deployments'),
    apiGet<Plan[]>('/admin/plans'),
  ]);
  const sellable = plans.flatMap((p) =>
    p.versions
      .filter((v) => v.state === 'PUBLISHED')
      .map((v) => ({ product: p.product, id: v.id, label: `${p.name} v${v.version}` })),
  );

  return (
    <Page>
      <PageHeader
        title={customer.name}
        description={
          [customer.legalName, customer.country, customer.contactEmail]
            .filter(Boolean)
            .join(' · ') || 'No details recorded.'
        }
        actions={
          <Badge tone={customer.status === 'ACTIVE' ? 'success' : 'muted'}>
            {customer.status === 'ACTIVE' ? 'Active' : 'Closed'}
          </Badge>
        }
      />

      {customer.tenants.map((tenant) => {
        const live = tenant.subscriptions.find((s) => s.status !== 'CANCELLED');
        const options = sellable.filter((o) => o.product === tenant.product);
        return (
          <Card key={tenant.id}>
            <CardHeader>
              <CardTitle>
                {productName(tenant.product)} — {tenant.displayName}
              </CardTitle>
              <CardDescription>
                Tenant <code className="font-mono">{tenant.tenantRef}</code> ·{' '}
                {tenant.deploymentType === 'SAAS'
                  ? `SaaS on ${tenant.deployment?.name ?? 'a deployment'}`
                  : 'On premises (licence file)'}
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              {tenant.subscriptions.length > 0 && (
                <Table>
                  <THead>
                    <TR>
                      <TH>Subscription</TH>
                      <TH>Plan</TH>
                      <TH>Status</TH>
                      <TH>Ends</TH>
                    </TR>
                  </THead>
                  <TBody>
                    {tenant.subscriptions.map((s) => (
                      <TR key={s.id}>
                        <TD>
                          <Link
                            href={`/subscriptions/${s.id}`}
                            className="font-mono underline-offset-4 hover:underline"
                          >
                            {s.id.slice(0, 8)}
                          </Link>
                        </TD>
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
              )}
              {live === undefined && customer.status === 'ACTIVE' && (
                <ActionForm action={createSubscription} submitLabel="Start subscription">
                  <input type="hidden" name="tenantLinkId" value={tenant.id} />
                  <Field label="Plan version" htmlFor={`plan-${tenant.id}`} required>
                    <Select id={`plan-${tenant.id}`} name="planVersionId" required>
                      {options.map((o) => (
                        <option key={o.id} value={o.id}>
                          {o.label}
                        </option>
                      ))}
                    </Select>
                  </Field>
                  <Field label="Start as" htmlFor={`start-${tenant.id}`}>
                    <Select id={`start-${tenant.id}`} name="start" defaultValue="ACTIVE">
                      <option value="ACTIVE">Paid term</option>
                      <option value="TRIAL">Trial</option>
                    </Select>
                  </Field>
                  <Field
                    label="Term ends"
                    htmlFor={`ends-${tenant.id}`}
                    hint="Leave empty for one billing period."
                  >
                    <Input id={`ends-${tenant.id}`} name="expiresAt" type="date" />
                  </Field>
                </ActionForm>
              )}
              {tenant.deploymentType === 'ON_PREMISES' && (
                <>
                  <Table>
                    <THead>
                      <TR>
                        <TH>Installation</TH>
                        <TH>Status</TH>
                        <TH>Registered</TH>
                      </TR>
                    </THead>
                    <TBody>
                      {tenant.installations.map((i) => (
                        <TR key={i.id}>
                          <TD className="font-mono">{i.installationRef}</TD>
                          <TD>
                            <Badge tone={i.status === 'ACTIVE' ? 'success' : 'muted'}>
                              {i.status === 'ACTIVE' ? 'Active' : 'Replaced'}
                            </Badge>
                          </TD>
                          <TD>{formatDateTime(i.registeredAt)}</TD>
                        </TR>
                      ))}
                    </TBody>
                  </Table>
                  <ActionForm
                    action={registerInstallation}
                    submitLabel="Register installation"
                    tone="outline"
                  >
                    <input type="hidden" name="tenantLinkId" value={tenant.id} />
                    <input type="hidden" name="customerId" value={customer.id} />
                    <Field
                      label="Installation identifier"
                      htmlFor={`inst-${tenant.id}`}
                      hint="The LICENSE_INSTALLATION_ID configured on the customer's server."
                      required
                    >
                      <Input
                        id={`inst-${tenant.id}`}
                        name="installationRef"
                        required
                        maxLength={128}
                      />
                    </Field>
                  </ActionForm>
                </>
              )}
            </CardContent>
          </Card>
        );
      })}

      {customer.status === 'ACTIVE' && (
        <Card>
          <CardHeader>
            <CardTitle>Link a product tenant</CardTitle>
            <CardDescription>
              The tenant identifier is the product&apos;s own; copy it from the product, never
              invent one.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ActionForm action={linkTenant} submitLabel="Link tenant">
              <input type="hidden" name="customerId" value={customer.id} />
              <Field label="Product" htmlFor="product" required>
                <Select id="product" name="product" required>
                  <option value="school">Munaxa School</option>
                  <option value="work">Munaxa Work</option>
                  <option value="docs">Munaxa Docs</option>
                </Select>
              </Field>
              <Field label="Tenant identifier" htmlFor="tenantRef" required>
                <Input
                  id="tenantRef"
                  name="tenantRef"
                  required
                  maxLength={128}
                  className="font-mono"
                />
              </Field>
              <Field label="Display name" htmlFor="displayName" required>
                <Input id="displayName" name="displayName" required maxLength={200} />
              </Field>
              <Field label="Delivery" htmlFor="deploymentType" required>
                <Select id="deploymentType" name="deploymentType" defaultValue="SAAS">
                  <option value="SAAS">SaaS (served by a deployment)</option>
                  <option value="ON_PREMISES">On premises (licence file)</option>
                </Select>
              </Field>
              <Field
                label="Deployment"
                htmlFor="deploymentId"
                hint="SaaS only. Must be the same product."
              >
                <Select id="deploymentId" name="deploymentId">
                  <option value="">—</option>
                  {deployments.map((d) => (
                    <option key={d.id} value={d.id}>
                      {productName(d.product)} — {d.name}
                    </option>
                  ))}
                </Select>
              </Field>
            </ActionForm>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>
            {customer.status === 'ACTIVE' ? 'Close customer' : 'Reopen customer'}
          </CardTitle>
          <CardDescription>
            Closing stops new tenants and subscriptions. It changes nothing already sold and deletes
            nothing.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ActionForm
            action={setCustomerStatus}
            submitLabel={customer.status === 'ACTIVE' ? 'Close customer' : 'Reopen customer'}
            tone={customer.status === 'ACTIVE' ? 'destructive' : 'outline'}
            {...(customer.status === 'ACTIVE' && { confirm: `Close ${customer.name}?` })}
          >
            <input type="hidden" name="customerId" value={customer.id} />
            <input type="hidden" name="version" value={customer.version} />
            <input
              type="hidden"
              name="status"
              value={customer.status === 'ACTIVE' ? 'CLOSED' : 'ACTIVE'}
            />
          </ActionForm>
        </CardContent>
      </Card>
    </Page>
  );
}
