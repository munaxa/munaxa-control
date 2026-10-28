import {
  type CanActivate,
  type ExecutionContext,
  HttpStatus,
  Inject,
  Injectable,
} from '@nestjs/common';
import type { Request, Response } from 'express';

import { parseServiceToken } from '../auth/service-credentials';
import { ENVIRONMENT, type Environment } from '../config/environment';
import { CLOCK, type Clock } from './clock';
import { AppError } from './errors';

const WINDOW_MS = 60_000;

/**
 * More keys than this in one window is a flood of distinct clients, not traffic. The limiter then
 * refuses keys it has not seen rather than grow without bound: memory is the resource it protects.
 */
const MAX_KEYS = 50_000;

interface Window {
  readonly window: number;
  count: number;
}

/** Fixed one-minute windows, counted per key on the injected clock. One process's view. */
class Counter {
  private readonly counts = new Map<string, Window>();

  constructor(private readonly clock: Clock) {}

  /** The count after this hit, or `null` when the key could not be tracked. */
  hit(key: string): number | null {
    const window = this.windowNow();
    const current = this.counts.get(key);
    if (current !== undefined && current.window === window) return ++current.count;
    if (current === undefined && this.counts.size >= MAX_KEYS) {
      this.prune(window);
      if (this.counts.size >= MAX_KEYS) return null;
    }
    this.counts.set(key, { window, count: 1 });
    return 1;
  }

  count(key: string): number {
    const current = this.counts.get(key);
    return current !== undefined && current.window === this.windowNow() ? current.count : 0;
  }

  /** Seconds until the current window ends: what `Retry-After` says. */
  retryAfterSeconds(): number {
    const now = this.clock.now().getTime();
    return Math.max(1, Math.ceil((WINDOW_MS - (now % WINDOW_MS)) / 1000));
  }

  private windowNow(): number {
    return Math.floor(this.clock.now().getTime() / WINDOW_MS);
  }

  private prune(window: number): void {
    for (const [key, value] of this.counts) if (value.window !== window) this.counts.delete(key);
  }
}

/**
 * Abuse protection for every route but the probes — ADR-0007.
 *
 * - **Requests per client per minute.** A client is its IP address, except a request presenting a
 *   service credential, which counts against that credential: one product deployment's many
 *   tenants arrive from one egress address, and must not starve each other or share a budget with
 *   strangers behind the same NAT.
 * - **Failed authentications per IP per minute.** Past the limit, every request from that address
 *   is refused for the rest of the window, valid credential or not, so credentials cannot be
 *   guessed at speed. Counting by address is what makes inventing a fresh credential id for each
 *   guess useless.
 *
 * Per process: behind several replicas each enforces its own budget, so the front door's own rate
 * rule remains the outer bound (docs/operations/deployment.md).
 */
@Injectable()
export class RateLimiter {
  private readonly requests: Counter;
  private readonly failures: Counter;

  constructor(
    @Inject(ENVIRONMENT) private readonly environment: Environment,
    @Inject(CLOCK) clock: Clock,
  ) {
    this.requests = new Counter(clock);
    this.failures = new Counter(clock);
  }

  /** Throws `429` when the request may not proceed. */
  admit(request: Request, response: Response): void {
    const address = clientAddress(request);
    if (this.failures.count(address) >= this.environment.AUTH_FAILURE_LIMIT_PER_MINUTE) {
      throw this.refusal(
        response,
        'TOO_MANY_FAILED_ATTEMPTS',
        'Too many failed sign-in attempts from this address. Try again shortly.',
      );
    }
    const credential = serviceCredentialOf(request);
    const count = this.requests.hit(credential === null ? `ip:${address}` : `svc:${credential}`);
    const limit =
      credential === null
        ? this.environment.RATE_LIMIT_PER_MINUTE
        : this.environment.SERVICE_RATE_LIMIT_PER_MINUTE;
    if (count === null || count > limit) {
      throw this.refusal(response, 'RATE_LIMITED', 'Too many requests. Try again shortly.');
    }
  }

  /** Called by the authentication guard for every credential it refuses. */
  recordFailure(request: Request): void {
    this.failures.hit(clientAddress(request));
  }

  private refusal(response: Response, code: string, message: string): AppError {
    response.setHeader('Retry-After', String(this.requests.retryAfterSeconds()));
    return new AppError(HttpStatus.TOO_MANY_REQUESTS, code, message);
  }
}

/** The first global guard, so a refused client costs no token verification and no query. */
@Injectable()
export class RateLimitGuard implements CanActivate {
  constructor(@Inject(RateLimiter) private readonly limiter: RateLimiter) {}

  canActivate(context: ExecutionContext): boolean {
    const http = context.switchToHttp();
    const request = http.getRequest<Request>();
    // Probes come from the orchestrator, every few seconds, and must never be refused.
    if (request.path.startsWith('/health')) return true;
    this.limiter.admit(request, http.getResponse<Response>());
    return true;
  }
}

/**
 * `req.ip`, which honours `trust proxy` (`TRUST_PROXY_HOPS`) and so is the client's address behind
 * the load balancer rather than the balancer's. Never `X-Forwarded-For` read directly: a client
 * can write anything there.
 */
function clientAddress(request: Request): string {
  return request.ip ?? request.socket.remoteAddress ?? 'unknown';
}

function serviceCredentialOf(request: Request): string | null {
  const header = request.header('authorization');
  if (header === undefined) return null;
  const [scheme, value] = header.split(' ');
  if (scheme?.toLowerCase() !== 'bearer' || value === undefined) return null;
  return parseServiceToken(value)?.credentialId ?? null;
}
