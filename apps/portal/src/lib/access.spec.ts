import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto';

import { AccessVerifier, accessConfigFrom, importKeySet, type FetchAccessKeys } from './access';

const TEAM = 'https://munaxa.cloudflareaccess.com';
const AUD = 'e'.repeat(64);
const NOW = Date.parse('2026-11-01T09:00:00Z');
const seconds = (ms: number) => Math.floor(ms / 1_000);

const cloudflare = generateKeyPairSync('rsa', { modulusLength: 2048 });
const stranger = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = (key: KeyObject, kid: string) => ({
  ...key.export({ format: 'jwk' }),
  kid,
  alg: 'RS256',
  use: 'sig',
});
const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');

function accessToken(
  claims: Record<string, unknown> = {},
  header: Record<string, unknown> = {},
  key: KeyObject = cloudflare.privateKey,
): string {
  const body = `${part({ alg: 'RS256', kid: 'k1', ...header })}.${part({
    iss: TEAM,
    aud: [AUD],
    email: 'tamer@munaxa.test',
    sub: 'access-user-1',
    type: 'app',
    iat: seconds(NOW) - 60,
    exp: seconds(NOW) + 3_600,
    ...claims,
  })}`;
  return `${body}.${sign('RSA-SHA256', Buffer.from(body), key).toString('base64url')}`;
}

const published: FetchAccessKeys = () =>
  Promise.resolve({ keys: [jwk(cloudflare.publicKey, 'k1')] });
const verifier = (fetchKeys = published, now = () => NOW) =>
  new AccessVerifier({ teamDomain: TEAM, audience: AUD }, fetchKeys, now);

describe('accessConfigFrom', () => {
  it('is off outside production without settings, and refuses production without them', () => {
    expect(accessConfigFrom({ NODE_ENV: 'development' })).toBeNull();
    expect(accessConfigFrom({ NODE_ENV: 'production' })).toMatch(/not configured/);
  });

  it('needs both settings, a team domain and an AUD tag', () => {
    expect(
      accessConfigFrom({ OPERATOR_ACCESS_TEAM_DOMAIN: TEAM, OPERATOR_ACCESS_AUDIENCE: AUD }),
    ).toEqual({
      teamDomain: TEAM,
      audience: AUD,
    });
    expect(accessConfigFrom({ OPERATOR_ACCESS_TEAM_DOMAIN: TEAM })).toMatch(/both or neither/);
    expect(
      accessConfigFrom({
        OPERATOR_ACCESS_TEAM_DOMAIN: 'https://evil.example',
        OPERATOR_ACCESS_AUDIENCE: AUD,
      }),
    ).toMatch(/not a team domain/);
    expect(
      accessConfigFrom({ OPERATOR_ACCESS_TEAM_DOMAIN: TEAM, OPERATOR_ACCESS_AUDIENCE: 'x y' }),
    ).toMatch(/not an AUD tag/);
  });
});

describe('AccessVerifier', () => {
  it('accepts a token Access signed for this application', async () => {
    await expect(verifier().verify(accessToken())).resolves.toEqual({
      ok: true,
      email: 'tamer@munaxa.test',
    });
  });

  it.each([
    ['no token', null],
    ['an empty token', ''],
    ['a malformed token', 'a.b'],
    ['alg none', accessToken({}, { alg: 'none' })],
    ['HS256', accessToken({}, { alg: 'HS256' })],
    ['a key Cloudflare did not publish', accessToken({}, {}, stranger.privateKey)],
    ['an unknown kid', accessToken({}, { kid: 'k9' })],
    ['another issuer', accessToken({ iss: 'https://evil.cloudflareaccess.com' })],
    ['another application', accessToken({ aud: ['f'.repeat(64)] })],
    ['an expired token', accessToken({ exp: seconds(NOW) - 60 })],
    ['a token not yet valid', accessToken({ nbf: seconds(NOW) + 120 })],
    ['a token with no iat', accessToken({ iat: undefined })],
    ['a service token (no email)', accessToken({ email: '', common_name: 'ci' })],
    ['a token naming no subject', accessToken({ sub: '' })],
  ])('refuses %s with 401', async (_label, token) => {
    await expect(verifier().verify(token)).resolves.toMatchObject({ ok: false, status: 401 });
  });

  it('refuses claims changed after signing', async () => {
    const [header, , signature] = accessToken().split('.');
    const forged = `${header}.${accessToken({ email: 'other@munaxa.test' }).split('.')[1]}.${signature}`;
    await expect(verifier().verify(forged)).resolves.toMatchObject({
      ok: false,
      reason: 'bad signature',
    });
  });

  it('answers 503 while no key can be read, and keeps keys it already has', async () => {
    const down = verifier(() => Promise.reject(new Error('timeout')));
    await expect(down.verify(accessToken())).resolves.toMatchObject({ ok: false, status: 503 });

    let now = NOW;
    let fail = false;
    const v = verifier(
      () => (fail ? Promise.reject(new Error('timeout')) : published('')),
      () => now,
    );
    await v.verify(accessToken());
    fail = true;
    now += 2 * 60 * 60_000;
    const fresh = accessToken({ iat: seconds(now), exp: seconds(now) + 60 });
    await expect(v.verify(fresh)).resolves.toMatchObject({ ok: true });
  });
});

describe('importKeySet', () => {
  it('keeps only RS256 signing keys of 2048 bits or more', async () => {
    const small = generateKeyPairSync('rsa', { modulusLength: 1024 });
    const keys = await importKeySet({
      keys: [
        jwk(cloudflare.publicKey, 'good'),
        jwk(small.publicKey, 'small'),
        { ...jwk(stranger.publicKey, 'enc'), use: 'enc' },
      ],
    });
    expect([...keys.keys()]).toEqual(['good']);
    await expect(importKeySet({ keys: [] })).rejects.toThrow(/no RS256/);
  });
});
