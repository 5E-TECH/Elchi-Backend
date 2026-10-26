import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { DataSource } from 'typeorm';
import { Cashbox_type, rmqSend } from '@app/common';
import { Cashbox } from '../entities/cashbox.entity';
import { money } from './finance-day.util';

const DEFAULT_TOP = 3;
const MAX_TOP = 10;
const MAX_HQ_COURIER_IDS = 5000;
const BIGINT_RE = /^\d{1,19}$/;

const quote = (tablePath: string) =>
  tablePath
    .split('.')
    .map((part) => `"${part}"`)
    .join('.');

/**
 * uzWcMR1C — /payments KPI meta sanoqlari (moliya spec §7, maket
 * `*-payments-overview`): «6 ta marketga» + top-market taqsimoti (segbar) va
 * «2 ta HQ kuryeri». 10 000 lik ro'yxat so'ramasdan — faqat SQL COUNT/SUM va
 * eng katta N ta qator.
 *
 * Qoidalar mavjud kartalar bilan AYNI:
 *   • market — «Berilishi kerak» = faqat MUSBAT market kassalari (audit M16,
 *     `marketPayableTotal`): Σ amount == `berilishi_kerak`;
 *   • HQ kuryeri — `GET /finance/cashbox/hq-couriers` oynasi bilan bir xil
 *     to'plam: HQ filialiga COURIER sifatida biriktirilgan va kuryer kassasi
 *     MUSBAT (id'larni gateway beradi).
 * FAQAT O'QIYDI.
 */
@Injectable()
export class PaymentsMetaService {
  private readonly logger = new Logger(PaymentsMetaService.name);

  constructor(
    private readonly dataSource: DataSource,
    @Optional()
    @Inject('IDENTITY')
    private readonly identityClient?: ClientProxy,
  ) {}

  private cashboxesTable(): string {
    return quote(this.dataSource.getMetadata(Cashbox).tablePath);
  }

  private normalizeTop(value: unknown): number {
    const num = Number(value);
    if (!Number.isInteger(num) || num < 0) return DEFAULT_TOP;
    return Math.min(num, MAX_TOP);
  }

  async paymentsMeta(input?: { hq_courier_ids?: unknown; top?: unknown }) {
    const top = this.normalizeTop(input?.top ?? DEFAULT_TOP);
    const rawIds: unknown = input?.hq_courier_ids;
    const hqCourierIds = Array.from(
      new Set(
        (Array.isArray(rawIds) ? (rawIds as unknown[]) : [])
          .map((id) =>
            typeof id === 'string' || typeof id === 'number'
              ? String(id).trim()
              : '',
          )
          .filter((id) => BIGINT_RE.test(id)),
      ),
    ).slice(0, MAX_HQ_COURIER_IDS);
    const cashboxes = this.cashboxesTable();

    const [marketTotals, topRows, courierTotals] = await Promise.all([
      this.dataSource.query(
        `SELECT COUNT(*) AS cnt, COALESCE(SUM("balance"), 0) AS total
           FROM ${cashboxes}
          WHERE "cashbox_type"::text = $1 AND "is_deleted" = false AND "balance" > 0`,
        [Cashbox_type.FOR_MARKET],
      ) as Promise<Array<{ cnt: string | number; total: string }>>,
      top > 0
        ? (this.dataSource.query(
            `SELECT "id"::text AS cashbox_id, "user_id"::text AS user_id, "balance"
               FROM ${cashboxes}
              WHERE "cashbox_type"::text = $1 AND "is_deleted" = false AND "balance" > 0
              ORDER BY "balance" DESC, "id" ASC
              LIMIT $2`,
            [Cashbox_type.FOR_MARKET, top],
          ) as Promise<
            Array<{ cashbox_id: string; user_id: string; balance: string }>
          >)
        : Promise.resolve([]),
      hqCourierIds.length
        ? (this.dataSource.query(
            `SELECT COUNT(*) AS cnt, COALESCE(SUM("balance"), 0) AS total
               FROM ${cashboxes}
              WHERE "cashbox_type"::text = $1 AND "is_deleted" = false
                AND "balance" > 0 AND "user_id" = ANY($2::bigint[])`,
            [Cashbox_type.FOR_COURIER, hqCourierIds],
          ) as Promise<Array<{ cnt: string | number; total: string }>>)
        : Promise.resolve([{ cnt: 0, total: '0' }]),
    ]);

    const names = await this.marketNames(topRows.map((row) => row.user_id));
    const marketsCount = Number(marketTotals?.[0]?.cnt ?? 0);
    const marketsAmount = money(marketTotals?.[0]?.total);
    const topMarkets = topRows.map((row) => {
      const amount = money(row.balance);
      return {
        market_id: String(row.user_id),
        cashbox_id: String(row.cashbox_id),
        name: names.get(String(row.user_id)) ?? null,
        amount,
        share:
          marketsAmount > 0
            ? Math.round((amount / marketsAmount) * 1000) / 10
            : 0,
      };
    });
    const topAmount = topMarkets.reduce((sum, row) => sum + row.amount, 0);
    const othersAmount = money(marketsAmount - topAmount);

    return {
      statusCode: 200,
      message: "To'lovlar KPI meta",
      data: {
        payable: {
          markets_count: marketsCount,
          amount: marketsAmount,
          top_markets: topMarkets,
          others: {
            count: Math.max(marketsCount - topMarkets.length, 0),
            amount: othersAmount,
            share:
              marketsAmount > 0
                ? Math.round((othersAmount / marketsAmount) * 1000) / 10
                : 0,
          },
        },
        hq_couriers: {
          count: Number(courierTotals?.[0]?.cnt ?? 0),
          amount: money(courierTotals?.[0]?.total),
        },
      },
    };
  }

  /** Top marketlar nomi — identity'dan BITTA batch; xato bo'lsa null nomlar. */
  private async marketNames(ids: string[]): Promise<Map<string, string>> {
    const names = new Map<string, string>();
    if (!ids.length || !this.identityClient) return names;
    try {
      const response = await rmqSend<{
        data?: Array<{ id?: unknown; name?: unknown }>;
      }>(this.identityClient, { cmd: 'identity.market.find_by_ids' }, { ids });
      for (const user of Array.isArray(response?.data) ? response.data : []) {
        if (user?.id === undefined || user?.id === null) continue;
        const name = typeof user.name === 'string' ? user.name.trim() : '';
        if (name) names.set(String(user.id), name);
      }
    } catch (error) {
      this.logger.warn(
        `Top marketlar nomlanmadi: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return names;
  }
}
