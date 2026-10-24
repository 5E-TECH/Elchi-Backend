import { RpcException } from '@nestjs/microservices';
import {
  EntityManager,
  EntityTarget,
  ObjectLiteral,
  QueryFailedError,
} from 'typeorm';
import {
  WAREHOUSE_ERROR_CODES,
  WAREHOUSE_IDEMPOTENCY_KEY_PATTERN,
  WAREHOUSE_MAX_LINES,
  WAREHOUSE_MAX_QTY,
} from '@app/common';

/** RMQ yukidagi aktyor (gateway `requester` yoki order-service `actor`). */
export interface WarehouseActorInput {
  id?: string | number | null;
  roles?: string[] | null;
  role?: string | null;
}

export interface WarehouseActor {
  /** Faqat raqamli id (bigint ustun); `system` kabi qiymat — null. */
  id: string | null;
  role: string | null;
}

/**
 * Filial xodimi (MANAGER/BRANCH) so'rovi — gateway uning filialini
 * aniqlab beradi. `null` — cheklovsiz (SUPERADMIN/ADMIN, ichki RPC).
 */
export interface WarehouseScope {
  branch_id: string;
}

export function rpcError(
  statusCode: number,
  message: string,
  extra?: Record<string, unknown>,
): never {
  throw new RpcException({ statusCode, message, ...(extra ?? {}) });
}

export function badRequest(
  message: string,
  extra?: Record<string, unknown>,
): never {
  return rpcError(400, message, extra);
}

export function notFoundWarehouse(id?: string): never {
  return rpcError(404, id ? `Ombor #${id} topilmadi` : 'Ombor topilmadi', {
    code: WAREHOUSE_ERROR_CODES.NOT_FOUND,
  });
}

const text = (value: unknown): string =>
  typeof value === 'string' || typeof value === 'number'
    ? String(value).trim()
    : '';

/** Musbat bigint id (satr); noto'g'ri — 400. */
export function toId(raw: unknown, field: string): string {
  const value = text(raw);
  if (!/^[1-9]\d{0,18}$/.test(value)) {
    badRequest(`${field} noto'g'ri (musbat butun son bo'lishi kerak)`);
  }
  return value;
}

/** `undefined`/`null`/'' — null; aks holda `toId`. */
export function toOptionalId(raw: unknown, field: string): string | null {
  if (raw === undefined || raw === null || text(raw) === '') return null;
  return toId(raw, field);
}

/** Butun son [min, max]; noto'g'ri — 400. Satr ham qabul qilinadi (RMQ/query). */
export function toInt(
  raw: unknown,
  field: string,
  min: number,
  max: number,
): number {
  const value =
    typeof raw === 'number'
      ? raw
      : typeof raw === 'string' && /^-?\d+$/.test(raw.trim())
        ? Number(raw.trim())
        : NaN;
  if (!Number.isInteger(value) || value < min || value > max) {
    badRequest(`${field} — ${min} dan ${max} gacha butun son bo'lishi kerak`);
  }
  return value;
}

/** Ixtiyoriy matn: `undefined` — o'zgarmaydi, `null`/'' — null. */
export function toOptionalText(
  raw: unknown,
  field: string,
  max: number,
): string | null | undefined {
  if (raw === undefined) return undefined;
  if (raw === null) return null;
  if (typeof raw !== 'string') badRequest(`${field} matn bo'lishi kerak`);
  const value = raw.trim().replace(/\s+/g, ' ');
  if (!value) return null;
  if (value.length > max) {
    badRequest(`${field} ${max} belgidan oshmasligi kerak`);
  }
  return value;
}

export function normalizeActor(
  raw?: WarehouseActorInput | null,
): WarehouseActor {
  const id = text(raw?.id);
  const roles = Array.isArray(raw?.roles)
    ? raw.roles.map((role) => text(role).toLowerCase()).filter(Boolean)
    : [];
  const role = text(raw?.role).toLowerCase() || roles[0] || null;
  return {
    id: /^\d{1,19}$/.test(id) ? id : null,
    role: role ? role.slice(0, 32) : null,
  };
}

export function hasAnyRole(
  raw: WarehouseActorInput | null | undefined,
  roles: string[],
): boolean {
  const own = [
    ...(Array.isArray(raw?.roles) ? raw.roles : []),
    ...(raw?.role ? [raw.role] : []),
  ].map((role) => text(role).toLowerCase());
  return roles.some((role) => own.includes(role));
}

export function requireIdempotencyKey(raw: unknown): string {
  const value = text(raw);
  if (!WAREHOUSE_IDEMPOTENCY_KEY_PATTERN.test(value)) {
    badRequest(
      "Idempotency-Key sarlavhasi majburiy: 8–128 belgi (harf, raqam, . _ : -). Har yangi so'rov uchun yangi kalit (masalan UUID), qayta yuborishda — o'sha kalit",
    );
  }
  return value;
}

/** Ixtiyoriy kalit (order-service `return`): berilsa — shakli tekshiriladi. */
export function optionalIdempotencyKey(raw: unknown): string | null {
  if (raw === undefined || raw === null || text(raw) === '') return null;
  return requireIdempotencyKey(raw);
}

export interface RawStockLine {
  product_id?: unknown;
  code?: unknown;
  qty?: unknown;
  quantity?: unknown;
  counted?: unknown;
}

export interface StockLine {
  index: number;
  product_id: string | null;
  code: string | null;
  value: number;
}

/**
 * Kirim/inventarizatsiya qatorlari: har qatorda `product_id` YOKI `code`
 * (skaner qiymati) va son maydoni (`valueField`). 1..WAREHOUSE_MAX_LINES.
 */
export function normalizeStockLines(
  raw: unknown,
  valueField: 'qty' | 'counted',
  min: number,
): StockLine[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    badRequest("lines — kamida bitta qator bo'lishi kerak");
  }
  if (raw.length > WAREHOUSE_MAX_LINES) {
    badRequest(`lines — ko'pi bilan ${WAREHOUSE_MAX_LINES} ta qator`);
  }
  return raw.map((item: RawStockLine, index) => {
    const row = item && typeof item === 'object' ? item : ({} as RawStockLine);
    const productId = toOptionalId(
      row.product_id,
      `lines[${index}].product_id`,
    );
    const code = text(row.code) || null;
    if (!productId && !code) {
      badRequest(`lines[${index}] — product_id yoki code majburiy`);
    }
    if (productId && code) {
      badRequest(`lines[${index}] — product_id va code dan faqat bittasi`);
    }
    if (code && code.length > 512) {
      badRequest(`lines[${index}].code 512 belgidan oshmasligi kerak`);
    }
    const rawValue =
      valueField === 'qty' ? (row.qty ?? row.quantity) : row.counted;
    return {
      index,
      product_id: productId,
      code,
      value: toInt(
        rawValue,
        `lines[${index}].${valueField}`,
        min,
        WAREHOUSE_MAX_QTY,
      ),
    };
  });
}

export interface OrderItem {
  product_id: string;
  quantity: number;
}

/**
 * Buyurtma qatorlari: `{ product_id, quantity }`, bir xil mahsulot
 * qo'shiladi (bitta posilka). Bo'sh ro'yxat — `[]` (chaqiruvchi hal qiladi).
 */
export function normalizeOrderItems(raw: unknown): OrderItem[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) badRequest("items massiv bo'lishi kerak");
  if (raw.length > WAREHOUSE_MAX_LINES) {
    badRequest(`items — ko'pi bilan ${WAREHOUSE_MAX_LINES} ta qator`);
  }
  const merged = new Map<string, number>();
  raw.forEach((item: { product_id?: unknown; quantity?: unknown }, index) => {
    const productId = toId(item?.product_id, `items[${index}].product_id`);
    const quantity = toInt(
      item?.quantity ?? 1,
      `items[${index}].quantity`,
      1,
      WAREHOUSE_MAX_QTY,
    );
    merged.set(productId, (merged.get(productId) ?? 0) + quantity);
  });
  return Array.from(merged, ([product_id, quantity]) => ({
    product_id,
    quantity,
  })).sort((a, b) => compareIds(a.product_id, b.product_id));
}

/** bigint satrlarni son sifatida solishtirish (qulf tartibi). */
export function compareIds(a: string, b: string): number {
  if (a.length !== b.length) return a.length - b.length;
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Sahifalash: page ≥ 1, 1 ≤ limit ≤ max. */
export function pagination(
  rawPage: unknown,
  rawLimit: unknown,
  defaultLimit: number,
  maxLimit: number,
): { page: number; limit: number; offset: number } {
  const page = Number(text(rawPage) || 1);
  const limit = Number(text(rawLimit) || defaultLimit);
  const safePage = Number.isInteger(page) && page > 0 ? page : 1;
  const safeLimit =
    Number.isInteger(limit) && limit > 0
      ? Math.min(limit, maxLimit)
      : defaultLimit;
  return {
    page: safePage,
    limit: safeLimit,
    offset: (safePage - 1) * safeLimit,
  };
}

/** Xom SQL uchun to'liq jadval nomi (sxema DataSource'dan). */
export function tableRef(
  manager: EntityManager,
  entity: EntityTarget<ObjectLiteral>,
): string {
  const metadata = manager.connection.getMetadata(entity);
  return metadata.schema
    ? `"${metadata.schema}"."${metadata.tableName}"`
    : `"${metadata.tableName}"`;
}

/**
 * `UPDATE … RETURNING` — TypeORM postgres `[rows, count]` qaytaradi,
 * SELECT/INSERT esa `rows`. Ikkalasidan qatorlar.
 */
export function returnedRows<T>(result: unknown): T[] {
  if (
    Array.isArray(result) &&
    result.length === 2 &&
    Array.isArray(result[0]) &&
    typeof result[1] === 'number'
  ) {
    return result[0] as T[];
  }
  return Array.isArray(result) ? (result as T[]) : [];
}

/** DB xatosi → tushunarli RPC xatosi (ma'lumot hech qachon chala yozilmaydi). */
export function mapWarehouseDbError(error: unknown): never {
  if (error instanceof RpcException) throw error;
  if (error instanceof QueryFailedError) {
    const pg = error.driverError as { code?: string; constraint?: string };
    if (pg?.code === '22P02') badRequest("ID format noto'g'ri");
    if (pg?.code === '23505') {
      if (pg.constraint === 'UQ_warehouses_branch_id') {
        rpcError(409, 'Bu filialda ombor allaqachon ochilgan');
      }
      if (pg.constraint === 'UQ_stock_reservations_order_product_active') {
        rpcError(409, 'Buyurtma allaqachon band qilingan', {
          code: WAREHOUSE_ERROR_CODES.ORDER_ALREADY_RESERVED,
        });
      }
      rpcError(409, "So'rov allaqachon bajarilgan (takroriy kalit)", {
        code: WAREHOUSE_ERROR_CODES.IDEMPOTENCY_CONFLICT,
      });
    }
    if (pg?.code === '23514') {
      rpcError(
        409,
        "Qoldiq yetarli emas — qoldiq manfiy yoki band qoldiqdan ko'p bo'la olmaydi",
        {
          code: WAREHOUSE_ERROR_CODES.STOCK_INSUFFICIENT,
        },
      );
    }
    if (pg?.code === '23503') badRequest('Ombor yoki mahsulot topilmadi');
  }
  throw error;
}
