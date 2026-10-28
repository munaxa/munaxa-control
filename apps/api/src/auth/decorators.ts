import { createParamDecorator, type ExecutionContext, SetMetadata } from '@nestjs/common';

import type { ControlPermission } from './permissions';
import type {
  AuthenticatedRequest,
  OperatorPrincipal,
  Principal,
  ServicePrincipal,
} from './principal';

export const AUDIENCE = 'control:audience';
export const REQUIRED_PERMISSIONS = 'control:permissions';
export const PUBLIC_ROUTE = 'control:public';
export const WITHHOLDS_SECRET = 'control:withholds-secret';

/**
 * Who a controller serves. Every controller declares one — the guard refuses a route that does
 * not — so an operator token can never reach a product route and a service credential can never
 * reach an administration route, however a path is written.
 */
export const ForOperators = (): ClassDecorator => SetMetadata(AUDIENCE, 'OPERATOR');
export const ForServices = (): ClassDecorator => SetMetadata(AUDIENCE, 'SERVICE');

/** Every one of these must be held. */
export const RequirePermission = (
  ...permissions: [ControlPermission, ...ControlPermission[]]
): MethodDecorator => SetMetadata(REQUIRED_PERMISSIONS, permissions);

/** Reachable with no credential; the reason is mandatory and says why. */
export const Public = (reason: string): MethodDecorator & ClassDecorator =>
  SetMetadata(PUBLIC_ROUTE, reason);

/**
 * The response carries a secret shown once (a new service credential). Its idempotency record keeps
 * only the response's `id`, never the body, and a replay is told the request succeeded rather than
 * shown the secret again: a secret at rest in a retry table is a secret stored.
 */
export const WithholdsSecret = (): MethodDecorator => SetMetadata(WITHHOLDS_SECRET, true);

export const CurrentOperator = createParamDecorator(
  (_: unknown, context: ExecutionContext): OperatorPrincipal => {
    const principal = context.switchToHttp().getRequest<AuthenticatedRequest>().principal;
    if (principal?.kind !== 'OPERATOR')
      throw new Error('CurrentOperator used outside an operator route');
    return principal;
  },
);

export const CurrentService = createParamDecorator(
  (_: unknown, context: ExecutionContext): ServicePrincipal => {
    const principal = context.switchToHttp().getRequest<AuthenticatedRequest>().principal;
    if (principal?.kind !== 'SERVICE')
      throw new Error('CurrentService used outside a service route');
    return principal;
  },
);

export const CurrentPrincipal = createParamDecorator(
  (_: unknown, context: ExecutionContext): Principal | undefined =>
    context.switchToHttp().getRequest<AuthenticatedRequest>().principal,
);

export const RequestId = createParamDecorator(
  (_: unknown, context: ExecutionContext): string | undefined =>
    context.switchToHttp().getRequest<AuthenticatedRequest>().requestId,
);
