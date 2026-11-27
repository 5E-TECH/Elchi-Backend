import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Commission_type } from '@app/common';
import {
  MarketOperatorMembership,
  MarketOperatorMembershipStatus,
} from '../entities/market-operator-membership.entity';

/** Operatorning bitta a'zoligi (ichki RPC javobi — gateway'gacha). */
export interface MarketOperatorMembershipView {
  market_id: string;
  status: MarketOperatorMembershipStatus;
  is_primary: boolean;
  commission_type: Commission_type | null;
  commission_value: number | null;
  can_view_warehouse_stock: boolean;
  accepted_at: string | null;
  /** Market qatori (o'chirilgan bo'lsa ham — `is_deleted`); topilmasa null. */
  market: {
    id: string;
    name: string | null;
    status: string | null;
    add_order: boolean;
    is_deleted: boolean;
  } | null;
}

const ID_RE = /^\d{1,19}$/;
const INT8_MAX = 9223372036854775807n;

type Row = {
  market_id: string;
  status: string;
  is_primary: boolean;
  commission_type: string | null;
  commission_value: string | number | null;
  can_view_warehouse_stock: boolean;
  accepted_at: Date | string | null;
  market_name: string | null;
  market_status: string | null;
  market_add_order: boolean | null;
  market_deleted: boolean | null;
  market_found: boolean;
};

/**
 * Asosiy market birinchi, keyin market nomi (katta-kichik harf farqsiz) va id
 * — har so'rovda bir xil tartib (bot tugmalari, FE ro'yxati).
 */
const LIST_SQL = `
  SELECT m."market_id"::text AS "market_id",
         m."status",
         m."is_primary",
         m."commission_type",
         m."commission_value",
         m."can_view_warehouse_stock",
         m."accepted_at",
         mk."name" AS "market_name",
         mk."status"::text AS "market_status",
         mk."add_order" AS "market_add_order",
         mk."is_deleted" AS "market_deleted",
         (mk."id" IS NOT NULL) AS "market_found"
    FROM "identity_schema"."market_operator_markets" m
    LEFT JOIN "identity_schema"."admins" mk ON mk."id" = m."market_id"
   WHERE m."operator_id" = $1
     AND ($2::boolean OR m."status" <> 'removed')
   ORDER BY m."is_primary" DESC, lower(mk."name") ASC NULLS LAST,
            m."market_id" ASC
`;

const toIso = (value: Date | string | null): string | null => {
  if (value == null) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
};

const toNumber = (value: string | number | null): number | null => {
  if (value == null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

/**
 * Bitta operator — bir nechta market (1-bosqich): a'zoliklarni O'QISH.
 * Jadval hozircha `admins` dan trigger orqali saqlanadi (migratsiya
 * 1716000000255) — bu servis unga yozmaydi.
 *
 * Ichki RPC `identity.market_operator.memberships` uchun: gateway (keyingi
 * bosqich) operatorning qaysi marketlarda ishlashini shu yerdan oladi.
 * Noto'g'ri id — bo'sh ro'yxat (fail-closed: «hech qaysi marketda emas»).
 */
@Injectable()
export class MarketOperatorMembershipService {
  constructor(
    @InjectRepository(MarketOperatorMembership)
    private readonly memberships: Repository<MarketOperatorMembership>,
  ) {}

  async listForOperator(
    operatorId: unknown,
    options: { include_removed?: unknown } = {},
  ): Promise<MarketOperatorMembershipView[]> {
    const raw =
      typeof operatorId === 'string' || typeof operatorId === 'number'
        ? String(operatorId).trim()
        : '';
    if (!ID_RE.test(raw) || BigInt(raw) > INT8_MAX) {
      return [];
    }
    const rows: Row[] = await this.memberships.query(LIST_SQL, [
      BigInt(raw).toString(),
      options.include_removed === true,
    ]);
    return rows.map((row) => ({
      market_id: String(row.market_id),
      status: row.status as MarketOperatorMembershipStatus,
      is_primary: row.is_primary === true,
      commission_type: (row.commission_type as Commission_type | null) ?? null,
      commission_value: toNumber(row.commission_value),
      can_view_warehouse_stock: row.can_view_warehouse_stock === true,
      accepted_at: toIso(row.accepted_at),
      market: row.market_found
        ? {
            id: String(row.market_id),
            name: row.market_name ?? null,
            status: row.market_status ?? null,
            add_order: row.market_add_order === true,
            is_deleted: row.market_deleted === true,
          }
        : null,
    }));
  }
}
