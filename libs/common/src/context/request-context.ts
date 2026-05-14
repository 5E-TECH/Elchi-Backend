import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

export interface RequestContextStore {
  traceId: string;
  /** Optional user id when known (gateway extracts from JWT). */
  userId?: string;
}

/**
 * Process-wide correlation store. Set at the entry boundary (gateway HTTP
 * middleware, RMQ message interceptor) and read everywhere else: log mixin,
 * outgoing RMQ payload, Sentry tags, etc.
 *
 * AsyncLocalStorage transparently follows Promise chains, so a value set in
 * a middleware survives async hops inside that request.
 */
class RequestContext {
  private readonly als = new AsyncLocalStorage<RequestContextStore>();

  /** Run `fn` inside a fresh context. */
  run<T>(store: RequestContextStore, fn: () => T): T {
    return this.als.run(store, fn);
  }

  /** Current store, or undefined if called outside any request. */
  get(): RequestContextStore | undefined {
    return this.als.getStore();
  }

  getTraceId(): string | undefined {
    return this.als.getStore()?.traceId;
  }

  /** Generate a new trace id; useful for callers that may need to root one. */
  static newTraceId(): string {
    return randomUUID();
  }
}

export const requestContext = new RequestContext();
