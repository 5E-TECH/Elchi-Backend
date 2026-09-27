import { RmqContext, RpcException } from '@nestjs/microservices';
import { RmqService } from '../rmq/rmq.service';
import { executeAndAck } from '../rmq/execute-and-ack.helper';
import {
  IdempotencyService,
  type TryAcquireOptions,
} from './idempotency.service';

export interface IdempotentExecuteOptions {
  /** Unique request identifier from the caller (gateway). If absent, fallback to plain executeAndAck. */
  requestId?: string;
  /** Pattern for indexing/diagnostics, e.g. 'order.create'. */
  pattern: string;
  /** Optional namespace prefix to keep keys unique across services if needed. */
  keyPrefix?: string;
  /**
   * `tryAcquire` ga uzatiladi: `completed` kesh shu muddatdan (ms) eskirsa
   * handler QAYTA ishlaydi. Faqat deterministik kalitlar uchun
   * (`TryAcquireOptions.completedTtlMs` izohiga qarang).
   */
  completedTtlMs?: number;
  /** `tryAcquire` ga uzatiladi: `failed` kalit qayta egallanib handler qayta urinadi. */
  reclaimFailed?: boolean;
  /**
   * Keshdan qaytgan (takroriy) javob obyekt bo'lsa, unga `idempotent_replay: true`
   * qo'shiladi — chaqiruvchi (gateway ai-confirm) "yangi yaratildi" va "avval
   * yaratilgan dublikat" ni ajrata olishi uchun. Yangi bajarilgan javobga
   * QO'SHILMAYDI; massiv/primitiv/null javob o'zgarmaydi.
   * Shuningdek `in_progress` holatida (nack/requeue'dan keyin) oddiy `Error`
   * o'rniga `RpcException({statusCode:409, message:'Idempotency in_progress …'})`
   * tashlanadi — matn RMQ orqali gateway'ga yetib boradi.
   */
  markReplay?: boolean;
}

/** Keshdagi javob `{...}` bilan kengaytirsa bo'ladigan oddiy obyektmi (null/massiv emas). */
function isReplayMarkable(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Idempotent message handler. If a request_id is present in the payload, the
 * key (pattern + request_id) is used to deduplicate work:
 *   - first call → handler runs, response cached
 *   - duplicate call (any future delivery) → cached response returned, no re-run
 *   - duplicate while first call is still running → message requeued (will retry shortly)
 *
 * Ixtiyoriy kengaytmalar (berilmasa xatti-harakat o'zgarmaydi):
 *   - `completedTtlMs` → kesh TTL'dan eskirsa handler qayta ishlaydi
 *   - `reclaimFailed`  → avval yiqilgan kalit uchun handler qayta urinadi
 *   - `markReplay`     → keshdan qaytgan obyekt javobiga `idempotent_replay: true`;
 *                        `in_progress` da oddiy `Error` o'rniga
 *                        `RpcException({statusCode:409, message})` tashlanadi
 * ack/nack semantikasi hamma holatda bir xil.
 *
 * Without a request_id this delegates to executeAndAck (no idempotency).
 */
export async function executeIdempotent<T>(
  rmqService: RmqService,
  idempotencyService: IdempotencyService,
  context: RmqContext,
  options: IdempotentExecuteOptions,
  handler: () => Promise<T> | T,
): Promise<T> {
  const {
    requestId,
    pattern,
    keyPrefix,
    completedTtlMs,
    reclaimFailed,
    markReplay,
  } = options;

  if (!requestId) {
    return executeAndAck(rmqService, context, handler);
  }

  const key = `${keyPrefix ?? pattern}:${requestId}`;
  // ⚠️ Yangi opsiyalar berilmasa `opts` ham `undefined` — mavjud chaqiruvchilar
  // (order.create va boshqalar) uchun `tryAcquire` xatti-harakati AYNAN avvalgidek.
  const acquireOpts: TryAcquireOptions | undefined =
    completedTtlMs !== undefined || reclaimFailed
      ? { completedTtlMs, reclaimFailed }
      : undefined;
  const acquire = await idempotencyService.tryAcquire<T>(
    key,
    pattern,
    undefined,
    acquireOpts,
  );

  if (acquire.status === 'cached') {
    rmqService.ack(context);
    if (markReplay && isReplayMarkable(acquire.response)) {
      return { ...acquire.response, idempotent_replay: true } as T;
    }
    return acquire.response;
  }

  if (acquire.status === 'failed') {
    rmqService.ack(context);
    throw new RpcException(acquire.error as object);
  }

  if (acquire.status === 'in_progress') {
    rmqService.nack(context, { requeue: true });
    const inProgressMessage = `Idempotency in_progress for ${key}, message requeued`;
    // ⚠️ `markReplay` (faqat ai-confirm `ai-dedupe:` kaliti) bo'lsa xato
    // `RpcException({statusCode:409, message})` — oddiy `Error` ni Nest'ning
    // sukutdagi RPC filtri `Internal server error` ga aylantirib matnni
    // yashiradi, gateway esa `duplicate_in_progress` ni ajrata olmaydi
    // (PLAN C10, wgqxS0Cp #13). Xabar YUQORIDA nack qilingan — bu yerda
    // ikkinchi ack/nack YO'Q. `markReplay` siz chaqiruvchilar uchun oddiy
    // `Error` — xatti-harakat baytma-bayt avvalgidek.
    if (markReplay) {
      throw new RpcException({ statusCode: 409, message: inProgressMessage });
    }
    throw new Error(inProgressMessage);
  }

  try {
    const result = await handler();
    await idempotencyService.markCompleted(key, result);
    rmqService.ack(context);
    return result;
  } catch (handlerError) {
    const errorPayload =
      handlerError instanceof RpcException
        ? handlerError.getError()
        : { message: (handlerError as Error)?.message ?? 'unknown error' };
    await idempotencyService.markFailed(key, errorPayload);
    rmqService.nackForError(context, handlerError);
    throw handlerError;
  }
}
