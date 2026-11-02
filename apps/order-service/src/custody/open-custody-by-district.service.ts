import { Injectable } from '@nestjs/common';
import { RpcException } from '@nestjs/microservices';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { BranchTransferBatchStatus, Order_status } from '@app/common';
import { successRes } from '../../../../libs/common/helpers/response';
import { BranchTransferBatch } from '../entities/branch-transfer-batch.entity';
import { Order } from '../entities/order.entity';

/**
 * `order.open_custody_by_district` — tuman ko'chirilganda (boshqa viloyatga
 * yoki boshqa xizmat filialiga) logistika "eski filialda tugaydigan"
 * buyurtmalarni aniqlashi uchun: berilgan tumanlardagi OCHIQ (marketga
 * qaytmagan, pul yopilmagan) buyurtmalarning custody ustunlari. Faqat
 * o'qish — holat, pul, custody o'zgarmaydi.
 *
 * Kim imtiyozli ekanini (eski filial / uning kuryeri) logistika o'zi
 * hisoblaydi (`holder_*` / `branch_id` / `batch_destination_branch_id`
 * dan) — bu yerda faqat qatorlar. Sahifalash id bo'yicha keyset
 * (`after_id`): `next_after_id` — sahifa to'lsa oxirgi id, aks holda `null`.
 */
export interface OpenCustodyRow {
  id: string;
  district_id: string | null;
  region_id: string | null;
  status: string;
  holder_type: string | null;
  holder_branch_id: string | null;
  holder_courier_id: string | null;
  branch_id: string | null;
  courier_id: string | null;
  current_batch_id: string | null;
  /**
   * Yo'ldagi buyurtma qayerga ketyapti: `current_batch_id` dagi partiya
   * JO'NATILGAN (SENT, FORWARD yoki RETURN) bo'lsa — uning
   * `destination_branch_id`; aks holda `null`. PENDING partiya — buyurtma
   * hali jismonan manbada (null); RECEIVED/CANCELLED — partiya yopilgan.
   */
  batch_destination_branch_id: string | null;
}

export interface OpenCustodyPage {
  rows: OpenCustodyRow[];
  next_after_id: string | null;
}

/** RMQ javobi — `successRes` shakli. */
export interface OpenCustodyResponse {
  statusCode: number;
  message: string;
  data: OpenCustodyPage;
}

export interface OpenCustodyQuery {
  districtIds: string[];
  afterId: string | null;
  limit: number;
}

/** Bitta so'rovdagi tumanlar soni (shartnoma: 1..50). */
export const OPEN_CUSTODY_MAX_DISTRICT_IDS = 50;
/** Sahifa hajmi chegarasi va sukut qiymati (RMQ xabari hajmi). */
export const OPEN_CUSTODY_MAX_LIMIT = 1000;
export const OPEN_CUSTODY_DEFAULT_LIMIT = OPEN_CUSTODY_MAX_LIMIT;

/**
 * Ochiq custody holatlari. `cancelled` va `sold` ham kiradi: ushlab turgan
 * filial menejeri / kuryer ularni WAITING ga qaytara oladi
 * (rollbackOrderToWaiting) — imtiyozsiz bunday buyurtma eski filialda
 * qotib qolardi. paid, partly_paid, closed — rollback faqat superadmin'ga,
 * snapshot tarix bilan shishmasin; `cancelled (sent)` va
 * `returned_to_market` — marketga ketgan. `created` — hali qabul
 * qilinmagan qoralama, custody'da emas.
 */
export const OPEN_CUSTODY_STATUSES: readonly Order_status[] = [
  Order_status.NEW,
  Order_status.RECEIVED,
  Order_status.WAITING,
  Order_status.WAITING_CUSTOMER,
  Order_status.ON_THE_ROAD,
  Order_status.CANCELLED,
  Order_status.SOLD,
];

const PG_BIGINT_MAX = BigInt('9223372036854775807');
const CANONICAL_ID = /^[1-9]\d{0,18}$/;

function badRequest(message: string): never {
  throw new RpcException({ statusCode: 400, message });
}

/**
 * Kanonik musbat bigint satr: bosh nolsiz, bo'shliqsiz, Postgres bigint
 * chegarasida ('05', ' 5', 5 (son), '0' — yo'q). Aks holda PG 22P02/22003
 * → 500 bo'lardi yoki chaqiruvchi xatosi jim yashirinardi.
 */
function isCanonicalBigintId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    CANONICAL_ID.test(value) &&
    BigInt(value) <= PG_BIGINT_MAX
  );
}

/**
 * Payload tekshiruvi. `district_ids` — 1..50 ta kanonik bigint satr
 * (takrorlar olib tashlanadi, tartib saqlanadi); `after_id` — kanonik
 * bigint yoki null/yo'q; `limit` — butun son 1..1000 (yo'q/null → 1000).
 * Noto'g'ri qiymat — 400 (jim tuzatilmaydi).
 */
export function normalizeOpenCustodyPayload(raw: unknown): OpenCustodyQuery {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    badRequest("payload obyekt bo'lishi kerak");
  }
  const payload = raw as {
    district_ids?: unknown;
    after_id?: unknown;
    limit?: unknown;
  };

  const rawIds = payload.district_ids;
  if (!Array.isArray(rawIds)) {
    badRequest("district_ids massiv bo'lishi kerak");
  }
  if (rawIds.length < 1 || rawIds.length > OPEN_CUSTODY_MAX_DISTRICT_IDS) {
    badRequest(
      `district_ids: 1 dan ${OPEN_CUSTODY_MAX_DISTRICT_IDS} tagacha tuman`,
    );
  }
  const districtIds = new Set<string>();
  for (const value of rawIds as unknown[]) {
    if (!isCanonicalBigintId(value)) {
      badRequest(`Noto'g'ri tuman id: ${JSON.stringify(value) ?? 'undefined'}`);
    }
    districtIds.add(value);
  }

  let afterId: string | null = null;
  if (payload.after_id !== undefined && payload.after_id !== null) {
    if (!isCanonicalBigintId(payload.after_id)) {
      badRequest(
        `Noto'g'ri after_id: ${JSON.stringify(payload.after_id) ?? 'undefined'}`,
      );
    }
    afterId = payload.after_id;
  }

  let limit = OPEN_CUSTODY_DEFAULT_LIMIT;
  if (payload.limit !== undefined && payload.limit !== null) {
    const value = payload.limit;
    if (
      typeof value !== 'number' ||
      !Number.isInteger(value) ||
      value < 1 ||
      value > OPEN_CUSTODY_MAX_LIMIT
    ) {
      badRequest(
        `limit 1 dan ${OPEN_CUSTODY_MAX_LIMIT} gacha butun son bo'lishi kerak`,
      );
    }
    limit = value;
  }

  return { districtIds: [...districtIds], afterId, limit };
}

/** `getRawMany` xom qatori — barcha ustunlar `CAST(... AS text)`. */
type RawOpenCustodyRow = Record<
  keyof OpenCustodyRow,
  string | number | null | undefined
>;

const textOrNull = (
  value: string | number | null | undefined,
): string | null =>
  value === null || value === undefined ? null : String(value);

@Injectable()
export class OpenCustodyByDistrictService {
  constructor(
    @InjectRepository(Order)
    private readonly orderRepo: Repository<Order>,
  ) {}

  async findOpenCustodyByDistrict(
    payload: unknown,
  ): Promise<OpenCustodyResponse> {
    const query = normalizeOpenCustodyPayload(payload);
    // `deleted_at IS NULL` ni TypeORM o'zi qo'shadi (`@DeleteDateColumn`) —
    // `is_deleted` bilan birga ikkala o'chirish yo'li ham chiqarib tashlanadi.
    // Faqat kerakli ustunlar (relation'siz); id'lar matn — bigint aniqligi
    // JSON'da yo'qolmasin. Keyset `o.id > :afterId` — bigint bo'yicha.
    // Partiya LEFT JOIN — `b.id` PK, buyurtmada bitta `current_batch_id`:
    // qator ko'paymaydi, keyset buzilmaydi. Faqat SENT partiya (yo'nalishdan
    // qat'i nazar) manzil beradi, boshqasi — `null`.
    const qb = this.orderRepo
      .createQueryBuilder('o')
      .select('CAST(o.id AS text)', 'id')
      .addSelect('CAST(o.district_id AS text)', 'district_id')
      .addSelect('CAST(o.region_id AS text)', 'region_id')
      .addSelect('CAST(o.status AS text)', 'status')
      .addSelect('CAST(o.holder_type AS text)', 'holder_type')
      .addSelect('CAST(o.holder_branch_id AS text)', 'holder_branch_id')
      .addSelect('CAST(o.holder_courier_id AS text)', 'holder_courier_id')
      .addSelect('CAST(o.branch_id AS text)', 'branch_id')
      .addSelect('CAST(o.courier_id AS text)', 'courier_id')
      .addSelect('CAST(o.current_batch_id AS text)', 'current_batch_id')
      .addSelect(
        'CAST(b.destination_branch_id AS text)',
        'batch_destination_branch_id',
      )
      .leftJoin(
        BranchTransferBatch,
        'b',
        'b.id = o.current_batch_id AND b.status = :batchSentStatus',
        { batchSentStatus: BranchTransferBatchStatus.SENT },
      )
      .where('o.is_deleted = false')
      .andWhere('o.district_id IN (:...districtIds)', {
        districtIds: query.districtIds,
      })
      .andWhere('o.status IN (:...statuses)', {
        statuses: [...OPEN_CUSTODY_STATUSES],
      })
      .andWhere("o.holder_type IS DISTINCT FROM 'MARKET'");
    if (query.afterId !== null) {
      qb.andWhere('o.id > :afterId', { afterId: query.afterId });
    }
    const raw = await qb
      .orderBy('o.id', 'ASC')
      .limit(query.limit)
      .getRawMany<RawOpenCustodyRow>();

    const rows: OpenCustodyRow[] = raw.map((row) => ({
      id: String(row.id),
      district_id: textOrNull(row.district_id),
      region_id: textOrNull(row.region_id),
      status: textOrNull(row.status) ?? '',
      holder_type: textOrNull(row.holder_type),
      holder_branch_id: textOrNull(row.holder_branch_id),
      holder_courier_id: textOrNull(row.holder_courier_id),
      branch_id: textOrNull(row.branch_id),
      courier_id: textOrNull(row.courier_id),
      current_batch_id: textOrNull(row.current_batch_id),
      batch_destination_branch_id: textOrNull(row.batch_destination_branch_id),
    }));
    const page: OpenCustodyPage = {
      rows,
      next_after_id:
        rows.length === query.limit ? rows[rows.length - 1].id : null,
    };
    return successRes(page, 200, 'Open custody orders by district');
  }
}
