import 'reflect-metadata';

import { NestFactory } from '@nestjs/core';

import { AppModule } from './app.module';
import { loadEnvironment } from './config/environment';
import { IdempotencyInterceptor } from './core/idempotency.interceptor';
import { SubscriptionsService } from './subscriptions/subscriptions.service';

/**
 * Records the status moves term dates have already made, and deletes idempotency records past
 * retention. Safe to run as often as wanted; run it at
 * least daily from the scheduler (docs/operations/deployment.md). Exits non-zero on failure.
 */
async function sweep(): Promise<void> {
  const application = await NestFactory.createApplicationContext(
    AppModule.with(loadEnvironment(process.env)),
    {
      logger: ['error', 'warn'],
    },
  );
  try {
    const moved = await application.get(SubscriptionsService).sweep();
    const purged = await application.get(IdempotencyInterceptor).purgeExpired();
    process.stdout.write(`${JSON.stringify({ event: 'sweep', moved, purged })}\n`);
  } finally {
    await application.close();
  }
}

sweep().catch((error: unknown) => {
  process.stderr.write(`Sweep failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
