import { Body, Controller, Get, Headers, Inject, Param, Post, Res } from '@nestjs/common';
import type { Response } from 'express';
import { z } from 'zod';

import { CurrentService, ForServices, RequestId } from '../auth/decorators';
import type { ServicePrincipal } from '../auth/principal';
import { ENVIRONMENT, type Environment } from '../config/environment';
import { isoDate } from '../core/http';
import { keySchema, productSchema } from '../core/products';
import { ZodPipe } from '../core/validation';
import { UsageService } from '../usage/usage.service';
import { EntitlementsService } from './entitlements.service';

const tenantRef = z.string().min(1).max(128);
const usageBody = z.object({
  reports: z
    .array(
      z.object({
        tenantId: tenantRef,
        metric: keySchema,
        value: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
        measuredAt: isoDate,
        installationId: z.string().min(1).max(128).optional(),
      }),
    )
    .min(1)
    .max(500),
});

/**
 * The product-facing API. Authenticated by a service credential only; an operator token is not
 * looked at on these routes.
 *
 * `GET …/entitlements` is the contract Munaxa Docs' `ControlPlaneLookup` already calls, and the
 * one School and Work use: `200` with an `EntitlementSnapshot`, or `404` when the tenant has no
 * subscription here (which a product reads as "nothing is included").
 */
@Controller({ path: 'products/:product' })
@ForServices()
export class ProductsController {
  constructor(
    @Inject(EntitlementsService) private readonly entitlements: EntitlementsService,
    @Inject(UsageService) private readonly usage: UsageService,
    @Inject(ENVIRONMENT) private readonly environment: Environment,
  ) {}

  @Get('tenants/:tenantId/entitlements')
  async entitlementsOf(
    @CurrentService() service: ServicePrincipal,
    @Param('product', new ZodPipe(productSchema)) product: string,
    @Param('tenantId', new ZodPipe(tenantRef)) tenantId: string,
    @Headers('if-none-match') ifNoneMatch: string | undefined,
    @Res({ passthrough: true }) response: Response,
  ) {
    const { snapshot, etag } = await this.entitlements.resolve(service, product, tenantId);
    // `private`: an entitlement answer is about one customer and must never sit in a shared cache.
    response.setHeader(
      'Cache-Control',
      `private, max-age=${String(this.environment.ENTITLEMENT_CACHE_SECONDS)}`,
    );
    response.setHeader('ETag', etag);
    if (ifNoneMatch === etag) {
      response.status(304);
      return undefined;
    }
    return snapshot;
  }

  @Post('usage')
  report(
    @CurrentService() service: ServicePrincipal,
    @Param('product', new ZodPipe(productSchema)) product: string,
    @Body(new ZodPipe(usageBody)) body: z.infer<typeof usageBody>,
    @RequestId() requestId?: string,
  ) {
    return this.usage.report(service, product, body.reports, requestId);
  }
}
