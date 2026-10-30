import { generateKeyPairSync, sign } from 'node:crypto';

import { NextRequest } from 'next/server';

import { config, middleware } from './middleware';

const TEAM = 'https://munaxa.cloudflareaccess.com';
const AUD = 'e'.repeat(64);
const key = generateKeyPairSync('rsa', { modulusLength: 2048 });
const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
function accessToken(): string {
  const now = Math.floor(Date.now() / 1_000);
  const body = `${part({ alg: 'RS256', kid: 'k1' })}.${part({ iss: TEAM, aud: [AUD], email: 'tamer@munaxa.test', sub: 'u1', iat: now, exp: now + 600 })}`;
  return `${body}.${sign('RSA-SHA256', Buffer.from(body), key.privateKey).toString('base64url')}`;
}

const request = (path: string, headers: Record<string, string> = {}) =>
  new NextRequest(`https://operator-test.munaxa.com${path}`, { headers });

beforeEach(() => {
  vi.stubEnv('OPERATOR_ACCESS_TEAM_DOMAIN', TEAM);
  vi.stubEnv('OPERATOR_ACCESS_AUDIENCE', AUD);
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string) =>
      Promise.resolve(
        url === `${TEAM}/cdn-cgi/access/certs`
          ? Response.json({
              keys: [{ ...key.publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'RS256' }],
            })
          : new Response('no', { status: 404 }),
      ),
    ),
  );
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('middleware', () => {
  it('answers nothing, pages or assets, to a request that went round Cloudflare Access', async () => {
    for (const path of ['/', '/customers', '/_next/static/chunks/app.js', '/branding/logo.svg']) {
      const response = await middleware(request(path));
      expect(response.status, path).toBe(401);
      expect(await response.text()).toMatch(/Cloudflare Access/);
    }
  });

  it('lets a request that passed Access on to the session check', async () => {
    const response = await middleware(
      request('/customers', { 'cf-access-jwt-assertion': accessToken() }),
    );
    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toContain('/api/auth/login?returnTo=%2Fcustomers');
  });

  it('serves assets to a request that passed Access, without a session', async () => {
    const response = await middleware(
      request('/_next/static/chunks/app.js', { 'cf-access-jwt-assertion': accessToken() }),
    );
    expect(response.headers.get('x-middleware-next')).toBe('1');
  });

  it('fails closed in production when Access is not configured', async () => {
    vi.stubEnv('OPERATOR_ACCESS_TEAM_DOMAIN', '');
    vi.stubEnv('OPERATOR_ACCESS_AUDIENCE', '');
    vi.stubEnv('NODE_ENV', 'production');
    const response = await middleware(request('/'));
    expect(response.status).toBe(503);
  });

  it('runs on everything but the health check and the Identity routes', () => {
    const matcher = new RegExp(`^${config.matcher[0]!}$`);
    expect(matcher.test('/')).toBe(true);
    expect(matcher.test('/_next/static/x.js')).toBe(true);
    expect(matcher.test('/healthz')).toBe(false);
    expect(matcher.test('/healthzx')).toBe(true);
    expect(matcher.test('/api/auth/login')).toBe(false);
    expect(config.runtime).toBe('nodejs');
  });
});
