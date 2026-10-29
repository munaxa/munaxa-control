import { createHash, generateKeyPairSync, randomBytes, sign, verify } from 'node:crypto';

import { fromBase64Url } from '@munaxa/crypto';
import {
  DeploymentType,
  REVOCATION_LIST_FORMAT,
  RevocationReason,
  SubscriptionStatus,
  issueLicense,
  issueRevocationList,
  licenseVerifier,
  verifyLicense,
  verifyRevocationList,
  type LicensePayload,
} from '@munaxa/licensing';

import { loadEnvironment } from '../config/environment';

import { FileLicenceSigner, KmsLicenceSigner, derToP1363, type KmsSignApi } from './licence-signer';

// --- A stand-in for AWS KMS ------------------------------------------------------------------------
//
// KMS signs a SHA-256 digest it is given (MessageType DIGEST) and answers in DER. Node's signing
// API always hashes its input, so the stand-in signs the digest with textbook ECDSA over P-256.
// Test code only: production never signs here.

const P = 0xffffffff00000001000000000000000000000000ffffffffffffffffffffffffn;
const N = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;
const G: Point = [
  0x6b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c296n,
  0x4fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5n,
];
type Point = readonly [bigint, bigint] | null;

const mod = (a: bigint, m: bigint) => ((a % m) + m) % m;
const inv = (a: bigint, m: bigint) => {
  let [r, t, oldR, oldT] = [m, 0n, mod(a, m), 1n];
  while (r !== 0n) {
    const q = oldR / r;
    [oldR, r] = [r, oldR - q * r];
    [oldT, t] = [t, oldT - q * t];
  }
  return mod(oldT, m);
};
const add = (a: Point, b: Point): Point => {
  if (a === null) return b;
  if (b === null) return a;
  if (a[0] === b[0] && mod(a[1] + b[1], P) === 0n) return null;
  const l =
    a[0] === b[0]
      ? mod(3n * a[0] * a[0] - 3n, P) * inv(2n * a[1], P)
      : mod(b[1] - a[1], P) * inv(b[0] - a[0], P);
  const x = mod(l * l - a[0] - b[0], P);
  return [x, mod(l * (a[0] - x) - a[1], P)];
};
const multiply = (k: bigint, point: Point): Point => {
  let result: Point = null;
  let addend = point;
  for (let e = k; e > 0n; e >>= 1n) {
    if (e & 1n) result = add(result, addend);
    addend = add(addend, addend);
  }
  return result;
};
const toBig = (bytes: Uint8Array) => BigInt(`0x${Buffer.from(bytes).toString('hex') || '0'}`);
const derInteger = (value: bigint) => {
  let hex = value.toString(16);
  if (hex.length % 2) hex = `0${hex}`;
  let bytes = Buffer.from(hex, 'hex');
  if ((bytes[0] ?? 0) & 0x80) bytes = Buffer.concat([Buffer.from([0]), bytes]);
  return Buffer.concat([Buffer.from([0x02, bytes.length]), bytes]);
};

function kmsStandIn(keyId: string): { kms: KmsSignApi; publicKey: string; calls: Uint8Array[] } {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const d = toBig(Buffer.from(privateKey.export({ format: 'jwk' }).d as string, 'base64url'));
  const calls: Uint8Array[] = [];
  return {
    publicKey: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    calls,
    kms: {
      signDigest(id, digest) {
        if (id !== keyId) return Promise.reject(new Error('AccessDeniedException'));
        calls.push(digest);
        const z = toBig(digest);
        for (;;) {
          const k = mod(toBig(randomBytes(32)), N);
          if (k === 0n) continue;
          const r = mod((multiply(k, G) as readonly [bigint, bigint])[0], N);
          const s = mod(inv(k, N) * (z + r * d), N);
          if (r === 0n || s === 0n) continue;
          const body = Buffer.concat([derInteger(r), derInteger(s)]);
          return Promise.resolve(Buffer.concat([Buffer.from([0x30, body.length]), body]));
        }
      },
    },
  };
}

const KEY_ARN = 'arn:aws:kms:eu-central-1:229251310592:key/0b5c2a1e-6f3d-4e8a-9c71-2d4f5e6a7b8c';

const payload: LicensePayload = {
  schemaVersion: 1,
  customerId: 'customer-1',
  tenantId: 'tenant-1',
  product: 'docs',
  deployment: DeploymentType.ON_PREMISES,
  subscriptionId: 'sub-1',
  plan: { code: 'standard', version: 1 },
  status: SubscriptionStatus.ACTIVE,
  trialEndsAt: null,
  expiresAt: '2027-11-01T00:00:00.000Z',
  graceUntil: '2027-11-15T00:00:00.000Z',
  features: ['core'],
  limits: { users: 25 },
  licenseId: 'lic-1',
  installationId: 'inst-1',
  issuedAt: '2026-11-01T00:00:00.000Z',
  notBefore: '2026-11-01T00:00:00.000Z',
  supersedes: null,
};

describe('derToP1363', () => {
  it('turns every DER signature Node produces into the fixed-width form that verifies', () => {
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    // Enough signatures that short r and s values (leading zero bytes dropped in DER) occur.
    for (let i = 0; i < 300; i += 1) {
      const message = randomBytes(40);
      const der = sign('sha256', message, { key: privateKey, dsaEncoding: 'der' });
      const raw = derToP1363(der, 32);
      expect(raw).toHaveLength(64);
      expect(verify('sha256', message, { key: publicKey, dsaEncoding: 'ieee-p1363' }, raw)).toBe(
        true,
      );
    }
  });

  it('refuses malformed input', () => {
    expect(() => derToP1363(Buffer.from([0x31, 0x00]), 32)).toThrow('Malformed');
    expect(() => derToP1363(Buffer.from([0x30, 0x06, 0x02, 0x01, 0x01, 0x02, 0x01]), 32)).toThrow(
      'Malformed',
    );
    const long = Buffer.concat([
      Buffer.from([0x30, 0x25, 0x02, 0x21]),
      randomBytes(33),
      Buffer.from([0x02, 0x00]),
    ]);
    long[4] = 0x7f;
    expect(() => derToP1363(long, 32)).toThrow('Malformed');
  });
});

describe('KmsLicenceSigner', () => {
  it('issues a licence the published public key verifies, with one KMS call per signature', async () => {
    const { kms, publicKey, calls } = kmsStandIn(KEY_ARN);
    const signer = new KmsLicenceSigner('licence-kms-1', KEY_ARN, publicKey, kms);

    const token = await signer.sign((s) => issueLicense(payload, s));

    expect(calls).toHaveLength(1);
    expect(token.split('.')[2]).toBe('licence-kms-1');
    const result = verifyLicense(token, {
      verifier: licenseVerifier('ES256', [{ kid: 'licence-kms-1', publicKey }]),
      now: new Date('2026-12-01T00:00:00.000Z'),
      product: 'docs',
      installationId: 'inst-1',
    });
    expect(result).toMatchObject({ ok: true });
  });

  it('signs the SHA-256 of exactly the bytes the contract asked for', async () => {
    const { kms, publicKey, calls } = kmsStandIn(KEY_ARN);
    const signer = new KmsLicenceSigner('licence-kms-1', KEY_ARN, publicKey, kms);
    const token = await signer.sign((s) => issueLicense(payload, s));
    const [format, encoded] = token.split('.');
    const local = new FileLicenceSigner(
      'probe',
      'ES256',
      generateKeyPairSync('ec', { namedCurve: 'P-256' })
        .privateKey.export({ type: 'pkcs8', format: 'pem' })
        .toString(),
    );
    // The same payload through a local signer yields the same encoded body, so the signed bytes
    // are the contract's, not a copy of its encoding.
    const reference = await local.sign((s) => issueLicense(payload, s));
    expect(reference.split('.').slice(0, 2)).toEqual([format, encoded]);
    const asked: Uint8Array[] = [];
    await local.sign((s) =>
      issueLicense(payload, {
        ...s,
        algorithm: s.algorithm,
        sign: (p) => {
          asked.push(typeof p === 'string' ? Buffer.from(p) : p);
          return s.sign(p);
        },
        verify: s.verify.bind(s),
      }),
    );
    expect(Buffer.from(calls[0] as Uint8Array)).toEqual(
      createHash('sha256')
        .update(asked[0] as Uint8Array)
        .digest(),
    );
  });

  it('signs revocation lists through the same path', async () => {
    const { kms, publicKey } = kmsStandIn(KEY_ARN);
    const signer = new KmsLicenceSigner('licence-kms-1', KEY_ARN, publicKey, kms);
    const body = await signer.sign((s) =>
      issueRevocationList(
        {
          format: REVOCATION_LIST_FORMAT,
          product: 'docs',
          sequence: 2,
          issuedAt: '2026-11-01T00:00:00.000Z',
          revoked: [
            {
              licenseId: 'lic-1',
              revokedAt: '2026-11-01T00:00:00.000Z',
              reason: RevocationReason.SUPERSEDED,
            },
          ],
        },
        s,
      ),
    );
    const value = body.split('.')[3] as string;
    expect(Buffer.from(fromBase64Url(value))).toHaveLength(64);
    expect(
      verifyRevocationList(body, {
        verifier: licenseVerifier('ES256', [{ kid: 'licence-kms-1', publicKey }]),
        product: 'docs',
        now: new Date('2026-11-02T00:00:00.000Z'),
      }),
    ).toMatchObject({ ok: true });
  });

  it('refuses a build that asks to sign different bytes the second time', async () => {
    const { kms, publicKey } = kmsStandIn(KEY_ARN);
    const signer = new KmsLicenceSigner('licence-kms-1', KEY_ARN, publicKey, kms);
    let pass = 0;
    await expect(
      signer.sign((s) => {
        pass += 1;
        return s.sign(`document ${pass}`).value;
      }),
    ).rejects.toThrow('changed between signing passes');
  });

  it('refuses a KMS signature the published public key does not verify', async () => {
    const { kms } = kmsStandIn(KEY_ARN);
    const other = kmsStandIn(KEY_ARN);
    const signer = new KmsLicenceSigner('licence-kms-1', KEY_ARN, other.publicKey, kms);
    await expect(signer.selfTest()).rejects.toThrow('does not verify');
    await expect(signer.sign((s) => issueLicense(payload, s))).rejects.toThrow('does not verify');
  });

  it('passes its self-test with a matching key, and surfaces a KMS refusal', async () => {
    const { kms, publicKey } = kmsStandIn(KEY_ARN);
    await expect(
      new KmsLicenceSigner('licence-kms-1', KEY_ARN, publicKey, kms).selfTest(),
    ).resolves.toBeUndefined();
    const wrongKey = KEY_ARN.replace('0b5c2a1e', '1b5c2a1e');
    await expect(
      new KmsLicenceSigner('licence-kms-1', wrongKey, publicKey, kms).selfTest(),
    ).rejects.toThrow('AccessDenied');
  });
});

describe('licence signing configuration', () => {
  const ec = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const base = {
    NODE_ENV: 'test',
    DATABASE_URL: 'postgresql://control_app@localhost:5432/control',
    OPERATOR_AUTH_ISSUER: 'https://id.munaxa.test',
    OPERATOR_AUTH_AUDIENCE: 'munaxa-control',
    OPERATOR_AUTH_PUBLIC_KEYS: JSON.stringify([
      { kid: 'identity-1', publicKey: ec.publicKey.export({ type: 'spki', format: 'pem' }) },
    ]),
    OPERATOR_ORGANISATION_ID: 'org-munaxa',
    LICENCE_SIGNING_KID: 'licence-1',
  };
  const publicPem = ec.publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const privatePem = ec.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const load = (extra: Record<string, string>) =>
    loadEnvironment({ ...base, ...extra }, () => privatePem);

  it('keeps FILE as the default, which still needs the key file', () => {
    expect(() => load({})).toThrow('LICENCE_SIGNING_PRIVATE_KEY_FILE: required');
    const environment = load({ LICENCE_SIGNING_PRIVATE_KEY_FILE: '/secrets/licence.pem' });
    expect(environment.LICENCE_SIGNING_BACKEND).toBe('FILE');
    expect(environment.licencePrivateKey).toBe(privatePem);
  });

  it('accepts KMS with a key ARN and a P-256 public key, and holds no private key', () => {
    const environment = load({
      LICENCE_SIGNING_BACKEND: 'KMS',
      LICENCE_SIGNING_KMS_KEY_ID: KEY_ARN,
      LICENCE_SIGNING_PUBLIC_KEY: publicPem,
    });
    expect(environment.licencePrivateKey).toBeNull();
  });

  it('refuses KMS without its inputs, with a key file, with a private key or with RS256', () => {
    expect(() => load({ LICENCE_SIGNING_BACKEND: 'KMS' })).toThrow(
      /LICENCE_SIGNING_KMS_KEY_ID: required[\s\S]*LICENCE_SIGNING_PUBLIC_KEY: required/,
    );
    const kms = {
      LICENCE_SIGNING_BACKEND: 'KMS',
      LICENCE_SIGNING_KMS_KEY_ID: KEY_ARN,
      LICENCE_SIGNING_PUBLIC_KEY: publicPem,
    };
    expect(() =>
      load({ ...kms, LICENCE_SIGNING_PRIVATE_KEY_FILE: '/secrets/licence.pem' }),
    ).toThrow('must not be set when LICENCE_SIGNING_BACKEND=KMS');
    expect(() => load({ ...kms, LICENCE_SIGNING_PUBLIC_KEY: privatePem })).toThrow(
      'holds a private key',
    );
    expect(() => load({ ...kms, LICENCE_SIGNING_ALGORITHM: 'RS256' })).toThrow('ES256 only');
    expect(() => load({ ...kms, LICENCE_SIGNING_KMS_KEY_ID: 'alias/licence' })).toThrow(
      'must be a KMS key ARN',
    );
    const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
    expect(() =>
      load({
        ...kms,
        LICENCE_SIGNING_PUBLIC_KEY: rsa.publicKey
          .export({ type: 'spki', format: 'pem' })
          .toString(),
      }),
    ).toThrow('must be a P-256 public key');
  });
});
