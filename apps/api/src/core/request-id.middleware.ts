import { randomUUID } from 'node:crypto';

import { Injectable, type NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';

const ACCEPTABLE = /^[A-Za-z0-9._-]{1,64}$/;

/** A request id on every request and response, propagated from a caller that sent a sane one. */
@Injectable()
export class RequestIdMiddleware implements NestMiddleware {
  use(request: Request & { requestId?: string }, response: Response, next: NextFunction): void {
    const offered = request.header('x-request-id');
    request.requestId = offered !== undefined && ACCEPTABLE.test(offered) ? offered : randomUUID();
    response.setHeader('x-request-id', request.requestId);
    next();
  }
}
