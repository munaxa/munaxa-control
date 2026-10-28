import type { Params } from 'nestjs-pino';

import type { Environment } from '../config/environment';

/**
 * Structured JSON logs with credentials redacted at the logger, not at each call site. A licence
 * body, a service secret and an access token are all bearer material and none is ever written.
 */
export const loggingOptions = (environment: Environment): Params => ({
  pinoHttp: {
    level: environment.LOG_LEVEL,
    ...(environment.LOG_PRETTY && { transport: { target: 'pino-pretty' } }),
    autoLogging: { ignore: (request) => (request.url ?? '').startsWith('/health') },
    customProps: (request) => ({
      requestId: (request as { requestId?: string }).requestId,
      service: 'munaxa-control',
      version: environment.APP_VERSION,
    }),
    redact: {
      paths: [
        'req.headers.authorization',
        'req.headers.cookie',
        'res.headers["set-cookie"]',
        'req.body.code',
        'req.body.token',
        'res.body.token',
      ],
      censor: '[redacted]',
    },
    serializers: {
      req: (request: { requestId?: string; method?: string; url?: string }) => ({
        id: request.requestId,
        method: request.method,
        url: request.url,
      }),
    },
  },
});
