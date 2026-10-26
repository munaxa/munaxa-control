import { Body, Controller, Get, Inject, Param, Post, Put, Query } from '@nestjs/common';
import { LifecycleEvent } from '@munaxa/licensing';
import { z } from 'zod';

import { CurrentOperator, ForOperators, RequestId, RequirePermission } from '../auth/decorators';
import { ControlPermission } from '../auth/permissions';
import type { OperatorPrincipal } from '../auth/principal';
import { expectedVersion, isoDate, pageSchema, reasonSchema, uuidParam } from '../core/http';
import { keySchema, productSchema } from '../core/products';
import { ZodPipe } from '../core/validation';
import { SubscriptionsService } from './subscriptions.service';

const listQuery = pageSchema.extend({
  product: productSchema.optional(),
  status: z
    .enum(['TRIAL', 'ACTIVE', 'PAST_DUE', 'GRACE_PERIOD', 'EXPIRED', 'SUSPENDED', 'CANCELLED'])
    .optional(),
  customerId: z.string().uuid().optional(),
  expiringBefore: isoDate.optional(),
});

const createBody = z.object({
  tenantLinkId: z.string().uuid(),
  planVersionId: z.string().uuid(),
  start: z.enum(['TRIAL', 'ACTIVE']),
  startsAt: isoDate.optional(),
  expiresAt: isoDate.optional(),
  reason: reasonSchema.optional(),
});

const transitionBody = z.object({
  event: z.nativeEnum(LifecycleEvent),
  expectedVersion,
  expiresAt: isoDate.optional(),
  reason: reasonSchema.optional(),
});

const planChangeBody = z.object({
  planVersionId: z.string().uuid(),
  expectedVersion,
  reason: reasonSchema.optional(),
});

const overridesBody = z.object({
  expectedVersion,
  features: z.object({ add: z.array(keySchema).max(100), remove: z.array(keySchema).max(100) }),
  limits: z.record(keySchema, z.number().int().min(0).nullable()),
  reason: reasonSchema,
});

@Controller({ path: 'admin/subscriptions' })
@ForOperators()
export class SubscriptionsController {
  constructor(@Inject(SubscriptionsService) private readonly subscriptions: SubscriptionsService) {}

  @Get()
  @RequirePermission(ControlPermission.SUBSCRIPTIONS_READ)
  list(@Query(new ZodPipe(listQuery)) query: z.infer<typeof listQuery>) {
    return this.subscriptions.list(query);
  }

  @Get(':id')
  @RequirePermission(ControlPermission.SUBSCRIPTIONS_READ)
  get(@Param('id', new ZodPipe(uuidParam)) id: string) {
    return this.subscriptions.get(id);
  }

  @Post()
  @RequirePermission(ControlPermission.SUBSCRIPTIONS_WRITE)
  async create(
    @CurrentOperator() operator: OperatorPrincipal,
    @Body(new ZodPipe(createBody)) body: z.infer<typeof createBody>,
    @RequestId() requestId?: string,
  ) {
    return this.subscriptions.get(await this.subscriptions.create(operator, body, requestId));
  }

  /** Activate, renew, mark past due, enter grace, expire, suspend, reactivate or cancel. */
  @Post(':id/transitions')
  @RequirePermission(ControlPermission.SUBSCRIPTIONS_WRITE)
  async transition(
    @CurrentOperator() operator: OperatorPrincipal,
    @Param('id', new ZodPipe(uuidParam)) id: string,
    @Body(new ZodPipe(transitionBody)) body: z.infer<typeof transitionBody>,
    @RequestId() requestId?: string,
  ) {
    return this.subscriptions.get(
      await this.subscriptions.transition(operator, id, body, requestId),
    );
  }

  /** Upgrade or downgrade to another published version of the same product. */
  @Post(':id/plan')
  @RequirePermission(ControlPermission.SUBSCRIPTIONS_WRITE)
  async changePlan(
    @CurrentOperator() operator: OperatorPrincipal,
    @Param('id', new ZodPipe(uuidParam)) id: string,
    @Body(new ZodPipe(planChangeBody)) body: z.infer<typeof planChangeBody>,
    @RequestId() requestId?: string,
  ) {
    return this.subscriptions.get(
      await this.subscriptions.changePlan(operator, id, body, requestId),
    );
  }

  @Put(':id/overrides')
  @RequirePermission(ControlPermission.SUBSCRIPTIONS_WRITE)
  async overrides(
    @CurrentOperator() operator: OperatorPrincipal,
    @Param('id', new ZodPipe(uuidParam)) id: string,
    @Body(new ZodPipe(overridesBody)) body: z.infer<typeof overridesBody>,
    @RequestId() requestId?: string,
  ) {
    return this.subscriptions.get(
      await this.subscriptions.setOverrides(operator, id, body, requestId),
    );
  }
}
