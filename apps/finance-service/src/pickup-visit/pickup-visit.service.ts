import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { RpcException } from '@nestjs/microservices';
import { DataSource, QueryFailedError, SelectQueryBuilder } from 'typeorm';
import {
  ActivityLogService,
  Cashbox_type,
  computePickupFee,
  DeliveryPricingInputError,
  tashkentDayRange,
} from '@app/common';
import { successRes } from '../../../../libs/common/helpers/response';
import { Cashbox } from '../entities/cashbox.entity';
import { PickupVisit } from '../entities/pickup-visit.entity';
import { FinanceServiceService } from '../finance-service.service';

/** `finance.pickup_visit.record` kirishi (gateway'dan, maydonlar ishonchsiz). */
export interface PickupVisitRecordInput {
  market_id?: unknown;
  courier_id?: unknown;
  parcel_count?: unknown;
  occurred_at?: unknown;
  idempotency_key?: unknown;
  created_by?: unknown;
  /** Gateway `logistics.delivery.settings.get` dan oladi — kodda summa yo'q. */
  settings?: { pickup_fee?: unknown; pickup_free_from_count?: unknown } | null;
}

export interface PickupVisitListInput {
  market_id?: unknown;
  courier_id?: unknown;
  is_free?: unknown;
  from_date?: string;
  to_date?: string;
  page?: unknown;
  limit?: unknown;
}

const ID_RE = /^[1-9]\d{0,18}$/;
const MAX_PARCELS = 100_000;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

const reject = (statusCode: number, message: string): never => {
  throw new RpcException({ statusCode, message });
};

/**
 * B824gOu5 — kuryer chaqiruvi (pickup) tashrifi.
 *
 * LANGAR QARORI: tashrif MUSTAQIL yozuv, `POST /orders/receive` partiyasiga
 * ham, `assign-to-courier` ga ham bog'lanmagan. Sabab: qabul partiyasi va
 * biriktirish bir tashrifni bildirmaydi — ikkalasi filialdagi skaner/biriktirish
 * bo'laklari (bir tashrif bir necha `receive` chaqiruvi yoki aksincha), market
 * va kuryer esa ularda majburiy emas. 10 chegarasi posilka sonining ANIQ
 * sanalishiga tayanadi, shuning uchun son yozuvchi kiritadi. Mavjud qabul va
 * sotuv oqimi o'zgarmaydi: haq faqat shu servis chaqirilganda yoziladi.
 */
@Injectable()
export class PickupVisitService {
  private readonly logger = new Logger(PickupVisitService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly activityLog: ActivityLogService,
    private readonly finance: FinanceServiceService,
  ) {}

  private parseId(value: unknown, field: string): string {
    const id = typeof value === 'number' ? String(value) : value;
    if (typeof id !== 'string' || !ID_RE.test(id)) {
      reject(400, `${field} noto'g'ri`);
    }
    return id as string;
  }

  private parseParcelCount(value: unknown): number {
    const count = Number(value);
    if (!Number.isInteger(count) || count < 1 || count > MAX_PARCELS) {
      reject(400, `parcel_count 1…${MAX_PARCELS} oralig'idagi butun son`);
    }
    return count;
  }

  private parseKey(value: unknown): string {
    const key = typeof value === 'string' ? value.trim() : '';
    if (!key || key.length > 255) {
      reject(400, "Idempotency-Key 1-255 belgi bo'lishi kerak");
    }
    return key;
  }

  private parseOccurredAt(value: unknown): Date {
    if (value === undefined || value === null || value === '') {
      return new Date();
    }
    const date =
      typeof value === 'string' ? new Date(value) : new Date(Number.NaN);
    if (Number.isNaN(date.getTime())) {
      reject(400, "occurred_at noto'g'ri");
    }
    return date;
  }

  private view(visit: PickupVisit) {
    return {
      id: String(visit.id),
      market_id: String(visit.market_id),
      courier_id: String(visit.courier_id),
      parcel_count: visit.parcel_count,
      fee: Number(visit.fee),
      is_free: visit.is_free,
      created_by: String(visit.created_by),
      occurred_at: visit.occurred_at,
      cashbox_history_id: visit.cashbox_history_id,
      created_at: visit.createdAt,
    };
  }

  /**
   * Bitta tashrif — bitta yozuv: yozuv, market kassasi chiqimi va P&L kirimi
   * bitta tranzaksiyada. Ayni `idempotency_key` bilan takror — o'sha yozuv
   * (haq qayta hisoblanmaydi, sozlama orada o'zgargan bo'lsa ham); ayni kalit
   * boshqa tashrif bilan — 409.
   */
  async record(input: PickupVisitRecordInput) {
    const marketId = this.parseId(input?.market_id, 'market_id');
    const courierId = this.parseId(input?.courier_id, 'courier_id');
    const createdBy = this.parseId(input?.created_by, 'created_by');
    const parcelCount = this.parseParcelCount(input?.parcel_count);
    const key = this.parseKey(input?.idempotency_key);
    const occurredAt = this.parseOccurredAt(input?.occurred_at);

    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();
    let saved!: PickupVisit;
    try {
      const tx = queryRunner.manager;
      // Avval market kassasi qulfi: bir xil kalitli parallel so'rovlar va
      // to'lovning FIFO hisobi shu qulf ostida ketma-ket.
      const marketCashbox = await tx.findOne(Cashbox, {
        where: {
          user_id: marketId,
          cashbox_type: Cashbox_type.FOR_MARKET,
          isDeleted: false,
        },
        lock: { mode: 'pessimistic_write' },
      });
      if (!marketCashbox) {
        throw new NotFoundException('Market kassasi topilmadi');
      }

      const existing = await tx.findOne(PickupVisit, {
        where: { idempotency_key: key },
      });
      if (existing) {
        if (
          String(existing.market_id) !== marketId ||
          String(existing.courier_id) !== courierId ||
          existing.parcel_count !== parcelCount
        ) {
          reject(
            409,
            'Idempotency-Key boshqa tashrif uchun allaqachon ishlatilgan',
          );
        }
        await queryRunner.commitTransaction();
        return successRes(
          { ...this.view(existing), idempotent: true },
          200,
          "Pickup tashrifi allaqachon yozilgan (takroriy so'rov)",
        );
      }

      const { fee, isFree } = computePickupFee({
        parcelCount,
        pickupFee: input?.settings?.pickup_fee as number,
        pickupFreeFromCount: input?.settings?.pickup_free_from_count as number,
      });
      const visit = await tx.save(
        tx.create(PickupVisit, {
          market_id: marketId,
          courier_id: courierId,
          parcel_count: parcelCount,
          fee,
          is_free: isFree,
          created_by: createdBy,
          occurred_at: occurredAt,
          idempotency_key: key,
        }),
      );
      const history = await this.finance.applyPickupFeeInTx(tx, {
        marketCashbox,
        visit_id: String(visit.id),
        market_id: marketId,
        fee,
        parcel_count: parcelCount,
        occurred_at: occurredAt,
        created_by: createdBy,
      });
      visit.cashbox_history_id = String(history.id);
      await tx.update(
        PickupVisit,
        { id: visit.id },
        { cashbox_history_id: visit.cashbox_history_id },
      );

      await queryRunner.commitTransaction();
      saved = visit;
    } catch (error) {
      if (queryRunner.isTransactionActive) {
        await queryRunner.rollbackTransaction();
      }
      this.rethrow(error);
    } finally {
      await queryRunner.release();
    }

    await this.activityLog
      .log({
        entity_type: 'PickupVisit',
        entity_id: String(saved.id),
        action: 'finance.pickup_visit_recorded',
        new_value: {
          market_id: marketId,
          courier_id: courierId,
          parcel_count: parcelCount,
          fee: Number(saved.fee),
          is_free: saved.is_free,
        },
        user_id: createdBy,
      })
      .catch((error: unknown) =>
        this.logger.warn(
          `pickup visit audit: ${(error as Error)?.message ?? error}`,
        ),
      );
    return successRes(
      { ...this.view(saved), idempotent: false },
      201,
      saved.is_free
        ? 'Pickup tashrifi yozildi (tekin)'
        : 'Pickup tashrifi yozildi',
    );
  }

  private rethrow(error: unknown): never {
    if (error instanceof RpcException) {
      throw error;
    }
    if (error instanceof NotFoundException) {
      throw new RpcException({ statusCode: 404, message: error.message });
    }
    if (
      error instanceof BadRequestException ||
      error instanceof DeliveryPricingInputError
    ) {
      throw new RpcException({ statusCode: 400, message: error.message });
    }
    // Boshqa market bilan ayni kalit: qulflar turlicha, UNIQUE ushlaydi.
    if (
      error instanceof QueryFailedError &&
      (error.driverError as { code?: string } | undefined)?.code === '23505'
    ) {
      throw new RpcException({
        statusCode: 409,
        message: 'Idempotency-Key boshqa tashrif uchun allaqachon ishlatilgan',
      });
    }
    throw new RpcException({
      statusCode: 500,
      message: error instanceof Error ? error.message : 'Internal server error',
    });
  }

  private applyFilters(
    qb: SelectQueryBuilder<PickupVisit>,
    input: PickupVisitListInput,
  ) {
    qb.where('v.isDeleted = false');
    if (input?.market_id != null && input.market_id !== '') {
      qb.andWhere('v.market_id = :marketId', {
        marketId: this.parseId(input.market_id, 'market_id'),
      });
    }
    if (input?.courier_id != null && input.courier_id !== '') {
      qb.andWhere('v.courier_id = :courierId', {
        courierId: this.parseId(input.courier_id, 'courier_id'),
      });
    }
    if (input?.is_free === true || input?.is_free === 'true') {
      qb.andWhere('v.is_free = true');
    } else if (input?.is_free === false || input?.is_free === 'false') {
      qb.andWhere('v.is_free = false');
    }
    // Toshkent kuni (kassa ro'yxatlari bilan bir xil), tashrif sanasi bo'yicha.
    const { start, end } = tashkentDayRange(input?.from_date, input?.to_date);
    if (start) qb.andWhere('v.occurred_at >= :start', { start });
    if (end) qb.andWhere('v.occurred_at <= :end', { end });
    return qb;
  }

  private async summaryOf(input: PickupVisitListInput) {
    const raw = await this.applyFilters(
      this.dataSource.getRepository(PickupVisit).createQueryBuilder('v'),
      input,
    )
      .select('COALESCE(SUM(v.fee), 0)', 'income')
      .addSelect('COUNT(*)', 'visits')
      .addSelect('COUNT(*) FILTER (WHERE v.is_free = true)', 'free_visits')
      .addSelect('COALESCE(SUM(v.parcel_count), 0)', 'parcels')
      .getRawOne<{
        income: string;
        visits: string;
        free_visits: string;
        parcels: string;
      }>();
    const visits = Number(raw?.visits ?? 0);
    const freeVisits = Number(raw?.free_visits ?? 0);
    return {
      income: Number(raw?.income ?? 0),
      visits,
      paid_visits: visits - freeVisits,
      free_visits: freeVisits,
      parcels: Number(raw?.parcels ?? 0),
    };
  }

  /** `GET /finance/pickup-visits` — tashriflar + AYNI filtr bo'yicha yig'indi. */
  async findAll(input: PickupVisitListInput) {
    try {
      const page = Math.max(Math.floor(Number(input?.page)) || 1, 1);
      const limit = Math.min(
        Math.max(Math.floor(Number(input?.limit)) || DEFAULT_LIMIT, 1),
        MAX_LIMIT,
      );
      const [rows, total] = await this.applyFilters(
        this.dataSource.getRepository(PickupVisit).createQueryBuilder('v'),
        input,
      )
        .orderBy('v.occurred_at', 'DESC')
        .addOrderBy('v.id', 'DESC')
        .skip((page - 1) * limit)
        .take(limit)
        .getManyAndCount();
      const [summary, names] = await Promise.all([
        this.summaryOf(input),
        this.finance
          .userNames(
            rows.flatMap((row) => [
              String(row.market_id),
              String(row.courier_id),
              String(row.created_by),
            ]),
          )
          .catch(() => new Map<string, string | null>()),
      ]);
      return successRes(
        {
          items: rows.map((row) => ({
            ...this.view(row),
            market_name: names.get(String(row.market_id)) ?? null,
            courier_name: names.get(String(row.courier_id)) ?? null,
            created_by_name: names.get(String(row.created_by)) ?? null,
          })),
          summary,
          pagination: {
            total,
            page,
            limit,
            totalPages: Math.ceil(total / limit),
          },
        },
        200,
        'Pickup tashriflari',
      );
    } catch (error) {
      this.rethrow(error);
    }
  }

  /**
   * Foyda hisoboti uchun: davrdagi pickup daromadi. `order.analytics.*` foydasi
   * faqat buyurtma tariflaridan — bu pul u yerda ko'rinmaydi.
   */
  async incomeSummary(input: { from_date?: string; to_date?: string }) {
    try {
      return successRes(
        await this.summaryOf({
          from_date: input?.from_date,
          to_date: input?.to_date,
        }),
        200,
        'Pickup daromadi',
      );
    } catch (error) {
      this.rethrow(error);
    }
  }
}
