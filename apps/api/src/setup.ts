import { type INestApplication, RequestMethod } from '@nestjs/common';
import type { Express, NextFunction, Request, Response } from 'express';

import type { Environment } from './config/environment';
import { bigintReplacer } from './core/json';

/**
 * Prefix and serialisation. Health stays unprefixed so a probe URL never moves with the API
 * version. `bigint` columns (usage values, audit ids) serialise as numbers when safe and as
 * strings when not, rather than throwing inside `JSON.stringify`.
 *
 * `trust proxy` is the number of proxies in front (`TRUST_PROXY_HOPS`), so `req.ip` — what the
 * rate limiter counts by — is the client's address and not the load balancer's, without trusting
 * an `X-Forwarded-For` a client wrote itself.
 */
export function configureApplication(
  application: INestApplication,
  environment: Environment,
): void {
  application.setGlobalPrefix('api/v1', {
    exclude: [{ path: 'health/*splat', method: RequestMethod.ALL }],
  });
  const express = application.getHttpAdapter().getInstance() as Express;
  express.set('json replacer', bigintReplacer);
  express.set('trust proxy', environment.TRUST_PROXY_HOPS);
  express.disable('x-powered-by');
  express.use(securityHeaders(environment.NODE_ENV === 'production'));
  application.enableShutdownHooks();
}

/**
 * Every answer is JSON for a machine or the portal's server, never a page: nothing may frame it,
 * sniff it into something else, or keep it. `no-store` matters most — answers carry licences,
 * entitlements and, once, a service credential's secret, and no shared cache may hold them. The
 * entitlement route sets its own `private, max-age` after this and wins, as it should.
 */
function securityHeaders(production: boolean) {
  return (_request: Request, response: Response, next: NextFunction): void => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('X-Frame-Options', 'DENY');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    response.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
    if (production) {
      response.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    }
    next();
  };
}
