import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Module } from '@nestjs/common';
import { LoggerModule } from 'nestjs-pino';
import { APP_CONFIG } from '../config/config.module.js';
import type { AppConfig } from '../config/config.schema.js';

const REQUEST_ID_HEADER = 'x-request-id';
const VALID_REQUEST_ID = /^[\w.-]{1,128}$/;

/** Reuses a sane incoming `x-request-id`, else generates one; echoes it on the response. */
export function requestId(req: IncomingMessage, res: ServerResponse): string {
  const incoming = req.headers[REQUEST_ID_HEADER];
  const id =
    typeof incoming === 'string' && VALID_REQUEST_ID.test(incoming)
      ? incoming
      : randomUUID();
  res.setHeader(REQUEST_ID_HEADER, id);
  return id;
}

/**
 * Structured JSON logs via pino. Every request log line carries `req.id`.
 * Pretty output in development (pino-pretty is a dev dependency).
 */
@Module({
  imports: [
    LoggerModule.forRootAsync({
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) => ({
        pinoHttp: {
          level: config.logLevel,
          genReqId: requestId,
          redact: [
            'req.headers["x-api-key"]',
            'req.headers.authorization',
            'req.headers.cookie',
          ],
          autoLogging: {
            ignore: (req: IncomingMessage) => req.url === '/api/health',
          },
          customLogLevel: (
            _req: IncomingMessage,
            res: ServerResponse,
            err?: Error,
          ) =>
            err || res.statusCode >= 500
              ? 'error'
              : res.statusCode >= 400
                ? 'warn'
                : 'info',
          transport:
            config.nodeEnv === 'production'
              ? undefined
              : { target: 'pino-pretty', options: { singleLine: true } },
        },
      }),
    }),
  ],
})
export class LoggingModule {}
