import { createHash } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';
import type { EntitlementSnapshot } from '@munaxa/licensing';

import type { ServicePrincipal } from '../auth/principal';
import { CLOCK, type Clock } from '../core/clock';
import { notFound } from '../core/errors';
import { PrismaService } from '../core/prisma.service';
import { snapshotOf } from './snapshot';

/**
 * What a product deployment may learn about its tenants — and nothing else.
 *
 * The boundary is three equalities, all from the authenticated credential rather than the request:
 * the product in the path must be the credential's product, the tenant must be linked to that
 * product, and it must be served by the credential's own deployment. Failing any of them is the
 * same `404` as a tenant that does not exist, so a credential cannot even confirm that another
 * product's or another deployment's tenant is a Munaxa customer.
 */
@Injectable()
export class EntitlementsService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async resolve(
    principal: ServicePrincipal,
    product: string,
    tenantRef: string,
  ): Promise<{ snapshot: EntitlementSnapshot; etag: string }> {
    if (product !== principal.product) throw notFound('The tenant');
    const tenant = await this.prisma.tenantLink.findFirst({
      where: { product, tenantRef, deploymentType: 'SAAS', deploymentId: principal.deploymentId },
    });
    if (tenant === null) throw notFound('The tenant');

    // The live subscription, or — when there is none — the most recent cancelled one. A cancelled
    // tenant is answered with its CANCELLED snapshot (export-only), never with "no subscription",
    // which a product reads as "grant nothing": a customer keeps the right to take their records.
    const subscription =
      (await this.prisma.subscription.findFirst({
        where: { tenantLinkId: tenant.id, status: { not: 'CANCELLED' } },
        include: { tenant: true, planVersion: { include: { plan: true } } },
      })) ??
      (await this.prisma.subscription.findFirst({
        where: { tenantLinkId: tenant.id },
        orderBy: { cancelledAt: 'desc' },
        include: { tenant: true, planVersion: { include: { plan: true } } },
      }));
    if (subscription === null) throw notFound('A subscription for the tenant');

    const snapshot = snapshotOf(subscription, tenant.customerId, this.clock.now());
    const { resolvedAt: _ignored, ...stable } = snapshot;
    const etag = `"${createHash('sha256').update(JSON.stringify(stable)).digest('base64url').slice(0, 27)}"`;
    return { snapshot, etag };
  }
}
