import { Controller, Get, Inject, ServiceUnavailableException } from '@nestjs/common';

import { Public } from '../auth/decorators';
import { PrismaService } from '../core/prisma.service';

/** Probes. Never licensed, never authenticated, and never carrying anything about a customer. */
@Controller({ path: 'health' })
export class HealthController {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  @Get('live')
  @Public('An orchestrator probe holds no credential.')
  live() {
    return { status: 'ok' };
  }

  @Get('ready')
  @Public('An orchestrator probe holds no credential.')
  async ready() {
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      return { status: 'ok' };
    } catch {
      throw new ServiceUnavailableException('database unavailable');
    }
  }
}
