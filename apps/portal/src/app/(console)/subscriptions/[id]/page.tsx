import Link from 'next/link';
import type { ReactNode } from 'react';

import {
  Alert,
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
  TH,
  THead,
  TR,
  Timeline,
  TimelineItem,
} from '@munaxa/ui';

import { ActionForm } from '@/components/action-form';
import { StatusBadge } from '@/components/status-badge';
import { apiGet } from '@/lib/api';
import { formatDate, formatDateTime, formatLimit, productName } from '@/lib/format';
import type { Plan, SubscriptionDetail } from '@/lib/types';

import { changePlan, issueLicence, revokeLicence, transitionSubscription } from '../../../actions';

export const metadata = { title: 'Subscription' };

/** What each lifecycle event means to an operator, and whether it needs a new term. */
const EVENTS: Readonly<
  Record<string, { label: string; term?: true; destructive?: true; help: string }>
> = {
  ACTIVATE: {
    label: 'Activate',
    term: true,
    help: 'Convert a trial, or settle an overdue account, starting a paid term.',
  },
  RENEW: {
    label: 'Renew',
    term: true,
    help: 'A new term from the later of today and the current term end.',
  },
  MARK_PAST_DUE: { label: 'Mark past due', help: 'An invoice is overdue. Access is unchanged.' },
  ENTER_GRACE: {
    label: 'Enter grace',
    help: 'Stop growth (new users, new storage) while payment is resolved.',
  },
  EXPIRE: {
    label: 'Expire now',
    destructive: true,
    help: 'End the term today. The customer keeps read access.',
  },
  SUSPEND: {
    label: 'Suspend',
    destructive: true,
    help: 'Immediate and reversible. Products become read-only at once.',
  },
  REACTIVATE: {
    label: 'Reactivate',
    help: 'Lift the suspension, returning to the state it interrupted.',
  },
  CANCEL: {
    label: 'Cancel',
    destructive: true,
    help: 'Final. The customer keeps export access; nothing is deleted.',
  },
};

export default async function SubscriptionPage({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<ReactNode> {
  const { id } = await params;
  const s = await apiGet<SubscriptionDetail>(`/admin/subscriptions/${id}`, `/subscriptions/${id}`);
  const plans = await apiGet<Plan[]>(`/admin/plans?product=${s.tenant.product}`);
  const otherVersions = plans.flatMap((p) =>
    p.versions
      .filter((v) => v.state === 'PUBLISHED' && v.id !== s.planVersion.id)
      .map((v) => ({ id: v.id, label: `${p.name} v${v.version}` })),
  );
  const onPremises = s.tenant.deploymentType === 'ON_PREMISES';
  const activeInstallations = s.licences.flatMap((l) =>
    l.installation?.status === 'ACTIVE' ? [l.installation.installationRef] : [],
  );

  return (
    <Page>
      <PageHeader
        above={
          <Link
            href={`/customers/${s.tenant.customerId}`}
            className="text-sm underline-offset-4 hover:underline"
          >
            {s.tenant.customer.name}
          </Link>
        }
        title={`${productName(s.tenant.product)} — ${s.planVersion.plan.name} v${s.planVersion.version}`}
        description={`Tenant ${s.tenant.tenantRef} · ${onPremises ? 'on premises' : `SaaS on ${s.tenant.deployment?.name ?? '—'}`}`}
        actions={<StatusBadge status={s.effectiveStatus} />}
      />
      {s.effectiveStatus !== s.status && (
        <Alert tone="info">
          Recorded as {s.status}; the term dates make it {s.effectiveStatus} now. Products already
          apply the dates; the scheduled sweep records it.
        </Alert>
      )}

      <Grid cols={{ base: 1, lg: 2 }}>
        <Card>
          <CardHeader>
            <CardTitle>Term</CardTitle>
          </CardHeader>
          <CardContent>
            <Table>
              <TBody>
                <TR>
                  <TH>Started</TH>
                  <TD>{formatDate(s.startsAt)}</TD>
                </TR>
                <TR>
                  <TH>Trial ends</TH>
                  <TD>{formatDate(s.trialEndsAt)}</TD>
                </TR>
                <TR>
                  <TH>Term ends</TH>
                  <TD>{formatDate(s.expiresAt)}</TD>
                </TR>
                <TR>
                  <TH>Grace until</TH>
                  <TD>{formatDate(s.graceUntil)}</TD>
                </TR>
                {s.suspendedFrom !== null && (
                  <TR>
                    <TH>Suspended from</TH>
                    <TD>
                      <StatusBadge status={s.suspendedFrom} />
                    </TD>
                  </TR>
                )}
              </TBody>
            </Table>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Entitlements</CardTitle>
            <CardDescription>Exactly what the product receives.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <div className="flex flex-wrap gap-2">
              {s.entitlements.features.length === 0 ? (
                <span className="text-muted-foreground">No paid features</span>
              ) : null}
              {s.entitlements.features.map((f) => (
                <Badge key={f}>{f}</Badge>
              ))}
            </div>
            <Table>
              <TBody>
                {Object.entries(s.entitlements.limits).map(([key, value]) => (
                  <TR key={key}>
                    <TD className="font-mono">{key}</TD>
                    <TD className="text-end">{formatLimit(value)}</TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          </CardContent>
        </Card>
      </Grid>

      <Card>
        <CardHeader>
          <CardTitle>Lifecycle</CardTitle>
          <CardDescription>
            Only the actions a {s.effectiveStatus.toLowerCase().replace('_', ' ')} subscription
            accepts are offered.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Grid cols={{ base: 1, md: 2 }}>
            {s.allowedEvents.map((event) => {
              const meaning = EVENTS[event];
              if (meaning === undefined) return null;
              return (
                <Card key={event}>
                  <CardHeader>
                    <CardTitle>{meaning.label}</CardTitle>
                    <CardDescription>{meaning.help}</CardDescription>
                  </CardHeader>
                  <CardContent>
                    <ActionForm
                      action={transitionSubscription}
                      submitLabel={meaning.label}
                      tone={meaning.destructive ? 'destructive' : 'primary'}
                      {...(meaning.destructive && {
                        confirm: `${meaning.label} this subscription?`,
                      })}
                    >
                      <input type="hidden" name="subscriptionId" value={s.id} />
                      <input type="hidden" name="version" value={s.version} />
                      <input type="hidden" name="event" value={event} />
                      {meaning.term && (
                        <Field
                          label="New term ends"
                          htmlFor={`term-${event}`}
                          hint="Leave empty for one billing period."
                        >
                          <Input id={`term-${event}`} name="expiresAt" type="date" />
                        </Field>
                      )}
                      <Field
                        label="Reason"
                        htmlFor={`reason-${event}`}
                        {...(meaning.destructive && { required: true })}
                      >
                        <Input
                          id={`reason-${event}`}
                          name="reason"
                          maxLength={500}
                          {...(meaning.destructive && { required: true, minLength: 3 })}
                        />
                      </Field>
                    </ActionForm>
                  </CardContent>
                </Card>
              );
            })}
          </Grid>
        </CardContent>
      </Card>

      {s.status !== 'CANCELLED' && otherVersions.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Change plan</CardTitle>
            <CardDescription>
              Upgrade or downgrade to another published version. The term is unchanged.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ActionForm action={changePlan} submitLabel="Change plan">
              <input type="hidden" name="subscriptionId" value={s.id} />
              <input type="hidden" name="version" value={s.version} />
              <Field label="New plan version" htmlFor="planVersionId" required>
                <Select id="planVersionId" name="planVersionId" required>
                  {otherVersions.map((v) => (
                    <option key={v.id} value={v.id}>
                      {v.label}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Reason" htmlFor="plan-reason">
                <Input id="plan-reason" name="reason" maxLength={500} />
              </Field>
            </ActionForm>
          </CardContent>
        </Card>
      )}

      {onPremises && (
        <Card>
          <CardHeader>
            <CardTitle>Licences</CardTitle>
            <CardDescription>
              Signed here, verified offline by the installation with the public key. A revocation
              reaches an offline installation only with the revocation list, delivered like a
              licence file — until then the licence keeps working, so keep terms short.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <Table>
              <THead>
                <TR>
                  <TH>Licence</TH>
                  <TH>Installation</TH>
                  <TH>Issued</TH>
                  <TH>Ends</TH>
                  <TH />
                </TR>
              </THead>
              <TBody>
                {s.licences.map((l) => (
                  <TR key={l.id}>
                    <TD className="font-mono">{l.id.slice(0, 8)}</TD>
                    <TD className="font-mono">{l.installation?.installationRef ?? 'unbound'}</TD>
                    <TD>{formatDateTime(l.issuedAt)}</TD>
                    <TD>{formatDate(l.expiresAt)}</TD>
                    <TD>
                      {l.revokedAt === null ? (
                        <a href={`/licences/${l.id}/download`} className="underline">
                          Download
                        </a>
                      ) : (
                        <Badge tone="muted">Revoked</Badge>
                      )}
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
            {(s.effectiveStatus === 'ACTIVE' || s.effectiveStatus === 'TRIAL') && (
              <ActionForm action={issueLicence} submitLabel="Issue licence">
                <input type="hidden" name="subscriptionId" value={s.id} />
                <Field
                  label="Installation"
                  htmlFor="installationRef"
                  hint="A registered installation of this tenant. Leave empty for a short, unbound first-activation licence."
                >
                  <Input
                    id="installationRef"
                    name="installationRef"
                    list="installations"
                    maxLength={128}
                    className="font-mono"
                  />
                </Field>
                <datalist id="installations">
                  {[...new Set(activeInstallations)].map((ref) => (
                    <option key={ref} value={ref} />
                  ))}
                </datalist>
                <Field
                  label="Ends no later than"
                  htmlFor="licence-ends"
                  hint="Never beyond the subscription term or the maximum licence term."
                >
                  <Input id="licence-ends" name="expiresAt" type="date" />
                </Field>
              </ActionForm>
            )}
            {s.licences.some((l) => l.revokedAt === null) && (
              <ActionForm
                action={revokeLicence}
                submitLabel="Record revocation"
                tone="destructive"
                confirm="Record this licence as revoked?"
              >
                <input type="hidden" name="subscriptionId" value={s.id} />
                <Field label="Licence" htmlFor="licenceId" required>
                  <Select id="licenceId" name="licenceId" required>
                    {s.licences
                      .filter((l) => l.revokedAt === null)
                      .map((l) => (
                        <option key={l.id} value={l.id}>
                          {l.id.slice(0, 8)} — {l.installation?.installationRef ?? 'unbound'}
                        </option>
                      ))}
                  </Select>
                </Field>
                <Field label="Category" htmlFor="revoke-category" required>
                  <Select id="revoke-category" name="category" required>
                    <option value="CONTRACT_ENDED">Contract ended early</option>
                    <option value="ISSUED_IN_ERROR">Issued in error</option>
                    <option value="SUPERSEDED">Superseded</option>
                    <option value="KEY_COMPROMISE">Signing key compromised</option>
                  </Select>
                </Field>
                <Field label="Reason" htmlFor="revoke-reason" required>
                  <Input id="revoke-reason" name="reason" required minLength={3} maxLength={500} />
                </Field>
              </ActionForm>
            )}
            <p>
              <a href={`/products/${s.tenant.product}/revocation-list`} download>
                Download the {s.tenant.product} revocation list
              </a>{' '}
              — every revoked licence of the product, signed. Install it next to the licence file.
            </p>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>History</CardTitle>
        </CardHeader>
        <CardContent>
          <Timeline>
            {s.events.map((e) => (
              <TimelineItem
                key={e.id}
                title={`${e.event.replaceAll('_', ' ').toLowerCase()} → ${e.toStatus}`}
                timestamp={formatDateTime(e.createdAt)}
                meta={e.reason === null ? e.actor : `${e.actor} — ${e.reason}`}
              />
            ))}
          </Timeline>
        </CardContent>
      </Card>
    </Page>
  );
}
