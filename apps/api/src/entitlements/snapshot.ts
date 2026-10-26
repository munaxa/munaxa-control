import {
  parseEntitlementSnapshot,
  type DeploymentType,
  type EntitlementSnapshot,
  type SubscriptionStatus,
} from '@munaxa/licensing';
import type { Plan, PlanVersion, Subscription, TenantLink } from '@prisma/client';

export type SubscriptionWithTerms = Subscription & {
  tenant: TenantLink;
  planVersion: PlanVersion & { plan: Plan };
};

interface FeatureOverrides {
  add: string[];
  remove: string[];
}

export function featureOverridesOf(value: unknown): FeatureOverrides {
  const v = (value ?? {}) as Partial<Record<'add' | 'remove', unknown>>;
  const list = (x: unknown): string[] =>
    Array.isArray(x) ? x.filter((e): e is string => typeof e === 'string') : [];
  return { add: list(v.add), remove: list(v.remove) };
}

export function limitsOf(value: unknown): Record<string, number | null> {
  const out: Record<string, number | null> = {};
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return out;
  for (const [key, limit] of Object.entries(value as Record<string, unknown>)) {
    if (limit === null || (typeof limit === 'number' && Number.isSafeInteger(limit) && limit >= 0))
      out[key] = limit;
  }
  return out;
}

const iso = (date: Date | null): string | null => (date === null ? null : date.toISOString());

/**
 * The shared-contract snapshot for one subscription: plan version plus the subscription's own
 * overrides, resolved. What a product receives, and what a licence asserts.
 *
 * Re-validated through `parseEntitlementSnapshot` before it leaves: if the stored terms ever
 * failed the contract (a hand-edited row, a bad migration), this throws rather than serve a snapshot
 * a product would have to refuse.
 */
export function snapshotOf(
  subscription: SubscriptionWithTerms,
  customerId: string,
  now: Date,
): EntitlementSnapshot {
  const overrides = featureOverridesOf(subscription.featureOverrides);
  const features = new Set([...subscription.planVersion.features, ...overrides.add]);
  for (const removed of overrides.remove) features.delete(removed);

  const candidate = {
    schemaVersion: 1,
    customerId,
    tenantId: subscription.tenant.tenantRef,
    product: subscription.tenant.product,
    deployment: subscription.tenant.deploymentType as DeploymentType,
    subscriptionId: subscription.id,
    plan: { code: subscription.planVersion.plan.code, version: subscription.planVersion.version },
    status: subscription.status as SubscriptionStatus,
    trialEndsAt: iso(subscription.trialEndsAt),
    expiresAt: iso(subscription.expiresAt),
    graceUntil: iso(subscription.graceUntil),
    features: [...features].sort(),
    limits: {
      ...limitsOf(subscription.planVersion.limits),
      ...limitsOf(subscription.limitOverrides),
    },
    resolvedAt: now.toISOString(),
  };
  const parsed = parseEntitlementSnapshot(candidate);
  if (!parsed.ok)
    throw new Error(
      `Subscription ${subscription.id} does not satisfy the contract: ${parsed.error}`,
    );
  return parsed.snapshot;
}
