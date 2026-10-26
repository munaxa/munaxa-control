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

const tenantBody = z.object({
  product: productSchema,
  /** The product's own tenant identifier, exactly as the product sends it. */
  tenantRef: z.string().trim().min(1).max(128),
  deploymentType: z.enum(['SAAS', 'ON_PREMISES']),
  deploymentId: z.string().uuid().optional(),
  displayName: z.string().trim().min(1).max(200),
});

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
  constructor(@Inject(CustomersService) private readonly customers: CustomersService) {}

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
    return this.customers.linkTenant(operator, id, body, requestId);
  }

  @Get('tenants')
  @RequirePermission(ControlPermission.CUSTOMERS_READ)
  tenants(@Query(new ZodPipe(tenantQuery)) query: z.infer<typeof tenantQuery>) {
    return this.customers.tenants(query);
  }
}
