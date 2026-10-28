/** The API's response shapes the portal reads. The API is the contract; these only name it. */
export interface Customer {
  id: string;
  name: string;
  legalName: string | null;
  country: string | null;
  contactEmail: string | null;
  status: 'ACTIVE' | 'CLOSED';
  version: number;
  createdAt: string;
  _count?: { tenants: number };
}

export interface Deployment {
  id: string;
  product: string;
  name: string;
  createdAt: string;
  credentials: {
    id: string;
    label: string;
    createdAt: string;
    lastUsedAt: string | null;
    revokedAt: string | null;
  }[];
  _count: { tenants: number };
}

export interface PlanVersion {
  id: string;
  planId: string;
  version: number;
  state: 'DRAFT' | 'PUBLISHED' | 'RETIRED';
  features: string[];
  limits: Record<string, number | null>;
  priceMinor: number | null;
  currency: string | null;
  billingPeriod: 'MONTHLY' | 'YEARLY' | null;
  trialDays: number;
  graceDays: number;
  publishedAt: string | null;
  _count?: { subscriptions: number };
}

export interface Plan {
  id: string;
  product: string;
  code: string;
  name: string;
  description: string | null;
  versions: PlanVersion[];
}

export interface Installation {
  id: string;
  installationRef: string;
  status: 'ACTIVE' | 'REPLACED';
  registeredAt: string;
  replacedAt: string | null;
}

export interface SubscriptionSummary {
  id: string;
  status: string;
  version: number;
  startsAt: string;
  trialEndsAt: string | null;
  expiresAt: string | null;
  graceUntil: string | null;
  cancelledAt: string | null;
  planVersion: PlanVersion & { plan: Plan };
  tenant?: Tenant & { customer: Customer };
}

export interface Tenant {
  id: string;
  customerId: string;
  product: string;
  tenantRef: string;
  deploymentType: 'SAAS' | 'ON_PREMISES';
  deploymentId: string | null;
  displayName: string;
  deployment?: { id: string; name: string } | null;
}

export interface CustomerDetail extends Customer {
  tenants: (Tenant & { subscriptions: SubscriptionSummary[]; installations: Installation[] })[];
}

export interface SubscriptionDetail extends SubscriptionSummary {
  suspendedFrom: string | null;
  effectiveStatus: string;
  allowedEvents: string[];
  tenant: Tenant & { customer: Customer; deployment: { id: string; name: string } | null };
  events: {
    id: number;
    event: string;
    fromStatus: string | null;
    toStatus: string;
    reason: string | null;
    actor: string;
    createdAt: string;
  }[];
  licences: {
    id: string;
    kid: string;
    issuedAt: string;
    expiresAt: string | null;
    supersedesId: string | null;
    revokedAt: string | null;
    installation: Installation | null;
  }[];
  entitlements: { features: string[]; limits: Record<string, number | null> };
}

export interface AuditEvent {
  id: number;
  at: string;
  actorKind: string;
  actor: string;
  action: string;
  product: string | null;
  customerId: string | null;
  subscriptionId: string | null;
  payload: Record<string, unknown>;
}

export interface Dashboard {
  activeCustomers: number;
  subscriptionsByStatus: Record<string, number>;
  tenantsByProduct: Record<string, number>;
  expiringWithin30Days: number;
  licencesExpiringWithin30Days: number;
}
