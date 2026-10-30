import { generateKeyPairSync } from 'node:crypto';

import { ConfigurationError, loadEnvironment } from './environment';

const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const PRIVATE = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const PUBLIC = publicKey.export({ type: 'spki', format: 'pem' }).toString();

const base = {
  DATABASE_URL: 'postgresql://control_app@localhost:5432/control',
  OPERATOR_AUTH_ISSUER: 'https://munaxa.example/api/auth',
  OPERATOR_AUTH_PUBLIC_KEYS: JSON.stringify([{ kid: 'identity-1', publicKey: PUBLIC }]),
  OPERATOR_ORGANISATION_ID: 'munaxa-group',
  LICENCE_SIGNING_PRIVATE_KEY_FILE: '/run/secrets/licence.pem',
  LICENCE_SIGNING_KID: 'licence-2026-1',
};
const reads = () => PRIVATE;

describe('loadEnvironment', () => {
  it('accepts production with an operator allow-list, or with MFA required', () => {
    const production = { ...base, NODE_ENV: 'production', LICENCE_SIGNING_BACKEND: 'FILE' };
    expect(
      loadEnvironment({ ...production, OPERATOR_SUBJECT_ALLOWLIST: ' a , b ' }, reads)
        .operatorSubjects,
    ).toEqual(new Set(['a', 'b']));
    expect(
      loadEnvironment({ ...production, OPERATOR_REQUIRE_MFA: 'true' }, reads).operatorSubjects.size,
    ).toBe(0);
  });

  it('loads a complete configuration with safe defaults', () => {
    const environment = loadEnvironment(base, reads);
    expect(environment).toMatchObject({
      operatorAudience: ['munaxa-control'],
      OPERATOR_REQUIRE_MFA: false,
      LICENCE_MAX_TERM_DAYS: 400,
      ENTITLEMENT_CACHE_SECONDS: 30,
    });
  });

  it.each([
    [
      'a private key among the operator keys',
      { OPERATOR_AUTH_PUBLIC_KEYS: JSON.stringify([{ kid: 'k', publicKey: PRIVATE }]) },
    ],
    ['no operator key', { OPERATOR_AUTH_PUBLIC_KEYS: '[]' }],
    [
      'duplicate kids',
      {
        OPERATOR_AUTH_PUBLIC_KEYS: JSON.stringify([
          { kid: 'k', publicKey: PUBLIC },
          { kid: 'k', publicKey: PUBLIC },
        ]),
      },
    ],
    [
      'a previous licence key repeating the current kid',
      {
        LICENCE_PREVIOUS_PUBLIC_KEYS: JSON.stringify([
          { kid: 'licence-2026-1', publicKey: PUBLIC },
        ]),
      },
    ],
    [
      'production without MFA and without an operator allow-list',
      { NODE_ENV: 'production', LICENCE_SIGNING_BACKEND: 'FILE' },
    ],
    [
      'production without an explicit signing backend',
      { NODE_ENV: 'production', OPERATOR_SUBJECT_ALLOWLIST: 'operator-1' },
    ],
    [
      'a plain-http issuer in production',
      {
        NODE_ENV: 'production',
        LICENCE_SIGNING_BACKEND: 'FILE',
        OPERATOR_AUTH_ISSUER: 'http://munaxa.example/api/auth',
        OPERATOR_SUBJECT_ALLOWLIST: 'operator-1',
      },
    ],
  ])('refuses %s', (_label, patch) => {
    expect(() => loadEnvironment({ ...base, ...patch }, reads)).toThrow(ConfigurationError);
  });

  it('refuses a signing key that cannot be read or is not a private key', () => {
    expect(() =>
      loadEnvironment(base, () => {
        throw new Error('ENOENT');
      }),
    ).toThrow(/cannot be read/);
    expect(() => loadEnvironment(base, () => PUBLIC)).toThrow(/not a PEM private key/);
  });

  it('refuses a missing issuer or organisation', () => {
    const { OPERATOR_ORGANISATION_ID: _o, ...withoutOrganisation } = base;
    expect(() => loadEnvironment(withoutOrganisation, reads)).toThrow(ConfigurationError);
  });
});
