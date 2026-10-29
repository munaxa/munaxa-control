import { randomUUID } from 'node:crypto';

import {
  decodeActivationRequest,
  encodeActivationRequest,
  licenseVerifier,
  parseEntitlementSnapshot,
  verifyLicense,
  applyRevocation,
  resolveRevocationList,
  revocationInForce,
} from '@munaxa/licensing';

import { ControlPermission } from './auth/permissions';
import { IdempotencyInterceptor } from './core/idempotency.interceptor';
import { PrismaService } from './core/prisma.service';
import { startHarness, type Harness } from './testing/harness';

let h: Harness;

beforeAll(async () => {
  h = await startHarness();
});
afterAll(async () => {
  await h.close();
});
beforeEach(async () => {
  await h.reset();
});

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
const admin = () => auth(h.token());

async function post<T = Record<string, unknown>>(
  path: string,
  body: unknown,
  headers = admin(),
  status = 201,
): Promise<T> {
  const response = await h.http
    .post(`/api/v1${path}`)
    .set(headers)
    .send(body as object);
  if (response.status !== status)
    throw new Error(`POST ${path} → ${response.status}: ${JSON.stringify(response.body)}`);
  return response.body as T;
}

/** A customer with one Docs SaaS tenant, a deployment and its credential, and a published plan. */
async function world() {
  const customer = await post<{ id: string }>('/admin/customers', {
    name: 'Acme Holdings',
    country: 'JO',
  });
  const deployment = await post<{ id: string }>('/admin/deployments', {
    product: 'docs',
    name: 'docs-eu-prod',
  });
  const credential = await post<{ id: string; token: string }>(
    `/admin/deployments/${deployment.id}/credentials`,
    { label: 'eu-prod api' },
  );
  const tenant = await post<{ id: string }>(`/admin/customers/${customer.id}/tenants`, {
    product: 'docs',
    tenantRef: '019489f0-0000-7000-8000-0000000000a1',
    deploymentType: 'SAAS',
    deploymentId: deployment.id,
    displayName: 'Acme Docs',
  });
  const plan = await post<{ id: string }>('/admin/plans', {
    product: 'docs',
    code: 'business',
    name: 'Docs Business',
  });
  const version = await post<{ id: string }>(`/admin/plans/${plan.id}/versions`, {
    features: ['integration.webhooks', 'api.access'],
    limits: { users: 25, 'storage.bytes': 10_000_000_000 },
    priceMinor: 9900,
    currency: 'JOD',
    billingPeriod: 'MONTHLY',
    trialDays: 14,
    graceDays: 10,
  });
  await post(`/admin/plan-versions/${version.id}/publish`, {});
  return { customer, deployment, credential, tenant, plan, version };
}

async function subscribe(
  w: Awaited<ReturnType<typeof world>>,
  start: 'TRIAL' | 'ACTIVE' = 'ACTIVE',
) {
  return post<{ id: string; version: number; status: string }>('/admin/subscriptions', {
    tenantLinkId: w.tenant.id,
    planVersionId: w.version.id,
    start,
  });
}

const entitlementsPath = (product: string, tenant: string) =>
  `/api/v1/products/${product}/tenants/${tenant}/entitlements`;

describe('health', () => {
  it('answers without credentials and touches the database for readiness', async () => {
    await h.http.get('/health/live').expect(200, { status: 'ok' });
    await h.http.get('/health/ready').expect(200, { status: 'ok' });
  });
});

describe('operator authentication through Munaxa Identity', () => {
  it('refuses no token, a forged token, another organisation and a missing permission', async () => {
    await h.http.get('/api/v1/admin/customers').expect(401);
    await h.http.get('/api/v1/admin/customers').set(auth(h.forgedToken())).expect(401);
    await h.http
      .get('/api/v1/admin/customers')
      .set(auth(h.token(undefined, { tid: 'customer-org' })))
      .expect(401);
    await h.http
      .get('/api/v1/admin/customers')
      .set(auth(h.token([ControlPermission.AUDIT_READ])))
      .expect(403);
    await h.http
      .get('/api/v1/admin/customers')
      .set(auth(h.token([ControlPermission.CUSTOMERS_READ])))
      .expect(200);
  });

  it('refuses a token minted outside an Identity session', async () => {
    await h.http
      .get('/api/v1/admin/customers')
      .set(auth(h.token(undefined, { session: false })))
      .expect(401);
  });

  it('honours no wildcard and no other product’s namespace', async () => {
    await h.http
      .get('/api/v1/admin/customers')
      .set(auth(h.token(['control:*', 'work:customers:read'])))
      .expect(403);
  });

  it('refuses an expired token', async () => {
    const token = h.token();
    h.clock.advanceDays(1);
    await h.http.get('/api/v1/admin/customers').set(auth(token)).expect(401);
  });

  it('read permission does not write', async () => {
    await h.http
      .post('/api/v1/admin/customers')
      .set(auth(h.token([ControlPermission.CUSTOMERS_READ])))
      .send({ name: 'X' })
      .expect(403);
  });
});

describe('the operator and product planes never cross', () => {
  it('a service credential cannot reach administration, and an operator token cannot reach a product route', async () => {
    const w = await world();
    await subscribe(w);
    await h.http.get('/api/v1/admin/customers').set(auth(w.credential.token)).expect(401);
    await h.http
      .get(entitlementsPath('docs', '019489f0-0000-7000-8000-0000000000a1'))
      .set(admin())
      .expect(401);
  });
});

describe('entitlements for products', () => {
  it('serves the contract snapshot to the tenant’s own deployment, with private caching and an ETag', async () => {
    const w = await world();
    await subscribe(w);
    const response = await h.http
      .get(entitlementsPath('docs', '019489f0-0000-7000-8000-0000000000a1'))
      .set(auth(w.credential.token))
      .expect(200);
    const parsed = parseEntitlementSnapshot(response.body);
    expect(parsed.ok).toBe(true);
    expect(response.body).toMatchObject({
      product: 'docs',
      tenantId: '019489f0-0000-7000-8000-0000000000a1',
      customerId: w.customer.id,
      deployment: 'SAAS',
      status: 'ACTIVE',
      features: ['api.access', 'integration.webhooks'],
      limits: { users: 25, 'storage.bytes': 10_000_000_000 },
      plan: { code: 'business', version: 1 },
    });
    expect(response.headers['cache-control']).toBe('private, max-age=30');
    await h.http
      .get(entitlementsPath('docs', '019489f0-0000-7000-8000-0000000000a1'))
      .set({ ...auth(w.credential.token), 'If-None-Match': response.headers['etag'] })
      .expect(304);
  });

  it('a credential cannot ask about another product, another deployment’s tenant, or a stranger — all the same 404', async () => {
    const w = await world();
    await subscribe(w);
    const other = await post<{ id: string }>('/admin/deployments', {
      product: 'docs',
      name: 'docs-me-prod',
    });
    const otherCredential = await post<{ token: string }>(
      `/admin/deployments/${other.id}/credentials`,
      { label: 'me' },
    );
    const tenant = '019489f0-0000-7000-8000-0000000000a1';
    await h.http.get(entitlementsPath('school', tenant)).set(auth(w.credential.token)).expect(404);
    await h.http.get(entitlementsPath('docs', tenant)).set(auth(otherCredential.token)).expect(404);
    await h.http
      .get(entitlementsPath('docs', 'no-such-tenant'))
      .set(auth(w.credential.token))
      .expect(404);
    await h.http.get(entitlementsPath('crm', tenant)).set(auth(w.credential.token)).expect(422);
  });

  it('a revoked or tampered credential is refused', async () => {
    const w = await world();
    await subscribe(w);
    const path = entitlementsPath('docs', '019489f0-0000-7000-8000-0000000000a1');
    await h.http
      .get(path)
      .set(auth(`${w.credential.token.slice(0, -2)}xx`))
      .expect(401);
    await post(`/admin/credentials/${w.credential.id}/revoke`, {});
    await h.http.get(path).set(auth(w.credential.token)).expect(401);
  });

  it('a cancelled tenant is answered CANCELLED — export-only — never "no subscription"', async () => {
    const w = await world();
    const subscription = await subscribe(w);
    await post(`/admin/subscriptions/${subscription.id}/transitions`, {
      event: 'CANCEL',
      expectedVersion: subscription.version,
      reason: 'customer left',
    });
    const response = await h.http
      .get(entitlementsPath('docs', '019489f0-0000-7000-8000-0000000000a1'))
      .set(auth(w.credential.token))
      .expect(200);
    expect(response.body.status).toBe('CANCELLED');
  });
});

describe('the subscription lifecycle', () => {
  it('suspension returns to the state it interrupted; history and audit record each step', async () => {
    const w = await world();
    let s = await subscribe(w, 'TRIAL');
    expect(s.status).toBe('TRIAL');
    s = await post(`/admin/subscriptions/${s.id}/transitions`, {
      event: 'SUSPEND',
      expectedVersion: s.version,
      reason: 'abuse report',
    });
    expect(s).toMatchObject({ status: 'SUSPENDED', suspendedFrom: 'TRIAL' });
    s = await post(`/admin/subscriptions/${s.id}/transitions`, {
      event: 'REACTIVATE',
      expectedVersion: s.version,
      reason: 'cleared',
    });
    expect(s.status).toBe('TRIAL');
    const detail = await h.http.get(`/api/v1/admin/subscriptions/${s.id}`).set(admin()).expect(200);
    expect(detail.body.events.map((e: { event: string }) => e.event)).toEqual([
      'REACTIVATE',
      'SUSPEND',
      'CREATE',
    ]);
    const audit = await h.http
      .get(`/api/v1/admin/audit?subscriptionId=${s.id}`)
      .set(admin())
      .expect(200);
    expect(audit.body.map((e: { action: string }) => e.action)).toEqual([
      'licensing.subscription.transitioned',
      'licensing.subscription.transitioned',
      'licensing.subscription.created',
    ]);
    expect(audit.body[0].actor).toBe('operator:operator-1');
  });

  it('refuses an illegal transition and a stale version, and allows only one live subscription per tenant', async () => {
    const w = await world();
    const s = await subscribe(w);
    const illegal = await h.http
      .post(`/api/v1/admin/subscriptions/${s.id}/transitions`)
      .set(admin())
      .send({ event: 'REACTIVATE', expectedVersion: s.version });
    expect(illegal.status).toBe(409);
    expect(illegal.body.code).toBe('INVALID_TRANSITION');
    const stale = await h.http
      .post(`/api/v1/admin/subscriptions/${s.id}/transitions`)
      .set(admin())
      .send({ event: 'MARK_PAST_DUE', expectedVersion: s.version + 5 });
    expect(stale.body.code).toBe('VERSION_CONFLICT');
    const second = await h.http
      .post('/api/v1/admin/subscriptions')
      .set(admin())
      .send({ tenantLinkId: w.tenant.id, planVersionId: w.version.id, start: 'ACTIVE' });
    expect(second.body.code).toBe('SUBSCRIPTION_EXISTS');
  });

  it('renewing early extends from the old term end, never shortening what was paid for', async () => {
    const w = await world();
    const s = await subscribe(w);
    const before = await h.http.get(`/api/v1/admin/subscriptions/${s.id}`).set(admin());
    const renewed = await post<{ expiresAt: string }>(`/admin/subscriptions/${s.id}/transitions`, {
      event: 'RENEW',
      expectedVersion: s.version,
    });
    const oldEnd = new Date(before.body.expiresAt as string);
    expect(new Date(renewed.expiresAt).getUTCMonth()).toBe((oldEnd.getUTCMonth() + 1) % 12);
  });

  it('the sweep records moves the dates have made; decisions never waited for it', async () => {
    const w = await world();
    const s = await subscribe(w);
    h.clock.advanceDays(35); // past the monthly term, inside the 10-day grace
    const detail = await h.http.get(`/api/v1/admin/subscriptions/${s.id}`).set(admin());
    expect(detail.body).toMatchObject({ status: 'ACTIVE', effectiveStatus: 'GRACE_PERIOD' });
    const moved = await h.app
      .get((await import('./subscriptions/subscriptions.service')).SubscriptionsService)
      .sweep();
    expect(moved).toBe(1);
    const after = await h.http.get(`/api/v1/admin/subscriptions/${s.id}`).set(admin());
    expect(after.body.status).toBe('GRACE_PERIOD');
    expect(after.body.events[0]).toMatchObject({ event: 'ENTER_GRACE', actor: 'system:sweep' });
  });

  it('upgrades to another published version and refuses another product’s plan', async () => {
    const w = await world();
    const s = await subscribe(w);
    const v2 = await post<{ id: string }>(`/admin/plans/${w.plan.id}/versions`, {
      features: ['integration.webhooks', 'api.access', 'esignature'],
      limits: { users: 100 },
      billingPeriod: 'MONTHLY',
    });
    const draft = await h.http
      .post(`/api/v1/admin/subscriptions/${s.id}/plan`)
      .set(admin())
      .send({ planVersionId: v2.id, expectedVersion: s.version });
    expect(draft.body.code).toBe('PLAN_VERSION_NOT_PUBLISHED');
    await post(`/admin/plan-versions/${v2.id}/publish`, {});
    const upgraded = await post<{ entitlements: { features: string[] } }>(
      `/admin/subscriptions/${s.id}/plan`,
      {
        planVersionId: v2.id,
        expectedVersion: s.version,
        reason: 'upgrade to e-signature',
      },
    );
    expect(upgraded.entitlements.features).toContain('esignature');

    const schoolPlan = await post<{ id: string }>('/admin/plans', {
      product: 'school',
      code: 'starter',
      name: 'Starter',
    });
    const sv = await post<{ id: string }>(`/admin/plans/${schoolPlan.id}/versions`, {
      features: [],
      limits: {},
      billingPeriod: 'YEARLY',
    });
    await post(`/admin/plan-versions/${sv.id}/publish`, {});
    const cross = await h.http
      .post(`/api/v1/admin/subscriptions/${s.id}/plan`)
      .set(admin())
      .send({ planVersionId: sv.id, expectedVersion: s.version + 1 });
    expect(cross.status).toBe(422);
  });
});

describe('plans', () => {
  it('a published version’s terms cannot change — by the API or under it', async () => {
    const w = await world();
    const edit = await h.http
      .put(`/api/v1/admin/plan-versions/${w.version.id}`)
      .set(admin())
      .send({ features: ['everything'], limits: {} });
    expect(edit.body.code).toBe('PLAN_VERSION_FROZEN');
    await expect(
      h.owner.$executeRawUnsafe(
        `UPDATE plan_version SET features = '{everything}' WHERE id = '${w.version.id}'`,
      ),
    ).rejects.toThrow(/immutable/);
  });
});

describe('idempotent retries', () => {
  it('the same key replays the first answer; the same key with another body is refused', async () => {
    const w = await world();
    const headers = { ...admin(), 'Idempotency-Key': 'create-sub-0001' };
    const body = { tenantLinkId: w.tenant.id, planVersionId: w.version.id, start: 'ACTIVE' };
    const first = await h.http
      .post('/api/v1/admin/subscriptions')
      .set(headers)
      .send(body)
      .expect(201);
    const retry = await h.http.post('/api/v1/admin/subscriptions').set(headers).send(body);
    expect(retry.body).toMatchObject({ id: first.body.id });
    expect(retry.status).toBe(201);
    expect(retry.headers['idempotent-replay']).toBe('true');
    expect(retry.body.id).toBe(first.body.id);
    const reused = await h.http
      .post('/api/v1/admin/subscriptions')
      .set(headers)
      .send({ ...body, start: 'TRIAL' });
    expect(reused.body.code).toBe('IDEMPOTENCY_KEY_REUSED');
    expect(await h.owner.subscription.count()).toBe(1);
  });
  it('replays an answer holding a bigint price, which the portal sends with every draft', async () => {
    const w = await world();
    const headers = { ...admin(), 'Idempotency-Key': 'draft-version-0001' };
    const body = { features: [], limits: {}, priceMinor: 12_500, currency: 'JOD' };
    const first = await h.http
      .post(`/api/v1/admin/plans/${w.plan.id}/versions`)
      .set(headers)
      .send(body)
      .expect(201);
    expect(first.body.priceMinor).toBe(12_500);
    const retry = await h.http
      .post(`/api/v1/admin/plans/${w.plan.id}/versions`)
      .set(headers)
      .send(body)
      .expect(201);
    expect(retry.headers['idempotent-replay']).toBe('true');
    expect(retry.body).toEqual(first.body);
    expect(await h.owner.planVersion.count({ where: { planId: w.plan.id } })).toBe(2);
  });
});

describe('idempotent retries of a secret', () => {
  it('a credential is issued once; its retry is refused and its secret is never kept', async () => {
    const deployment = await post<{ id: string }>('/admin/deployments', {
      product: 'docs',
      name: 'docs-eu-prod',
    });
    const headers = { ...admin(), 'Idempotency-Key': 'issue-credential-0001' };
    const path = `/api/v1/admin/deployments/${deployment.id}/credentials`;
    const first = await h.http.post(path).set(headers).send({ label: 'eu-prod api' }).expect(201);
    expect(first.body.token).toMatch(/^mxc_/);
    const retry = await h.http.post(path).set(headers).send({ label: 'eu-prod api' });
    expect(retry.status).toBe(409);
    expect(retry.body.code).toBe('SECRET_NOT_REPLAYED');
    expect(JSON.stringify(retry.body)).not.toContain(first.body.token);
    const stored = await h.owner.$queryRaw<{ response: string }[]>`
      SELECT response::text AS response FROM idempotency_record`;
    expect(stored).toHaveLength(1);
    expect(stored[0]?.response).not.toContain('mxc_');
    expect(stored[0]?.response).toContain(first.body.id);
    expect(await h.owner.serviceCredential.count()).toBe(1);
  });
  it('the sweep deletes records past retention and keeps the rest', async () => {
    const w = await world();
    const body = { tenantLinkId: w.tenant.id, planVersionId: w.version.id, start: 'ACTIVE' };
    await h.http
      .post('/api/v1/admin/subscriptions')
      .set({ ...admin(), 'Idempotency-Key': 'create-sub-0002' })
      .send(body)
      .expect(201);
    const interceptor = h.app.get(IdempotencyInterceptor);
    // Stamped against the harness clock, not the database's.
    await h.owner.idempotencyRecord.updateMany({ data: { createdAt: h.clock.now() } });
    const before = await h.owner.idempotencyRecord.count();
    expect(before).toBeGreaterThan(0);
    expect(await interceptor.purgeExpired()).toBe(0);
    await h.owner.idempotencyRecord.updateMany({
      data: { createdAt: new Date(h.clock.now().getTime() - 49 * 3_600_000) },
    });
    expect(await interceptor.purgeExpired()).toBe(before);
    expect(await h.owner.idempotencyRecord.count()).toBe(0);
  });
});

describe('idempotent retries under concurrency', () => {
  it('ten simultaneous requests under one key perform the action once', async () => {
    const w = await world();
    const headers = { ...admin(), 'Idempotency-Key': 'race-create-0001' };
    const body = { tenantLinkId: w.tenant.id, planVersionId: w.version.id, start: 'ACTIVE' };
    const answers = await Promise.all(
      Array.from({ length: 10 }, () =>
        h.http.post('/api/v1/admin/subscriptions').set(headers).send(body),
      ),
    );
    // One owner answers 201; the rest are replays (201) or told it is still in progress (409).
    expect(answers.every((a) => a.status === 201 || a.body.code === 'REQUEST_IN_PROGRESS')).toBe(
      true,
    );
    expect(answers.some((a) => a.body.code === 'SUBSCRIPTION_EXISTS')).toBe(false);
    expect(await h.owner.subscription.count()).toBe(1);
  });
});

describe('on-premises licences', () => {
  async function onPremises() {
    const customer = await post<{ id: string }>('/admin/customers', { name: 'Al-Noor School' });
    const tenant = await post<{ id: string }>(`/admin/customers/${customer.id}/tenants`, {
      product: 'school',
      tenantRef: '0d1f4c9e-0000-4000-8000-000000000001',
      deploymentType: 'ON_PREMISES',
      displayName: 'Al-Noor (on site)',
    });
    const plan = await post<{ id: string }>('/admin/plans', {
      product: 'school',
      code: 'professional',
      name: 'Professional',
    });
    const version = await post<{ id: string }>(`/admin/plans/${plan.id}/versions`, {
      features: ['advanced_reports'],
      limits: { students: 1500 },
      billingPeriod: 'YEARLY',
      graceDays: 30,
    });
    await post(`/admin/plan-versions/${version.id}/publish`, {});
    const subscription = await post<{ id: string; version: number }>('/admin/subscriptions', {
      tenantLinkId: tenant.id,
      planVersionId: version.id,
      start: 'ACTIVE',
    });
    return { customer, tenant, subscription };
  }

  const verifierFrom = async () => {
    const keys = await h.http.get('/api/v1/licensing/public-keys').expect(200);
    expect(JSON.stringify(keys.body)).not.toMatch(/PRIVATE/);
    return licenseVerifier('ES256', keys.body.keys as { kid: string; publicKey: string }[]);
  };

  it('issues a licence an offline installation verifies with the published public key alone', async () => {
    const { tenant, subscription } = await onPremises();
    await post(`/admin/tenants/${tenant.id}/installations`, { installationRef: 'inst-alnoor-1' });
    const issued = await post<{ id: string }>(`/admin/subscriptions/${subscription.id}/licences`, {
      installationRef: 'inst-alnoor-1',
    });
    const file = await h.http
      .get(`/api/v1/admin/licences/${issued.id}/download`)
      .set(admin())
      .expect(200);
    const result = verifyLicense(file.text, {
      verifier: await verifierFrom(),
      product: 'school',
      installationId: 'inst-alnoor-1',
      now: h.clock.now(),
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.license.licenseId).toBe(issued.id);
      expect(result.snapshot).toMatchObject({
        tenantId: '0d1f4c9e-0000-4000-8000-000000000001',
        limits: { students: 1500 },
      });
      // Never longer than the configured maximum term.
      expect(
        Date.parse(result.license.expiresAt as string) - h.clock.now().getTime(),
      ).toBeLessThanOrEqual(400 * 86_400_000);
    }
  });

  it('a replaced server is reactivated under control: the old installation is retired and the new licence supersedes', async () => {
    const { tenant, subscription } = await onPremises();
    await post(`/admin/tenants/${tenant.id}/installations`, { installationRef: 'inst-old' });
    const first = await post<{ id: string }>(`/admin/subscriptions/${subscription.id}/licences`, {
      installationRef: 'inst-old',
    });
    const code = encodeActivationRequest({
      format: 'mxa1',
      product: 'school',
      installationId: 'inst-new',
      licenseId: first.id,
      requestedAt: h.clock.now().toISOString(),
      reason: 'SERVER_REPLACEMENT',
    });
    expect(decodeActivationRequest(code)).not.toBeNull();
    const second = await post<{ id: string; installationRef: string }>('/admin/activations', {
      code,
    });
    expect(second.installationRef).toBe('inst-new');
    const installations = await h.http
      .get(`/api/v1/admin/tenants/${tenant.id}/installations`)
      .set(admin())
      .expect(200);
    expect(
      Object.fromEntries(
        installations.body.map((i: { installationRef: string; status: string }) => [
          i.installationRef,
          i.status,
        ]),
      ),
    ).toEqual({
      'inst-old': 'REPLACED',
      'inst-new': 'ACTIVE',
    });
    // The old server's licence names the old installation, so the new server refuses it.
    const old = await h.http.get(`/api/v1/admin/licences/${first.id}/download`).set(admin());
    expect(
      verifyLicense(old.text, {
        verifier: await verifierFrom(),
        product: 'school',
        installationId: 'inst-new',
        now: h.clock.now(),
      }),
    ).toMatchObject({ ok: false, reason: 'WRONG_INSTALLATION' });
    // A replaced installation cannot be issued another licence.
    const again = await h.http
      .post(`/api/v1/admin/subscriptions/${subscription.id}/licences`)
      .set(admin())
      .send({ installationRef: 'inst-old' });
    expect(again.body.code).toBe('INSTALLATION_NOT_ACTIVE');
  });

  it('a revoked licence reaches an offline installation in a signed list, and suspends it there', async () => {
    const { tenant, subscription } = await onPremises();
    await post(`/admin/tenants/${tenant.id}/installations`, { installationRef: 'inst-revoked' });
    const issued = await post<{ id: string }>(`/admin/subscriptions/${subscription.id}/licences`, {
      installationRef: 'inst-revoked',
    });
    const download = (product = 'school') =>
      h.http.get(`/api/v1/admin/products/${product}/revocation-list`).set(admin());
    const verifier = await verifierFrom();
    const opts = { verifier, product: 'school', now: h.clock.now() };

    const before = await download().expect(200);
    const empty = resolveRevocationList(before.text, null, opts);
    expect(empty.rejected).toBeNull();
    const startSequence = empty.list?.sequence ?? 0;
    expect(empty.list?.revoked.some((e) => e.licenseId === issued.id)).toBe(false);

    // A category is required: the list states why in a fixed vocabulary.
    await h.http
      .post(`/api/v1/admin/licences/${issued.id}/revoke`)
      .set(admin())
      .send({ reason: 'Refunded in full' })
      .expect(422);
    await post(`/admin/licences/${issued.id}/revoke`, {
      reason: 'Refunded in full',
      category: 'CONTRACT_ENDED',
    });

    const after = await download().expect(200);
    expect(after.headers['cache-control']).toBe('no-store');
    // The installation persisted the earlier list; the new one is newer, so it is taken.
    const r = resolveRevocationList(after.text, before.text.trim(), opts);
    expect(r.list?.sequence).toBe(startSequence + 1);
    expect(r.persist).not.toBeNull();
    const file = await h.http.get(`/api/v1/admin/licences/${issued.id}/download`).set(admin());
    const licence = verifyLicense(file.text, { ...opts, installationId: 'inst-revoked' });
    expect(licence.ok).toBe(true);
    if (!licence.ok) return;
    const entry = revocationInForce(licence.license, r, h.clock.now());
    expect(entry).toMatchObject({ licenseId: issued.id, reason: 'CONTRACT_ENDED' });
    expect(applyRevocation(licence.snapshot, entry).status).toBe('SUSPENDED');

    // Offering the older list afterwards changes nothing.
    const stale = resolveRevocationList(before.text, r.persist, opts);
    expect(stale.list?.sequence).toBe(startSequence + 1);
    expect(stale.persist).toBeNull();

    // Revoking twice is one revocation: the list does not grow.
    await post(`/admin/licences/${issued.id}/revoke`, {
      reason: 'again',
      category: 'CONTRACT_ENDED',
    });
    expect(resolveRevocationList((await download()).text, null, opts).list?.sequence).toBe(
      startSequence + 1,
    );

    // Another product's list does not name it, and the issue is audited.
    const work = resolveRevocationList((await download('work')).text, null, {
      ...opts,
      product: 'work',
    });
    expect(work.list?.revoked.some((e) => e.licenseId === issued.id)).toBe(false);
    const audit = await h.app.get(PrismaService).auditEvent.findMany({
      where: { action: 'control.revocation_list.issued', product: 'school' },
    });
    expect(audit.length).toBeGreaterThanOrEqual(2);
  });

  it('the revocation list needs licence-issuing permission', async () => {
    await h.http
      .get('/api/v1/admin/products/school/revocation-list')
      .set(auth(h.token([ControlPermission.SUBSCRIPTIONS_READ])))
      .expect(403);
    await h.http.get('/api/v1/admin/products/school/revocation-list').expect(401);
    await h.http
      .get('/api/v1/admin/products/NOT%20A%20PRODUCT/revocation-list')
      .set(admin())
      .expect(422);
  });

  it('refuses a licence for a SaaS tenant or a suspended subscription', async () => {
    const w = await world();
    const saas = await subscribe(w);
    const refusal = await h.http
      .post(`/api/v1/admin/subscriptions/${saas.id}/licences`)
      .set(admin())
      .send({ installationRef: null });
    expect(refusal.status).toBe(422);
    const { subscription } = await onPremises();
    await post(`/admin/subscriptions/${subscription.id}/transitions`, {
      event: 'SUSPEND',
      expectedVersion: subscription.version,
      reason: 'unpaid',
    });
    const suspended = await h.http
      .post(`/api/v1/admin/subscriptions/${subscription.id}/licences`)
      .set(admin())
      .send({ installationRef: null });
    expect(suspended.body.code).toBe('SUBSCRIPTION_NOT_LICENSABLE');
  });
});

describe('usage reporting', () => {
  it('is idempotent per point and silently refuses a tenant outside the credential’s deployment', async () => {
    const w = await world();
    const report = (tenantId: string) => ({
      reports: [{ tenantId, metric: 'users', value: 12, measuredAt: '2026-11-01T00:00:00.000Z' }],
    });
    const path = '/products/docs/usage';
    expect(
      await post(path, report('019489f0-0000-7000-8000-0000000000a1'), auth(w.credential.token)),
    ).toEqual({ accepted: 1, duplicates: 0, rejected: 0 });
    expect(
      await post(path, report('019489f0-0000-7000-8000-0000000000a1'), auth(w.credential.token)),
    ).toEqual({ accepted: 0, duplicates: 1, rejected: 0 });
    expect(await post(path, report('someone-else'), auth(w.credential.token))).toEqual({
      accepted: 0,
      duplicates: 0,
      rejected: 1,
    });
    const latest = await h.http
      .get(`/api/v1/admin/tenants/${w.tenant.id}/usage`)
      .set(admin())
      .expect(200);
    expect(latest.body).toEqual([
      { metric: 'users', value: 12, measured_at: '2026-11-01T00:00:00.000Z' },
    ]);
  });
});

describe('the audit trail', () => {
  it('records every privileged action and cannot be rewritten by the runtime role', async () => {
    await world();
    const audit = await h.http.get('/api/v1/admin/audit').set(admin()).expect(200);
    expect(audit.body.map((e: { action: string }) => e.action)).toEqual(
      expect.arrayContaining([
        'licensing.customer.created',
        'control.credential.issued',
        'licensing.plan.published',
      ]),
    );
    const secretsInTrail = JSON.stringify(audit.body);
    expect(secretsInTrail).not.toMatch(/mxc_/);
    const runtime = h.app.get(PrismaService);
    await expect(
      runtime.$executeRawUnsafe("UPDATE audit_event SET action = 'rewritten'"),
    ).rejects.toThrow(/permission denied/);
    await expect(runtime.$executeRawUnsafe('DELETE FROM audit_event')).rejects.toThrow(
      /permission denied/,
    );
  });
});

describe('no route answers without a credential, but the probes and the public keys', () => {
  const PUBLIC = new Set([
    'GET /health/live',
    'GET /health/ready',
    'GET /api/v1/licensing/public-keys',
  ]);

  it('refuses every other route the application registers', async () => {
    // Its own harness, so the failed-authentication lockout does not turn the 401s under test into
    // 429s part-way through the walk.
    const open = await startHarness({ AUTH_FAILURE_LIMIT_PER_MINUTE: '10000' });
    try {
      interface Layer {
        route?: { path: string; methods: Record<string, boolean> };
      }
      const express = open.app.getHttpAdapter().getInstance() as { router: { stack: Layer[] } };
      // A controller route declares its verbs; a layer that answers every verb is a catch-all
      // the framework installs, not a route anyone wrote.
      const VERBS = new Set(['get', 'post', 'put', 'patch', 'delete']);
      const routes = express.router.stack.flatMap((layer) => {
        const methods = Object.keys(layer.route?.methods ?? {});
        if (layer.route === undefined || methods.some((m) => !VERBS.has(m))) return [];
        return methods.map((method) => ({
          method: method.toUpperCase(),
          path: layer.route?.path ?? '',
        }));
      });
      // The walk is only evidence if it found the routes: every controller, not an empty list.
      expect(routes.length).toBeGreaterThan(30);
      expect(routes.some((r) => r.path.startsWith('/api/v1/admin/'))).toBe(true);
      expect(routes.some((r) => r.path.startsWith('/api/v1/products/'))).toBe(true);

      const answered: string[] = [];
      for (const route of routes) {
        const path = route.path.replace(/:[A-Za-z]+/g, () => randomUUID());
        const call = open.http[route.method.toLowerCase() as 'get'](path).send({});
        const response = await call;
        const name = `${route.method} ${route.path}`;
        if (PUBLIC.has(name)) {
          expect(response.status, name).toBeLessThan(400);
        } else if (response.status !== 401) {
          answered.push(`${name} → ${String(response.status)}`);
        }
      }
      expect(answered).toEqual([]);
      expect(routes.filter((r) => PUBLIC.has(`${r.method} ${r.path}`))).toHaveLength(PUBLIC.size);
    } finally {
      await open.close();
    }
  });
});

describe('abuse protection (ADR-0007)', () => {
  let limited: Harness;
  beforeAll(async () => {
    limited = await startHarness({
      RATE_LIMIT_PER_MINUTE: '3',
      AUTH_FAILURE_LIMIT_PER_MINUTE: '2',
    });
  });
  afterAll(async () => {
    await limited.close();
  });
  beforeEach(() => {
    // A fresh window for every test: the limiter's counts belong to the window, not the test.
    limited.clock.set(new Date('2026-11-01T09:00:00.000Z'));
    limited.clock.advanceDays(1);
  });

  const customers = (token = limited.token()) =>
    limited.http.get('/api/v1/admin/customers').set(auth(token));

  it('answers every request with headers that forbid caching, framing and sniffing', async () => {
    const answer = await h.http.get('/api/v1/admin/customers').set(admin()).expect(200);
    expect(answer.headers['cache-control']).toBe('no-store');
    expect(answer.headers['x-content-type-options']).toBe('nosniff');
    expect(answer.headers['x-frame-options']).toBe('DENY');
    expect(answer.headers['content-security-policy']).toBe(
      "default-src 'none'; frame-ancestors 'none'",
    );
    expect(answer.headers['x-powered-by']).toBeUndefined();
    const probe = await h.http.get('/health/live').expect(200);
    expect(probe.headers['cache-control']).toBe('no-store');
  });

  it('refuses a client past its budget until the window ends, and never refuses a probe', async () => {
    for (let i = 0; i < 3; i += 1) await customers().expect(200);
    const refused = await customers().expect(429);
    expect(refused.body.code).toBe('RATE_LIMITED');
    expect(Number(refused.headers['retry-after'])).toBeGreaterThan(0);
    await limited.http.get('/health/live').expect(200);
    limited.clock.set(new Date(limited.clock.now().getTime() + 60_000));
    await customers().expect(200);
  });

  it('locks an address out after repeated refused credentials, valid ones included', async () => {
    await customers(limited.forgedToken()).expect(401);
    await customers(limited.forgedToken()).expect(401);
    const lockedOut = await customers().expect(429);
    expect(lockedOut.body.code).toBe('TOO_MANY_FAILED_ATTEMPTS');
    // Guessing service credentials counts the same way, whatever id each guess invents.
    limited.clock.set(new Date(limited.clock.now().getTime() + 60_000));
    const guess = () =>
      limited.http
        .get('/api/v1/products/docs/tenants/019489f0-0000-7000-8000-0000000000a1/entitlements')
        .set(auth(`mxc_${randomUUID()}_${'x'.repeat(43)}`));
    await guess().expect(401);
    await guess().expect(401);
    await guess().expect(429);
    limited.clock.set(new Date(limited.clock.now().getTime() + 60_000));
    await customers().expect(200);
  });

  it('counts a product deployment by its credential, not by the address it calls from', async () => {
    const deployment = await limited.http
      .post('/api/v1/admin/deployments')
      .set(auth(limited.token()))
      .send({ product: 'docs', name: 'docs-eu-prod' })
      .expect(201);
    const credential = await limited.http
      .post(`/api/v1/admin/deployments/${deployment.body.id as string}/credentials`)
      .set(auth(limited.token()))
      .send({ label: 'eu-prod api' })
      .expect(201);
    // The address has one request left; the deployment's own budget is untouched by it.
    for (let i = 0; i < 5; i += 1) {
      const answer = await limited.http
        .get('/api/v1/products/docs/tenants/019489f0-0000-7000-8000-0000000000a1/entitlements')
        .set(auth(credential.body.token as string));
      expect(answer.status).not.toBe(429);
    }
    await customers().expect(200);
    await customers().expect(429);
  });
});

describe('the interim operator restriction (ADR-0006)', () => {
  let restricted: Harness;
  beforeAll(async () => {
    restricted = await startHarness({ OPERATOR_SUBJECT_ALLOWLIST: 'operator-1, operator-2' });
  });
  afterAll(async () => {
    await restricted.close();
  });

  it('admits only the subjects this deployment names, whatever Identity grants', async () => {
    const as = (subject: string) =>
      restricted.http
        .get('/api/v1/admin/customers')
        .set(auth(restricted.token(undefined, { subject })));
    await as('operator-1').expect(200);
    await as('operator-2').expect(200);
    const refused = await as('someone-granted-by-mistake').expect(401);
    expect(refused.body.detail).toMatch(/may not operate/);
  });

  it('requires a satisfied second factor once MFA is switched on', async () => {
    const mfa = await startHarness({ OPERATOR_REQUIRE_MFA: 'true' });
    try {
      await mfa.http.get('/api/v1/admin/customers').set(auth(mfa.token())).expect(401);
      await mfa.http
        .get('/api/v1/admin/customers')
        .set(auth(mfa.token(undefined, { mfa: true })))
        .expect(200);
    } finally {
      await mfa.close();
    }
  });
});
