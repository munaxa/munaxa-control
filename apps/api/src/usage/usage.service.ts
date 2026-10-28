import { Inject, Injectable } from '@nestjs/common';

import { AuditAction, AuditService } from '../audit/audit.service';
import type { ServicePrincipal } from '../auth/principal';
import { PrismaService } from '../core/prisma.service';

export interface UsagePoint {
  readonly tenantId: string;
  readonly metric: string;
  readonly value: number;
  readonly measuredAt: Date;
  readonly installationId?: string | undefined;
}

/**
 * Metered quantities reported by products. Informational — a product enforces its own limits
 * against its own rows — and idempotent on (tenant, metric, measured_at), so a retried batch is
 * counted once. A point for a tenant outside the credential's deployment is not stored and is
 * reported back as rejected, without saying whether the tenant exists.
 */
@Injectable()
export class UsageService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  async report(
    principal: ServicePrincipal,
    product: string,
    points: readonly UsagePoint[],
    requestId?: string,
  ) {
    if (product !== principal.product)
      return { accepted: 0, duplicates: 0, rejected: points.length };
    const refs = [...new Set(points.map((p) => p.tenantId))];
    const tenants = await this.prisma.tenantLink.findMany({
      where: {
        product,
        tenantRef: { in: refs },
        deploymentType: 'SAAS',
        deploymentId: principal.deploymentId,
      },
      select: { id: true, tenantRef: true },
    });
    const byRef = new Map(tenants.map((t) => [t.tenantRef, t.id]));
    const rows = points.flatMap((p) => {
      const tenantLinkId = byRef.get(p.tenantId);
      return tenantLinkId === undefined
        ? []
        : [
            {
              tenantLinkId,
              metric: p.metric,
              value: BigInt(p.value),
              measuredAt: p.measuredAt,
              installationRef: p.installationId ?? null,
            },
          ];
    });
    return this.prisma.$transaction(async (tx) => {
      const { count } = await tx.usageReport.createMany({ data: rows, skipDuplicates: true });
      if (count > 0) {
        await this.audit.record(
          tx,
          principal,
          { action: AuditAction.USAGE_REPORTED, product, payload: { points: count } },
          requestId,
        );
      }
      return {
        accepted: count,
        duplicates: rows.length - count,
        rejected: points.length - rows.length,
      };
    });
  }

  /** The latest value of each metric for a tenant, beside the plan ceiling the portal shows. */
  latest(tenantLinkId: string) {
    return this.prisma.$queryRaw<{ metric: string; value: bigint; measured_at: Date }[]>`
      SELECT DISTINCT ON (metric) metric, value, measured_at
      FROM usage_report
      WHERE tenant_link_id = ${tenantLinkId}::uuid
      ORDER BY metric, measured_at DESC`;
  }

  history(tenantLinkId: string, metric: string, limit: number) {
    return this.prisma.usageReport.findMany({
      where: { tenantLinkId, metric },
      orderBy: { measuredAt: 'desc' },
      take: limit,
    });
  }
}
