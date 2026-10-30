import { createPublicKey, verify, type JsonWebKey, type KeyObject } from 'node:crypto';

/**
 * Cloudflare Access in front of the operator console (munaxa-platform `infra/aws/cloudflare-access.md`).
 *
 * Access signs a JWT for every request it lets through and sends it in `Cf-Access-Jwt-Assertion`.
 * The portal forwards that header with each call it makes here, so an operator route can require
 * that the person passed Access as well as signing in to Munaxa Identity. A request that reached
 * the portal round Access (straight at the load balancer, or from inside the network) has no such
 * token and is refused. Access decides who may reach the console; it never replaces the Identity
 * token, the organisation check, the subject allow-list or the route's permissions.
 *
 * The token is RS256, signed by keys published at `<team domain>/cdn-cgi/access/certs`. It must
 * name the team domain as issuer and this Access application's AUD tag as audience, be inside its
 * validity, and identify a person (an email and a subject); a service token is not an operator.
 */
export const ACCESS_VERIFIER = Symbol('ACCESS_VERIFIER');
export const ACCESS_HEADER = 'cf-access-jwt-assertion';

export interface AccessIdentity {
  readonly email: string;
  readonly subject: string;
}

/** The token is missing or is not one this application accepts. */
export class AccessTokenError extends Error {
  override readonly name = 'AccessTokenError';
}

/** The signing keys could not be read, so no token can be checked. Fails closed. */
export class AccessKeysUnavailableError extends Error {
  override readonly name = 'AccessKeysUnavailableError';
}

/** Reads the published key set. Returns the parsed JSON body. */
export type FetchAccessKeys = (url: string) => Promise<unknown>;

export interface AccessVerifierOptions {
  /** `https://<team>.cloudflareaccess.com`, the token's issuer. */
  readonly teamDomain: string;
  /** The Access application's AUD tag. */
  readonly audience: string;
  readonly clockSkewMs: number;
  readonly now: () => number;
  readonly fetchKeys?: FetchAccessKeys;
}

/** How long a fetched key set is used before it is read again. Cloudflare rotates every six weeks. */
const KEYS_MAX_AGE_MS = 60 * 60_000;
/** An unknown `kid` or a failed read tries again, but not more often than this. */
const REFETCH_INTERVAL_MS = 60_000;
const MIN_RSA_BITS = 2048;
const BASE64URL = /^[A-Za-z0-9_-]+$/;

export const fetchAccessKeys: FetchAccessKeys = async (url) => {
  const response = await fetch(url, {
    headers: { accept: 'application/json' },
    redirect: 'error',
    signal: AbortSignal.timeout(3_000),
  });
  if (!response.ok) throw new Error(`answered ${String(response.status)}`);
  return response.json();
};

export class CloudflareAccessVerifier {
  private keys = new Map<string, KeyObject>();
  private fetchedAt = Number.NEGATIVE_INFINITY;
  private attemptedAt = Number.NEGATIVE_INFINITY;
  private pending: Promise<void> | null = null;
  private readonly certsUrl: string;
  private readonly fetchKeys: FetchAccessKeys;

  constructor(private readonly options: AccessVerifierOptions) {
    this.certsUrl = `${options.teamDomain}/cdn-cgi/access/certs`;
    this.fetchKeys = options.fetchKeys ?? fetchAccessKeys;
  }

  async verify(token: string | undefined): Promise<AccessIdentity> {
    if (token === undefined || token.trim() === '') {
      throw new AccessTokenError('no Cloudflare Access token');
    }
    const parts = token.split('.');
    if (parts.length !== 3 || !parts.every((part) => BASE64URL.test(part))) {
      throw new AccessTokenError('not a compact JWT');
    }
    const [encodedHeader, encodedPayload, encodedSignature] = parts as [string, string, string];
    const header = decodeJson(encodedHeader);
    if (header['alg'] !== 'RS256') throw new AccessTokenError('not RS256');
    const kid = header['kid'];
    if (typeof kid !== 'string' || kid === '') throw new AccessTokenError('no kid');

    const key = await this.keyFor(kid);
    const signed = verify(
      'RSA-SHA256',
      Buffer.from(`${encodedHeader}.${encodedPayload}`),
      key,
      Buffer.from(encodedSignature, 'base64url'),
    );
    if (!signed) throw new AccessTokenError('bad signature');

    return this.identityFrom(decodeJson(encodedPayload));
  }

  private identityFrom(claims: Record<string, unknown>): AccessIdentity {
    const { teamDomain, audience, clockSkewMs } = this.options;
    const now = this.options.now();
    if (claims['iss'] !== teamDomain) throw new AccessTokenError('wrong issuer');
    const aud = claims['aud'];
    const audiences = Array.isArray(aud) ? aud : [aud];
    if (!audiences.includes(audience)) throw new AccessTokenError('wrong audience');
    const exp = claims['exp'];
    if (typeof exp !== 'number' || now - clockSkewMs >= exp * 1_000) {
      throw new AccessTokenError('expired');
    }
    const nbf = claims['nbf'];
    if (nbf !== undefined && (typeof nbf !== 'number' || now + clockSkewMs < nbf * 1_000)) {
      throw new AccessTokenError('not yet valid');
    }
    const iat = claims['iat'];
    if (typeof iat !== 'number' || now + clockSkewMs < iat * 1_000) {
      throw new AccessTokenError('issued in the future');
    }
    if (claims['type'] !== undefined && claims['type'] !== 'app') {
      throw new AccessTokenError('not an application token');
    }
    const email = claims['email'];
    const subject = claims['sub'];
    if (
      typeof email !== 'string' ||
      email === '' ||
      typeof subject !== 'string' ||
      subject === ''
    ) {
      throw new AccessTokenError('names no person');
    }
    return { email, subject };
  }

  private async keyFor(kid: string): Promise<KeyObject> {
    const now = this.options.now();
    const mayTry = now - this.attemptedAt >= REFETCH_INTERVAL_MS;
    const stale = now - this.fetchedAt >= KEYS_MAX_AGE_MS;
    if (mayTry && (stale || !this.keys.has(kid))) {
      try {
        await this.refresh();
      } catch (error) {
        // Keys that were good an hour ago still verify; with none at all, nothing does.
        if (this.keys.size === 0) {
          throw new AccessKeysUnavailableError(
            `Cloudflare Access keys cannot be read: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
    }
    const key = this.keys.get(kid);
    if (key !== undefined) return key;
    if (this.keys.size === 0) throw new AccessKeysUnavailableError('no Cloudflare Access keys yet');
    throw new AccessTokenError('unknown kid');
  }

  private refresh(): Promise<void> {
    this.pending ??= (async () => {
      this.attemptedAt = this.options.now();
      try {
        const body = await this.fetchKeys(this.certsUrl);
        this.keys = parseKeySet(body);
        this.fetchedAt = this.options.now();
      } finally {
        this.pending = null;
      }
    })();
    return this.pending;
  }
}

function decodeJson(part: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
    if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value as Record<string, unknown>;
  } catch {
    throw new AccessTokenError('not JSON');
  }
}

/** The RSA signing keys of a JWKS, by `kid`. Anything else in it is ignored. */
export function parseKeySet(body: unknown): Map<string, KeyObject> {
  const keys = new Map<string, KeyObject>();
  const entries = (body as { keys?: unknown } | null)?.keys;
  if (!Array.isArray(entries)) throw new Error('not a JWKS');
  for (const entry of entries as Record<string, unknown>[]) {
    if (entry['kty'] !== 'RSA' || typeof entry['kid'] !== 'string') continue;
    if (entry['use'] !== undefined && entry['use'] !== 'sig') continue;
    if (entry['alg'] !== undefined && entry['alg'] !== 'RS256') continue;
    const key = createPublicKey({
      key: { kty: 'RSA', n: entry['n'], e: entry['e'] } as JsonWebKey,
      format: 'jwk',
    });
    if ((key.asymmetricKeyDetails?.modulusLength ?? 0) < MIN_RSA_BITS) continue;
    keys.set(entry['kid'], key);
  }
  if (keys.size === 0) throw new Error('holds no RS256 signing key');
  return keys;
}
