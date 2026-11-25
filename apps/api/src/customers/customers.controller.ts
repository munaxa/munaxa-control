import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { Inject } from '@nestjs/common';
import { z } from 'zod';

import { CurrentOperator, ForOperators, RequestId, RequirePermission } from '../auth/decorators';
import { ControlPermission } from '../auth/permissions';
import type { OperatorPrincipal } from '../auth/principal';
import { expectedVersion, pageSchema, uuidParam } from '../core/http';
import { productSchema } from '../core/products';
import { ZodPipe } from '../core/validation';
import { CustomersService } from './customers.service';
import { TenantSightingsService } from './tenant-sightings.service';

const customerBody = z.object({
  name: z.string().trim().min(1).max(200),
  legalName: z.string().trim().min(1).max(300).optional(),
  country: z
    .string()
    .regex(/^[A-Z]{2}$/, 'ISO 3166-1 alpha-2')
    .optional(),
  contactEmail: z.string().email().max(320).optional(),
});

const customerPatch = customerBody.partial().extend({
  expectedVersion,
  status: z.enum(['ACTIVE', 'CLOSED']).optional(),
});

const manualTenantBody = z
  .object({
    product: productSchema,
    /** The product's own tenant identifier, exactly as the product sends it. */
    tenantRef: z.string().trim().min(1).max(128),
    deploymentType: z.enum(['SAAS', 'ON_PREMISES']),
    deploymentId: z.string().uuid().optional(),
    displayName: z.string().trim().min(1).max(200),
  })
  .strict();

/**
 * A tenant the product reported (`GET /admin/tenant-sightings`): the product, identifier and
 * deployment come from what the deployment's credential asked about, never from the form.
 */
const sightedTenantBody = z
  .object({
    sightingId: z.string().uuid(),
    displayName: z.string().trim().min(1).max(200).optional(),
  })
  .strict();

const tenantBody = z.union([sightedTenantBody, manualTenantBody]);

const sightingQuery = z.object({ product: productSchema.optional() });

const listQuery = pageSchema.extend({
  search: z.string().max(200).optional(),
  status: z.enum(['ACTIVE', 'CLOSED']).optional(),
});

const tenantQuery = pageSchema.extend({
  product: productSchema.optional(),
  search: z.string().max(200).optional(),
});

@Controller({ path: 'admin' })
@ForOperators()
export class CustomersController {
  constructor(
    @Inject(CustomersService) private readonly customers: CustomersService,
    @Inject(TenantSightingsService) private readonly sightings: TenantSightingsService,
  ) {}

  @Get('customers')
  @RequirePermission(ControlPermission.CUSTOMERS_READ)
  async list(@Query(new ZodPipe(listQuery)) query: z.infer<typeof listQuery>) {
    const [items, total] = await this.customers.list(query);
    return { items, total, limit: query.limit, offset: query.offset };
  }

  @Get('customers/:id')
  @RequirePermission(ControlPermission.CUSTOMERS_READ)
  get(@Param('id', new ZodPipe(uuidParam)) id: string) {
    return this.customers.get(id);
  }

  @Post('customers')
  @RequirePermission(ControlPermission.CUSTOMERS_WRITE)
  create(
    @CurrentOperator() operator: OperatorPrincipal,
    @Body(new ZodPipe(customerBody)) body: z.infer<typeof customerBody>,
    @RequestId() requestId?: string,
  ) {
    return this.customers.create(operator, body, requestId);
  }

  @Patch('customers/:id')
  @RequirePermission(ControlPermission.CUSTOMERS_WRITE)
  update(
    @CurrentOperator() operator: OperatorPrincipal,
    @Param('id', new ZodPipe(uuidParam)) id: string,
    @Body(new ZodPipe(customerPatch)) body: z.infer<typeof customerPatch>,
    @RequestId() requestId?: string,
  ) {
    const { expectedVersion: version, ...patch } = body;
    return this.customers.update(operator, id, version, patch, requestId);
  }

  @Post('customers/:id/tenants')
  @RequirePermission(ControlPermission.CUSTOMERS_WRITE)
  linkTenant(
    @CurrentOperator() operator: OperatorPrincipal,
    @Param('id', new ZodPipe(uuidParam)) id: string,
    @Body(new ZodPipe(tenantBody)) body: z.infer<typeof tenantBody>,
    @RequestId() requestId?: string,
  ) {
    if ('sightingId' in body) {
      return this.customers.linkSightedTenant(
        operator,
        id,
        body.sightingId,
        body.displayName,
        requestId,
      );
    }
    return this.customers.linkTenant(operator, id, body, requestId);
  }

  /**
   * Tenants a product deployment has asked about that no customer holds yet: what the portal offers
   * when linking, so a tenant identifier is picked rather than copied from the product by hand.
   */
  @Get('tenant-sightings')
  @RequirePermission(ControlPermission.CUSTOMERS_READ)
  tenantSightings(@Query(new ZodPipe(sightingQuery)) query: z.infer<typeof sightingQuery>) {
    return this.sightings.unlinked(query);
  }

  @Get('tenants')
  @RequirePermission(ControlPermission.CUSTOMERS_READ)
  tenants(@Query(new ZodPipe(tenantQuery)) query: z.infer<typeof tenantQuery>) {
    return this.customers.tenants(query);
  }
}
