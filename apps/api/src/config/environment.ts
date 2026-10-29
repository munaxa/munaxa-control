import { createPublicKey } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { z } from 'zod';

/**
 * The validated environment. Read once, at the composition root; nothing else reads `process.env`.
 *
 * A misconfiguration stops the process at startup rather than surfacing at the first request:
 * a control plane that boots with no operator issuer answers 401 to everybody and looks healthy
 * while doing it.
 */
const booleanFromEnv = z
  .enum(['true', 'false'])
  .transform((value) => value === 'true')
  .or(z.boolean());

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  APP_VERSION: z.string().default('0.1.0'),
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().int().min(1).max(65_535).default(3100),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  LOG_PRETTY: booleanFromEnv.default(false),

  /** The runtime role, `control_app`. Never the schema owner. */
  DATABASE_URL: z.string().url(),

  /**
   * Munaxa Identity — the only issuer of operator tokens (ADR-0001 in the corporate repository).
   * This service verifies with the public key and could not mint a token it would accept.
   */
  OPERATOR_AUTH_ISSUER: z.string().url(),
  /** Comma-separated; a token must carry at least one. Identity's `IDENTITY_AUTH_AUDIENCE` must include it. */
  OPERATOR_AUTH_AUDIENCE: z.string().min(1).default('munaxa-control'),
  OPERATOR_AUTH_ALGORITHM: z.enum(['ES256', 'RS256']).default('ES256'),
  /** JSON `[{"kid","publicKey"}]`. Public keys only. */
  OPERATOR_AUTH_PUBLIC_KEYS: z.string().min(1),
  OPERATOR_AUTH_CLOCK_SKEW_MS: z.coerce.number().int().min(0).max(300_000).default(30_000),
  /**
   * The Identity organisation Munaxa Group's own staff sign in to. A token from any other
   * organisation is refused whatever it carries, so a customer's administrator can never reach
   * this plane by being granted a `control:` permission in their own organisation.
   */
  OPERATOR_ORGANISATION_ID: z.string().min(1),
  /**
   * Refuse operator tokens that did not satisfy MFA. Off by default only because Munaxa Identity
   * has not shipped MFA yet (its ADR-0003); production must turn it on the day it does.
   */
  OPERATOR_REQUIRE_MFA: booleanFromEnv.default(false),
  /**
   * The Identity subjects (user ids) allowed to operate this plane, comma-separated — ADR-0006.
   *
   * The interim restriction while Identity issues no `mfa` claim: a `control:` role granted by
   * mistake in Identity does not by itself open the control plane, because the person must also be
   * named here, in this deployment's own configuration. Required in production while
   * `OPERATOR_REQUIRE_MFA` is off; optional (and still enforced when set) once it is on.
   */
  OPERATOR_SUBJECT_ALLOWLIST: z.string().default(''),

  /**
   * Where the licence signing key lives. `FILE`: a mounted private key in this process (ADR-0003).
   * `KMS`: an AWS KMS key the process can ask to sign but never read (ADR-0008, proposed).
   */
  LICENCE_SIGNING_BACKEND: z.enum(['FILE', 'KMS']).default('FILE'),
  /** `FILE`: the licence signing key, as a file. Never an environment literal, never in an image. */
  LICENCE_SIGNING_PRIVATE_KEY_FILE: z.string().min(1).optional(),
  /** `KMS`: the key's ARN (`arn:aws:kms:<region>:<account>:key/<id>`); an ECC_NIST_P256 SIGN_VERIFY key. */
  LICENCE_SIGNING_KMS_KEY_ID: z
    .string()
    .regex(/^arn:aws:kms:[a-z0-9-]+:\d{12}:key\/[0-9a-f-]{36}$/, 'must be a KMS key ARN')
    .optional(),
  /** `KMS`: the key's public half, SPKI PEM. Checked against a KMS signature at startup. */
  LICENCE_SIGNING_PUBLIC_KEY: z.string().min(1).optional(),
  LICENCE_SIGNING_KID: z.string().min(1).max(64),
  LICENCE_SIGNING_ALGORITHM: z.enum(['ES256', 'RS256']).default('ES256'),
  /**
   * Earlier public keys still trusted by installations, as JSON `[{"kid","publicKey"}]`, so the
   * published key set keeps them during a rotation. Public keys only.
   */
  LICENCE_PREVIOUS_PUBLIC_KEYS: z.string().default('[]'),
  /** The longest term a single licence may cover; renewal issues the next one. */
  LICENCE_MAX_TERM_DAYS: z.coerce.number().int().min(1).max(1_100).default(400),

  /** How long a product may reuse an entitlement answer (`Cache-Control: max-age`). */
  ENTITLEMENT_CACHE_SECONDS: z.coerce.number().int().min(0).max(300).default(30),
  /** How long an `Idempotency-Key` answer is replayed. */
  IDEMPOTENCY_RETENTION_HOURS: z.coerce.number().int().min(1).max(720).default(48),

  /** Requests per client address per minute, across every route but the probes (ADR-0007). */
  RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(1).max(100_000).default(600),
  /** Requests per product service credential per minute: one deployment's whole fleet of tenants. */
  SERVICE_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(1).max(1_000_000).default(6_000),
  /** Refused credentials per client address per minute before that address is refused outright. */
  AUTH_FAILURE_LIMIT_PER_MINUTE: z.coerce.number().int().min(1).max(10_000).default(20),
  /**
   * Proxies in front of this process whose `X-Forwarded-For` is trusted, nearest first: `1` behind
   * one load balancer. `0` trusts none, and is the default, so a client cannot choose its own
   * address by writing the header.
   */
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(10).default(0),
});

export type RawEnvironment = z.infer<typeof schema>;

export interface PublicKey {
  readonly kid: string;
  readonly publicKey: string;
}

export interface Environment extends RawEnvironment {
  readonly operatorAudience: readonly string[];
  readonly operatorPublicKeys: readonly PublicKey[];
  /** `OPERATOR_SUBJECT_ALLOWLIST`, parsed. Empty means no allow-list is configured. */
  readonly operatorSubjects: ReadonlySet<string>;
  /** The `FILE` backend's private key; null with `KMS`, whose key never enters this process. */
  readonly licencePrivateKey: string | null;
  readonly licencePreviousPublicKeys: readonly PublicKey[];
}

export class ConfigurationError extends Error {
  constructor(readonly issues: readonly string[]) {
    super(`Invalid configuration:\n  - ${issues.join('\n  - ')}`);
    this.name = 'ConfigurationError';
  }
}

function parsePublicKeys(name: string, raw: string, issues: string[]): PublicKey[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    issues.push(`${name}: is not JSON.`);
    return [];
  }
  if (!Array.isArray(parsed)) {
    issues.push(`${name}: must be a JSON array of {kid, publicKey}.`);
    return [];
  }
  const keys: PublicKey[] = [];
  const kids = new Set<string>();
  for (const entry of parsed as unknown[]) {
    const e = entry as Record<string, unknown>;
    if (typeof e['kid'] !== 'string' || typeof e['publicKey'] !== 'string') {
      issues.push(`${name}: every key needs a string kid and publicKey.`);
      continue;
    }
    if (/PRIVATE KEY/.test(e['publicKey'])) {
      issues.push(`${name}: holds a private key. Only public keys belong here.`);
      continue;
    }
    if (kids.has(e['kid'])) issues.push(`${name}: duplicate kid ${e['kid']}.`);
    kids.add(e['kid']);
    keys.push({ kid: e['kid'], publicKey: e['publicKey'] });
  }
  return keys;
}

/**
 * Validates an environment. `readFile` is a parameter so tests can supply the key file without a
 * file system; production reads the mounted secret.
 */
export function loadEnvironment(
  source: Record<string, string | undefined>,
  readFile: (path: string) => string = (path) => readFileSync(path, 'utf8'),
): Environment {
  const result = schema.safeParse(source);
  if (!result.success) {
    throw new ConfigurationError(
      result.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`),
    );
  }
  const raw = result.data;
  const issues: string[] = [];

  const operatorPublicKeys = parsePublicKeys(
    'OPERATOR_AUTH_PUBLIC_KEYS',
    raw.OPERATOR_AUTH_PUBLIC_KEYS,
    issues,
  );
  if (
    operatorPublicKeys.length === 0 &&
    !issues.some((i) => i.startsWith('OPERATOR_AUTH_PUBLIC_KEYS'))
  ) {
    issues.push('OPERATOR_AUTH_PUBLIC_KEYS: must hold at least one key.');
  }
  const licencePreviousPublicKeys = parsePublicKeys(
    'LICENCE_PREVIOUS_PUBLIC_KEYS',
    raw.LICENCE_PREVIOUS_PUBLIC_KEYS,
    issues,
  );
  if (licencePreviousPublicKeys.some((key) => key.kid === raw.LICENCE_SIGNING_KID)) {
    issues.push('LICENCE_PREVIOUS_PUBLIC_KEYS: must not repeat LICENCE_SIGNING_KID.');
  }

  const operatorAudience = raw.OPERATOR_AUTH_AUDIENCE.split(',')
    .map((a) => a.trim())
    .filter((a) => a.length > 0);
  if (operatorAudience.length === 0) issues.push('OPERATOR_AUTH_AUDIENCE: must name an audience.');

  if (raw.NODE_ENV === 'production' && !raw.OPERATOR_AUTH_ISSUER.startsWith('https://')) {
    issues.push('OPERATOR_AUTH_ISSUER: must be https in production.');
  }

  const operatorSubjects = raw.OPERATOR_SUBJECT_ALLOWLIST.split(',')
    .map((subject) => subject.trim())
    .filter((subject) => subject.length > 0);
  if (raw.NODE_ENV === 'production' && !raw.OPERATOR_REQUIRE_MFA && operatorSubjects.length === 0) {
    issues.push(
      'OPERATOR_SUBJECT_ALLOWLIST: required in production until OPERATOR_REQUIRE_MFA is on (ADR-0006).',
    );
  }

  let licencePrivateKey: string | null = null;
  if (raw.LICENCE_SIGNING_BACKEND === 'FILE') {
    if (raw.LICENCE_SIGNING_PRIVATE_KEY_FILE === undefined) {
      issues.push('LICENCE_SIGNING_PRIVATE_KEY_FILE: required when LICENCE_SIGNING_BACKEND=FILE.');
    } else {
      try {
        licencePrivateKey = readFile(raw.LICENCE_SIGNING_PRIVATE_KEY_FILE);
        if (!/-----BEGIN (EC |RSA )?PRIVATE KEY-----/.test(licencePrivateKey)) {
          issues.push('LICENCE_SIGNING_PRIVATE_KEY_FILE: is not a PEM private key.');
        }
      } catch {
        issues.push('LICENCE_SIGNING_PRIVATE_KEY_FILE: cannot be read.');
      }
    }
  } else {
    // KMS: the private half never reaches this process, so there must be no file to fall back to.
    if (raw.LICENCE_SIGNING_PRIVATE_KEY_FILE !== undefined) {
      issues.push(
        'LICENCE_SIGNING_PRIVATE_KEY_FILE: must not be set when LICENCE_SIGNING_BACKEND=KMS.',
      );
    }
    if (raw.LICENCE_SIGNING_KMS_KEY_ID === undefined) {
      issues.push('LICENCE_SIGNING_KMS_KEY_ID: required when LICENCE_SIGNING_BACKEND=KMS.');
    }
    if (raw.LICENCE_SIGNING_ALGORITHM !== 'ES256') {
      issues.push('LICENCE_SIGNING_ALGORITHM: KMS signing supports ES256 only.');
    }
    const publicKey = raw.LICENCE_SIGNING_PUBLIC_KEY;
    if (publicKey === undefined) {
      issues.push('LICENCE_SIGNING_PUBLIC_KEY: required when LICENCE_SIGNING_BACKEND=KMS.');
    } else if (/PRIVATE KEY/.test(publicKey)) {
      issues.push(
        'LICENCE_SIGNING_PUBLIC_KEY: holds a private key. Only the public half belongs here.',
      );
    } else {
      try {
        const key = createPublicKey(publicKey);
        if (
          key.asymmetricKeyType !== 'ec' ||
          key.asymmetricKeyDetails?.namedCurve !== 'prime256v1'
        ) {
          issues.push('LICENCE_SIGNING_PUBLIC_KEY: must be a P-256 public key.');
        }
      } catch {
        issues.push('LICENCE_SIGNING_PUBLIC_KEY: is not a PEM public key.');
      }
    }
  }

  if (issues.length > 0) throw new ConfigurationError(issues);
  return Object.freeze({
    ...raw,
    operatorAudience,
    operatorPublicKeys,
    /** Empty means no list: every subject of the operator organisation, as far as this check goes. */
    operatorSubjects: new Set(operatorSubjects),
    licencePrivateKey,
    licencePreviousPublicKeys,
  });
}

export const ENVIRONMENT = Symbol('Environment');
