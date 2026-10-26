import { Inject, Injectable } from '@nestjs/common';

import { CLOCK, type Clock } from '../core/clock';
import { PrismaService } from '../core/prisma.service';

const DAY = 86_400_000;

/** Read-only summaries for the portal. Nothing here changes a record. */
@Injectable()
export class ReportsService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async dashboard() {
    const now = this.clock.now();
    const soon = new Date(now.getTime() + 30 * DAY);
    const [customers, byStatus, byProduct, expiringSoon, licencesExpiringSoon] =
      await this.prisma.$transaction([
        this.prisma.customer.count({ where: { status: 'ACTIVE' } }),
        this.prisma.subscription.groupBy({
          by: ['status'],
          _count: { _all: true },
          orderBy: { status: 'asc' },
        }),
        this.prisma.tenantLink.groupBy({
          by: ['product'],
          _count: { _all: true },
          orderBy: { product: 'asc' },
        }),
        this.prisma.subscription.count({
          where: {
            status: { in: ['TRIAL', 'ACTIVE', 'PAST_DUE'] },
            OR: [{ expiresAt: { gte: now, lte: soon } }, { trialEndsAt: { gte: now, lte: soon } }],
          },
        }),
        this.prisma.licence.count({
          where: { revokedAt: null, expiresAt: { gte: now, lte: soon } },
        }),
      ]);
    return {
      activeCustomers: customers,
      subscriptionsByStatus: Object.fromEntries(
        byStatus.map((r) => [r.status, (r._count as { _all: number })._all]),
      ),
      tenantsByProduct: Object.fromEntries(
        byProduct.map((r) => [r.product, (r._count as { _all: number })._all]),
      ),
      expiringWithin30Days: expiringSoon,
      licencesExpiringWithin30Days: licencesExpiringSoon,
    };
  }

  expiring(days: number) {
    const now = this.clock.now();
    const until = new Date(now.getTime() + days * DAY);
    return this.prisma.subscription.findMany({
      where: {
        status: { in: ['TRIAL', 'ACTIVE', 'PAST_DUE'] },
        OR: [{ expiresAt: { gte: now, lte: until } }, { trialEndsAt: { gte: now, lte: until } }],
      },
      include: {
        tenant: { include: { customer: true } },
        planVersion: { include: { plan: true } },
      },
      orderBy: { expiresAt: 'asc' },
    });
  }

  /** Past due, in grace, or already expired and not yet renewed or cancelled. */
  overdue() {
    const now = this.clock.now();
    return this.prisma.subscription.findMany({
      where: {
        OR: [
          { status: { in: ['PAST_DUE', 'GRACE_PERIOD', 'EXPIRED'] } },
          {
            status: { in: ['ACTIVE', 'TRIAL'] },
            OR: [{ expiresAt: { lt: now } }, { trialEndsAt: { lt: now } }],
          },
        ],
      },
      include: {
        tenant: { include: { customer: true } },
        planVersion: { include: { plan: true } },
      },
      orderBy: { expiresAt: 'asc' },
    });
  }
}
