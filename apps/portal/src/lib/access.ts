/**
 * Cloudflare Access in front of the operator console (munaxa-platform `infra/aws/cloudflare-access.md`).
 *
 * Access signs a JWT for every request it lets through, in `Cf-Access-Jwt-Assertion`. The
 * middleware refuses any request without a valid one, so a request sent straight to the load
 * balancer, round Access, gets no page, no script and no server action. The portal forwards the
 * header with each API call, and the API checks it again (its `auth/cloudflare-access.ts`).
 *
 * Web Crypto only: the middleware runs in the Edge runtime. RS256, the team domain as issuer, this
 * application's AUD tag as audience, inside its validity, naming a person.
 */
export const ACCESS_HEADER = 'cf-access-jwt-assertion';

export interface AccessConfig {
  readonly teamDomain: string;
  readonly audience: string;
}

export type AccessOutcome =
  | { readonly ok: true; readonly email: string }
  | { readonly ok: false; readonly status: 401 | 503; readonly reason: string };

/** Reads the published key set; returns the parsed JSON body. */
export type FetchAccessKeys = (url: string) => Promise<unknown>;

const TEAM_DOMAIN = /^https:\/\/[a-z0-9][a-z0-9-]*\.cloudflareaccess\.com$/;
const AUD_TAG = /^[A-Za-z0-9]{32,128}$/;
const BASE64URL = /^[A-Za-z0-9_-]+$/;
const CLOCK_SKEW_MS = 30_000;
const KEYS_MAX_AGE_MS = 60 * 60_000;
const REFETCH_INTERVAL_MS = 60_000;

/**
 * The configuration, `null` when Access is off (only outside production), or an error string when
 * it is incomplete or invalid, which the middleware answers with 503: production never runs open.
 */
export function accessConfigFrom(
  env: Readonly<Record<string, string | undefined>>,
): AccessConfig | null | string {
  const teamDomain = env['OPERATOR_ACCESS_TEAM_DOMAIN']?.trim() || undefined;
  const audience = env['OPERATOR_ACCESS_AUDIENCE']?.trim() || undefined;
  if (teamDomain === undefined && audience === undefined) {
    return env['NODE_ENV'] === 'production' ? 'Cloudflare Access is not configured.' : null;
  }
  if (teamDomain === undefined || audience === undefined) {
    return 'OPERATOR_ACCESS_TEAM_DOMAIN and OPERATOR_ACCESS_AUDIENCE: set both or neither.';
  }
  if (!TEAM_DOMAIN.test(teamDomain)) return 'OPERATOR_ACCESS_TEAM_DOMAIN is not a team domain.';
  if (!AUD_TAG.test(audience)) return 'OPERATOR_ACCESS_AUDIENCE is not an AUD tag.';
  return { teamDomain, audience };
}

const defaultFetchKeys: FetchAccessKeys = async (url) => {
  const response = await fetch(url, {
    headers: { accept: 'application/json' },
    redirect: 'error',
    signal: AbortSignal.timeout(3_000),
    cache: 'no-store',
  });
  if (!response.ok) throw new Error(`answered ${String(response.status)}`);
  return response.json();
};

const refuse = (reason: string): AccessOutcome => ({ ok: false, status: 401, reason });

export class AccessVerifier {
  private keys = new Map<string, CryptoKey>();
  private fetchedAt = Number.NEGATIVE_INFINITY;
  private attemptedAt = Number.NEGATIVE_INFINITY;
  private pending: Promise<void> | null = null;

  constructor(
    private readonly config: AccessConfig,
    private readonly fetchKeys: FetchAccessKeys = defaultFetchKeys,
    private readonly now: () => number = Date.now,
  ) {}

  async verify(token: string | null | undefined): Promise<AccessOutcome> {
    if (token == null || token.trim() === '') return refuse('no Cloudflare Access token');
    const parts = token.split('.');
    if (parts.length !== 3 || !parts.every((part) => BASE64URL.test(part))) {
      return refuse('not a compact JWT');
    }
    const [encodedHeader, encodedPayload, encodedSignature] = parts as [string, string, string];
    const header = decodeJson(encodedHeader);
    const claims = decodeJson(encodedPayload);
    if (header === null || claims === null) return refuse('not JSON');
    if (header['alg'] !== 'RS256') return refuse('not RS256');
    const kid = header['kid'];
    if (typeof kid !== 'string' || kid === '') return refuse('no kid');

    const key = await this.keyFor(kid);
    if (key === 'unavailable') {
      return { ok: false, status: 503, reason: 'Cloudflare Access keys cannot be read' };
    }
    if (key === undefined) return refuse('unknown kid');
    const signed = await crypto.subtle.verify(
      'RSASSA-PKCS1-v1_5',
      key,
      bytes(encodedSignature),
      new TextEncoder().encode(`${encodedHeader}.${encodedPayload}`),
    );
    if (!signed) return refuse('bad signature');
    return this.checkClaims(claims);
  }

  private checkClaims(claims: Record<string, unknown>): AccessOutcome {
    const now = this.now();
    if (claims['iss'] !== this.config.teamDomain) return refuse('wrong issuer');
    const aud = claims['aud'];
    if (!(Array.isArray(aud) ? aud : [aud]).includes(this.config.audience)) {
      return refuse('wrong audience');
    }
    const { exp, nbf, iat } = claims;
    if (typeof exp !== 'number' || now - CLOCK_SKEW_MS >= exp * 1_000) return refuse('expired');
    if (nbf !== undefined && (typeof nbf !== 'number' || now + CLOCK_SKEW_MS < nbf * 1_000)) {
      return refuse('not yet valid');
    }
    if (typeof iat !== 'number' || now + CLOCK_SKEW_MS < iat * 1_000) {
      return refuse('issued in the future');
    }
    if (claims['type'] !== undefined && claims['type'] !== 'app') {
      return refuse('not an application token');
    }
    const { email, sub } = claims;
    if (typeof email !== 'string' || email === '' || typeof sub !== 'string' || sub === '') {
      return refuse('names no person');
    }
    return { ok: true, email };
  }

  private async keyFor(kid: string): Promise<CryptoKey | undefined | 'unavailable'> {
    const now = this.now();
    const mayTry = now - this.attemptedAt >= REFETCH_INTERVAL_MS;
    if (mayTry && (now - this.fetchedAt >= KEYS_MAX_AGE_MS || !this.keys.has(kid))) {
      try {
        await this.refresh();
      } catch {
        // Keys that verified within the hour still do; with none at all, nothing does.
      }
    }
    if (this.keys.size === 0) return 'unavailable';
    return this.keys.get(kid);
  }

  private refresh(): Promise<void> {
    this.pending ??= (async () => {
      this.attemptedAt = this.now();
      try {
        this.keys = await importKeySet(
          await this.fetchKeys(`${this.config.teamDomain}/cdn-cgi/access/certs`),
        );
        this.fetchedAt = this.now();
      } finally {
        this.pending = null;
      }
    })();
    return this.pending;
  }
}

/** The RS256 signing keys of a JWKS, by `kid`, of at least 2048 bits. Anything else is ignored. */
export async function importKeySet(body: unknown): Promise<Map<string, CryptoKey>> {
  const entries = (body as { keys?: unknown } | null)?.keys;
  if (!Array.isArray(entries)) throw new Error('not a JWKS');
  const keys = new Map<string, CryptoKey>();
  for (const entry of entries as Record<string, unknown>[]) {
    if (entry['kty'] !== 'RSA' || typeof entry['kid'] !== 'string') continue;
    if (entry['use'] !== undefined && entry['use'] !== 'sig') continue;
    if (entry['alg'] !== undefined && entry['alg'] !== 'RS256') continue;
    if (typeof entry['n'] !== 'string' || typeof entry['e'] !== 'string') continue;
    if (bytes(entry['n']).length * 8 < 2048) continue;
    try {
      keys.set(
        entry['kid'],
        await crypto.subtle.importKey(
          'jwk',
          { kty: 'RSA', n: entry['n'], e: entry['e'], alg: 'RS256', ext: true },
          { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
          false,
          ['verify'],
        ),
      );
    } catch {
      // A key that does not import is not one to trust.
    }
  }
  if (keys.size === 0) throw new Error('holds no RS256 signing key');
  return keys;
}

function bytes(base64url: string): Uint8Array<ArrayBuffer> {
  const base64 = base64url.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(base64 + '='.repeat((4 - (base64.length % 4)) % 4));
  const out = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

function decodeJson(part: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(new TextDecoder().decode(bytes(part)));
    return value !== null && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}
