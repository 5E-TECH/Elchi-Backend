import { DynamicModule, Module } from '@nestjs/common';
import { LoggerModule, Params } from 'nestjs-pino';
import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { requestContext } from '../context/request-context';

export interface AppLoggerOptions {
  /** Service name embedded in every log entry. */
  serviceName: string;
  /** Optional level override. Defaults to LOG_LEVEL env or 'info'. */
  level?: string;
}

/**
 * Shared Pino configuration used by every service. Centralised here so the
 * log shape stays consistent across the monorepo.
 *
 * - Dev (NODE_ENV !== production): pino-pretty (colourised, single-line)
 * - Prod: raw JSON to stdout (suitable for Loki/Datadog/CloudWatch)
 *
 * Every log line carries:
 *   - `service`     name of the microservice
 *   - `request_id`  taken from x-request-id header (or auto-generated)
 *   - `level`, `time`, `pid`, `hostname` (Pino built-ins)
 */
@Module({})
export class AppLoggerModule {
  static forRoot(options: AppLoggerOptions): DynamicModule {
    const isProduction = process.env.NODE_ENV === 'production';
    const level = options.level ?? process.env.LOG_LEVEL ?? 'info';

    const pinoParams: Params = {
      pinoHttp: {
        level,
        // x-request-id roundtrips through gateway → RMQ → service; if absent,
        // generate one so every line still has a correlation key.
        genReqId: (req: IncomingMessage) => {
          const headerId = req.headers['x-request-id'];
          if (typeof headerId === 'string' && headerId.trim()) {
            return headerId.trim();
          }
          if (Array.isArray(headerId) && headerId[0]?.trim()) {
            return headerId[0].trim();
          }
          return randomUUID();
        },
        // mixin runs for EVERY log call — pull trace_id from AsyncLocalStorage
        // so logs originating outside HTTP (RMQ handlers, scheduled jobs)
        // still carry correlation.
        mixin: () => {
          const ctx = requestContext.get();
          return ctx?.traceId ? { trace_id: ctx.traceId } : {};
        },
        customProps: () => ({ service: options.serviceName }),
        // Reduce noise from successful health/metric probes
        customLogLevel: (_req: IncomingMessage, res: ServerResponse, err?: Error) => {
          if (err || res.statusCode >= 500) return 'error';
          if (res.statusCode >= 400) return 'warn';
          return 'info';
        },
        // Don't dump full HTTP req/res bodies in prod logs
        serializers: {
          req: (req: IncomingMessage & { id?: string }) => ({
            id: req.id,
            method: req.method,
            url: req.url,
          }),
          res: (res: ServerResponse) => ({ statusCode: res.statusCode }),
        },
        transport: isProduction
          ? undefined
          : {
              target: 'pino-pretty',
              options: {
                colorize: true,
                singleLine: true,
                translateTime: 'SYS:HH:MM:ss.l',
                ignore: 'pid,hostname,req,res,responseTime',
                messageFormat: '{service} | {msg}',
              },
            },
      },
    };

    return {
      module: AppLoggerModule,
      imports: [LoggerModule.forRoot(pinoParams)],
      exports: [LoggerModule],
    };
  }
}
