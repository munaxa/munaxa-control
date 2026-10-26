import { type INestApplication, RequestMethod } from '@nestjs/common';
import type { Express } from 'express';

import { bigintReplacer } from './core/json';

/**
 * Prefix and serialisation. Health stays unprefixed so a probe URL never moves with the API
 * version. `bigint` columns (usage values, audit ids) serialise as numbers when safe and as
 * strings when not, rather than throwing inside `JSON.stringify`.
 */
export function configureApplication(application: INestApplication): void {
  application.setGlobalPrefix('api/v1', {
    exclude: [{ path: 'health/*splat', method: RequestMethod.ALL }],
  });
  const express = application.getHttpAdapter().getInstance() as Express;
  express.set('json replacer', bigintReplacer);
  express.disable('x-powered-by');
  application.enableShutdownHooks();
}
