import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import {
  DeploymentType,
  SubscriptionStatus,
  armorLicense,
  decodeActivationRequest,
  effectiveStatus,
  issueLicense,
  issueRevocationList,
  REVOCATION_LIST_FORMAT,
  RevocationReason,
  type LicensePayload,
} from '@munaxa/licensing';
import type { Prisma } from '@prisma/client';

import { AuditAction, AuditService } from '../audit/audit.service';
import { actorOf, type Principal } from '../auth/principal';
import { ENVIRONMENT, type Environment } from '../config/environment';
import { CLOCK, type Clock } from '../core/clock';
import { conflict, invalid, notFound } from '../core/errors';
import { newId } from '../core/ids';
import { PrismaService, type Transaction } from '../core/prisma.service';
import { snapshotOf } from '../entitlements/snapshot';
import { termOf } from '../subscriptions/subscriptions.service';

import { LICENCE_SIGNER, type LicenceSigner } from './licence-signer';

const DAY = 86_400_000;
const EPOCH = '1970-01-01T00:00:00.000Z';

/** Why a licence was revoked, as a revocation list states it (never the list's fail-closed reason). */
export const REVOCATION_CATEGORIES = [
  RevocationReason.ISSUED_IN_ERROR,
  RevocationReason.SUPERSEDED,
  RevocationReason.CONTRACT_ENDED,
  RevocationReason.KEY_COMPROMISE,
] as const;
export type RevocationCategory = (typeof REVOCATION_CATEGORIES)[number];
const WITH_TERMS = { tenant: true, planVersion: { include: { plan: true } } } as const;

export interface PublishedKey {
  readonly kid: string;
  readonly algorithm: 'ES256' | 'RS256';
  readonly publicKey: string;
  /** `true` for the key new licences are signed with. */
  readonly current: boolean;
}

/**
 * Licence issuance, renewal and controlled reactivation for on-premises installations.
 *
 * The private key is either read once, from a mounted file, into this process and nowhere else, or
 * held by AWS KMS and never read at all (`licence-signer.ts`, ADR-0008). It never appears in a
 * response, a log, the portal or a database row; installations are given the public half through
 * `GET /api/v1/licensing/public-keys`.
 *
 * A licence covers at most `LICENCE_MAX_TERM_DAYS` and never beyond the subscription's own term,
 * because an offline installation cannot learn of a revocation: the term is the only lever there
 * is (platform ADR-0022). Renewal is issuing the next one.
 */
@Injectable()
export class LicensingService implements OnModuleInit {
  private readonly keys: readonly PublishedKey[];

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(ENVIRONMENT) private readonly environment: Environment,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(LICENCE_SIGNER) private readonly signer: LicenceSigner,
  ) {
    this.keys = [
      {
        kid: signer.kid,
        algorithm: signer.algorithm,
        publicKey: signer.publicKey,
        current: true,
      },
      ...environment.licencePreviousPublicKeys.map((k) => ({
        kid: k.kid,
        algorithm: environment.LICENCE_SIGNING_ALGORITHM,
        publicKey: k.publicKey,
        current: false,
      })),
    ];
  }

  /** A key that cannot sign, or whose published half does not verify it, stops startup. */
  async onModuleInit(): Promise<void> {
    await this.signer.selfTest();
  }

  publicKeys(): readonly PublishedKey[] {
    return this.keys;
  }

  installations(tenantLinkId: string) {
    return this.prisma.installation.findMany({
      where: { tenantLinkId },
      orderBy: { registeredAt: 'desc' },
      include: {
        licences: {
          orderBy: { issuedAt: 'desc' },
          take: 1,
          select: { id: true, issuedAt: true, expiresAt: true },
        },
      },
    });
  }

  registerInstallation(
    principal: Principal,
    tenantLinkId: string,
    installationRef: string,
    requestId?: string,
  ) {
    return this.prisma.$transaction(async (tx) => {
      const tenant = await tx.tenantLink.findUnique({ where: { id: tenantLinkId } });
      if (tenant === null) throw notFound('The tenant');
      return this.register(tx, principal, tenant, installationRef, requestId);
    });
  }

  /**
   * Issue a licence for a subscription. `installationRef` binds it to one registered installation;
   * `null` issues an unbound licence for first activation, which any installation of the product
   * will accept — so it is the exception, and its term is short.
   */
  issue(
    principal: Principal,
    subscriptionId: string,
    request: { installationRef: string | null; expiresAt?: Date | undefined },
    requestId?: string,
  ) {
    return this.prisma.$transaction((tx) =>
      this.issueIn(tx, principal, subscriptionId, request, requestId),
    );
  }

  /** Turns an installation's offline activation request into a licence bound to it. */
  activate(principal: Principal, code: string, requestId?: string) {
    const request = decodeActivationRequest(code);
    if (request === null) throw invalid('That is not an activation request.');
    return this.prisma.$transaction(async (tx) => {
      const licence = await tx.licence.findUnique({
        where: { id: request.licenseId },
        include: { subscription: { include: { tenant: true } }, installation: true },
      });
      if (licence === null) throw notFound('The licence named in the request');
      const tenant = licence.subscription.tenant;
      if (tenant.product !== request.product) {
        throw invalid(
          `The licence is for ${tenant.product}; the installation is ${request.product}.`,
        );
      }
      if (licence.revokedAt !== null)
        throw conflict('LICENCE_REVOKED', 'That licence was revoked; issue a new one.');

      const existing = await tx.installation.findUnique({
        where: { installationRef: request.installationId },
      });
      if (existing !== null && existing.tenantLinkId !== tenant.id) {
        throw conflict('INSTALLATION_TAKEN', 'That installation is registered to another tenant.');
      }

      if (request.reason === 'SERVER_REPLACEMENT') {
        const old = licence.installation;
        if (old === null)
          throw invalid('The licence is not bound to an installation; activate instead.');
        if (old.installationRef === request.installationId) {
          throw invalid(
            'The replacement server has the same installation identifier as the old one.',
          );
        }
        const replacement =
          existing ??
          (await this.register(tx, principal, tenant, request.installationId, requestId));
        await tx.installation.update({
          where: { id: old.id },
          data: { status: 'REPLACED', replacedById: replacement.id, replacedAt: this.clock.now() },
        });
        await this.audit.record(
          tx,
          principal,
          {
            action: AuditAction.INSTALLATION_REACTIVATED,
            customerId: tenant.customerId,
            tenantLinkId: tenant.id,
            product: tenant.product,
            installationId: replacement.id,
            payload: {
              replaced: old.installationRef,
              by: request.installationId,
              licenceId: licence.id,
            },
          },
          requestId,
        );
      } else if (request.reason === 'RENEWAL') {
        if (existing === null || existing.status !== 'ACTIVE') {
          throw conflict(
            'INSTALLATION_NOT_ACTIVE',
            'Only an active, registered installation can renew.',
          );
        }
      } else if (existing === null) {
        await this.register(tx, principal, tenant, request.installationId, requestId);
      } else if (existing.status !== 'ACTIVE') {
        throw conflict(
          'INSTALLATION_NOT_ACTIVE',
          'That installation was replaced; reactivate the current one.',
        );
      }

      return this.issueIn(
        tx,
        principal,
        licence.subscriptionId,
        { installationRef: request.installationId },
        requestId,
      );
    });
  }

  revoke(
    principal: Principal,
    licenceId: string,
    reason: string,
    category: RevocationCategory,
    requestId?: string,
  ) {
    return this.prisma.$transaction(async (tx) => {
      const licence = await tx.licence.findUnique({
        where: { id: licenceId },
        include: { subscription: { include: { tenant: true } } },
      });
      if (licence === null) throw notFound('The licence');
      if (licence.revokedAt === null) {
        await tx.licence.update({
          where: { id: licenceId },
          data: { revokedAt: this.clock.now(), revokedReason: reason, revokedCategory: category },
        });
        await this.audit.record(
          tx,
          principal,
          {
            action: AuditAction.LICENSE_REVOKED,
            customerId: licence.subscription.tenant.customerId,
            tenantLinkId: licence.subscription.tenantLinkId,
            product: licence.subscription.tenant.product,
            subscriptionId: licence.subscriptionId,
            licenceId,
            payload: {
              reason,
              category,
              note: 'Reaches an offline installation only with the next revocation list it receives.',
            },
          },
          requestId,
        );
      }
      return { id: licenceId, revoked: true };
    });
  }

  /**
   * The product's revocation list, signed with the licence key: every licence of the product ever
   * revoked. Cumulative, and numbered by how many there are (plus one, so an empty list is 1 and the
   * first revocation makes 2) — a revocation is never undone, so the number only grows and a list
   * an installation holds is never replaced by an older one. Its `issuedAt` is the latest revocation
   * it names, so it is never later than the installation's clock.
   */
  async revocationList(
    principal: Principal,
    product: string,
    requestId?: string,
  ): Promise<{ filename: string; body: string; sequence: number }> {
    const revoked = await this.prisma.licence.findMany({
      where: { revokedAt: { not: null }, subscription: { tenant: { product } } },
      select: { id: true, revokedAt: true, revokedCategory: true },
      orderBy: { id: 'asc' },
    });
    const entries = revoked.map((licence) => ({
      licenseId: licence.id,
      revokedAt: (licence.revokedAt as Date).toISOString(),
      reason: (licence.revokedCategory ?? RevocationReason.CONTRACT_ENDED) as RevocationReason,
    }));
    const latest = entries.reduce((max, e) => (e.revokedAt > max ? e.revokedAt : max), EPOCH);
    const sequence = entries.length + 1;
    const body = await this.signer.sign((signer) =>
      issueRevocationList(
        { format: REVOCATION_LIST_FORMAT, product, sequence, issuedAt: latest, revoked: entries },
        signer,
      ),
    );
    await this.prisma.$transaction((tx) =>
      this.audit.record(
        tx,
        principal,
        {
          action: AuditAction.REVOCATION_LIST_ISSUED,
          product,
          payload: { sequence, revoked: entries.length },
        },
        requestId,
      ),
    );
    return { filename: `${product}-revocations-${sequence}.mxr`, body: `${body}\n`, sequence };
  }

  async download(licenceId: string): Promise<{ filename: string; body: string }> {
    const licence = await this.prisma.licence.findUnique({
      where: { id: licenceId },
      include: { subscription: { include: { tenant: true } } },
    });
    if (licence === null) throw notFound('The licence');
    return {
      filename: `${licence.subscription.tenant.product}-${licence.id}.license`,
      body: armorLicense(licence.token),
    };
  }

  private async register(
    tx: Transaction,
    principal: Principal,
    tenant: { id: string; customerId: string; product: string; deploymentType: string },
    installationRef: string,
    requestId?: string,
  ) {
    if (tenant.deploymentType !== DeploymentType.ON_PREMISES) {
      throw invalid(
        'Installations belong to on-premises tenants; a SaaS tenant is served by its deployment.',
      );
    }
    const installation = await tx.installation.create({
      data: {
        id: newId(),
        tenantLinkId: tenant.id,
        installationRef,
        registeredBy: actorOf(principal),
      },
    });
    await this.audit.record(
      tx,
      principal,
      {
        action: AuditAction.INSTALLATION_REGISTERED,
        customerId: tenant.customerId,
        tenantLinkId: tenant.id,
        product: tenant.product,
        installationId: installation.id,
        payload: { installationRef },
      },
      requestId,
    );
    return installation;
  }

  private async issueIn(
    tx: Transaction,
    principal: Principal,
    subscriptionId: string,
    request: { installationRef: string | null; expiresAt?: Date | undefined },
    requestId?: string,
  ) {
    const subscription = await tx.subscription.findUnique({
      where: { id: subscriptionId },
      include: WITH_TERMS,
    });
    if (subscription === null) throw notFound('The subscription');
    if (subscription.tenant.deploymentType !== DeploymentType.ON_PREMISES) {
      throw invalid(
        'A SaaS tenant is served its entitlements by its deployment, not by a licence.',
      );
    }
    const now = this.clock.now();
    const status = effectiveStatus(termOf(subscription), now);
    // The contract issues a licence ACTIVE or TRIAL only. A lapsed, suspended or cancelled
    // subscription gets no new licence; the installation keeps the one it has until it ends.
    if (status !== SubscriptionStatus.ACTIVE && status !== SubscriptionStatus.TRIAL) {
      throw conflict(
        'SUBSCRIPTION_NOT_LICENSABLE',
        `A ${status} subscription cannot be issued a licence.`,
        { status },
      );
    }

    let installation: { id: string; installationRef: string } | null = null;
    if (request.installationRef !== null) {
      const found = await tx.installation.findUnique({
        where: { installationRef: request.installationRef },
      });
      if (
        found === null ||
        found.tenantLinkId !== subscription.tenantLinkId ||
        found.status !== 'ACTIVE'
      ) {
        throw conflict(
          'INSTALLATION_NOT_ACTIVE',
          'That installation is not an active installation of this tenant.',
        );
      }
      installation = found;
    }

    const termEnd =
      status === SubscriptionStatus.TRIAL ? subscription.trialEndsAt : subscription.expiresAt;
    if (termEnd === null)
      throw conflict(
        'SUBSCRIPTION_HAS_NO_END',
        'A licence must end; this subscription has no term end.',
      );
    const ceiling = new Date(
      Math.min(termEnd.getTime(), now.getTime() + this.environment.LICENCE_MAX_TERM_DAYS * DAY),
    );
    // An unbound licence is for first activation only, so it is short whatever was asked.
    const unboundCeiling =
      installation === null
        ? new Date(Math.min(ceiling.getTime(), now.getTime() + 30 * DAY))
        : ceiling;
    const end =
      request.expiresAt === undefined
        ? unboundCeiling
        : new Date(Math.min(request.expiresAt.getTime(), unboundCeiling.getTime()));
    if (end <= now) throw invalid('The licence would already have ended.');

    const supersedes = await tx.licence.findFirst({
      where: { subscriptionId, installationId: installation?.id ?? null, revokedAt: null },
      orderBy: { issuedAt: 'desc' },
    });
    const snapshot = snapshotOf(subscription, subscription.tenant.customerId, now);
    const licenseId = newId();
    const isTrial = status === SubscriptionStatus.TRIAL;
    const payload: LicensePayload = {
      schemaVersion: 1,
      customerId: snapshot.customerId,
      tenantId: snapshot.tenantId,
      product: snapshot.product,
      deployment: DeploymentType.ON_PREMISES,
      subscriptionId,
      plan: snapshot.plan,
      status: isTrial ? SubscriptionStatus.TRIAL : SubscriptionStatus.ACTIVE,
      trialEndsAt: isTrial ? end.toISOString() : null,
      expiresAt: isTrial ? null : end.toISOString(),
      graceUntil: isTrial
        ? null
        : new Date(end.getTime() + subscription.planVersion.graceDays * DAY).toISOString(),
      features: snapshot.features,
      limits: snapshot.limits,
      licenseId,
      installationId: installation?.installationRef ?? null,
      issuedAt: now.toISOString(),
      notBefore: now.toISOString(),
      supersedes: supersedes?.id ?? null,
    };
    const token = await this.signer.sign((signer) => issueLicense(payload, signer));
    await tx.licence.create({
      data: {
        id: licenseId,
        subscriptionId,
        installationId: installation?.id ?? null,
        kid: this.environment.LICENCE_SIGNING_KID,
        token,
        payload: payload as unknown as Prisma.InputJsonObject,
        issuedAt: now,
        expiresAt: end,
        supersedesId: supersedes?.id ?? null,
        issuedBy: actorOf(principal),
      },
    });
    await this.audit.record(
      tx,
      principal,
      {
        action: AuditAction.LICENSE_ISSUED,
        customerId: subscription.tenant.customerId,
        tenantLinkId: subscription.tenantLinkId,
        product: subscription.tenant.product,
        subscriptionId,
        licenceId: licenseId,
        installationId: installation?.id ?? null,
        payload: {
          installationRef: installation?.installationRef ?? null,
          expiresAt: end.toISOString(),
          supersedes: supersedes?.id ?? null,
          kid: this.environment.LICENCE_SIGNING_KID,
        },
      },
      requestId,
    );
    return {
      id: licenseId,
      expiresAt: end.toISOString(),
      installationRef: installation?.installationRef ?? null,
      supersedes: supersedes?.id ?? null,
    };
  }
}
