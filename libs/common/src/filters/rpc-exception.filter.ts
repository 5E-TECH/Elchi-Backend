import {
  Catch,
  ArgumentsHost,
  ExceptionFilter,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { RpcException } from '@nestjs/microservices';
import { Response } from 'express';
import { captureException } from '../sentry/sentry.helper';
import { requestContext } from '../context/request-context';

@Catch(RpcException)
export class RpcExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(RpcExceptionFilter.name);

  catch(exception: RpcException, host: ArgumentsHost) {
    captureException(exception);
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const error = exception.getError();

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let message = 'Internal server error';

    if (typeof error === 'object' && error !== null) {
      const err = error as Record<string, unknown>;
      status =
        typeof err.statusCode === 'number'
          ? err.statusCode
          : HttpStatus.INTERNAL_SERVER_ERROR;
      // Mirror AllExceptionsFilter: a downstream service can throw an
      // RpcException whose message is a string[] (class-validator output). The
      // previous string-only check dropped those, producing an inconsistent
      // "Internal server error" envelope vs the HTTP path.
      if (Array.isArray(err.message)) {
        message = err.message.join('. ');
      } else if (typeof err.message === 'string') {
        message = err.message;
      }
    } else if (typeof error === 'string') {
      message = error;
    }

    const traceId = requestContext.get()?.traceId;

    // Structured 5xx log (Audit observability P1). Most business logic runs in
    // RPC handlers and surfaces here, so this is the primary server-error log.
    if (status >= 500) {
      this.logger.error(`${status} ${message} (trace_id=${traceId ?? '-'})`);
    }

    response.status(status).json({
      statusCode: status,
      message,
      ...(traceId ? { trace_id: traceId } : {}),
    });
  }
}
