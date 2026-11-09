import { Injectable, Logger, Optional } from '@nestjs/common';
import { RpcException } from '@nestjs/microservices';
import { DataSource, EntityManager, In } from 'typeorm';
import {
  ActivityLogService,
  ORDER_INTAKE_DEFAULT_DAY_CHANGE_TIME,
  ORDER_INTAKE_SETTING_KEYS,
  formatClockTime,
  orderIntakeClosedError,
  parseClockTime,
  resolveOrderIntakeState,
  resolveOrderIntakeWindow,
  type OrderIntakeState,
  type StoredOrderIntakeCutoff,
} from '@app/common';
import { OrderSetting } from '../entities/order-setting.entity';

/** Bir vaqtda ikki superadmin yozsa — ketma-ket (tranzaksiya qulfi). */
const INTAKE_SETTINGS_LOCK = 'order.intake.settings';

interface IntakeSettingsRow {
  dayChangeTime: unknown;
  cutoff: unknown;
}

export interface OrderIntakeUpdateInput {
  /** `'HH:MM'` — bugungi qabul vaqti; `null` — cheklovni olib tashlash. */
  cutoff_time?: unknown;
  /** `'HH:MM'` — kun almashish soati; `null` — sukut (`00:00`). */
  day_change_time?: unknown;
  requester?: { id?: unknown; roles?: unknown } | null;
}

function rpc(statusCode: number, message: string): RpcException {
  return new RpcException({ statusCode, message, data: null });
}

/**
 * BUGUNGI QABUL VAQTI va KUN ALMASHISH SOATI (ega 2026-11-09, Trello #756).
 * Vaqt hisobi — `@app/common` `order/order-intake.ts` (toza); bu servis
 * faqat `order_settings` ni o'qiydi/yozadi.
 *
 * Darvoza (`assertOpen`) controllerda IDEMPOTENCY'DAN OLDIN chaqiriladi:
 * aks holda rad etilgan `order.create` kaliti `failed` bo'lib keshlanardi va
 * hamkor (deterministik `request_id`, `reclaimFailed` yo'q) qabul ochilgach
 * ham o'sha buyurtmani HECH QACHON yarata olmasdi.
 */
@Injectable()
export class OrderIntakeService {
  private readonly logger = new Logger(OrderIntakeService.name);

  constructor(
    private readonly dataSource: DataSource,
    @Optional() private readonly activityLog?: ActivityLogService,
  ) {}

  async getState(now: Date = new Date()): Promise<OrderIntakeState> {
    const settings = await this.loadSettings();
    return resolveOrderIntakeState({ now, ...settings });
  }

  /**
   * Qabul yopiq bo'lsa — 409 `ORDER_INTAKE_CLOSED` (`reopens_at` bilan).
   *
   * ⚠️ FAIL OPEN: sozlamani o'qib bo'lmasa (DB xatosi, migratsiya 213
   * hali ishlamagan) darvoza o'tkazib yuboradi va `error` yoziladi — qabul
   * vaqti yumshoq qoida, uning nosozligi BUTUN buyurtma yaratishni
   * to'xtatmasin. (`getState` — `GET /orders/intake-settings` — xatoni
   * yashirmaydi.)
   */
  async assertOpen(now: Date = new Date()): Promise<OrderIntakeState | null> {
    let state: OrderIntakeState;
    try {
      state = await this.getState(now);
    } catch (error) {
      this.logger.error(
        `order intake settings unreadable — gate skipped (fail open): ${
          (error as Error)?.message ?? 'unknown'
        }`,
      );
      return null;
    }
    if (!state.is_open) {
      throw new RpcException(orderIntakeClosedError(state));
    }
    return state;
  }

  /**
   * Faqat SUPERADMIN (gateway ham `@Roles(SUPERADMIN)` — himoya chuqurligi).
   *
   * - `cutoff_time` — JORIY ish kuni oynasiga yoziladi (`window_start`);
   *   kun almashganda o'zi amal qilmay qoladi. O'tgan vaqt qo'yilsa qabul
   *   darhol yopiladi.
   * - `day_change_time` — doimiy. O'zgarsa joriy oyna siljiydi; bugungi
   *   cheklov (alohida berilmagan bo'lsa) yangi oynaga KO'CHADI, faqat ish
   *   kuni sanasi o'zgarmagan bo'lsa (masalan 00:00 → 06:00 ertalab). Sana
   *   o'zgarsa (19:00 da 00:00 → 18:00 — yangi kun boshlangan) — eski kunning
   *   cheklovi yangi kunga o'tmaydi.
   */
  async update(
    input: OrderIntakeUpdateInput,
    now: Date = new Date(),
  ): Promise<OrderIntakeState> {
    const roles = Array.isArray(input?.requester?.roles)
      ? input.requester.roles.map((role) => String(role).toLowerCase())
      : [];
    if (!roles.includes('superadmin')) {
      throw rpc(
        403,
        "Bugungi qabul vaqti va kun almashish soatini faqat superadmin o'zgartira oladi",
      );
    }
    const hasCutoff = input?.cutoff_time !== undefined;
    const hasDayChange = input?.day_change_time !== undefined;
    if (!hasCutoff && !hasDayChange) {
      throw rpc(
        400,
        "O'zgartiriladigan sozlama berilmadi (cutoff_time yoki day_change_time)",
      );
    }
    const cutoffTime = hasCutoff
      ? this.parseClockInput(input.cutoff_time, 'cutoff_time', null)
      : undefined;
    const dayChangeTime = hasDayChange
      ? this.parseClockInput(
          input.day_change_time,
          'day_change_time',
          ORDER_INTAKE_DEFAULT_DAY_CHANGE_TIME,
        )
      : undefined;
    const rawId =
      typeof input?.requester?.id === 'string' ||
      typeof input?.requester?.id === 'number'
        ? String(input.requester.id)
        : '';
    const requesterId = /^\d{1,19}$/.test(rawId) ? rawId : null;

    const { before, after } = await this.dataSource.transaction(
      async (manager) => {
        await manager.query(
          'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
          [INTAKE_SETTINGS_LOCK],
        );
        const beforeState = resolveOrderIntakeState({
          now,
          ...(await this.loadSettings(manager)),
        });
        const nextDayChange = dayChangeTime ?? beforeState.day_change_time;
        if (
          dayChangeTime !== undefined &&
          dayChangeTime !== beforeState.day_change_time
        ) {
          await this.writeSetting(
            manager,
            ORDER_INTAKE_SETTING_KEYS.dayChangeTime,
            { time: dayChangeTime },
            requesterId,
          );
        }
        const window = resolveOrderIntakeWindow(
          now,
          parseClockTime(nextDayChange) as number,
        );
        let nextCutoff: string | null | undefined = cutoffTime;
        if (
          nextCutoff === undefined &&
          dayChangeTime !== undefined &&
          beforeState.cutoff_time !== null &&
          window.date === beforeState.date &&
          window.start.toISOString() !== beforeState.day_started_at
        ) {
          // Kun almashish soati o'zgardi, ish kuni o'sha — bugungi cheklov
          // yangi oynada ham amal qilsin.
          nextCutoff = beforeState.cutoff_time;
        }
        if (nextCutoff !== undefined) {
          const value: StoredOrderIntakeCutoff = {
            window_start: window.start.toISOString(),
            date: window.date,
            cutoff_time: nextCutoff,
          };
          await this.writeSetting(
            manager,
            ORDER_INTAKE_SETTING_KEYS.cutoff,
            value,
            requesterId,
          );
        }
        return {
          before: beforeState,
          after: resolveOrderIntakeState({
            now,
            ...(await this.loadSettings(manager)),
          }),
        };
      },
    );

    // Jurnal — tranzaksiyadan keyin (fail-safe; yozilmasa ham sozlama turadi).
    if (hasCutoff) {
      await this.activityLog?.log({
        entity_type: 'OrderSetting',
        entity_id: ORDER_INTAKE_SETTING_KEYS.cutoff,
        action: 'order.intake_cutoff_changed',
        old_value: { cutoff_time: before.cutoff_time, date: before.date },
        new_value: { cutoff_time: after.cutoff_time, date: after.date },
        user_id: requesterId,
        metadata: {
          closes_at: after.closes_at,
          reopens_at: after.reopens_at,
          is_open: after.is_open,
        },
      });
    }
    if (before.day_change_time !== after.day_change_time) {
      await this.activityLog?.log({
        entity_type: 'OrderSetting',
        entity_id: ORDER_INTAKE_SETTING_KEYS.dayChangeTime,
        action: 'order.day_change_time_changed',
        old_value: { day_change_time: before.day_change_time },
        new_value: { day_change_time: after.day_change_time },
        user_id: requesterId,
        metadata: {
          day_started_at: after.day_started_at,
          next_day_change_at: after.next_day_change_at,
          cutoff_time: after.cutoff_time,
        },
      });
    }
    this.logger.log(
      `order intake updated by ${requesterId ?? 'unknown'}: cutoff ${before.cutoff_time ?? '-'} → ${after.cutoff_time ?? '-'}, day change ${before.day_change_time} → ${after.day_change_time}`,
    );
    return after;
  }

  private parseClockInput(
    value: unknown,
    field: 'cutoff_time' | 'day_change_time',
    nullValue: string | null,
  ): string | null {
    if (value === null) return nullValue;
    const minutes = parseClockTime(value);
    if (minutes === null) {
      throw rpc(
        400,
        `${field} HH:MM ko'rinishida bo'lishi kerak (00:00–23:59, masalan 10:00)`,
      );
    }
    return formatClockTime(minutes);
  }

  private async loadSettings(
    manager?: EntityManager,
  ): Promise<IntakeSettingsRow> {
    const rows = await (manager ?? this.dataSource.manager)
      .getRepository(OrderSetting)
      .find({
        where: {
          key: In([
            ORDER_INTAKE_SETTING_KEYS.dayChangeTime,
            ORDER_INTAKE_SETTING_KEYS.cutoff,
          ]),
          isDeleted: false,
        },
      });
    const map = new Map(rows.map((row) => [row.key, row.value]));
    const dayChange = map.get(ORDER_INTAKE_SETTING_KEYS.dayChangeTime);
    return {
      dayChangeTime:
        dayChange && typeof dayChange === 'object'
          ? (dayChange as { time?: unknown }).time
          : null,
      cutoff: map.get(ORDER_INTAKE_SETTING_KEYS.cutoff) ?? null,
    };
  }

  private async writeSetting(
    manager: EntityManager,
    key: string,
    value: unknown,
    requesterId: string | null,
  ): Promise<void> {
    await manager
      .createQueryBuilder()
      .insert()
      .into(OrderSetting)
      .values({ key, value: value as never, updated_by: requesterId })
      .orUpdate(['value', 'updated_by', 'updatedAt'], ['key'])
      .execute();
  }
}
