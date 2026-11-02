import { Injectable, Logger } from '@nestjs/common';
import { RpcException } from '@nestjs/microservices';
import { DataSource } from 'typeorm';
import { successRes } from '../../../../libs/common/helpers/response';

/**
 * Pochta ↔ buyurtma tarixi (`order_schema.post_order_memberships`,
 * migratsiya 1716000000201) — o'qish tomoni.
 *
 * `order.post_membership.find` (logistika eski pochta ro'yxati uchun):
 * berilgan pochtalarga QACHONDIR kirgan har buyurtmaning "turish" qatorlari,
 * `joined_at` bo'yicha tartiblangan. Jadvalni trigger to'ldiradi — bu servis
 * faqat o'qiydi (yozuv, pul, holat o'zgarmaydi).
 */
export type PostMembershipKind = 'DELIVERY' | 'CANCELED';

export interface PostMembershipRow {
  order_id: string;
  post_id: string;
  kind: PostMembershipKind;
  joined_at: string;
  left_at: string | null;
  next_post_id: string | null;
}

/** Bitta so'rovdagi pochtalar soni — logistika odatda bitta yuboradi. */
export const POST_MEMBERSHIP_MAX_POST_IDS = 200;
/**
 * Javob qatorlari chegarasi (RMQ xabari hajmi). Logistika buyurtmalarni
 * baribir 5000 tadan ortiq olmaydi; bitta pochtada bundan ko'p tarix
 * qatori amalda bo'lmaydi.
 */
export const POST_MEMBERSHIP_MAX_ROWS = 20_000;

const POSITIVE_ID = /^[1-9]\d{0,17}$/;

/**
 * `post_ids` — musbat butun sonlar (satr yoki son) massivi. Takrorlar olib
 * tashlanadi. Noto'g'ri element yoki massiv emas — 400 (jim tashlab
 * yuborilsa chaqiruvchidagi xato yashirinardi).
 */
export function normalizePostIds(raw: unknown): string[] {
  if (!Array.isArray(raw)) {
    throw new RpcException({
      statusCode: 400,
      message: "post_ids massiv bo'lishi kerak",
    });
  }
  const ids = new Set<string>();
  for (const value of raw as unknown[]) {
    const text =
      typeof value === 'string' || typeof value === 'number'
        ? String(value).trim()
        : '';
    if (!POSITIVE_ID.test(text)) {
      throw new RpcException({
        statusCode: 400,
        message: `Noto'g'ri pochta id: ${JSON.stringify(value) ?? 'undefined'}`,
      });
    }
    ids.add(text);
  }
  if (ids.size > POST_MEMBERSHIP_MAX_POST_IDS) {
    throw new RpcException({
      statusCode: 400,
      message: `Bir so'rovda ko'pi bilan ${POST_MEMBERSHIP_MAX_POST_IDS} ta pochta`,
    });
  }
  return [...ids];
}

function toIso(value: Date | string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export const POST_MEMBERSHIP_FIND_SQL = `
  SELECT m."order_id"::text AS "order_id",
         m."post_id"::text AS "post_id",
         m."kind" AS "kind",
         m."joined_at" AS "joined_at",
         m."left_at" AS "left_at",
         m."next_post_id"::text AS "next_post_id"
    FROM "order_schema"."post_order_memberships" m
   WHERE m."post_id" = ANY($1::bigint[])
   ORDER BY m."joined_at" ASC, m."id" ASC
   LIMIT $2`;

/** `pg` drayveri qaytaradigan xom qator (id'lar `::text`, vaqtlar Date). */
interface RawMembershipRow {
  order_id: string;
  post_id: string;
  kind: PostMembershipKind;
  joined_at: Date | string;
  left_at: Date | string | null;
  next_post_id: string | null;
}

/** Postgres `undefined_table` — migratsiya hali yurmagan (deploy oralig'i). */
const PG_UNDEFINED_TABLE = '42P01';

@Injectable()
export class PostMembershipService {
  private readonly logger = new Logger(PostMembershipService.name);

  constructor(private readonly dataSource: DataSource) {}

  async findByPostIds(payload: { post_ids?: unknown } | null | undefined) {
    const postIds = normalizePostIds(payload?.post_ids);
    if (!postIds.length) return successRes([]);
    let rows: RawMembershipRow[];
    try {
      rows = await this.dataSource.query(POST_MEMBERSHIP_FIND_SQL, [
        postIds,
        POST_MEMBERSHIP_MAX_ROWS,
      ]);
    } catch (error) {
      // Jadval hali yo'q — tarixsiz (avvalgidek joriy ko'rsatkichlar bilan)
      // ishlash xatodan yaxshiroq; boshqa har qanday xato yuqoriga chiqadi.
      if ((error as { code?: string })?.code === PG_UNDEFINED_TABLE) {
        this.logger.warn(
          'post_order_memberships jadvali topilmadi — migratsiya 1716000000201 yurmagan',
        );
        return successRes([]);
      }
      throw error;
    }
    if (rows.length >= POST_MEMBERSHIP_MAX_ROWS) {
      this.logger.warn(
        `Pochta tarixi ${POST_MEMBERSHIP_MAX_ROWS} qatorda kesildi (post_ids=${postIds.join(',')})`,
      );
    }
    const data: PostMembershipRow[] = rows.map((row) => ({
      order_id: String(row.order_id),
      post_id: String(row.post_id),
      kind: row.kind,
      joined_at: toIso(row.joined_at) as string,
      left_at: toIso(row.left_at),
      next_post_id:
        row.next_post_id === null || row.next_post_id === undefined
          ? null
          : String(row.next_post_id),
    }));
    return successRes(data);
  }
}
