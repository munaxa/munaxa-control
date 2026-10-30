import { ControlPermission } from './auth/permissions';
import { accessEnvironment, startHarness, type Harness } from './testing/harness';

/**
 * Cloudflare Access in front of the operator plane, on the real application and database. The
 * portal forwards `Cf-Access-Jwt-Assertion`; without a valid one, no operator route answers,
 * whatever Identity token comes with it. Product routes and health do not go through Access.
 */
let h: Harness;

beforeAll(async () => {
  h = await startHarness(accessEnvironment);
});
afterAll(async () => {
  await h.close();
});
beforeEach(async () => {
  await h.reset();
});

const operator = (access?: string) => ({
  Authorization: `Bearer ${h.token()}`,
  ...(access !== undefined && { 'Cf-Access-Jwt-Assertion': access }),
});

describe('operator routes behind Cloudflare Access', () => {
  it('answer an Identity operator who also passed Access', async () => {
    await h.http.get('/api/v1/admin/customers').set(operator(h.accessToken())).expect(200);
  });

  it('refuse a valid Identity token that did not come through Access', async () => {
    const response = await h.http.get('/api/v1/admin/customers').set(operator()).expect(401);
    expect(JSON.stringify(response.body)).toMatch(/Cloudflare Access/);
  });

  it('refuse a forged, expired, foreign or personless Access token', async () => {
    const now = Math.floor(h.clock.now().getTime() / 1_000);
    for (const access of [
      'not-a-token',
      h.accessToken({}, { forged: true }),
      h.accessToken({ exp: now - 3_600 }),
      h.accessToken({ aud: ['c'.repeat(64)] }),
      h.accessToken({ iss: 'https://other.cloudflareaccess.com' }),
      h.accessToken({ email: '' }),
    ]) {
      await h.http.get('/api/v1/admin/customers').set(operator(access)).expect(401);
    }
  });

  it('still require the Identity token, its organisation and the permission', async () => {
    const access = h.accessToken();
    await h.http
      .get('/api/v1/admin/customers')
      .set({ 'Cf-Access-Jwt-Assertion': access })
      .expect(401);
    await h.http
      .get('/api/v1/admin/customers')
      .set({
        Authorization: `Bearer ${h.token(undefined, { tid: 'customer-org' })}`,
        'Cf-Access-Jwt-Assertion': access,
      })
      .expect(401);
    await h.http
      .get('/api/v1/admin/customers')
      .set({
        Authorization: `Bearer ${h.token([ControlPermission.AUDIT_READ])}`,
        'Cf-Access-Jwt-Assertion': access,
      })
      .expect(403);
  });

  it('leave health and the product plane alone', async () => {
    await h.http.get('/health/live').expect(200);
    // A product route still wants its service credential, and no Access token stands in for it.
    await h.http
      .get('/api/v1/products/docs/tenants/x/entitlements')
      .set({ 'Cf-Access-Jwt-Assertion': h.accessToken() })
      .expect(401);
  });
});
