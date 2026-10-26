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
import { apiGet } from '@/lib/api';
import { formatDateTime, productName } from '@/lib/format';
import type { Deployment } from '@/lib/types';

import { createDeployment, issueCredential, revokeCredential } from '../../actions';

export const metadata = { title: 'Deployments' };

export default async function DeploymentsPage(): Promise<ReactNode> {
  const deployments = await apiGet<Deployment[]>('/admin/deployments', '/deployments');
  return (
    <Page>
      <PageHeader
        title="Deployments"
        description="Each running SaaS deployment of a product, and the credentials it calls this service with. A credential sees only its own deployment's tenants."
      />
      {deployments.map((d) => (
        <Card key={d.id}>
          <CardHeader>
            <CardTitle>
              {productName(d.product)} — {d.name}
            </CardTitle>
            <CardDescription>{d._count.tenants} tenant(s)</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <Table>
              <THead>
                <TR>
                  <TH>Credential</TH>
                  <TH>Created</TH>
                  <TH>Last used</TH>
                  <TH>Status</TH>
                </TR>
              </THead>
              <TBody>
                {d.credentials.map((c) => (
                  <TR key={c.id}>
                    <TD>
                      {c.label}{' '}
                      <span className="font-mono text-muted-foreground">{c.id.slice(0, 8)}</span>
                    </TD>
                    <TD>{formatDateTime(c.createdAt)}</TD>
                    <TD>{formatDateTime(c.lastUsedAt)}</TD>
                    <TD>
                      {c.revokedAt === null ? (
                        <Badge tone="success">Active</Badge>
                      ) : (
                        <Badge tone="muted">Revoked</Badge>
                      )}
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
            <ActionForm action={issueCredential} submitLabel="Issue credential" tone="outline">
              <input type="hidden" name="deploymentId" value={d.id} />
              <Field
                label="Label"
                htmlFor={`label-${d.id}`}
                hint="Where it will be configured, e.g. eu-prod api."
                required
              >
                <Input id={`label-${d.id}`} name="label" required maxLength={100} />
              </Field>
            </ActionForm>
            {d.credentials.some((c) => c.revokedAt === null) && (
              <ActionForm
                action={revokeCredential}
                submitLabel="Revoke credential"
                tone="destructive"
                confirm="Revoke? The deployment loses access at its next request."
              >
                <Field label="Credential" htmlFor={`revoke-${d.id}`} required>
                  <Select id={`revoke-${d.id}`} name="credentialId" required>
                    {d.credentials
                      .filter((c) => c.revokedAt === null)
                      .map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.label} ({c.id.slice(0, 8)})
                        </option>
                      ))}
                  </Select>
                </Field>
              </ActionForm>
            )}
          </CardContent>
        </Card>
      ))}
      <Card>
        <CardHeader>
          <CardTitle>New deployment</CardTitle>
        </CardHeader>
        <CardContent>
          <ActionForm action={createDeployment} submitLabel="Create deployment">
            <Field label="Product" htmlFor="product" required>
              <Select id="product" name="product" required>
                <option value="school">Munaxa School</option>
                <option value="work">Munaxa Work</option>
                <option value="docs">Munaxa Docs</option>
              </Select>
            </Field>
            <Field label="Name" htmlFor="name" hint="Lowercase, e.g. docs-eu-prod" required>
              <Input id="name" name="name" required pattern="[a-z0-9][a-z0-9\-]+" maxLength={63} />
            </Field>
          </ActionForm>
        </CardContent>
      </Card>
    </Page>
  );
}
