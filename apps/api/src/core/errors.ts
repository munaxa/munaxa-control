import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { Request, Response } from 'express';

/**
 * A failure this service means to report. Its `code` is stable and documented; its message is
 * safe to show an operator. Anything else that escapes is a 500 with no detail.
 */
export class AppError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const notFound = (what: string): AppError =>
  new AppError(HttpStatus.NOT_FOUND, 'NOT_FOUND', `${what} was not found.`);
export const conflict = (
  code: string,
  message: string,
  details: Record<string, unknown> = {},
): AppError => new AppError(HttpStatus.CONFLICT, code, message, details);
export const invalid = (message: string, details: Record<string, unknown> = {}): AppError =>
  new AppError(HttpStatus.UNPROCESSABLE_ENTITY, 'VALIDATION_FAILED', message, details);

interface Problem {
  type: string;
  title: string;
  status: number;
  code: string;
  detail?: string;
  requestId?: string;
  details?: Readonly<Record<string, unknown>>;
}

/** RFC 7807 problem details for every error, as the products' APIs answer. */
@Catch()
export class ProblemFilter implements ExceptionFilter {
  private readonly logger = new Logger(ProblemFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const context = host.switchToHttp();
    const response = context.getResponse<Response>();
    const request = context.getRequest<Request & { requestId?: string }>();
    const problem = this.toProblem(exception);
    if (request.requestId !== undefined) problem.requestId = request.requestId;
    if (problem.status >= 500) {
      this.logger.error({ err: exception, requestId: request.requestId }, 'request failed');
    }
    response.status(problem.status).type('application/problem+json').json(problem);
  }

  private toProblem(exception: unknown): Problem {
    if (exception instanceof AppError) {
      return {
        type: 'about:blank',
        title: HttpStatus[exception.status] ?? 'Error',
        status: exception.status,
        code: exception.code,
        detail: exception.message,
        ...(Object.keys(exception.details).length > 0 && { details: exception.details }),
      };
    }
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const body = exception.getResponse();
      const detail =
        typeof body === 'string'
          ? body
          : typeof body === 'object' && body !== null && 'message' in body
            ? String(body.message)
            : undefined;
      return {
        type: 'about:blank',
        title: HttpStatus[status] ?? 'Error',
        status,
        code: HttpStatus[status] ?? 'ERROR',
        ...(detail !== undefined && status < 500 && { detail }),
      };
    }
    if (exception instanceof Prisma.PrismaClientKnownRequestError && exception.code === 'P2002') {
      return {
        type: 'about:blank',
        title: 'CONFLICT',
        status: 409,
        code: 'DUPLICATE',
        detail: 'That already exists.',
      };
    }
    // A database rule this service relies on (a check constraint, the plan-version trigger)
    // refused the write. It is a conflict with the record's state, not a server fault.
    if (
      exception instanceof Prisma.PrismaClientUnknownRequestError &&
      /check_violation|23514/.test(exception.message)
    ) {
      return {
        type: 'about:blank',
        title: 'CONFLICT',
        status: 409,
        code: 'RULE_VIOLATED',
        detail: 'The record does not permit that change.',
      };
    }
    return { type: 'about:blank', title: 'INTERNAL_SERVER_ERROR', status: 500, code: 'INTERNAL' };
  }
}
