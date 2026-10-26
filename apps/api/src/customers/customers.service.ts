import { Inject, Injectable } from '@nestjs/common';

import { AuditAction, AuditService } from '../audit/audit.service';
import type { Principal } from '../auth/principal';
import { actorOf } from '../auth/principal';
import { conflict, invalid, notFound } from '../core/errors';
import { newId } from '../core/ids';
import { PrismaService } from '../core/prisma.service';
import type { Product } from '../core/products';

export interface CustomerInput {
  readonly name: string;
  readonly legalName?: string | undefined;
  readonly country?: string | undefined;
  readonly contactEmail?: string | undefined;
}

export interface TenantInput {
  readonly product: Product;
  readonly tenantRef: string;
  readonly deploymentType: 'SAAS' | 'ON_PREMISES';
  readonly deploymentId?: string | undefined;
  readonly displayName: string;
}

/** Customers and the tenants they hold in each product. Nothing here is ever deleted. */
@Injectable()
export class CustomersService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  list(query: {
    search?: string | undefined;
    status?: string | undefined;
    limit: number;
    offset: number;
  }) {
    const where = {
      ...(query.status !== undefined && { status: query.status }),
      ...(query.search !== undefined &&
        query.search.trim() !== '' && {
          OR: [
            { name: { contains: query.search, mode: 'insensitive' as const } },
            { legalName: { contains: query.search, mode: 'insensitive' as const } },
            { contactEmail: { contains: query.search, mode: 'insensitive' as const } },
            { tenants: { some: { tenantRef: { equals: query.search } } } },
          ],
        }),
    };
    return this.prisma.$transaction([
      this.prisma.customer.findMany({
        where,
        orderBy: { name: 'asc' },
        skip: query.offset,
        take: query.limit,
        include: { _count: { select: { tenants: true } } },
      }),
      this.prisma.customer.count({ where }),
    ]);
  }

  async get(id: string) {
    const customer = await this.prisma.customer.findUnique({
      where: { id },
      include: {
        tenants: {
          orderBy: { createdAt: 'asc' },
          include: {
            deployment: true,
            subscriptions: {
              orderBy: { createdAt: 'desc' },
              include: { planVersion: { include: { plan: true } } },
            },
            installations: { orderBy: { registeredAt: 'desc' } },
          },
        },
      },
    });
    if (customer === null) throw notFound('The customer');
    return customer;
  }

  create(principal: Principal, input: CustomerInput, requestId?: string) {
    return this.prisma.$transaction(async (tx) => {
      const customer = await tx.customer.create({
        data: {
          id: newId(),
          name: input.name,
          legalName: input.legalName ?? null,
          country: input.country ?? null,
          contactEmail: input.contactEmail ?? null,
          createdBy: actorOf(principal),
        },
      });
      await this.audit.record(
        tx,
        principal,
        {
          action: AuditAction.CUSTOMER_CREATED,
          customerId: customer.id,
          payload: { name: customer.name },
        },
        requestId,
      );
      return customer;
    });
  }

  update(
    principal: Principal,
    id: string,
    expectedVersion: number,
    patch: Partial<CustomerInput> & { status?: 'ACTIVE' | 'CLOSED' | undefined },
    requestId?: string,
  ) {
    return this.prisma.$transaction(async (tx) => {
      const current = await tx.customer.findUnique({ where: { id } });
      if (current === null) throw notFound('The customer');
      // Optimistic: the version in the WHERE clause, so two operators editing at once cannot both win.
      const { count } = await tx.customer.updateMany({
        where: { id, version: expectedVersion },
        data: {
          ...(patch.name !== undefined && { name: patch.name }),
          ...(patch.legalName !== undefined && { legalName: patch.legalName }),
          ...(patch.country !== undefined && { country: patch.country }),
          ...(patch.contactEmail !== undefined && { contactEmail: patch.contactEmail }),
          ...(patch.status !== undefined && { status: patch.status }),
          version: { increment: 1 },
        },
      });
      if (count === 0)
        throw conflict(
          'VERSION_CONFLICT',
          'Someone else changed this customer first. Reload and try again.',
        );
      await this.audit.record(
        tx,
        principal,
        {
          action: AuditAction.CUSTOMER_UPDATED,
          customerId: id,
          payload: { changed: Object.keys(patch) },
        },
        requestId,
      );
      return tx.customer.findUniqueOrThrow({ where: { id } });
    });
  }

  linkTenant(principal: Principal, customerId: string, input: TenantInput, requestId?: string) {
    return this.prisma.$transaction(async (tx) => {
      const customer = await tx.customer.findUnique({ where: { id: customerId } });
      if (customer === null) throw notFound('The customer');
      if (customer.status !== 'ACTIVE')
        throw conflict('CUSTOMER_CLOSED', 'A closed customer cannot gain tenants.');
      if (input.deploymentType === 'SAAS') {
        if (input.deploymentId === undefined)
          throw invalid('A SaaS tenant names the deployment that serves it.');
        const deployment = await tx.productDeployment.findUnique({
          where: { id: input.deploymentId },
        });
        if (deployment === null) throw notFound('The deployment');
        // The tenant and the deployment must be the same product, or the deployment's credential
        // would be able to read another product's entitlements.
        if (deployment.product !== input.product) {
          throw invalid(
            `Deployment ${deployment.name} serves ${deployment.product}, not ${input.product}.`,
          );
        }
      } else if (input.deploymentId !== undefined) {
        throw invalid('An on-premises tenant is not served by a deployment.');
      }
      const tenant = await tx.tenantLink.create({
        data: {
          id: newId(),
          customerId,
          product: input.product,
          tenantRef: input.tenantRef,
          deploymentType: input.deploymentType,
          deploymentId: input.deploymentType === 'SAAS' ? (input.deploymentId ?? null) : null,
          displayName: input.displayName,
          createdBy: actorOf(principal),
        },
      });
      await this.audit.record(
        tx,
        principal,
        {
          action: AuditAction.TENANT_LINKED,
          customerId,
          tenantLinkId: tenant.id,
          product: tenant.product,
          payload: { tenantRef: tenant.tenantRef, deploymentType: tenant.deploymentType },
        },
        requestId,
      );
      return tenant;
    });
  }

  tenants(query: {
    product?: Product | undefined;
    search?: string | undefined;
    limit: number;
    offset: number;
  }) {
    return this.prisma.tenantLink.findMany({
      where: {
        ...(query.product !== undefined && { product: query.product }),
        ...(query.search !== undefined &&
          query.search !== '' && {
            OR: [
              { tenantRef: { contains: query.search } },
              { displayName: { contains: query.search, mode: 'insensitive' as const } },
            ],
          }),
      },
      include: { customer: true, deployment: true },
      orderBy: { createdAt: 'desc' },
      skip: query.offset,
      take: query.limit,
    });
  }
}
