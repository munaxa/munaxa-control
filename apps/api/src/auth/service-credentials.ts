import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

import { UUID } from '../core/ids';

/**
 * Service credentials: `mxc_<credential id>_<secret>`.
 *
 * The id makes lookup a primary-key read; the secret is 32 random bytes and only its SHA-256 is
 * stored. A plain digest is enough here, unlike a password: the secret is machine-generated and
 * high-entropy, so there is nothing for a slow hash to protect against.
 */
const PREFIX = 'mxc_';

export function mintServiceSecret(credentialId: string): { token: string; secretHash: string } {
  const secret = randomBytes(32).toString('base64url');
  return { token: `${PREFIX}${credentialId}_${secret}`, secretHash: hashSecret(secret) };
}

export function hashSecret(secret: string): string {
  return createHash('sha256').update(secret, 'utf8').digest('hex');
}

export function parseServiceToken(token: string): { credentialId: string; secret: string } | null {
  if (!token.startsWith(PREFIX)) return null;
  const rest = token.slice(PREFIX.length);
  const separator = rest.indexOf('_');
  if (separator !== 36) return null;
  const credentialId = rest.slice(0, 36);
  const secret = rest.slice(37);
  if (!UUID.test(credentialId) || secret.length < 32) return null;
  return { credentialId, secret };
}

export function secretMatches(secret: string, storedHash: string): boolean {
  const presented = Buffer.from(hashSecret(secret), 'hex');
  const stored = Buffer.from(storedHash, 'hex');
  return presented.length === stored.length && timingSafeEqual(presented, stored);
}
