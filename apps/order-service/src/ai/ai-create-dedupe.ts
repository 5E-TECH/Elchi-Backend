import { RpcException } from '@nestjs/microservices';
import type { IdempotencyService } from '@app/common';

/**
 * ai-confirm → `order.create` ikki qatlamli dublikat himoyasi
 * (Cp2v3ZJ7, wgqxS0Cp #13) va AI audit metadata'si (vncdmXOy).
 *
 * 1-QATLAM — BARQAROR kalit (Cp2v3ZJ7 #1):
 *   `request_id = 'ai:<market_id>:<draft_id>:<item_index>'`. Tasodifiy
 *   request_id EMAS — qayta yuborish, tugmani ikki marta bosish, sahifa
 *   yangilanishi va RMQ qayta yetkazishida o'zgarmaydi. Kesh MUDDATSIZ
 *   (`completedTtlMs` yo'q): ayni draft bandi ikkinchi marta HECH QACHON
 *   yaratilmaydi, takror chaqiruv birinchisining order_id'sini
 *   `idempotent_replay:true` bilan qaytaradi. `market_id` kalitda — boshqa
 *   market begona draft_id bilan birovning keshlangan buyurtmasini ololmaydi.
 *   ⚠️ Kalitni chaqiruvchi (gateway) payloadga O'ZI yozadi: `rmqSend` /
 *   withRequestId faqat satr bo'lmasa randomUUID qo'yadi — kalit
 *   yozilmasa himoya JIMGINA o'chardi.
 *
 * 2-QATLAM — MAZMUN imzosi (Cp2v3ZJ7 #5): `ai_signature` =
 *   sha256(market|telefon|tuman|narx|yetkazish|mahsulotlar), 10 daqiqa TTL —
 *   BOSHQA draft'dan kelgan ayni buyurtmani ushlaydi. Imzo band bo'lsa
 *   `RpcException({statusCode:409, code:'duplicate_recent', order_id})`:
 *   ataylab XATO (kesh emas) — barqaror kalit `failed` bo'lib qoladi va
 *   (`reclaimFailed`) 10 daqiqadan keyin o'sha band yaratilishi mumkin (TC9).
 *
 * Eski gateway (`ai-dedupe:<sig>` request_id) yo'li O'ZGARMAGAN.
 */
export const AI_STABLE_REQUEST_PREFIX = 'ai:';
export const AI_SIGNATURE_PREFIX = 'ai-dedupe:';
/** Mazmun imzosining oynasi — 10 daqiqa (wgqxS0Cp #13 bilan bir xil). */
export const AI_SIGNATURE_TTL_MS = 600_000;
const ORDER_CREATE_PATTERN = 'order.create';

const STABLE_KEY_RE = /^ai:\d{1,19}:[0-9a-f-]{36}:\d{1,3}$/i;
const SIGNATURE_RE = /^[0-9a-f]{64}$/;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EDITABLE = new Set([
  'customer_name',
  'phone_number',
  'extra_number',
  'region_id',
  'district_id',
  'address',
  'total_price',
  'where_deliver',
  'comment',
  'operator',
  'items',
]);

/** Barqaror ai-confirm kalitimi (`ai:<market>:<draft>:<idx>`). */
export function isAiStableRequestId(requestId: unknown): boolean {
  return typeof requestId === 'string' && STABLE_KEY_RE.test(requestId);
}

/** order.create javobidan buyurtma ID'si (`{data:{id}}` yoki `{id}`). */
function orderIdOf(response: unknown): string | null {
  const r = response as { id?: unknown; data?: { id?: unknown } | null } | null;
  const id = r?.data?.id ?? r?.id;
  return typeof id === 'string' || typeof id === 'number' ? String(id) : null;
}

/** Bir so'rovda ko'pi bilan shuncha kalit (ai-confirm partiyasi ≤ 10). */
const COMPLETED_LOOKUP_MAX = 50;

/**
 * ai-confirm TAKRORI — qayta tekshiruvlardan OLDIN (`order.ai_confirm.completed`).
 *
 * Gateway operator/raqam/mijoz tekshiruvini `order.create` dan OLDIN qiladi;
 * natijasi noma'lum birinchi urinishdan keyin operator o'chirilsa, ikkinchi
 * «✅» mavjud buyurtma uchun `create_failed` olardi. Gateway shu funksiya
 * bilan barqaror kalit (`ai:<market>:<draft>:<idx>`) allaqachon `completed`
 * ekanini so'raydi va bo'lsa tekshiruvsiz `idempotent_replay` qaytaradi.
 *
 *  - FAQAT o'qish (kalit egallanmaydi; yangi yaratish tekshiruvi
 *    o'zgarmaydi);
 *  - faqat barqaror kalit shakli VA kalitdagi market = `market_id` (gateway
 *    server aniqlagan market) — boshqa market natijasi qaytmaydi;
 *  - javobda faqat `request_id` va `order_id` (keshlangan buyurtma tanasi
 *    EMAS).
 */
export async function findCompletedAiCreates(
  idempotency: Pick<IdempotencyService, 'findCompleted'>,
  marketId: unknown,
  requestIds: unknown,
): Promise<Array<{ request_id: string; order_id: string }>> {
  const market =
    typeof marketId === 'string' || typeof marketId === 'number'
      ? String(marketId).trim()
      : '';
  if (!/^\d{1,19}$/.test(market) || !Array.isArray(requestIds)) return [];
  const wanted = [
    ...new Set(
      requestIds.filter(
        (id): id is string =>
          typeof id === 'string' &&
          isAiStableRequestId(id) &&
          id.split(':')[1] === market,
      ),
    ),
  ].slice(0, COMPLETED_LOOKUP_MAX);
  if (wanted.length === 0) return [];
  const keyOf = (id: string) => `${ORDER_CREATE_PATTERN}:${id}`;
  const completed = await idempotency.findCompleted(wanted.map(keyOf));
  const out: Array<{ request_id: string; order_id: string }> = [];
  for (const id of wanted) {
    if (!completed.has(keyOf(id))) continue;
    const orderId = orderIdOf(completed.get(keyOf(id)));
    if (orderId) out.push({ request_id: id, order_id: orderId });
  }
  return out;
}

/**
 * 2-qatlam: mazmun imzosi. `signature` yaroqsiz bo'lsa — qatlamsiz `create`.
 * Ack/nack QILMAYDI (tashqi `executeIdempotent` ishi).
 */
export async function runWithAiSignature<T>(
  idempotency: Pick<
    IdempotencyService,
    'tryAcquire' | 'markCompleted' | 'markFailed'
  >,
  signature: unknown,
  create: () => Promise<T>,
): Promise<T> {
  if (typeof signature !== 'string' || !SIGNATURE_RE.test(signature)) {
    return create();
  }
  const key = `${ORDER_CREATE_PATTERN}:${AI_SIGNATURE_PREFIX}${signature}`;
  const acquire = await idempotency.tryAcquire<T>(
    key,
    ORDER_CREATE_PATTERN,
    undefined,
    { completedTtlMs: AI_SIGNATURE_TTL_MS, reclaimFailed: true },
  );
  if (acquire.status === 'cached') {
    const orderId = orderIdOf(acquire.response);
    throw new RpcException({
      statusCode: 409,
      code: 'duplicate_recent',
      ...(orderId ? { order_id: orderId } : {}),
      message: `AI duplicate_recent: xuddi shu buyurtma 10 daqiqa ichida yaratilgan${
        orderId ? ` (#${orderId})` : ''
      }`,
    });
  }
  if (acquire.status === 'in_progress') {
    throw new RpcException({
      statusCode: 409,
      message: `Idempotency in_progress for ${key}`,
    });
  }
  if (acquire.status === 'failed') {
    // reclaimFailed bilan amalda kelmaydi (poygada yutqazilgan holat).
    throw new RpcException({
      statusCode: 409,
      message: `Idempotency in_progress for ${key}`,
    });
  }
  try {
    const result = await create();
    await idempotency.markCompleted(key, result);
    return result;
  } catch (error) {
    const payload =
      error instanceof RpcException
        ? error.getError()
        : { message: (error as Error)?.message ?? 'unknown error' };
    await idempotency.markFailed(key, payload);
    throw error;
  }
}

const str = (value: unknown, max: number): string | null => {
  if (typeof value !== 'string') return null;
  const s = value.trim();
  return s ? s.slice(0, max) : null;
};

const money = (value: unknown): number | null => {
  const n = Number(value);
  return typeof value === 'number' && Number.isFinite(n) && n >= 0
    ? Math.round(n * 100) / 100
    : null;
};

/**
 * vncdmXOy #2: activity_log CREATED metadata'siga qo'shiladigan AI belgisi —
 * OQ RO'YXAT bo'yicha qayta yig'iladi (gateway server tomonda hisoblagan;
 * baribir RMQ chegarasi). `operator_id` bu yerdan HECH QACHON o'tmaydi.
 * Yaroqsiz (draft_id yo'q) bo'lsa null — metadata o'zgarmaydi.
 */
export function sanitizeAiAuditMetadata(
  raw: unknown,
): Record<string, unknown> | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const draftId = str(r.ai_draft_id, 36);
  if (!draftId || !UUID_RE.test(draftId)) return null;
  // Number(null) === 0 — indeks yuborilmagan bo'lsa 0 emas, null yozilsin.
  const rawIdx = r.ai_item_index;
  const idx =
    rawIdx === null || rawIdx === undefined || rawIdx === ''
      ? Number.NaN
      : Number(rawIdx);
  const edited = Array.isArray(r.edited_fields)
    ? r.edited_fields.filter(
        (f): f is string => typeof f === 'string' && EDITABLE.has(f),
      )
    : null;
  const out: Record<string, unknown> = {
    ai: true,
    ai_draft_id: draftId,
    ai_item_index: Number.isInteger(idx) && idx >= 0 && idx < 1000 ? idx : null,
    ai_draft_verified: r.ai_draft_verified === true,
    model: str(r.model, 64),
    prompt_version: str(r.prompt_version, 32),
    ai_cost_uzs: money(r.ai_cost_uzs),
    ai_draft_cost_uzs: money(r.ai_draft_cost_uzs),
    edited_fields: edited ? [...new Set(edited)] : null,
  };
  return out;
}
