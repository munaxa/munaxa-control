import type { ReactNode } from 'react';

import {
  Badge,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Field,
  Grid,
  Input,
  Page,
  PageHeader,
  Select,
  Table,
  TBody,
  TD,
  TR,
  Textarea,
} from '@munaxa/ui';

import { ActionForm } from '@/components/action-form';
import { apiGet } from '@/lib/api';
import { formatDate, formatLimit, formatMoney, productName } from '@/lib/format';
import type { Plan } from '@/lib/types';

import { draftVersion, publishVersion, retireVersion } from '../../../actions';

export const metadata = { title: 'Plan' };

/** The keys each product's own catalogue defines, as a hint. The product owns them; this only lists them. */
const KEY_HINTS: Readonly<Record<string, string>> = {
  docs: 'Features: api.access, integration.webhooks, sso.federation, audit.stream, esignature. Limits: users, storage.bytes.',
  school:
    'Features: api, ai_assistant, sso, jofotara, advanced_reports, automation, white_label, … Limits: students, campuses, staff, storage_gb.',
  work: 'See Munaxa Work ADR-0079 for its feature and limit keys.',
};

export default async function PlanPage({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<ReactNode> {
  const { id } = await params;
  const plan = await apiGet<
    Plan & { versions: (Plan['versions'][number] & { _count: { subscriptions: number } })[] }
  >(`/admin/plans/${id}`, `/plans/${id}`);

  return (
    <Page>
      <PageHeader
        title={plan.name}
        description={`${productName(plan.product)} · ${plan.code}${plan.description ? ` · ${plan.description}` : ''}`}
      />
      <Grid cols={{ base: 1, lg: 2 }}>
        {plan.versions.map((v) => (
          <Card key={v.id}>
            <CardHeader>
              <CardTitle>
                Version {v.version}{' '}
                <Badge tone={v.state === 'PUBLISHED' ? 'success' : 'muted'}>
                  {v.state.toLowerCase()}
                </Badge>
              </CardTitle>
              <CardDescription>
                {formatMoney(v.priceMinor, v.currency)}{' '}
                {v.billingPeriod?.toLowerCase() ?? 'bespoke term'} · trial {v.trialDays} days ·
                grace {v.graceDays} days · {v._count?.subscriptions ?? 0} subscription(s)
                {v.publishedAt ? ` · published ${formatDate(v.publishedAt)}` : ''}
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              <div className="flex flex-wrap gap-2">
                {v.features.map((f) => (
                  <Badge key={f}>{f}</Badge>
                ))}
              </div>
              <Table>
                <TBody>
                  {Object.entries(v.limits).map(([key, value]) => (
                    <TR key={key}>
                      <TD className="font-mono">{key}</TD>
                      <TD className="text-end">{formatLimit(value)}</TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
              {v.state === 'DRAFT' && (
                <ActionForm
                  action={publishVersion}
                  submitLabel="Publish"
                  confirm="Publishing freezes these terms for ever. Publish?"
                >
                  <input type="hidden" name="versionId" value={v.id} />
                  <input type="hidden" name="planId" value={plan.id} />
                </ActionForm>
              )}
              {v.state === 'PUBLISHED' && (
                <ActionForm
                  action={retireVersion}
                  submitLabel="Retire"
                  tone="outline"
                  confirm="Retire this version? Existing subscribers keep it."
                >
                  <input type="hidden" name="versionId" value={v.id} />
                  <input type="hidden" name="planId" value={plan.id} />
                </ActionForm>
              )}
            </CardContent>
          </Card>
        ))}
      </Grid>
      <Card>
        <CardHeader>
          <CardTitle>Draft a new version</CardTitle>
          <CardDescription>{KEY_HINTS[plan.product]}</CardDescription>
        </CardHeader>
        <CardContent>
          <ActionForm action={draftVersion} submitLabel="Create draft">
            <input type="hidden" name="planId" value={plan.id} />
            <Field
              label="Features"
              htmlFor="features"
              hint="Feature keys, separated by spaces or commas."
            >
              <Textarea id="features" name="features" rows={2} className="font-mono" />
            </Field>
            <Field
              label="Limits"
              htmlFor="limits"
              hint="One per line: key=number or key=unlimited. A limit not listed is zero."
            >
              <Textarea id="limits" name="limits" rows={4} className="font-mono" />
            </Field>
            <Grid cols={{ base: 1, md: 3 }}>
              <Field
                label="List price (minor units)"
                htmlFor="priceMinor"
                hint="Informational. Nothing here charges."
              >
                <Input id="priceMinor" name="priceMinor" inputMode="numeric" />
              </Field>
              <Field label="Currency" htmlFor="currency">
                <Input id="currency" name="currency" maxLength={3} placeholder="JOD" />
              </Field>
              <Field label="Billing period" htmlFor="billingPeriod">
                <Select id="billingPeriod" name="billingPeriod" defaultValue="YEARLY">
                  <option value="MONTHLY">Monthly</option>
                  <option value="YEARLY">Yearly</option>
                  <option value="">Bespoke term</option>
                </Select>
              </Field>
              <Field label="Trial days" htmlFor="trialDays">
                <Input id="trialDays" name="trialDays" inputMode="numeric" defaultValue="0" />
              </Field>
              <Field label="Grace days" htmlFor="graceDays">
                <Input id="graceDays" name="graceDays" inputMode="numeric" defaultValue="14" />
              </Field>
            </Grid>
          </ActionForm>
        </CardContent>
      </Card>
    </Page>
  );
}
