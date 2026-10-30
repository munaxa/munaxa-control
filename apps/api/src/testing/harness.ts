import { generateKeyPairSync, sign } from 'node:crypto';

import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { TokenService } from '@munaxa/auth';
import { AsymmetricSigner } from '@munaxa/crypto';
import { PrismaClient } from '@prisma/client';
import request from 'supertest';

import { AppModule } from '../app.module';
import { loadEnvironment, type Environment } from '../config/environment';
import type { Clock } from '../core/clock';
import { ControlPermission } from '../auth/permissions';
import { configureApplication } from '../setup';

/**
 * The real application, against a real PostgreSQL database, with keys minted for the run.
 *
 * `TEST_DATABASE_URL` is the runtime role (`control_app`), so every suite exercises the grants
 * production runs under; `TEST_DATABASE_MIGRATION_URL` is the owner, used only to reset tables.
 */
export const ISSUER = 'https://identity.test/api/auth';
/** Cloudflare Access, when a suite turns it on with `accessEnvironment`. */
export const ACCESS_TEAM_DOMAIN = 'https://munaxa-test.cloudflareaccess.com';
export const ACCESS_AUDIENCE = 'a'.repeat(64);
export const accessEnvironment = {
  OPERATOR_ACCESS_TEAM_DOMAIN: ACCESS_TEAM_DOMAIN,
  OPERATOR_ACCESS_AUDIENCE: ACCESS_AUDIENCE,
};
export const ORGANISATION = 'munaxa-group';
export const ALL_PERMISSIONS = Object.values(ControlPermission);

function pem(kind: 'ec') {
  const { privateKey, publicKey } = generateKeyPairSync(kind, { namedCurve: 'P-256' });
  return {
    privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    publicKey: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
  };
}

export class MovableClock implements Clock {
  constructor(private current = new Date('2026-11-01T09:00:00.000Z')) {}
  now(): Date {
    return new Date(this.current);
  }
  set(at: Date): void {
    this.current = new Date(at);
  }
  advanceDays(days: number): void {
    this.current = new Date(this.current.getTime() + days * 86_400_000);
  }
}

export interface Harness {
  readonly app: INestApplication;
  readonly http: ReturnType<typeof request>;
  readonly clock: MovableClock;
  readonly environment: Environment;
  readonly owner: PrismaClient;
  /** An Identity access token for a Munaxa Group operator holding `permissions`. */
  token(
    permissions?: readonly string[],
    overrides?: { tid?: string; subject?: string; session?: boolean; mfa?: boolean },
  ): string;
  /** A token signed by a key Identity does not hold. */
  forgedToken(): string;
  /** A Cloudflare Access token for this application; `claims` replace the defaults. */
  accessToken(claims?: Record<string, unknown>, options?: { forged?: boolean }): string;
  reset(): Promise<void>;
  close(): Promise<void>;
}

export async function startHarness(
  overrides: Readonly<Record<string, string>> = {},
): Promise<Harness> {
  const url = process.env['TEST_DATABASE_URL'];
  const ownerUrl = process.env['TEST_DATABASE_MIGRATION_URL'];
  if (url === undefined || ownerUrl === undefined) {
    throw new Error(
      'TEST_DATABASE_URL and TEST_DATABASE_MIGRATION_URL must name the control-plane test database.',
    );
  }
  const identity = pem('ec');
  const impostor = pem('ec');
  const licence = pem('ec');
  const environment = loadEnvironment(
    {
      NODE_ENV: 'test',
      LOG_LEVEL: 'fatal',
      DATABASE_URL: url,
      OPERATOR_AUTH_ISSUER: ISSUER,
      OPERATOR_AUTH_AUDIENCE: 'munaxa-control',
      OPERATOR_AUTH_PUBLIC_KEYS: JSON.stringify([
        { kid: 'identity-1', publicKey: identity.publicKey },
      ]),
      OPERATOR_ORGANISATION_ID: ORGANISATION,
      LICENCE_SIGNING_PRIVATE_KEY_FILE: '/secrets/licence.pem',
      LICENCE_SIGNING_KID: 'licence-test-1',
      ...overrides,
    },
    () => licence.privateKey,
  );
  const clock = new MovableClock();
  const issuer = (pair: { privateKey: string; publicKey: string }) =>
    new TokenService({
      signer: new AsymmetricSigner('ES256', [{ kid: 'identity-1', ...pair }]),
      issuer: ISSUER,
      audience: ['munaxa-control'],
      clock: { now: () => clock.now().getTime() },
    });
  const tokens = issuer(identity);
  const forged = issuer(impostor);

  // Cloudflare's side: an RSA key published as a JWKS, and one Cloudflare does not publish.
  const accessKey = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const strangerKey = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwks = {
    keys: [
      {
        ...accessKey.publicKey.export({ format: 'jwk' }),
        kid: 'access-1',
        alg: 'RS256',
        use: 'sig',
      },
    ],
  };
  const accessKeys = (url: string) =>
    url === `${ACCESS_TEAM_DOMAIN}/cdn-cgi/access/certs`
      ? Promise.resolve(jwks)
      : Promise.reject(new Error(`unexpected ${url}`));
  const accessToken = (
    claims: Record<string, unknown> = {},
    options: { forged?: boolean } = {},
  ) => {
    const now = Math.floor(clock.now().getTime() / 1_000);
    const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
    const body = `${part({ alg: 'RS256', kid: 'access-1', typ: 'JWT' })}.${part({
      iss: ACCESS_TEAM_DOMAIN,
      aud: [ACCESS_AUDIENCE],
      email: 'operator@munaxa.test',
      sub: 'access-user-1',
      type: 'app',
      iat: now,
      nbf: now,
      exp: now + 3_600,
      ...claims,
    })}`;
    const key = options.forged === true ? strangerKey.privateKey : accessKey.privateKey;
    return `${body}.${sign('RSA-SHA256', Buffer.from(body), key).toString('base64url')}`;
  };

  const module = await Test.createTestingModule({
    imports: [AppModule.with(environment, clock, undefined, accessKeys)],
  }).compile();
  const app = module.createNestApplication({ logger: false });
  configureApplication(app, environment);
  await app.init();
  const owner = new PrismaClient({ datasources: { db: { url: ownerUrl } } });

  const mint = (
    service: TokenService,
    permissions: readonly string[],
    overrides: { tid?: string; subject?: string; session?: boolean; mfa?: boolean } = {},
  ) =>
    service.issueAccessToken({
      subject: overrides.subject ?? 'operator-1',
      tenantId: (overrides.tid ?? ORGANISATION) as never,
      tokenVersion: 1,
      permissions: [...permissions],
      ...(overrides.session !== false && { sessionId: 'session-1' as never }),
      ...(overrides.mfa !== undefined && { mfaSatisfied: overrides.mfa }),
    }).token;

  return {
    app,
    http: request(app.getHttpServer()),
    clock,
    environment,
    owner,
    token: (permissions = ALL_PERMISSIONS, overrides) => mint(tokens, permissions, overrides),
    forgedToken: () => mint(forged, ALL_PERMISSIONS),
    accessToken,
    reset: async () => {
      await owner.$executeRawUnsafe(
        'TRUNCATE audit_event, usage_report, licence, installation, subscription_event, subscription, plan_version, plan, tenant_link, service_credential, product_deployment, customer, idempotency_record RESTART IDENTITY CASCADE',
      );
      clock.set(new Date('2026-11-01T09:00:00.000Z'));
    },
    close: async () => {
      await owner.$disconnect();
      await app.close();
    },
  };
}
