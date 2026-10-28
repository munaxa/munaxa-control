import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

import { ENVIRONMENT, type Environment } from '../config/environment';

/** One client, connected as the runtime role. */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleDestroy {
  constructor(@Inject(ENVIRONMENT) environment: Environment) {
    super({ datasources: { db: { url: environment.DATABASE_URL } } });
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}

export type Transaction = Parameters<Parameters<PrismaService['$transaction']>[0]>[0];
