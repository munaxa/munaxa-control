import type { ControlPermission } from './permissions';

/** A Munaxa Group staff member, authenticated by Munaxa Identity. */
export interface OperatorPrincipal {
  readonly kind: 'OPERATOR';
  /** Identity's stable subject. What every audit record names. */
  readonly subject: string;
  readonly permissions: ReadonlySet<ControlPermission>;
}

/** A product deployment, authenticated by its service credential. */
export interface ServicePrincipal {
  readonly kind: 'SERVICE';
  readonly credentialId: string;
  readonly deploymentId: string;
  /** The one product this deployment is. A request naming any other product is refused. */
  readonly product: string;
}

export type Principal = OperatorPrincipal | ServicePrincipal;

export interface AuthenticatedRequest {
  principal?: Principal;
  requestId?: string;
}

/** How an actor is written in `created_by` and audit rows. */
export const actorOf = (principal: Principal): string =>
  principal.kind === 'OPERATOR'
    ? `operator:${principal.subject}`
    : `service:${principal.credentialId}`;
