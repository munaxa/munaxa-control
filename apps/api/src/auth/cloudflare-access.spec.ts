import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto';

import {
  AccessKeysUnavailableError,
  AccessTokenError,
  CloudflareAccessVerifier,
  parseKeySet,
  type FetchAccessKeys,
} from './cloudflare-access';

const TEAM = 'https://munaxa.cloudflareaccess.com';
const AUD = 'b'.repeat(64);
const NOW = Date.parse('2026-11-01T09:00:00Z');
const seconds = (ms: number) => Math.floor(ms / 1_000);

const pair = () => generateKeyPairSync('rsa', { modulusLength: 2048 });
const cloudflare = pair();
const stranger = pair();
const jwk = (key: KeyObject, kid: string) => ({
  ...key.export({ format: 'jwk' }),
  kid,
  alg: 'RS256',
  use: 'sig',
});

const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
function token(
  claims: Record<string, unknown> = {},
  header: Record<string, unknown> = {},
  key: KeyObject = cloudflare.privateKey,
): string {
  const body = `${part({ alg: 'RS256', kid: 'k1', typ: 'JWT', ...header })}.${part({
    iss: TEAM,
    aud: [AUD],
    email: 'tamer@munaxa.test',
    sub: '7335d417-61da-459d-899c-0a01c76a2f94',
    type: 'app',
    iat: seconds(NOW) - 60,
    nbf: seconds(NOW) - 60,
    exp: seconds(NOW) + 3_600,
    ...claims,
  })}`;
  return `${body}.${sign('RSA-SHA256', Buffer.from(body), key).toString('base64url')}`;
}

function verifier(fetchKeys?: FetchAccessKeys, now = () => NOW) {
  const reads: string[] = [];
  const keys: FetchAccessKeys =
    fetchKeys ??
    ((url) => {
      reads.push(url);
      return Promise.resolve({ keys: [jwk(cloudflare.publicKey, 'k1')] });
    });
  return {
    reads,
    verifier: new CloudflareAccessVerifier({
      teamDomain: TEAM,
      audience: AUD,
      clockSkewMs: 30_000,
      now,
      fetchKeys: keys,
    }),
  };
}

const refused = (value: Promise<unknown>, reason: RegExp) =>
  expect(value).rejects.toThrow(
    expect.objectContaining({ name: 'AccessTokenError', message: expect.stringMatching(reason) }),
  );

describe('CloudflareAccessVerifier', () => {
  it('accepts a token Access signed for this application, and names the person', async () => {
    const { verifier: v, reads } = verifier();
    await expect(v.verify(token())).resolves.toEqual({
      email: 'tamer@munaxa.test',
      subject: '7335d417-61da-459d-899c-0a01c76a2f94',
    });
    expect(reads).toEqual([`${TEAM}/cdn-cgi/access/certs`]);
    // The key set is kept, not read per request.
    await v.verify(token());
    expect(reads).toHaveLength(1);
  });

  it('refuses a missing, empty or malformed token', async () => {
    const { verifier: v } = verifier();
    for (const value of [undefined, '', '   ', 'abc', 'a.b', 'a.b.c.d', 'a.b!.c']) {
      await expect(v.verify(value)).rejects.toBeInstanceOf(AccessTokenError);
    }
    await refused(v.verify(`${part('x')}.${part({})}.sig`), /not JSON/);
  });

  it('refuses any algorithm but RS256, including none and HS256', async () => {
    const { verifier: v } = verifier();
    for (const alg of ['none', 'HS256', 'ES256', 'PS256']) {
      await refused(v.verify(token({}, { alg })), /not RS256/);
    }
    const unsigned = token().split('.').slice(0, 2).join('.') + '.';
    await expect(v.verify(unsigned)).rejects.toBeInstanceOf(AccessTokenError);
  });

  it('refuses a token signed by a key Cloudflare did not publish', async () => {
    const { verifier: v } = verifier();
    await refused(v.verify(token({}, {}, stranger.privateKey)), /bad signature/);
  });

  it('refuses a token whose claims were changed after signing', async () => {
    const { verifier: v } = verifier();
    const [header, , signature] = token().split('.');
    const other = token({ email: 'someone@else.test' }).split('.')[1];
    await refused(v.verify(`${header}.${other}.${signature}`), /bad signature/);
  });

  it('refuses another issuer, another application, or no audience', async () => {
    const { verifier: v } = verifier();
    await refused(v.verify(token({ iss: 'https://evil.cloudflareaccess.com' })), /wrong issuer/);
    await refused(v.verify(token({ iss: `${TEAM}/` })), /wrong issuer/);
    await refused(v.verify(token({ aud: ['c'.repeat(64)] })), /wrong audience/);
    await refused(v.verify(token({ aud: undefined })), /wrong audience/);
    await expect(v.verify(token({ aud: AUD }))).resolves.toBeDefined();
  });

  it('refuses an expired token, one not yet valid, or one issued in the future (outside the skew)', async () => {
    const { verifier: v } = verifier();
    await refused(v.verify(token({ exp: seconds(NOW) - 31 })), /expired/);
    await refused(v.verify(token({ exp: undefined })), /expired/);
    await refused(v.verify(token({ exp: '9999999999' })), /expired/);
    await expect(v.verify(token({ exp: seconds(NOW) - 10 }))).resolves.toBeDefined();
    await refused(v.verify(token({ nbf: seconds(NOW) + 60 })), /not yet valid/);
    await refused(v.verify(token({ iat: seconds(NOW) + 60 })), /issued in the future/);
    await refused(v.verify(token({ iat: undefined })), /issued in the future/);
  });

  it('refuses a token that names no person: a service token, or a missing email or subject', async () => {
    const { verifier: v } = verifier();
    await refused(v.verify(token({ email: undefined })), /names no person/);
    await refused(v.verify(token({ email: '' })), /names no person/);
    await refused(v.verify(token({ sub: '' })), /names no person/);
    await refused(v.verify(token({ type: 'org' })), /not an application token/);
    await refused(
      v.verify(token({ email: undefined, sub: '', common_name: 'ci.access' })),
      /names no person/,
    );
  });

  it('reads the key set again for an unknown kid, at most once a minute', async () => {
    let published = [jwk(cloudflare.publicKey, 'k1')];
    let now = NOW;
    let reads = 0;
    const { verifier: v } = verifier(
      () => {
        reads += 1;
        return Promise.resolve({ keys: published });
      },
      () => now,
    );
    await v.verify(token());
    const rotated = pair();
    published = [jwk(cloudflare.publicKey, 'k1'), jwk(rotated.publicKey, 'k2')];
    await refused(v.verify(token({}, { kid: 'k2' }, rotated.privateKey)), /unknown kid/);
    expect(reads).toBe(1); // within the minute of the first read
    now += 61_000;
    await expect(v.verify(token({}, { kid: 'k2' }, rotated.privateKey))).resolves.toBeDefined();
    expect(reads).toBe(2);
  });

  it('fails closed when the keys cannot be read, and keeps keys it already has', async () => {
    const down = verifier(() => Promise.reject(new Error('timeout'))).verifier;
    await expect(down.verify(token())).rejects.toBeInstanceOf(AccessKeysUnavailableError);
    // Within the retry interval it still refuses, without asking again.
    await expect(down.verify(token())).rejects.toBeInstanceOf(AccessKeysUnavailableError);

    let now = NOW;
    let fail = false;
    const { verifier: v } = verifier(
      () =>
        fail
          ? Promise.reject(new Error('timeout'))
          : Promise.resolve({ keys: [jwk(cloudflare.publicKey, 'k1')] }),
      () => now,
    );
    await v.verify(token());
    fail = true;
    now += 2 * 60 * 60_000; // the cache is stale and the read fails
    await expect(
      v.verify(token({ iat: seconds(now), nbf: seconds(now), exp: seconds(now) + 60 })),
    ).resolves.toBeDefined();
  });
});

describe('parseKeySet', () => {
  it('keeps RS256 signing keys of at least 2048 bits and ignores the rest', () => {
    const small = generateKeyPairSync('rsa', { modulusLength: 1024 });
    const ec = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const keys = parseKeySet({
      keys: [
        jwk(cloudflare.publicKey, 'good'),
        jwk(small.publicKey, 'small'),
        { ...ec.publicKey.export({ format: 'jwk' }), kid: 'ec' },
        { ...jwk(stranger.publicKey, 'enc'), use: 'enc' },
        { ...jwk(stranger.publicKey, 'ps'), alg: 'PS256' },
      ],
    });
    expect([...keys.keys()]).toEqual(['good']);
  });

  it('refuses a body that is not a JWKS or holds no usable key', () => {
    expect(() => parseKeySet(null)).toThrow(/not a JWKS/);
    expect(() => parseKeySet({ keys: 'x' })).toThrow(/not a JWKS/);
    expect(() => parseKeySet({ keys: [] })).toThrow(/no RS256/);
  });
});
