import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Observable, from } from 'rxjs';
import { switchMap } from 'rxjs/operators';
import { RequestContextStore, requestContext } from './request-context';
import {
  auditContextFromRmqHeaders,
  readRmqHeaders,
  traceIdFromRmqHeaders,
} from './rmq-context.serializer';

/**
 * Server-side counterpart of the gateway trace middleware. When an RMQ
 * message arrives, this interceptor reads `trace_id` from the payload (set
 * by libs/common rmqSend) and binds it to AsyncLocalStorage for the entire
 * handler lifetime. All Pino log calls inside the handler then carry the
 * same trace_id as the gateway request that started the flow.
 *
 * f2Ud5tju: payload'da `trace_id` bo'lmasa AMQP `x-trace-id` sarlavhasi
 * olinadi (gateway'ning to'g'ridan-to'g'ri `client.send` chaqiruvlari shu
 * yo'l bilan keladi — `RequestContextRmqSerializer`), `x-audit-ctx`
 * sarlavhasidan esa IP/qurilma kontekstga qo'yiladi — `ActivityLogService.log()`
 * ularni metadata'ga avtomatik qo'shadi. Trace bo'lmasa (cron/outbox relay)
 * kontekst ochilmaydi — avvalgidek.
 *
 * No-op for HTTP requests (those are handled by the gateway middleware).
 */
@Injectable()
export class RmqTraceInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'rpc') {
      return next.handle();
    }

    const rpc = context.switchToRpc();
    const payload = rpc.getData();
    const payloadTraceId =
      payload && typeof payload === 'object' && !Array.isArray(payload)
        ? typeof payload.trace_id === 'string' && payload.trace_id.length > 0
          ? payload.trace_id
          : undefined
        : undefined;

    const headers = readRmqHeaders(rpc.getContext());
    const traceId = payloadTraceId ?? traceIdFromRmqHeaders(headers);

    if (!traceId) {
      return next.handle();
    }

    const store: RequestContextStore = {
      traceId,
      ...auditContextFromRmqHeaders(headers),
    };

    // Wrap the handler stream in AsyncLocalStorage. `from()` keeps the
    // observable surface; the inner `switchMap` only runs after `als.run`
    // has set up the context.
    return from(Promise.resolve()).pipe(
      switchMap(() => requestContext.run(store, () => next.handle())),
    );
  }
}
