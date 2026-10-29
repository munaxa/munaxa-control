import { Inject, Injectable } from '@nestjs/common';
import { LicensingAuditAction } from '@munaxa/licensing';
import type { Prisma } from '@prisma/client';

import { actorOf, type Principal } from '../auth/principal';
import { PrismaService, type Transaction } from '../core/prisma.service';

/**
 * The control plane's own actions, beside the ecosystem-wide licensing vocabulary. The licensing
 * names are reused verbatim so a question asked of this trail and of a product's has one spelling.
 */
export const AuditAction = {
  ...LicensingAuditAction,
  DEPLOYMENT_CREATED: 'control.deployment.created',
  CREDENTIAL_ISSUED: 'control.credential.issued',
  CREDENTIAL_REVOKED: 'control.credential.revoked',
  PLAN_CREATED: 'control.plan.created',
  PLAN_VERSION_DRAFTED: 'control.plan_version.drafted',
  ENTITLEMENT_SERVED: 'control.entitlement.served',
  REVOCATION_LIST_ISSUED: 'control.revocation_list.issued',
} as const;
export type AuditAction = (typeof AuditAction)[keyof typeof AuditAction];

export interface AuditEntry {
  readonly action: AuditAction;
  readonly customerId?: string | null;
  readonly tenantLinkId?: string | null;
  readonly product?: string | null;
  readonly subscriptionId?: string | null;
  readonly licenceId?: string | null;
  readonly installationId?: string | null;
  /** What changed. Never a secret, a token or a licence body. */
  readonly payload?: Prisma.InputJsonObject;
}

/**
 * Appends to `audit_event`, inside the caller's transaction so a change and its record commit or
 * fail together. The runtime role cannot update or delete the table (infra/sql/grants.sql).
 */
@Injectable()
export class AuditService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async record(
    tx: Transaction,
    principal: Principal | { readonly kind: 'SYSTEM'; readonly name: string },
    entry: AuditEntry,
    requestId?: string,
  ): Promise<void> {
    await tx.auditEvent.create({
      data: {
        actorKind: principal.kind,
        actor: principal.kind === 'SYSTEM' ? `system:${principal.name}` : actorOf(principal),
        action: entry.action,
        customerId: entry.customerId ?? null,
        tenantLinkId: entry.tenantLinkId ?? null,
        product: entry.product ?? null,
        subscriptionId: entry.subscriptionId ?? null,
        licenceId: entry.licenceId ?? null,
        installationId: entry.installationId ?? null,
        payload: entry.payload ?? {},
        requestId: requestId ?? null,
      },
    });
  }

  list(filter: {
    customerId?: string;
    subscriptionId?: string;
    action?: string;
    before?: bigint;
    limit: number;
  }) {
    return this.prisma.auditEvent.findMany({
      where: {
        ...(filter.customerId !== undefined && { customerId: filter.customerId }),
        ...(filter.subscriptionId !== undefined && { subscriptionId: filter.subscriptionId }),
        ...(filter.action !== undefined && { action: filter.action }),
        ...(filter.before !== undefined && { id: { lt: filter.before } }),
      },
      orderBy: { id: 'desc' },
      take: filter.limit,
    });
  }
}
