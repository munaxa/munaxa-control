import { Inject, Injectable, Logger } from '@nestjs/common';

import type { ServicePrincipal } from '../auth/principal';
import { CLOCK, type Clock } from '../core/clock';
import { newId } from '../core/ids';
import { PrismaService } from '../core/prisma.service';
import type { Product } from '../core/products';

/**
 * More unlinked sightings than this for one deployment is not organisations being set up; it is a
 * credential asking about identifiers it made up. New ones are then not recorded (the existing ones
 * still are), so a leaked credential cannot grow the table without bound.
 */
export const MAX_UNLINKED_SIGHTINGS_PER_DEPLOYMENT = 200;

/** A sighting already seen this recently is not written again: the product asks on every refresh. */
const REFRESH_MS = 5 * 60_000;

/** The header a product may send beside an entitlement question, naming the tenant for a person. */
export const TENANT_LABEL_HEADER = 'munaxa-tenant-label';

const LABEL_MAX = 100;

/** The most sightings the portal is offered at once. */
const LIST_LIMIT = 500;

/**
 * The product's name for a tenant, made safe to keep and show: control and format characters
 * removed, whitespace collapsed, at most 100 characters. `null` when nothing is left. It is shown
 * as text and never used to decide anything.
 */
export function cleanLabel(raw: string | readonly string[] | undefined): string | null {
  const value = typeof raw === 'string' ? raw : raw?.[0];
  if (typeof value !== 'string') return null;
  const cleaned = value
    .normalize('NFC')
    .replace(/\p{C}+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
  if (cleaned === '') return null;
  return [...cleaned].slice(0, LABEL_MAX).join('').trim();
}

/**
 * Tenants a product deployment has asked about that no operator has linked yet.
 *
 * This is how a tenant's identifier reaches the operator without anyone copying it: the product
 * already sends it, with its deployment's credential, every time it checks the tenant's licence.
 * Recording that question changes nothing about the answer (still the same `404`) and grants
 * nothing; the operator links the tenant to a customer exactly as before, but picks it from a list.
 *
 * What a sighting can be trusted for: that the holder of this deployment's credential asked about
 * this identifier. That is exactly what linking needs, because once linked the tenant's
 * entitlements are served to that deployment and no other.
 */
@Injectable()
export class TenantSightingsService {
  private readonly logger = new Logger(TenantSightingsService.name);

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * Note that `principal`'s deployment asked about `tenantRef`, which is linked to no customer.
   * Never throws: a failure here must not change the product's answer, so it is logged and dropped.
   */
  async record(
    principal: ServicePrincipal,
    tenantRef: string,
    label: string | null,
  ): Promise<void> {
    try {
      const now = this.clock.now();
      const stale = new Date(now.getTime() - REFRESH_MS);
      const { count } = await this.prisma.tenantSighting.updateMany({
        where: {
          deploymentId: principal.deploymentId,
          tenantRef,
          ...(label === null
            ? { lastSeenAt: { lt: stale } }
            : { OR: [{ lastSeenAt: { lt: stale } }, { NOT: { label } }, { label: null }] }),
        },
        data: { lastSeenAt: now, ...(label !== null && { label }) },
      });
      if (count > 0) return;
      const exists = await this.prisma.tenantSighting.findUnique({
        where: { deploymentId_tenantRef: { deploymentId: principal.deploymentId, tenantRef } },
        select: { id: true },
      });
      if (exists !== null) return;
      if (
        (await this.unlinkedCount(principal.deploymentId)) >= MAX_UNLINKED_SIGHTINGS_PER_DEPLOYMENT
      ) {
        this.logger.warn(
          { deploymentId: principal.deploymentId, product: principal.product },
          'tenant sighting not recorded: the deployment has too many unlinked tenants',
        );
        return;
      }
      await this.prisma.tenantSighting.createMany({
        data: [
          {
            id: newId(),
            product: principal.product,
            deploymentId: principal.deploymentId,
            tenantRef,
            label,
            firstSeenAt: now,
            lastSeenAt: now,
          },
        ],
        // Two of the product's processes asking at once: the second insert is the first's row.
        skipDuplicates: true,
      });
    } catch (error) {
      this.logger.warn(
        { deploymentId: principal.deploymentId, reason: (error as Error).message },
        'tenant sighting not recorded',
      );
    }
  }

  /** Sightings no tenant link has claimed yet, most recently seen first. */
  async unlinked(query: { product?: Product | undefined }) {
    const product = query.product ?? null;
    const ids = await this.prisma.$queryRaw<{ id: string }[]>`
      SELECT s.id
      FROM tenant_sighting s
      WHERE (${product}::text IS NULL OR s.product = ${product}::text)
        AND NOT EXISTS (
          SELECT 1 FROM tenant_link l WHERE l.product = s.product AND l.tenant_ref = s.tenant_ref
        )
      ORDER BY s.last_seen_at DESC
      LIMIT ${LIST_LIMIT}`;
    if (ids.length === 0) return [];
    return this.prisma.tenantSighting.findMany({
      where: { id: { in: ids.map((r) => r.id) } },
      include: { deployment: { select: { id: true, name: true, product: true } } },
      orderBy: { lastSeenAt: 'desc' },
    });
  }

  /** One sighting no tenant link has claimed, or `null`. */
  async unlinkedById(id: string) {
    const sighting = await this.prisma.tenantSighting.findUnique({ where: { id } });
    if (sighting === null) return null;
    const linked = await this.prisma.tenantLink.findUnique({
      where: { product_tenantRef: { product: sighting.product, tenantRef: sighting.tenantRef } },
      select: { id: true },
    });
    return linked === null ? sighting : null;
  }

  private async unlinkedCount(deploymentId: string): Promise<number> {
    const [row] = await this.prisma.$queryRaw<[{ count: bigint }]>`
      SELECT count(*) AS count
      FROM tenant_sighting s
      WHERE s.deployment_id = ${deploymentId}::uuid
        AND NOT EXISTS (
          SELECT 1 FROM tenant_link l WHERE l.product = s.product AND l.tenant_ref = s.tenant_ref
        )`;
    return Number(row.count);
  }
}
