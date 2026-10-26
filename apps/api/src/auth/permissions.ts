/**
 * The control plane's permission catalogue, in Munaxa Identity's grant grammar (`control:` is this
 * service's namespace, as `work:` is Munaxa Work's — Work ADR-0076).
 *
 * Identity holds the roles that confer these; this file is the source of truth for what exists,
 * and `scripts/emit-permission-catalogue.mjs` writes it out for Identity to seed from. A grant this
 * catalogue does not declare confers nothing, and a wildcard is never honoured.
 */
export const ControlPermission = {
  CUSTOMERS_READ: 'control:customers:read',
  CUSTOMERS_WRITE: 'control:customers:write',
  CATALOGUE_READ: 'control:catalogue:read',
  /** Plans, plan versions and product deployments. */
  CATALOGUE_WRITE: 'control:catalogue:write',
  SUBSCRIPTIONS_READ: 'control:subscriptions:read',
  SUBSCRIPTIONS_WRITE: 'control:subscriptions:write',
  /** Issue, renew and revoke licences; register and reactivate installations. */
  LICENCES_ISSUE: 'control:licences:issue',
  /** Mint and revoke the credentials product deployments authenticate with. */
  CREDENTIALS_MANAGE: 'control:credentials:manage',
  USAGE_READ: 'control:usage:read',
  AUDIT_READ: 'control:audit:read',
} as const;
export type ControlPermission = (typeof ControlPermission)[keyof typeof ControlPermission];

export const CONTROL_PERMISSIONS: ReadonlySet<string> = new Set(Object.values(ControlPermission));

/** The declared grants among a token's `perms`. Anything else — a wildcard, another namespace — is dropped. */
export function controlGrantsFrom(perms: unknown): ReadonlySet<ControlPermission> {
  if (!Array.isArray(perms)) return new Set();
  const granted = new Set<ControlPermission>();
  for (const entry of perms) {
    if (typeof entry === 'string' && CONTROL_PERMISSIONS.has(entry))
      granted.add(entry as ControlPermission);
  }
  return granted;
}
