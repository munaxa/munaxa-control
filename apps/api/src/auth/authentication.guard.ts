import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { TokenService } from '@munaxa/auth';
import { AsymmetricSigner } from '@munaxa/crypto';
import type { Request } from 'express';

import { ENVIRONMENT, type Environment } from '../config/environment';
import { CLOCK, type Clock } from '../core/clock';
import { PrismaService } from '../core/prisma.service';
import { AUDIENCE, PUBLIC_ROUTE, REQUIRED_PERMISSIONS } from './decorators';
import { controlGrantsFrom, type ControlPermission } from './permissions';
import type { AuthenticatedRequest, OperatorPrincipal, ServicePrincipal } from './principal';
import { parseServiceToken, secretMatches } from './service-credentials';

/**
 * The one guard. Closed by default and in this order:
 *
 * 1. A `@Public` route passes, and nothing else does without a credential.
 * 2. The controller's declared audience decides which credential is even looked at. An operator
 *    route reads only an Identity access token; a service route reads only a service credential.
 *    A controller that declares neither is refused outright, so a forgotten decorator is a 403
 *    rather than an open door.
 * 3. An operator token is verified against Identity's public keys — signature, expiry, issuer,
 *    audience — must belong to Munaxa Group's own organisation, and must carry every permission
 *    the route names. Permissions come from the token's `perms`, filtered to this catalogue.
 * 4. A service credential must exist, be unrevoked, and match.
 */
@Injectable()
export class AuthenticationGuard implements CanActivate {
  private readonly logger = new Logger(AuthenticationGuard.name);
  private readonly tokens: TokenService;

  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(ENVIRONMENT) private readonly environment: Environment,
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {
    this.tokens = new TokenService({
      signer: new AsymmetricSigner(environment.OPERATOR_AUTH_ALGORITHM, [
        ...environment.operatorPublicKeys,
      ]),
      issuer: environment.OPERATOR_AUTH_ISSUER,
      audience: environment.operatorAudience,
      clockSkew: environment.OPERATOR_AUTH_CLOCK_SKEW_MS,
      clock: { now: () => this.clock.now().getTime() },
    });
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const targets = [context.getHandler(), context.getClass()];
    if (this.reflector.getAllAndOverride<string | undefined>(PUBLIC_ROUTE, targets) !== undefined)
      return true;

    const request = context.switchToHttp().getRequest<Request & AuthenticatedRequest>();
    const audience = this.reflector.getAllAndOverride<'OPERATOR' | 'SERVICE' | undefined>(
      AUDIENCE,
      targets,
    );
    const bearer = bearerOf(request);

    if (audience === 'OPERATOR') {
      const operator = this.operatorFrom(bearer);
      const required = this.reflector.getAllAndOverride<ControlPermission[] | undefined>(
        REQUIRED_PERMISSIONS,
        targets,
      );
      if (required === undefined || required.length === 0) {
        // Every operator route names what it needs. One that does not is a defect, refused.
        throw new ForbiddenException('This route declares no permission.');
      }
      const missing = required.filter((permission) => !operator.permissions.has(permission));
      if (missing.length > 0) throw new ForbiddenException(`Requires ${missing.join(', ')}.`);
      request.principal = operator;
      return true;
    }
    if (audience === 'SERVICE') {
      request.principal = await this.serviceFrom(bearer);
      return true;
    }
    throw new ForbiddenException('This route declares no audience.');
  }

  private operatorFrom(bearer: string | null): OperatorPrincipal {
    if (bearer === null) throw new UnauthorizedException('Sign in with Munaxa Identity.');
    let claims: ReturnType<TokenService['verifyAccessToken']>;
    try {
      claims = this.tokens.verifyAccessToken(bearer);
    } catch {
      throw new UnauthorizedException('The access token is not valid.');
    }
    if (claims.tid !== this.environment.OPERATOR_ORGANISATION_ID) {
      // A valid token for somebody else's organisation. Logged by subject, never by token.
      this.logger.warn({ subject: claims.sub }, 'operator token from another organisation refused');
      throw new UnauthorizedException('This token is not for Munaxa Group.');
    }
    if (this.environment.OPERATOR_REQUIRE_MFA && claims.mfa !== true) {
      throw new UnauthorizedException('A second factor is required.');
    }
    return { kind: 'OPERATOR', subject: claims.sub, permissions: controlGrantsFrom(claims.perms) };
  }

  private async serviceFrom(bearer: string | null): Promise<ServicePrincipal> {
    const parsed = bearer === null ? null : parseServiceToken(bearer);
    if (parsed === null) throw new UnauthorizedException('A service credential is required.');
    const credential = await this.prisma.serviceCredential.findUnique({
      where: { id: parsed.credentialId },
      include: { deployment: true },
    });
    if (
      credential === null ||
      credential.revokedAt !== null ||
      !secretMatches(parsed.secret, credential.secretHash)
    ) {
      throw new UnauthorizedException('The service credential is not valid.');
    }
    // Best effort, and never on the request's critical path: a failed stamp is not a failed request.
    void this.prisma.serviceCredential
      .update({ where: { id: credential.id }, data: { lastUsedAt: this.clock.now() } })
      .catch(() => undefined);
    return {
      kind: 'SERVICE',
      credentialId: credential.id,
      deploymentId: credential.deploymentId,
      product: credential.deployment.product,
    };
  }
}

function bearerOf(request: Request): string | null {
  const header = request.header('authorization');
  if (header === undefined) return null;
  const [scheme, value] = header.split(' ');
  return scheme?.toLowerCase() === 'bearer' && value !== undefined && value.length > 0
    ? value
    : null;
}
