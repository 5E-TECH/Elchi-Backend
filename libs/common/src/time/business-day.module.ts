import {
  DynamicModule,
  Global,
  Inject,
  Injectable,
  Logger,
  Module,
  OnApplicationBootstrap,
  OnModuleDestroy,
  Optional,
} from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import type { ClientProxy } from '@nestjs/microservices';
import { DataSource } from 'typeorm';
import { rmqSend } from '../rmq/rmq-client.helper';
import {
  BUSINESS_DAY_REFRESH_MS,
  BUSINESS_DAY_SETTING_KEY,
  getBusinessDaySchedule,
  normalizeBusinessDaySchedule,
  parseStoredBusinessDay,
  setBusinessDaySchedule,
} from './business-day';

/** `BusinessDayModule` sozlamasi. */
export interface BusinessDayModuleOptions {
  /**
   * `'db'` (sukut) — `order_schema.order_settings` dan to'g'ridan-to'g'ri
   * (bitta Postgres, umumiy `POSTGRES_URI`); `{ rmqClient }` — bazasiz
   * servis (api-gateway): order-service `order.intake.state` orqali.
   */
  source?: 'db' | { rmqClient: string };
}

const OPTIONS = Symbol('BUSINESS_DAY_OPTIONS');
const SAFE_IDENT_RE = /^[a-z_][a-z0-9_]*$/;

/** Sozlama jadvali sxemasi (migratsiyalardagi `DB_SCHEMA_ORDER` qoidasi). */
function orderSchema(): string {
  const raw = String(process.env.DB_SCHEMA_ORDER || 'order_schema').trim();
  return SAFE_IDENT_RE.test(raw) ? raw : 'order_schema';
}

/**
 * Ish kuni jadvalini (`business-day.ts`) jarayonga yuklaydi va har
 * `BUSINESS_DAY_REFRESH_MS` da yangilaydi — servis qayta ishga tushmasdan
 * yangi soatni ko'pi bilan 1 daqiqada oladi (karta xhiXv3w3, mezon 3).
 *
 * O'qib bo'lmasa — oxirgi ma'lum jadval qoladi (birinchi marta — sukut
 * 00:00), faqat `warn` yoziladi: kun chegarasi xatosi servisni to'xtatmasin.
 */
/**
 * `order.intake.state` javobidan jadval: order-service `successRes(...)`
 * konvertida qaytaradi (`{ statusCode, message, data: { day_change_schedule } }`),
 * yalang'och holat ham qabul qilinadi. Topilmasa — `undefined`.
 */
export function intakeStateSchedule(response: unknown): unknown[] | undefined {
  const pick = (value: unknown): unknown[] | undefined => {
    if (!value || typeof value !== 'object') return undefined;
    const schedule = (value as { day_change_schedule?: unknown })
      .day_change_schedule;
    return Array.isArray(schedule) ? schedule : undefined;
  };
  return (
    pick(response) ??
    pick((response as { data?: unknown } | null | undefined)?.data)
  );
}

@Injectable()
export class BusinessDayScheduleSync
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(BusinessDayScheduleSync.name);
  private timer?: ReturnType<typeof setInterval>;
  private retry?: ReturnType<typeof setTimeout>;
  private lastSignature = '[]';
  private failing = false;

  constructor(
    private readonly moduleRef: ModuleRef,
    @Inject(OPTIONS) private readonly options: BusinessDayModuleOptions,
    @Optional() private readonly dataSource?: DataSource,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    // Ishga tushish ko'pi bilan ~3 s kutadi (RMQ manbasida order-service hali
    // ko'tarilmagan bo'lishi mumkin); o'qilmasa — 5 s dan keyin yana urinadi.
    let settled = false;
    const first = this.refresh().then(() => {
      settled = true;
    });
    await Promise.race([
      first,
      new Promise<void>((resolve) => {
        const wait = setTimeout(resolve, 3_000);
        wait.unref?.();
      }),
    ]);
    if (!settled || this.failing) {
      this.retry = setTimeout(() => void this.refresh(), 5_000);
      this.retry.unref?.();
    }
    this.timer = setInterval(
      () => void this.refresh(),
      BUSINESS_DAY_REFRESH_MS,
    );
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.retry) clearTimeout(this.retry);
  }

  /** Bir marta o'qib, jadvalni yangilaydi (testlar ham chaqiradi). */
  async refresh(): Promise<void> {
    try {
      const rules = await this.load();
      if (rules === undefined) return;
      const signature = JSON.stringify(rules);
      setBusinessDaySchedule(rules);
      if (signature !== this.lastSignature) {
        this.logger.log(`ish kuni jadvali: ${signature}`);
        this.lastSignature = signature;
      }
      this.failing = false;
    } catch (error) {
      if (!this.failing) {
        this.logger.warn(
          `ish kuni jadvalini o'qib bo'lmadi — oxirgisi qoladi (${JSON.stringify(
            getBusinessDaySchedule(),
          )}): ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      this.failing = true;
    }
  }

  private async load() {
    const source = this.options.source ?? 'db';
    if (source === 'db') {
      if (!this.dataSource?.isInitialized) return undefined;
      const rows: Array<{ value: unknown }> = await this.dataSource.query(
        `SELECT "value" FROM "${orderSchema()}"."order_settings"
          WHERE "key" = $1 AND "is_deleted" = false
          LIMIT 1`,
        [BUSINESS_DAY_SETTING_KEY],
      );
      return parseStoredBusinessDay(rows[0]?.value);
    }
    const client = this.moduleRef.get<ClientProxy>(source.rmqClient, {
      strict: false,
    });
    const response = await rmqSend<unknown>(
      client,
      { cmd: 'order.intake.state' },
      {},
      { timeoutMs: 5_000, retries: 1 },
    );
    const schedule = intakeStateSchedule(response);
    if (schedule === undefined) {
      throw new Error("order.intake.state javobida day_change_schedule yo'q");
    }
    return normalizeBusinessDaySchedule(schedule);
  }
}

/**
 * Har «kun»ga bog'liq servisning ildiz moduliga BIR MARTA qo'shiladi:
 * `BusinessDayModule.forRoot()` (DB) yoki
 * `BusinessDayModule.forRoot({ source: { rmqClient: 'ORDER' } })`.
 */
@Global()
@Module({})
export class BusinessDayModule {
  static forRoot(options: BusinessDayModuleOptions = {}): DynamicModule {
    return {
      module: BusinessDayModule,
      providers: [
        { provide: OPTIONS, useValue: options },
        BusinessDayScheduleSync,
      ],
      exports: [BusinessDayScheduleSync],
    };
  }
}
