import { Body, Controller, Get, Header, Inject, Param, Post, Res } from '@nestjs/common';
import type { Response } from 'express';
import { z } from 'zod';

import {
  CurrentOperator,
  ForOperators,
  Public,
  RequestId,
  RequirePermission,
} from '../auth/decorators';
import { ControlPermission } from '../auth/permissions';
import type { OperatorPrincipal } from '../auth/principal';
import { isoDate, reasonSchema, uuidParam } from '../core/http';
import { ZodPipe } from '../core/validation';
import { LicensingService, REVOCATION_CATEGORIES } from './licensing.service';

const installationRef = z.string().trim().min(1).max(128);
const issueBody = z.object({
  installationRef: installationRef.nullable(),
  expiresAt: isoDate.optional(),
});
const registerBody = z.object({ installationRef });
const activationBody = z.object({ code: z.string().trim().min(16).max(4_096) });
const revokeBody = z.object({ reason: reasonSchema, category: z.enum(REVOCATION_CATEGORIES) });
const productParam = z.string().regex(/^[a-z][a-z0-9-]{1,31}$/);

@Controller({ path: 'admin' })
@ForOperators()
export class LicensingAdminController {
  constructor(@Inject(LicensingService) private readonly licensing: LicensingService) {}

  @Post('subscriptions/:id/licences')
  @RequirePermission(ControlPermission.LICENCES_ISSUE)
  issue(
    @CurrentOperator() operator: OperatorPrincipal,
    @Param('id', new ZodPipe(uuidParam)) id: string,
    @Body(new ZodPipe(issueBody)) body: z.infer<typeof issueBody>,
    @RequestId() requestId?: string,
  ) {
    return this.licensing.issue(operator, id, body, requestId);
  }

  @Get('tenants/:id/installations')
  @RequirePermission(ControlPermission.SUBSCRIPTIONS_READ)
  installations(@Param('id', new ZodPipe(uuidParam)) id: string) {
    return this.licensing.installations(id);
  }

  @Post('tenants/:id/installations')
  @RequirePermission(ControlPermission.LICENCES_ISSUE)
  register(
    @CurrentOperator() operator: OperatorPrincipal,
    @Param('id', new ZodPipe(uuidParam)) id: string,
    @Body(new ZodPipe(registerBody)) body: z.infer<typeof registerBody>,
    @RequestId() requestId?: string,
  ) {
    return this.licensing.registerInstallation(operator, id, body.installationRef, requestId);
  }

  /** Paste an installation's activation request (first activation, renewal, or a replaced server). */
  @Post('activations')
  @RequirePermission(ControlPermission.LICENCES_ISSUE)
  activate(
    @CurrentOperator() operator: OperatorPrincipal,
    @Body(new ZodPipe(activationBody)) body: z.infer<typeof activationBody>,
    @RequestId() requestId?: string,
  ) {
    return this.licensing.activate(operator, body.code, requestId);
  }

  @Post('licences/:id/revoke')
  @RequirePermission(ControlPermission.LICENCES_ISSUE)
  revoke(
    @CurrentOperator() operator: OperatorPrincipal,
    @Param('id', new ZodPipe(uuidParam)) id: string,
    @Body(new ZodPipe(revokeBody)) body: z.infer<typeof revokeBody>,
    @RequestId() requestId?: string,
  ) {
    return this.licensing.revoke(operator, id, body.reason, body.category, requestId);
  }

  /**
   * The product's signed revocation list, for installations that cannot reach this service: every
   * licence of the product ever revoked. Delivered like a licence file, next to it.
   */
  @Get('products/:product/revocation-list')
  @RequirePermission(ControlPermission.LICENCES_ISSUE)
  @Header('Cache-Control', 'no-store')
  async revocationList(
    @CurrentOperator() operator: OperatorPrincipal,
    @Param('product', new ZodPipe(productParam)) product: string,
    @Res() response: Response,
    @RequestId() requestId?: string,
  ): Promise<void> {
    const file = await this.licensing.revocationList(operator, product, requestId);
    response
      .type('application/x-munaxa-revocation-list')
      .setHeader('Content-Disposition', `attachment; filename="${file.filename}"`)
      .send(file.body);
  }

  @Get('licences/:id/download')
  @RequirePermission(ControlPermission.LICENCES_ISSUE)
  @Header('Cache-Control', 'no-store')
  async download(
    @Param('id', new ZodPipe(uuidParam)) id: string,
    @Res() response: Response,
  ): Promise<void> {
    const file = await this.licensing.download(id);
    response
      .type('application/x-munaxa-license')
      .setHeader('Content-Disposition', `attachment; filename="${file.filename}"`)
      .send(file.body);
  }
}

/** The public half of the signing keys, for installations and their installers. */
@Controller({ path: 'licensing' })
export class LicensingPublicController {
  constructor(@Inject(LicensingService) private readonly licensing: LicensingService) {}

  @Get('public-keys')
  @Public(
    'Verification keys are public by construction; an installer fetches them before it holds any credential.',
  )
  @Header('Cache-Control', 'public, max-age=3600')
  keys() {
    return { keys: this.licensing.publicKeys() };
  }
}
