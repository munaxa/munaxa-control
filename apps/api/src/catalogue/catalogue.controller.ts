import { Body, Controller, Get, Inject, Param, Post, Put, Query } from '@nestjs/common';
import { z } from 'zod';

import { CurrentOperator, ForOperators, RequestId, RequirePermission } from '../auth/decorators';
import { ControlPermission } from '../auth/permissions';
import type { OperatorPrincipal } from '../auth/principal';
import { uuidParam } from '../core/http';
import { keySchema, productSchema } from '../core/products';
import { ZodPipe } from '../core/validation';
import { CatalogueService } from './catalogue.service';

const productQuery = z.object({ product: productSchema.optional() });

const deploymentBody = z.object({
  product: productSchema,
  name: z
    .string()
    .trim()
    .regex(/^[a-z0-9][a-z0-9-]{1,62}$/, 'lowercase letters, digits and hyphens'),
});

const credentialBody = z.object({ label: z.string().trim().min(1).max(100) });

const planBody = z.object({
  product: productSchema,
  code: keySchema,
  name: z.string().trim().min(1).max(200),
  description: z.string().max(2_000).optional(),
});

/** Terms of a version: what the product's own catalogue defines, plus informational pricing. */
const termsBody = z.object({
  features: z.array(keySchema).max(200),
  limits: z.record(keySchema, z.number().int().min(0).nullable()),
  priceMinor: z.number().int().min(0).nullable().optional(),
  currency: z
    .string()
    .regex(/^[A-Z]{3}$/, 'ISO 4217')
    .nullable()
    .optional(),
  billingPeriod: z.enum(['MONTHLY', 'YEARLY']).nullable().optional(),
  trialDays: z.number().int().min(0).max(365).default(0),
  graceDays: z.number().int().min(0).max(180).default(14),
});

@Controller({ path: 'admin' })
@ForOperators()
export class CatalogueController {
  constructor(@Inject(CatalogueService) private readonly catalogue: CatalogueService) {}

  @Get('deployments')
  @RequirePermission(ControlPermission.CATALOGUE_READ)
  deployments(@Query(new ZodPipe(productQuery)) query: z.infer<typeof productQuery>) {
    return this.catalogue.deployments(query.product);
  }

  @Post('deployments')
  @RequirePermission(ControlPermission.CATALOGUE_WRITE)
  createDeployment(
    @CurrentOperator() operator: OperatorPrincipal,
    @Body(new ZodPipe(deploymentBody)) body: z.infer<typeof deploymentBody>,
    @RequestId() requestId?: string,
  ) {
    return this.catalogue.createDeployment(operator, body, requestId);
  }

  /** The response carries the secret, once. It is never retrievable again. */
  @Post('deployments/:id/credentials')
  @RequirePermission(ControlPermission.CREDENTIALS_MANAGE)
  issueCredential(
    @CurrentOperator() operator: OperatorPrincipal,
    @Param('id', new ZodPipe(uuidParam)) id: string,
    @Body(new ZodPipe(credentialBody)) body: z.infer<typeof credentialBody>,
    @RequestId() requestId?: string,
  ) {
    return this.catalogue.issueCredential(operator, id, body.label, requestId);
  }

  @Post('credentials/:id/revoke')
  @RequirePermission(ControlPermission.CREDENTIALS_MANAGE)
  revokeCredential(
    @CurrentOperator() operator: OperatorPrincipal,
    @Param('id', new ZodPipe(uuidParam)) id: string,
    @RequestId() requestId?: string,
  ) {
    return this.catalogue.revokeCredential(operator, id, requestId);
  }

  @Get('plans')
  @RequirePermission(ControlPermission.CATALOGUE_READ)
  plans(@Query(new ZodPipe(productQuery)) query: z.infer<typeof productQuery>) {
    return this.catalogue.plans(query.product);
  }

  @Get('plans/:id')
  @RequirePermission(ControlPermission.CATALOGUE_READ)
  plan(@Param('id', new ZodPipe(uuidParam)) id: string) {
    return this.catalogue.plan(id);
  }

  @Post('plans')
  @RequirePermission(ControlPermission.CATALOGUE_WRITE)
  createPlan(
    @CurrentOperator() operator: OperatorPrincipal,
    @Body(new ZodPipe(planBody)) body: z.infer<typeof planBody>,
    @RequestId() requestId?: string,
  ) {
    return this.catalogue.createPlan(operator, body, requestId);
  }

  @Post('plans/:id/versions')
  @RequirePermission(ControlPermission.CATALOGUE_WRITE)
  draft(
    @CurrentOperator() operator: OperatorPrincipal,
    @Param('id', new ZodPipe(uuidParam)) id: string,
    @Body(new ZodPipe(termsBody)) body: z.infer<typeof termsBody>,
    @RequestId() requestId?: string,
  ) {
    return this.catalogue.draftVersion(operator, id, body, requestId);
  }

  @Put('plan-versions/:id')
  @RequirePermission(ControlPermission.CATALOGUE_WRITE)
  updateDraft(
    @CurrentOperator() operator: OperatorPrincipal,
    @Param('id', new ZodPipe(uuidParam)) id: string,
    @Body(new ZodPipe(termsBody)) body: z.infer<typeof termsBody>,
    @RequestId() requestId?: string,
  ) {
    return this.catalogue.updateDraft(operator, id, body, requestId);
  }

  @Post('plan-versions/:id/publish')
  @RequirePermission(ControlPermission.CATALOGUE_WRITE)
  publish(
    @CurrentOperator() operator: OperatorPrincipal,
    @Param('id', new ZodPipe(uuidParam)) id: string,
    @RequestId() requestId?: string,
  ) {
    return this.catalogue.publish(operator, id, requestId);
  }

  @Post('plan-versions/:id/retire')
  @RequirePermission(ControlPermission.CATALOGUE_WRITE)
  retire(
    @CurrentOperator() operator: OperatorPrincipal,
    @Param('id', new ZodPipe(uuidParam)) id: string,
    @RequestId() requestId?: string,
  ) {
    return this.catalogue.retire(operator, id, requestId);
  }
}
