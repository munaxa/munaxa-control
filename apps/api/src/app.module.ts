import { type MiddlewareConsumer, Module, type NestModule } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { LoggerModule } from 'nestjs-pino';

import { AuditService } from './audit/audit.service';
import { AuthenticationGuard } from './auth/authentication.guard';
import {
  ACCESS_VERIFIER,
  CloudflareAccessVerifier,
  type FetchAccessKeys,
} from './auth/cloudflare-access';
import { CatalogueController } from './catalogue/catalogue.controller';
import { CatalogueService } from './catalogue/catalogue.service';
import { ENVIRONMENT, type Environment } from './config/environment';
import { CLOCK, systemClock, type Clock } from './core/clock';
import { ProblemFilter } from './core/errors';
import { IdempotencyInterceptor } from './core/idempotency.interceptor';
import { PrismaService } from './core/prisma.service';
import { RateLimitGuard, RateLimiter } from './core/rate-limit';
import { RequestIdMiddleware } from './core/request-id.middleware';
import { CustomersController } from './customers/customers.controller';
import { CustomersService } from './customers/customers.service';
import { EntitlementsService } from './entitlements/entitlements.service';
import { ProductsController } from './entitlements/products.controller';
import { HealthController } from './health/health.controller';
import {
  LicensingAdminController,
  LicensingPublicController,
} from './licensing/licensing.controller';
import { LICENCE_SIGNER, licenceSignerFor, type LicenceSigner } from './licensing/licence-signer';
import { LicensingService } from './licensing/licensing.service';
import { loggingOptions } from './observability/logging';
import { ReportsController } from './reports/reports.controller';
import { ReportsService } from './reports/reports.service';
import { SubscriptionsController } from './subscriptions/subscriptions.controller';
import { SubscriptionsService } from './subscriptions/subscriptions.service';
import { UsageService } from './usage/usage.service';

/**
 * The composition root. The environment and the clock are given, not read, so a test builds the
 * same application against its own database, keys and time. The licence signer is built from the
 * environment unless one is given (a test standing in for AWS KMS), and Cloudflare Access's keys are
 * read from its team domain unless a reader is given (a test standing in for Cloudflare).
 *
 * Two global guards, in order: the rate limiter (`core/rate-limit.ts`, ADR-0007), then the one
 * authentication guard, closed by default (`auth/authentication.guard.ts`); one global filter that
 * answers every error as RFC 7807 problem details; and the idempotency interceptor, which needs the
 * principal the guard established and so runs after it.
 */
@Module({})
export class AppModule implements NestModule {
  static with(
    environment: Environment,
    clock: Clock = systemClock,
    licenceSigner?: LicenceSigner,
    accessKeys?: FetchAccessKeys,
  ) {
    const access = environment.operatorAccess;
    return {
      module: AppModule,
      imports: [LoggerModule.forRoot(loggingOptions(environment))],
      controllers: [
        HealthController,
        CustomersController,
        CatalogueController,
        SubscriptionsController,
        LicensingAdminController,
        LicensingPublicController,
        ReportsController,
        ProductsController,
      ],
      providers: [
        { provide: ENVIRONMENT, useValue: environment },
        { provide: CLOCK, useValue: clock },
        licenceSigner === undefined
          ? { provide: LICENCE_SIGNER, useFactory: () => licenceSignerFor(environment) }
          : { provide: LICENCE_SIGNER, useValue: licenceSigner },
        {
          provide: ACCESS_VERIFIER,
          useValue:
            access === null
              ? null
              : new CloudflareAccessVerifier({
                  ...access,
                  clockSkewMs: environment.OPERATOR_AUTH_CLOCK_SKEW_MS,
                  now: () => clock.now().getTime(),
                  ...(accessKeys !== undefined && { fetchKeys: accessKeys }),
                }),
        },
        PrismaService,
        AuditService,
        CustomersService,
        CatalogueService,
        SubscriptionsService,
        LicensingService,
        EntitlementsService,
        UsageService,
        ReportsService,
        RateLimiter,
        { provide: APP_GUARD, useClass: RateLimitGuard },
        { provide: APP_GUARD, useClass: AuthenticationGuard },
        { provide: APP_FILTER, useClass: ProblemFilter },
        IdempotencyInterceptor,
        { provide: APP_INTERCEPTOR, useExisting: IdempotencyInterceptor },
      ],
    };
  }

  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestIdMiddleware).forRoutes('*splat');
  }
}
