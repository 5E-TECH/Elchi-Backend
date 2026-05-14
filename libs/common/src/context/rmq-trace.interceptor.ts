import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Observable, from } from 'rxjs';
import { switchMap } from 'rxjs/operators';
import { requestContext } from './request-context';

/**
 * Server-side counterpart of the gateway trace middleware. When an RMQ
 * message arrives, this interceptor reads `trace_id` from the payload (set
 * by libs/common rmqSend) and binds it to AsyncLocalStorage for the entire
 * handler lifetime. All Pino log calls inside the handler then carry the
 * same trace_id as the gateway request that started the flow.
 *
 * No-op for HTTP requests (those are handled by the gateway middleware).
 */
@Injectable()
export class RmqTraceInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'rpc') {
      return next.handle();
    }

    const payload = context.switchToRpc().getData() as
      | Record<string, unknown>
      | undefined;
    const traceId =
      payload && typeof payload === 'object' && !Array.isArray(payload)
        ? typeof payload.trace_id === 'string' && payload.trace_id.length > 0
          ? payload.trace_id
          : undefined
        : undefined;

    if (!traceId) {
      return next.handle();
    }

    // Wrap the handler stream in AsyncLocalStorage. `from()` keeps the
    // observable surface; the inner `switchMap` only runs after `als.run`
    // has set up the context.
    return from(Promise.resolve()).pipe(
      switchMap(() =>
        requestContext.run({ traceId }, () => next.handle()),
      ),
    );
  }
}
