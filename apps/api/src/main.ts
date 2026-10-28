import 'reflect-metadata';

import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';

import { AppModule } from './app.module';
import { loadEnvironment } from './config/environment';
import { configureApplication } from './setup';

async function bootstrap(): Promise<void> {
  const environment = loadEnvironment(process.env);
  const application = await NestFactory.create(AppModule.with(environment), { bufferLogs: true });
  application.useLogger(application.get(Logger));
  configureApplication(application, environment);
  await application.listen(environment.PORT, environment.HOST);
}

// A startup failure exits non-zero so an orchestrator restarts or rolls back rather than leaving a
// process alive and not serving. The message is a configuration error's list, never a secret.
bootstrap().catch((error: unknown) => {
  process.stderr.write(
    `Failed to start: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
