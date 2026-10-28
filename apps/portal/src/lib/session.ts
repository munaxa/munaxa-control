import 'server-only';

import { cookies } from 'next/headers';

/**
 * Munaxa Identity's session cookie. Host-only and `httpOnly`, set by Identity on this same origin
 * (Identity ADR-0004: one origin, separate services). The portal reads it server-side and forwards
 * it as a bearer token; it never reaches browser script and is never stored here.
 */
export const SESSION_COOKIE = '__Host-mx_session';

export async function accessToken(): Promise<string | undefined> {
  const value = (await cookies()).get(SESSION_COOKIE)?.value;
  return value === undefined || value.trim() === '' ? undefined : value;
}

export interface Operator {
  readonly subject: string;
  readonly permissions: ReadonlySet<string>;
}

/**
 * Who is signed in and what they hold — **for drawing the screen only**.
 *
 * The token is decoded, not verified: the API verifies every request and refuses what this would
 * have shown. Hiding a button is a courtesy; the server is the authority (the engineering
 * standards' §9). A token that does not decode reads as no operator.
 */
export function operatorFrom(token: string): Operator | null {
  const payload = token.split('.')[1];
  if (payload === undefined) return null;
  try {
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {
      sub?: unknown;
      perms?: unknown;
    };
    if (typeof claims.sub !== 'string') return null;
    const perms = Array.isArray(claims.perms)
      ? claims.perms.filter((p): p is string => typeof p === 'string')
      : [];
    return { subject: claims.sub, permissions: new Set(perms) };
  } catch {
    return null;
  }
}

export const signInPath = (returnTo: string): string =>
  `/api/auth/login?returnTo=${encodeURIComponent(returnTo)}`;
