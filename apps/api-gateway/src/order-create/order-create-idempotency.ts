import { BadRequestException, ConflictException } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';

/**
 * gpCIsGjH — `POST /orders` idempotentligi (gateway tomoni).
 *
 * order-service `order.create` da `executeIdempotent` tayyor turardi, lekin
 * gateway `request_id` YUBORMASDI — mexanizm har safar chetlab o'tilib oddiy
 * `executeAndAck` ga tushardi (o'lik kod). Endi `order.create` payloadida
 * `request_id` DOIM bor:
 *
 *  • `Idempotency-Key` sarlavhasi bor — `idem:<user_id>:<sha256(kalit)>`.
 *    Ayni kalit bilan takroriy so'rov (ikki marta bosish, klient/proksi
 *    retry, RMQ qayta yetkazish) ikkinchi buyurtma YARATMAYDI: keshlangan
 *    javob `idempotent_replay: true` bilan qaytadi; birinchisi hali
 *    bajarilayotgan bo'lsa — 409. Kalit FOYDALANUVCHI bo'yicha ajratilgan:
 *    boshqa foydalanuvchi ayni kalitni yuborib birovning keshlangan
 *    buyurtmasini (mijoz PII) ololmaydi. Xom kalit o'rniga sha256 —
 *    `idempotency_keys.key` varchar(200) sig'imi va AI prefikslarini
 *    (`ai:`, `ai-dedupe:`) soxtalashtirib bo'lmasligi uchun.
 *  • Kalit yo'q — HAR HTTP so'rovga YANGI `randomUUID()` (finance TMgL1zvq
 *    naqshi): avvalgidek har so'rov alohida buyurtma, lekin RMQ xabari qayta
 *    yetkazilsa ikkinchi buyurtma yaratilmaydi.
 *
 * ⚠️ Prefiks order-service `ORDER_CREATE_CLIENT_KEY_PREFIX` bilan AYNI
 * (`apps/order-service/src/order-service.controller.ts`) — o'sha yerda shu
 * shakldagi kalitga `reclaimFailed` + `markReplay` qo'llanadi.
 */
export const ORDER_CREATE_CLIENT_KEY_PREFIX = 'idem:';

/** Finance `readIdempotencyKey` bilan bir xil chegara (TMgL1zvq). */
export const ORDER_CREATE_IDEMPOTENCY_KEY_MAX = 255;

/** 409 matni — frontend takroriy so'rovni shu bilan ajratadi. */
export const ORDER_CREATE_IN_PROGRESS_MESSAGE =
  "Takroriy so'rov: bu buyurtma hozir yaratilmoqda — biroz kuting va buyurtmalar ro'yxatini yangilang";

/**
 * Sarlavha qiymati — trim qilingan; bo'sh/yo'q bo'lsa ''. 255 belgidan uzun
 * kalit — 400.
 */
export function readOrderCreateIdempotencyKey(raw: unknown): string {
  const key = typeof raw === 'string' ? raw.trim() : '';
  if (key.length > ORDER_CREATE_IDEMPOTENCY_KEY_MAX) {
    throw new BadRequestException(
      `Idempotency-Key ${ORDER_CREATE_IDEMPOTENCY_KEY_MAX} belgidan oshmasligi kerak`,
    );
  }
  return key;
}

/** `order.create` uchun `request_id` (yuqoridagi izohga qarang). */
export function resolveOrderCreateRequestId(
  userId: unknown,
  rawKey: unknown,
): string {
  const key = readOrderCreateIdempotencyKey(rawKey);
  if (!key) {
    return randomUUID();
  }
  const owner =
    typeof userId === 'string' || typeof userId === 'number'
      ? String(userId).trim()
      : '';
  const digest = createHash('sha256').update(key, 'utf8').digest('hex');
  return `${ORDER_CREATE_CLIENT_KEY_PREFIX}${owner}:${digest}`;
}

/**
 * order-service ayni kalitning birinchi so'rovi hali bajarilayotganini
 * (`executeIdempotent` `in_progress` → `markReplay` bilan
 * `RpcException({statusCode:409, message:'Idempotency in_progress …'})`)
 * bildirsa — ichki kalit ko'rinmaydigan aniq 409. Boshqa xato o'zgarishsiz.
 */
export function mapOrderCreateInProgress(error: unknown): unknown {
  const obj =
    error && typeof error === 'object'
      ? (error as {
          message?: unknown;
          response?: { message?: unknown } | null;
        })
      : null;
  const message = [obj?.message, obj?.response?.message].find(
    (value): value is string => typeof value === 'string',
  );
  return message?.includes('Idempotency in_progress')
    ? new ConflictException(ORDER_CREATE_IN_PROGRESS_MESSAGE)
    : error;
}
