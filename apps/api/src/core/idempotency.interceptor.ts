import { createHash } from 'node:crypto';

import {
  type CallHandler,
  type ExecutionContext,
  Inject,
  Injectable,
  type NestInterceptor,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Prisma } from '@prisma/client';
import type { Request, Response } from 'express';
import { catchError, from, type Observable, of, switchMap, throwError } from 'rxjs';

import { WITHHOLDS_SECRET } from '../auth/decorators';
import { actorOf, type AuthenticatedRequest } from '../auth/principal';
import { ENVIRONMENT, type Environment } from '../config/environment';
import { CLOCK, type Clock } from './clock';
import { AppError } from './errors';
import { bigintReplacer } from './json';
import { PrismaService } from './prisma.service';

const KEY = /^[A-Za-z0-9_-]{8,128}$/;
const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * `Idempotency-Key` on any mutating request, so a retry never performs an action twice.
 *
 * The key is **claimed before the request runs**: the first request to insert its row owns it, and
 * that insert is decided by the primary key, atomically across every process. While the owner runs,
 * a duplicate gets `409 REQUEST_IN_PROGRESS` and retries; once it has answered, a duplicate with the
 * same body gets that answer replayed (`Idempotent-Replay: true`). The same key with a different
 * body is `409 IDEMPOTENCY_KEY_REUSED` — a different request wearing a used key.
 *
 * A request whose action fails releases its claim, so it may be retried and succeed. The guarantee
 * that matters (a licence issued once, a subscription created once) is about successes.
 */
const IN_PROGRESS = 0;

@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(ENVIRONMENT) private readonly environment: Environment,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(Reflector) private readonly reflector: Reflector,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const http = context.switchToHttp();
    const request = http.getRequest<Request & AuthenticatedRequest>();
    const key = request.header('idempotency-key');
    if (key === undefined || !MUTATING.has(request.method) || request.principal === undefined) {
      return next.handle();
    }
    if (!KEY.test(key)) {
      throw new AppError(
        400,
        'INVALID_IDEMPOTENCY_KEY',
        'Idempotency-Key must be 8–128 URL-safe characters.',
      );
    }

    const actor = actorOf(request.principal);
    const path = request.originalUrl.split('?')[0] ?? request.originalUrl;
    const requestHash = createHash('sha256')
      .update(`${request.method} ${path}\n${JSON.stringify(request.body ?? null, bigintReplacer)}`)
      .digest('hex');
    const response = http.getResponse<Response>();
    const where = { actor_key: { actor, key } };
    const withholds =
      this.reflector.get<boolean | undefined>(WITHHOLDS_SECRET, context.getHandler()) === true;

    return from(this.claim(actor, key, request.method, path, requestHash)).pipe(
      switchMap((existing) => {
        if (existing !== null) {
          if (existing.requestHash !== requestHash) {
            throw new AppError(
              409,
              'IDEMPOTENCY_KEY_REUSED',
              'That Idempotency-Key was used for a different request.',
            );
          }
          if (existing.status === IN_PROGRESS) {
            throw new AppError(
              409,
              'REQUEST_IN_PROGRESS',
              'The first request with this key has not answered yet. Retry shortly.',
            );
          }
          if (isWithheld(existing.response)) {
            throw new AppError(
              409,
              'SECRET_NOT_REPLAYED',
              'This request already succeeded. Its secret was shown once and is not kept; revoke it and issue another if it was lost.',
              { id: existing.response.id },
            );
          }
          response.status(existing.status).setHeader('idempotent-replay', 'true');
          return of(existing.response);
        }
        return next.handle().pipe(
          // Only a failure of the action itself releases the claim. Once the action has succeeded
          // the claim is never released: if recording its answer failed, a retry must not run it
          // again, so the key stays in progress until it expires.
          catchError((error: unknown) =>
            from(this.prisma.idempotencyRecord.delete({ where }).catch(() => undefined)).pipe(
              switchMap(() => throwError(() => error)),
            ),
          ),
          switchMap((body: unknown) =>
            from(
              this.prisma.idempotencyRecord.update({
                where,
                data: {
                  status: response.statusCode,
                  response: (withholds
                    ? withheld(body)
                    : body === undefined
                      ? {}
                      : JSON.parse(JSON.stringify(body, bigintReplacer))) as Prisma.InputJsonValue,
                },
              }),
            ).pipe(switchMap(() => of(body))),
          ),
        );
      }),
    );
  }

  /**
   * Deletes the records past retention. A record is only ever needed while its key may be retried;
   * after that it is a copy of a response nobody will ask for again. Run by the sweep.
   */
  async purgeExpired(): Promise<number> {
    const cutoff = new Date(
      this.clock.now().getTime() - this.environment.IDEMPOTENCY_RETENTION_HOURS * 3_600_000,
    );
    const { count } = await this.prisma.idempotencyRecord.deleteMany({
      where: { createdAt: { lt: cutoff } },
    });
    return count;
  }

  /** `null` when this request now owns the key; otherwise the record that already holds it. */
  private async claim(
    actor: string,
    key: string,
    method: string,
    path: string,
    requestHash: string,
  ) {
    const where = { actor_key: { actor, key } };
    const retention = this.environment.IDEMPOTENCY_RETENTION_HOURS * 3_600_000;
    const stale = await this.prisma.idempotencyRecord.findUnique({ where });
    if (stale !== null && this.clock.now().getTime() - stale.createdAt.getTime() >= retention) {
      await this.prisma.idempotencyRecord.deleteMany({
        where: { actor, key, createdAt: stale.createdAt },
      });
    }
    try {
      await this.prisma.idempotencyRecord.create({
        data: {
          actor,
          key,
          method,
          path,
          requestHash,
          status: IN_PROGRESS,
          // The same clock the retention check reads, never the database's: two clocks disagreeing
          // made a fresh record look expired and the request ran twice.
          createdAt: this.clock.now(),
          // Not yet answered; the column is NOT NULL and the status says what this means.
          response: {},
        },
      });
      return null;
    } catch (error) {
      if (!(error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002'))
        throw error;
      return this.prisma.idempotencyRecord.findUniqueOrThrow({ where });
    }
  }
}

/** What a secret-bearing response leaves in its idempotency record: that it happened, and its id. */
function withheld(body: unknown): { readonly secretWithheld: true; readonly id: string | null } {
  const id =
    typeof body === 'object' && body !== null && typeof (body as { id?: unknown }).id === 'string'
      ? (body as { id: string }).id
      : null;
  return { secretWithheld: true, id };
}

function isWithheld(value: unknown): value is { secretWithheld: true; id: string | null } {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { secretWithheld?: unknown }).secretWithheld === true
  );
}
