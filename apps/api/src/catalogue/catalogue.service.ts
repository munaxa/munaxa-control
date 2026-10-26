import { Inject, Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';

import { AuditAction, AuditService } from '../audit/audit.service';
import { actorOf, type Principal } from '../auth/principal';
import { mintServiceSecret } from '../auth/service-credentials';
import { CLOCK, type Clock } from '../core/clock';
import { conflict, notFound } from '../core/errors';
import { newId } from '../core/ids';
import { PrismaService } from '../core/prisma.service';
import type { Product } from '../core/products';

export interface PlanVersionTerms {
  readonly features: readonly string[];
  readonly limits: Readonly<Record<string, number | null>>;
  readonly priceMinor?: number | null | undefined;
  readonly currency?: string | null | undefined;
  readonly billingPeriod?: 'MONTHLY' | 'YEARLY' | null | undefined;
  readonly trialDays: number;
  readonly graceDays: number;
}

/**
 * What can be sold, and to whom it is served: plans and their versions, and the product
 * deployments that ask this service about their tenants.
 *
 * A plan version is drafted, published and retired. Publishing freezes its terms — the database
 * trigger refuses any later change — so a subscriber's terms are exactly what they were sold.
 */
@Injectable()
export class CatalogueService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  // --- Deployments and their credentials ---------------------------------------------------

  deployments(product?: Product) {
    return this.prisma.productDeployment.findMany({
      where: product === undefined ? {} : { product },
      orderBy: [{ product: 'asc' }, { name: 'asc' }],
      include: {
        credentials: {
          select: { id: true, label: true, createdAt: true, lastUsedAt: true, revokedAt: true },
          orderBy: { createdAt: 'desc' },
        },
        _count: { select: { tenants: true } },
      },
    });
  }

  createDeployment(
    principal: Principal,
    input: { product: Product; name: string },
    requestId?: string,
  ) {
    return this.prisma.$transaction(async (tx) => {
      const deployment = await tx.productDeployment.create({
        data: {
          id: newId(),
          product: input.product,
          name: input.name,
          createdBy: actorOf(principal),
        },
      });
      await this.audit.record(
        tx,
        principal,
        {
          action: AuditAction.DEPLOYMENT_CREATED,
          product: input.product,
          payload: { name: input.name, deploymentId: deployment.id },
        },
        requestId,
      );
      return deployment;
    });
  }

  /** Returns the secret once. It is not stored and cannot be shown again. */
  issueCredential(principal: Principal, deploymentId: string, label: string, requestId?: string) {
    return this.prisma.$transaction(async (tx) => {
      const deployment = await tx.productDeployment.findUnique({ where: { id: deploymentId } });
      if (deployment === null) throw notFound('The deployment');
      const id = newId();
      const { token, secretHash } = mintServiceSecret(id);
      await tx.serviceCredential.create({
        data: { id, deploymentId, label, secretHash, createdBy: actorOf(principal) },
      });
      await this.audit.record(
        tx,
        principal,
        {
          action: AuditAction.CREDENTIAL_ISSUED,
          product: deployment.product,
          payload: { credentialId: id, deploymentId, label },
        },
        requestId,
      );
      return { id, deploymentId, label, token };
    });
  }

  revokeCredential(principal: Principal, credentialId: string, requestId?: string) {
    return this.prisma.$transaction(async (tx) => {
      const credential = await tx.serviceCredential.findUnique({
        where: { id: credentialId },
        include: { deployment: true },
      });
      if (credential === null) throw notFound('The credential');
      if (credential.revokedAt === null) {
        await tx.serviceCredential.update({
          where: { id: credentialId },
          data: { revokedAt: this.clock.now(), revokedBy: actorOf(principal) },
        });
        await this.audit.record(
          tx,
          principal,
          {
            action: AuditAction.CREDENTIAL_REVOKED,
            product: credential.deployment.product,
            payload: { credentialId },
          },
          requestId,
        );
      }
      return { id: credentialId, revoked: true };
    });
  }

  // --- Plans --------------------------------------------------------------------------------

  plans(product?: Product) {
    return this.prisma.plan.findMany({
      where: product === undefined ? {} : { product },
      orderBy: [{ product: 'asc' }, { code: 'asc' }],
      include: { versions: { orderBy: { version: 'desc' } } },
    });
  }

  async plan(id: string) {
    const plan = await this.prisma.plan.findUnique({
      where: { id },
      include: {
        versions: {
          orderBy: { version: 'desc' },
          include: { _count: { select: { subscriptions: true } } },
        },
      },
    });
    if (plan === null) throw notFound('The plan');
    return plan;
  }

  createPlan(
    principal: Principal,
    input: { product: Product; code: string; name: string; description?: string | undefined },
    requestId?: string,
  ) {
    return this.prisma.$transaction(async (tx) => {
      const plan = await tx.plan.create({
        data: {
          id: newId(),
          product: input.product,
          code: input.code,
          name: input.name,
          description: input.description ?? null,
          createdBy: actorOf(principal),
        },
      });
      await this.audit.record(
        tx,
        principal,
        {
          action: AuditAction.PLAN_CREATED,
          product: plan.product,
          payload: { planId: plan.id, code: plan.code },
        },
        requestId,
      );
      return plan;
    });
  }

  /** A new draft version, numbered after the latest. */
  draftVersion(principal: Principal, planId: string, terms: PlanVersionTerms, requestId?: string) {
    return this.prisma.$transaction(async (tx) => {
      const plan = await tx.plan.findUnique({ where: { id: planId } });
      if (plan === null) throw notFound('The plan');
      const latest = await tx.planVersion.findFirst({
        where: { planId },
        orderBy: { version: 'desc' },
      });
      const version = await tx.planVersion.create({
        data: {
          id: newId(),
          planId,
          version: (latest?.version ?? 0) + 1,
          ...this.termsData(terms),
          createdBy: actorOf(principal),
        },
      });
      await this.audit.record(
        tx,
        principal,
        {
          action: AuditAction.PLAN_VERSION_DRAFTED,
          product: plan.product,
          payload: { planId, planVersionId: version.id, version: version.version },
        },
        requestId,
      );
      return version;
    });
  }

  updateDraft(
    principal: Principal,
    versionId: string,
    terms: PlanVersionTerms,
    requestId?: string,
  ) {
    return this.prisma.$transaction(async (tx) => {
      const current = await tx.planVersion.findUnique({
        where: { id: versionId },
        include: { plan: true },
      });
      if (current === null) throw notFound('The plan version');
      if (current.state !== 'DRAFT') {
        throw conflict(
          'PLAN_VERSION_FROZEN',
          'A published or retired version cannot change. Draft a new version.',
        );
      }
      const updated = await tx.planVersion.update({
        where: { id: versionId },
        data: this.termsData(terms),
      });
      await this.audit.record(
        tx,
        principal,
        {
          action: AuditAction.PLAN_VERSION_DRAFTED,
          product: current.plan.product,
          payload: { planVersionId: versionId, edited: true },
        },
        requestId,
      );
      return updated;
    });
  }

  publish(principal: Principal, versionId: string, requestId?: string) {
    return this.moveVersion(
      principal,
      versionId,
      'DRAFT',
      'PUBLISHED',
      AuditAction.PLAN_PUBLISHED,
      requestId,
    );
  }

  retire(principal: Principal, versionId: string, requestId?: string) {
    return this.moveVersion(
      principal,
      versionId,
      'PUBLISHED',
      'RETIRED',
      AuditAction.PLAN_RETIRED,
      requestId,
    );
  }

  private moveVersion(
    principal: Principal,
    versionId: string,
    from: string,
    to: 'PUBLISHED' | 'RETIRED',
    action: AuditAction,
    requestId?: string,
  ) {
    return this.prisma.$transaction(async (tx) => {
      const current = await tx.planVersion.findUnique({
        where: { id: versionId },
        include: { plan: true },
      });
      if (current === null) throw notFound('The plan version');
      if (current.state !== from) {
        throw conflict(
          'INVALID_TRANSITION',
          `A ${current.state.toLowerCase()} version cannot be ${to.toLowerCase()}.`,
        );
      }
      const now = this.clock.now();
      const updated = await tx.planVersion.update({
        where: { id: versionId },
        data: to === 'PUBLISHED' ? { state: to, publishedAt: now } : { state: to, retiredAt: now },
      });
      await this.audit.record(
        tx,
        principal,
        {
          action,
          product: current.plan.product,
          payload: { planVersionId: versionId, version: current.version },
        },
        requestId,
      );
      return updated;
    });
  }

  private termsData(terms: PlanVersionTerms) {
    return {
      features: [...new Set(terms.features)].sort(),
      limits: terms.limits as Prisma.InputJsonObject,
      priceMinor:
        terms.priceMinor === undefined || terms.priceMinor === null
          ? null
          : BigInt(terms.priceMinor),
      currency: terms.currency ?? null,
      billingPeriod: terms.billingPeriod ?? null,
      trialDays: terms.trialDays,
      graceDays: terms.graceDays,
    };
  }
}
