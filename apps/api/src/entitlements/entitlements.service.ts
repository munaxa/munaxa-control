import { createHash } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';
import type { EntitlementSnapshot } from '@munaxa/licensing';

import type { ServicePrincipal } from '../auth/principal';
import { CLOCK, type Clock } from '../core/clock';
import { notFound } from '../core/errors';
import { PrismaService } from '../core/prisma.service';
import { TenantSightingsService } from '../customers/tenant-sightings.service';
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
    @Inject(TenantSightingsService) private readonly sightings: TenantSightingsService,
  ) {}

  async resolve(
    principal: ServicePrincipal,
    product: string,
    tenantRef: string,
    label: string | null = null,
  ): Promise<{ snapshot: EntitlementSnapshot; etag: string }> {
    if (product !== principal.product) throw notFound('The tenant');
    const linked = await this.prisma.tenantLink.findUnique({
      where: { product_tenantRef: { product, tenantRef } },
    });
    if (linked === null) {
      // Linked to no customer yet: recorded so an operator can pick it when linking. Not awaited,
      // so the answer — the same 404 — takes no longer than any other tenant this credential may
      // not see, and a recording failure cannot change it.
      void this.sightings.record(principal, tenantRef, label);
      throw notFound('The tenant');
    }
    const tenant =
      linked.deploymentType === 'SAAS' && linked.deploymentId === principal.deploymentId
        ? linked
        : null;
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
