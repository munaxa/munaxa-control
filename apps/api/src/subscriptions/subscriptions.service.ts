import { Inject, Injectable } from '@nestjs/common';
import {
  LifecycleEvent,
  SubscriptionStatus,
  allowedEvents,
  effectiveStatus,
  transition,
} from '@munaxa/licensing';
import { Prisma, type PlanVersion } from '@prisma/client';

import { AuditAction, AuditService } from '../audit/audit.service';
import { actorOf, type Principal } from '../auth/principal';
import { CLOCK, type Clock } from '../core/clock';
import { conflict, invalid, notFound } from '../core/errors';
import { newId } from '../core/ids';
import { PrismaService, type Transaction } from '../core/prisma.service';
import type { Product } from '../core/products';
import { snapshotOf, type SubscriptionWithTerms } from '../entitlements/snapshot';

const DAY = 86_400_000;
const WITH_TERMS = { tenant: true, planVersion: { include: { plan: true } } } as const;

export interface CreateSubscription {
  readonly tenantLinkId: string;
  readonly planVersionId: string;
  /** `TRIAL` for a trial of the plan's `trialDays`, `ACTIVE` for a paid term. */
  readonly start: 'TRIAL' | 'ACTIVE';
  readonly startsAt?: Date | undefined;
  /** End of the paid term. Defaults to one billing period from the start. */
  readonly expiresAt?: Date | undefined;
  readonly reason?: string | undefined;
}

export interface TransitionRequest {
  readonly event: LifecycleEvent;
  readonly expectedVersion: number;
  readonly reason?: string | undefined;
  /** For `ACTIVATE` and `RENEW`: the end of the new term. Defaults to one billing period. */
  readonly expiresAt?: Date | undefined;
}

/** Add one billing period; a bespoke plan (no period) must state its term. */
function addPeriod(from: Date, version: PlanVersion): Date | null {
  if (version.billingPeriod === 'MONTHLY') {
    const d = new Date(from);
    d.setUTCMonth(d.getUTCMonth() + 1);
    return d;
  }
  if (version.billingPeriod === 'YEARLY') {
    const d = new Date(from);
    d.setUTCFullYear(d.getUTCFullYear() + 1);
    return d;
  }
  return null;
}

/**
 * The subscription lifecycle — authoritative for every SaaS subscription and every licence.
 *
 * Every state change goes through `@munaxa/licensing`'s `transition`, decided against the
 * subscription's **effective** status (its recorded status with dates applied), so an operator
 * cannot mark past-due a subscription whose term has already ended, and the products — which apply
 * the same dates — never disagree with what was recorded here.
 *
 * Concurrency is optimistic: every change names the version it was made against, and the version
 * is in the `WHERE` clause, so two operators acting at once cannot both succeed.
 *
 * Nothing here deletes anything. Expiry, suspension and cancellation change a status; the
 * customer's records live in the product and this service never reaches them.
 */
@Injectable()
export class SubscriptionsService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  list(query: {
    product?: Product | undefined;
    status?: string | undefined;
    customerId?: string | undefined;
    expiringBefore?: Date | undefined;
    limit: number;
    offset: number;
  }) {
    return this.prisma.subscription.findMany({
      where: {
        ...(query.status !== undefined && { status: query.status }),
        ...(query.product !== undefined && { tenant: { product: query.product } }),
        ...(query.customerId !== undefined && { tenant: { customerId: query.customerId } }),
        ...(query.expiringBefore !== undefined && {
          status: { notIn: ['CANCELLED'] },
          OR: [
            { expiresAt: { lte: query.expiringBefore } },
            { trialEndsAt: { lte: query.expiringBefore } },
          ],
        }),
      },
      include: {
        tenant: { include: { customer: true } },
        planVersion: { include: { plan: true } },
      },
      orderBy: [{ expiresAt: 'asc' }, { createdAt: 'desc' }],
      skip: query.offset,
      take: query.limit,
    });
  }

  async get(id: string) {
    const subscription = await this.prisma.subscription.findUnique({
      where: { id },
      include: {
        tenant: { include: { customer: true, deployment: true } },
        planVersion: { include: { plan: true } },
        events: { orderBy: { id: 'desc' }, take: 200 },
        licences: {
          orderBy: { issuedAt: 'desc' },
          select: {
            id: true,
            kid: true,
            issuedAt: true,
            expiresAt: true,
            supersedesId: true,
            revokedAt: true,
            revokedReason: true,
            installation: true,
          },
        },
      },
    });
    if (subscription === null) throw notFound('The subscription');
    const now = this.clock.now();
    return {
      ...subscription,
      effectiveStatus: effectiveStatus(termOf(subscription), now),
      allowedEvents: allowedEvents(effectiveStatus(termOf(subscription), now)),
      entitlements: snapshotOf(subscription, subscription.tenant.customerId, now),
    };
  }

  create(principal: Principal, input: CreateSubscription, requestId?: string) {
    return this.prisma.$transaction(async (tx) => {
      const tenant = await tx.tenantLink.findUnique({
        where: { id: input.tenantLinkId },
        include: { customer: true },
      });
      if (tenant === null) throw notFound('The tenant');
      if (tenant.customer.status !== 'ACTIVE')
        throw conflict('CUSTOMER_CLOSED', 'A closed customer cannot be sold a subscription.');
      const version = await this.sellable(tx, input.planVersionId, tenant.product);

      const startsAt = input.startsAt ?? this.clock.now();
      let trialEndsAt: Date | null = null;
      let expiresAt: Date | null = null;
      if (input.start === 'TRIAL') {
        if (version.trialDays <= 0) throw invalid('This plan version offers no trial.');
        trialEndsAt = new Date(startsAt.getTime() + version.trialDays * DAY);
      } else {
        expiresAt = input.expiresAt ?? addPeriod(startsAt, version);
        if (expiresAt === null)
          throw invalid('This plan version has no billing period; state the term end.');
        if (expiresAt <= startsAt) throw invalid('The term must end after it starts.');
      }

      const id = newId();
      try {
        await tx.subscription.create({
          data: {
            id,
            tenantLinkId: tenant.id,
            planVersionId: version.id,
            status: input.start,
            startsAt,
            trialEndsAt,
            expiresAt,
            graceUntil:
              expiresAt === null ? null : new Date(expiresAt.getTime() + version.graceDays * DAY),
            createdBy: actorOf(principal),
          },
        });
      } catch (error) {
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
          throw conflict(
            'SUBSCRIPTION_EXISTS',
            'This tenant already has a live subscription. Change its plan instead.',
          );
        }
        throw error;
      }
      await tx.subscriptionEvent.create({
        data: {
          subscriptionId: id,
          event: 'CREATE',
          fromStatus: null,
          toStatus: input.start,
          toPlanVersionId: version.id,
          reason: input.reason ?? null,
          actor: actorOf(principal),
        },
      });
      await this.audit.record(
        tx,
        principal,
        {
          action: AuditAction.SUBSCRIPTION_CREATED,
          customerId: tenant.customerId,
          tenantLinkId: tenant.id,
          product: tenant.product,
          subscriptionId: id,
          payload: {
            status: input.start,
            planVersionId: version.id,
            expiresAt: expiresAt?.toISOString() ?? null,
          },
        },
        requestId,
      );
      return id;
    });
  }

  transition(principal: Principal, id: string, request: TransitionRequest, requestId?: string) {
    return this.prisma.$transaction(async (tx) => {
      const current = await this.current(tx, id, request.expectedVersion);
      const now = this.clock.now();
      const from = effectiveStatus(termOf(current), now);
      const result = transition(
        from,
        request.event,
        current.suspendedFrom as SubscriptionStatus | null,
      );
      if (!result.ok) {
        throw conflict(
          'INVALID_TRANSITION',
          `A ${from} subscription does not accept ${request.event}.`,
          {
            from,
            event: request.event,
            allowed: allowedEvents(from),
          },
        );
      }

      const data: Prisma.SubscriptionUpdateManyMutationInput = {
        status: result.to,
        suspendedFrom: result.suspendedFrom,
        version: { increment: 1 },
      };
      if (request.event === LifecycleEvent.RENEW || request.event === LifecycleEvent.ACTIVATE) {
        // A new term runs from the later of now and the old term's end, so renewing early never
        // shortens what was paid for.
        const base =
          current.expiresAt !== null && current.expiresAt > now ? current.expiresAt : now;
        const expiresAt = request.expiresAt ?? addPeriod(base, current.planVersion);
        if (expiresAt === null)
          throw invalid('This plan version has no billing period; state the term end.');
        if (expiresAt <= now) throw invalid('The new term must end in the future.');
        data.expiresAt = expiresAt;
        data.graceUntil = new Date(expiresAt.getTime() + current.planVersion.graceDays * DAY);
        data.trialEndsAt = null;
      } else if (request.event === LifecycleEvent.ENTER_GRACE) {
        data.graceUntil =
          current.graceUntil ?? new Date(now.getTime() + current.planVersion.graceDays * DAY);
      } else if (request.event === LifecycleEvent.CANCEL) {
        data.cancelledAt = now;
      }
      await this.apply(tx, current, data);
      await tx.subscriptionEvent.create({
        data: {
          subscriptionId: id,
          event: request.event,
          fromStatus: from,
          toStatus: result.to,
          fromPlanVersionId: current.planVersionId,
          toPlanVersionId: current.planVersionId,
          reason: request.reason ?? null,
          actor: actorOf(principal),
        },
      });
      await this.audit.record(
        tx,
        principal,
        {
          action: AuditAction.SUBSCRIPTION_TRANSITIONED,
          customerId: current.tenant.customerId,
          tenantLinkId: current.tenantLinkId,
          product: current.tenant.product,
          subscriptionId: id,
          payload: { event: request.event, from, to: result.to, reason: request.reason ?? null },
        },
        requestId,
      );
      return id;
    });
  }

  /** Upgrade or downgrade: same product, a published version of any of its plans. Term unchanged. */
  changePlan(
    principal: Principal,
    id: string,
    request: { planVersionId: string; expectedVersion: number; reason?: string | undefined },
    requestId?: string,
  ) {
    return this.prisma.$transaction(async (tx) => {
      const current = await this.current(tx, id, request.expectedVersion);
      if (current.status === SubscriptionStatus.CANCELLED) {
        throw conflict(
          'INVALID_TRANSITION',
          'A cancelled subscription cannot change plan. Create a new one.',
        );
      }
      const version = await this.sellable(tx, request.planVersionId, current.tenant.product);
      if (version.id === current.planVersionId)
        throw conflict('NO_CHANGE', 'The subscription is already on that version.');
      await this.apply(tx, current, { planVersionId: version.id, version: { increment: 1 } });
      await tx.subscriptionEvent.create({
        data: {
          subscriptionId: id,
          event: 'CHANGE_PLAN',
          fromStatus: current.status,
          toStatus: current.status,
          fromPlanVersionId: current.planVersionId,
          toPlanVersionId: version.id,
          reason: request.reason ?? null,
          actor: actorOf(principal),
        },
      });
      await this.audit.record(
        tx,
        principal,
        {
          action: AuditAction.SUBSCRIPTION_PLAN_CHANGED,
          customerId: current.tenant.customerId,
          tenantLinkId: current.tenantLinkId,
          product: current.tenant.product,
          subscriptionId: id,
          payload: {
            fromPlanVersionId: current.planVersionId,
            toPlanVersionId: version.id,
            reason: request.reason ?? null,
          },
        },
        requestId,
      );
      return id;
    });
  }

  setOverrides(
    principal: Principal,
    id: string,
    request: {
      expectedVersion: number;
      features: { add: string[]; remove: string[] };
      limits: Record<string, number | null>;
      reason: string;
    },
    requestId?: string,
  ) {
    return this.prisma.$transaction(async (tx) => {
      const current = await this.current(tx, id, request.expectedVersion);
      await this.apply(tx, current, {
        featureOverrides: request.features,
        limitOverrides: request.limits,
        version: { increment: 1 },
      });
      await this.audit.record(
        tx,
        principal,
        {
          action: AuditAction.SUBSCRIPTION_OVERRIDE_SET,
          customerId: current.tenant.customerId,
          tenantLinkId: current.tenantLinkId,
          product: current.tenant.product,
          subscriptionId: id,
          payload: { features: request.features, limits: request.limits, reason: request.reason },
        },
        requestId,
      );
      return id;
    });
  }

  /**
   * Records the moves dates have already made — a trial or term that ended, a grace window that
   * closed — so stored status matches effective status and the reports read true. Decisions never
   * wait for this: products and this service both evaluate dates directly. Idempotent; run on a
   * schedule (`pnpm --filter @control/api sweep`).
   */
  async sweep(): Promise<number> {
    const now = this.clock.now();
    const candidates = await this.prisma.subscription.findMany({
      where: {
        status: { in: ['TRIAL', 'ACTIVE', 'PAST_DUE', 'GRACE_PERIOD'] },
        OR: [
          { trialEndsAt: { lte: now } },
          { expiresAt: { lte: now } },
          { graceUntil: { lte: now } },
        ],
      },
      include: WITH_TERMS,
    });
    let moved = 0;
    for (const subscription of candidates) {
      const to = effectiveStatus(termOf(subscription), now);
      if (to === subscription.status) continue;
      await this.prisma.$transaction(async (tx) => {
        const { count } = await tx.subscription.updateMany({
          where: { id: subscription.id, version: subscription.version },
          data: { status: to, version: { increment: 1 } },
        });
        if (count === 0) return; // An operator acted meanwhile; their change stands.
        await tx.subscriptionEvent.create({
          data: {
            subscriptionId: subscription.id,
            event:
              to === SubscriptionStatus.GRACE_PERIOD
                ? LifecycleEvent.ENTER_GRACE
                : LifecycleEvent.EXPIRE,
            fromStatus: subscription.status,
            toStatus: to,
            fromPlanVersionId: subscription.planVersionId,
            toPlanVersionId: subscription.planVersionId,
            reason: 'term dates',
            actor: 'system:sweep',
          },
        });
        await this.audit.record(
          tx,
          { kind: 'SYSTEM', name: 'sweep' },
          {
            action: AuditAction.SUBSCRIPTION_TRANSITIONED,
            customerId: subscription.tenant.customerId,
            tenantLinkId: subscription.tenantLinkId,
            product: subscription.tenant.product,
            subscriptionId: subscription.id,
            payload: { from: subscription.status, to, reason: 'term dates' },
          },
        );
        moved += 1;
      });
    }
    return moved;
  }

  private async current(
    tx: Transaction,
    id: string,
    expectedVersion: number,
  ): Promise<SubscriptionWithTerms> {
    const current = await tx.subscription.findUnique({ where: { id }, include: WITH_TERMS });
    if (current === null) throw notFound('The subscription');
    if (current.version !== expectedVersion) {
      throw conflict(
        'VERSION_CONFLICT',
        'Someone else changed this subscription first. Reload and try again.',
        {
          currentVersion: current.version,
        },
      );
    }
    return current;
  }

  private async apply(
    tx: Transaction,
    current: SubscriptionWithTerms,
    data: Prisma.SubscriptionUpdateManyMutationInput & { planVersionId?: string },
  ) {
    const { count } = await tx.subscription.updateMany({
      where: { id: current.id, version: current.version },
      data,
    });
    if (count === 0)
      throw conflict(
        'VERSION_CONFLICT',
        'Someone else changed this subscription first. Reload and try again.',
      );
  }

  private async sellable(tx: Transaction, planVersionId: string, product: string) {
    const version = await tx.planVersion.findUnique({
      where: { id: planVersionId },
      include: { plan: true },
    });
    if (version === null) throw notFound('The plan version');
    if (version.plan.product !== product) {
      throw invalid(`That plan is for ${version.plan.product}; this tenant is ${product}.`);
    }
    if (version.state !== 'PUBLISHED')
      throw conflict('PLAN_VERSION_NOT_PUBLISHED', 'Only a published plan version can be sold.');
    return version;
  }
}

export function termOf(subscription: {
  status: string;
  trialEndsAt: Date | null;
  expiresAt: Date | null;
  graceUntil: Date | null;
}) {
  return {
    status: subscription.status as SubscriptionStatus,
    trialEndsAt: subscription.trialEndsAt?.toISOString() ?? null,
    expiresAt: subscription.expiresAt?.toISOString() ?? null,
    graceUntil: subscription.graceUntil?.toISOString() ?? null,
  };
}
