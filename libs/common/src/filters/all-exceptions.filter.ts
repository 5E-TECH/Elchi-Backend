import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Response } from 'express';
import { captureException } from '../sentry/sentry.helper';
import { requestContext } from '../context/request-context';

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost) {
    // Forward unexpected (5xx) exceptions to Sentry. captureException itself
    // ignores 4xx-shaped business errors so this is safe to call unguarded.
    captureException(exception);
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    // An rxjs `timeout()` firing on a downstream RPC surfaces here as a
    // TimeoutError. The api-gateway is literally a gateway to the
    // microservices, so a stalled upstream is a 504 Gateway Timeout — not an
    // opaque 500. (Matches the per-RPC timeouts added to the gateway sends.)
    const isUpstreamTimeout =
      exception instanceof Error && exception.name === 'TimeoutError';

    let status =
      exception instanceof HttpException
        ? exception.getStatus()
        : isUpstreamTimeout
          ? HttpStatus.GATEWAY_TIMEOUT
          : HttpStatus.INTERNAL_SERVER_ERROR;

    let message = 'Internal server error';

    if (exception instanceof HttpException) {
      const exceptionResponse = exception.getResponse();
      if (typeof exceptionResponse === 'string') {
        message = exceptionResponse;
      } else if (
        typeof exceptionResponse === 'object' &&
        exceptionResponse !== null
      ) {
        const msg = (exceptionResponse as Record<string, unknown>).message;
        if (Array.isArray(msg)) {
          message = msg.join('. ');
        } else if (typeof msg === 'string') {
          message = msg;
        }
      }
    } else if (typeof exception === 'object' && exception !== null) {
      const obj = exception as Record<string, unknown>;
      const nestedResponse =
        typeof obj.response === 'object' && obj.response !== null
          ? (obj.response as Record<string, unknown>)
          : undefined;

      status =
        (typeof obj.statusCode === 'number' && obj.statusCode) ||
        (typeof obj.status === 'number' && obj.status) ||
        (typeof nestedResponse?.statusCode === 'number' &&
          nestedResponse.statusCode) ||
        status;

      const objMessage =
        obj.message ??
        nestedResponse?.message ??
        obj.error ??
        nestedResponse?.error;

      if (Array.isArray(objMessage)) {
        message = objMessage.join('. ');
      } else if (typeof objMessage === 'string' && objMessage.trim()) {
        message = objMessage;
      }
    } else if (exception instanceof Error) {
      const msg = exception.message || '';
      if (msg.includes('duplicate key') || msg.includes('unique constraint')) {
        message = "Bu ma'lumot allaqachon mavjud";
      } else if (msg.includes('foreign key constraint')) {
        message = "Bog'langan ma'lumotlar mavjud, o'chirish mumkin emas";
      } else if (msg.includes('connection') || msg.includes('timeout')) {
        message = "Ma'lumotlar bazasiga ulanishda xatolik";
      } else {
        message = msg || "Noma'lum xatolik yuz berdi";
      }
    }

    if (isUpstreamTimeout) {
      message = "Yuqori oqim xizmati vaqtida javob bermadi (timeout)";
    }

    const traceId = requestContext.get()?.traceId;

    // Structured 5xx log (Audit observability P1: the filter only sent to Sentry
    // and wrote nothing to the local structured log, so a prod 5xx was invisible
    // without a Sentry lookup). 4xx are client errors — not logged at error level
    // to keep the signal clean.
    if (status >= 500) {
      this.logger.error(
        `${status} ${message} (trace_id=${traceId ?? '-'})`,
        exception instanceof Error ? exception.stack : undefined,
      );
    }

    response.status(status).json({
      statusCode: status,
      message,
      ...(traceId ? { trace_id: traceId } : {}),
    });
  }
}
