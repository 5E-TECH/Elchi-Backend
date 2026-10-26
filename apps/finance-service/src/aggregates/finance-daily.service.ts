import { BadRequestException, Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { Cashbox_type, Operation_type, Source_type } from '@app/common';
import { Cashbox } from '../entities/cashbox.entity';
import { CashboxHistory } from '../entities/cashbox-history.entity';
import { FinancialBalanceHistory } from '../entities/financial-balance-history.entity';
import { FinanceCashboxDaily } from '../entities/finance-cashbox-daily.entity';
import { FinanceDailySnapshot } from '../entities/finance-daily-snapshot.entity';
import {
  addDays,
  dayKeysBetween,
  dayStart,
  daysBetween,
  money,
  moneyOrNull,
  parseDayKey,
  tashkentDayKey,
} from './finance-day.util';

/** Sukut oraliq — oxirgi 14 kun (maket: «oxirgi 14 kun», sparkline). */
const DEFAULT_RANGE_DAYS = 14;
/** Bitta so'rovda ko'pi bilan shuncha kun. */
export const MAX_RANGE_DAYS = 366;
/**
 * Oxirgi snapshot'dan keyingi kunlar (odatda faqat bugun) tarixdan
 * hisoblanadi; job shundan ko'p orqada qolsa (catch-up davom etyapti) —
 * qoldiqlar NULL (`balance_status: 'partial'`), og'ir so'rov yo'q.
 */
const MAX_LIVE_TAIL_DAYS = 7;

const quote = (tablePath: string) =>
  tablePath
    .split('.')
    .map((part) => `"${part}"`)
    .join('.');

const BIGINT_RE = /^\d{1,19}$/;

/** Skalyar so'rov qiymati → matn; obyekt/massiv → '' (keyin 400). */
const scalarText = (value: unknown): string =>
  typeof value === 'string' ||
  typeof value === 'number' ||
  typeof value === 'bigint' ||
  typeof value === 'boolean'
    ? String(value).trim()
    : '';
const CASHBOX_TYPES = new Set<string>(Object.values(Cashbox_type));
const OPERATION_TYPES = new Set<string>(Object.values(Operation_type));
const SOURCE_TYPES = new Set<string>(Object.values(Source_type));

export interface HistoryDailyInput {
  from_date?: string;
  to_date?: string;
  cashbox_id?: string;
  user_id?: string;
  cashbox_type?: string;
  cashboxType?: string;
  operation_type?: string;
  source_type?: string;
  source_types?: string;
  sourceTypes?: string;
  source_user_id?: string;
  created_by?: string;
}

export interface DailyFlowRow {
  date: string;
  income: number;
  expense: number;
  net: number;
  income_count: number;
  expense_count: number;
  opening_balance: number | null;
  closing_balance: number | null;
}

type Scope =
  | { kind: 'ids'; ids: string[] }
  | { kind: 'type'; type: string }
  | { kind: 'empty' };

type BalanceStatus = 'ok' | 'pending' | 'partial';

/**
 * qzjTMWPb — kunlik kirim/chiqim agregati va kunlik qoldiq (maketdagi «Pul
 * oqimi», «Kassa oqimi», «Balans dinamikasi», «Daftar qoldig'i», «Kunlik
 * kirim va chiqim», «kechaga nisbatan» delta, 7/14 kunlik sparkline, waterfall
 * «Davr boshi», kassa tafsilotidagi «Davr boshida» — M2 + M5).
 *
 * FAQAT O'QIYDI. Oqimlar (kirim/chiqim/soni) har doim `cashbox_history` dan
 * jonli SQL GROUP BY bilan (bugun ham aniq, filtrlar bilan). Kun oxiri
 * qoldig'i — `finance_cashbox_daily` snapshot'idan (o'tgan kunlar) va
 * oxirgi snapshot'dan keyingi tarix qatorlaridan (bugun).
 */
@Injectable()
export class FinanceDailyService {
  constructor(private readonly dataSource: DataSource) {}

  private tables() {
    const path = (entity: Parameters<DataSource['getMetadata']>[0]) =>
      quote(this.dataSource.getMetadata(entity).tablePath);
    return {
      cashboxes: path(Cashbox),
      history: path(CashboxHistory),
      ledger: path(FinancialBalanceHistory),
      daily: path(FinanceCashboxDaily),
      snapshots: path(FinanceDailySnapshot),
    };
  }

  /** from/to ('YYYY-MM-DD', Toshkent) → tekshirilgan oraliq. */
  resolveRange(
    input: { from_date?: string; to_date?: string },
    now: Date = new Date(),
  ): { from: string; to: string; today: string } {
    const today = tashkentDayKey(now);
    const rawFrom = input?.from_date;
    const rawTo = input?.to_date;
    const to = rawTo ? parseDayKey(rawTo) : today;
    if (!to) throw new BadRequestException(`Invalid to_date: ${rawTo}`);
    const from = rawFrom
      ? parseDayKey(rawFrom)
      : addDays(to, -(DEFAULT_RANGE_DAYS - 1));
    if (!from) throw new BadRequestException(`Invalid from_date: ${rawFrom}`);
    if (from > to) {
      throw new BadRequestException("from_date to_date dan keyin bo'lmasin");
    }
    if (daysBetween(from, to) + 1 > MAX_RANGE_DAYS) {
      throw new BadRequestException(
        `Oraliq ko'pi bilan ${MAX_RANGE_DAYS} kun bo'lishi mumkin`,
      );
    }
    return { from, to, today };
  }

  private optionalId(value: unknown, field: string): string | undefined {
    if (value === undefined || value === null || value === '') {
      return undefined;
    }
    const text = scalarText(value);
    if (!BIGINT_RE.test(text)) {
      throw new BadRequestException(`${field} noto'g'ri`);
    }
    return text;
  }

  private optionalEnum(
    value: unknown,
    allowed: Set<string>,
    field: string,
  ): string | undefined {
    if (value === undefined || value === null || value === '') {
      return undefined;
    }
    const text = scalarText(value);
    if (!allowed.has(text)) {
      throw new BadRequestException(`${field} noto'g'ri: ${text}`);
    }
    return text;
  }

  private sourceTypesFilter(input: HistoryDailyInput): string[] | undefined {
    const list = input.source_types ?? input.sourceTypes;
    if (list !== undefined && list !== null && String(list).trim() !== '') {
      const values = String(list)
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean);
      for (const value of values) {
        if (!SOURCE_TYPES.has(value)) {
          throw new BadRequestException(`source_types noto'g'ri: ${value}`);
        }
      }
      return values.length ? Array.from(new Set(values)) : undefined;
    }
    const single = this.optionalEnum(
      input.source_type,
      SOURCE_TYPES,
      'source_type',
    );
    return single ? [single] : undefined;
  }

  /**
   * Kassa doirasi — `finance.history.find_all` bilan AYNI tanlash qoidasi:
   * `cashbox_id` (turi berilsa mos kelishi shart) → `user_id` (+tur) →
   * `cashbox_type` → hech biri yo'q bo'lsa MAIN. Faqat faol kassalar.
   */
  private async resolveScope(input: HistoryDailyInput): Promise<Scope> {
    const cashboxId = this.optionalId(input.cashbox_id, 'cashbox_id');
    const userId = this.optionalId(input.user_id, 'user_id');
    const type = this.optionalEnum(
      input.cashbox_type ?? input.cashboxType,
      CASHBOX_TYPES,
      'cashbox_type',
    );
    const { cashboxes } = this.tables();

    if (cashboxId || userId) {
      const params: unknown[] = [];
      const where: string[] = ['"is_deleted" = false'];
      if (cashboxId) {
        params.push(cashboxId);
        where.push(`"id" = $${params.length}`);
      }
      if (userId) {
        params.push(userId);
        where.push(`"user_id" = $${params.length}`);
      }
      if (type) {
        params.push(type);
        where.push(`"cashbox_type"::text = $${params.length}`);
      }
      const rows: Array<{ id: string }> = await this.dataSource.query(
        `SELECT "id"::text AS id FROM ${cashboxes} WHERE ${where.join(' AND ')}`,
        params,
      );
      return rows.length
        ? { kind: 'ids', ids: rows.map((row) => String(row.id)) }
        : { kind: 'empty' };
    }
    return { kind: 'type', type: type ?? Cashbox_type.MAIN };
  }

  /** `alias."cashbox_id"` ni doiraga cheklovchi SQL bo'lagi. */
  private scopeSql(scope: Scope, column: string, params: unknown[]): string {
    const { cashboxes } = this.tables();
    if (scope.kind === 'ids') {
      params.push(scope.ids);
      return `${column} = ANY($${params.length}::bigint[])`;
    }
    if (scope.kind === 'type') {
      params.push(scope.type);
      return `${column} IN (SELECT "id" FROM ${cashboxes} WHERE "cashbox_type"::text = $${params.length} AND "is_deleted" = false)`;
    }
    return 'false';
  }

  async lastSnapshotDate(): Promise<string | null> {
    const { snapshots } = this.tables();
    const rows: Array<{ day: string | null }> = await this.dataSource.query(
      `SELECT to_char(MAX("snapshot_date"), 'YYYY-MM-DD') AS day FROM ${snapshots}`,
    );
    return rows?.[0]?.day ?? null;
  }

  /**
   * Doiradagi kassalarning [firstDay, lastDay] har kuni oxiridagi jami
   * qoldig'i. Snapshot bor kunlar — `finance_cashbox_daily` yig'indisi
   * (qator yo'q = 0); oxirgi snapshot'dan keyingi kunlar — snapshot
   * qoldig'i + keyingi tarix qatorlarining `balance_after`i.
   */
  private async closingSeries(
    scope: Scope,
    firstDay: string,
    lastDay: string,
    lastDone: string | null,
    today: string,
  ): Promise<{ closing: Map<string, number | null>; status: BalanceStatus }> {
    const closing = new Map<string, number | null>();
    const days = dayKeysBetween(firstDay, lastDay);
    if (!lastDone) {
      for (const day of days) closing.set(day, null);
      return { closing, status: 'pending' };
    }
    const t = this.tables();
    let status: BalanceStatus = 'ok';

    const snapshotEnd = lastDay < lastDone ? lastDay : lastDone;
    if (firstDay <= snapshotEnd) {
      const params: unknown[] = [firstDay, snapshotEnd];
      const scopeCond = this.scopeSql(scope, 'd."cashbox_id"', params);
      const rows: Array<{ day: string; total: string | null }> =
        await this.dataSource.query(
          `SELECT to_char(d."snapshot_date", 'YYYY-MM-DD') AS day,
                  SUM(d."closing_balance") AS total
             FROM ${t.daily} d
            WHERE d."snapshot_date" BETWEEN $1::date AND $2::date
              AND ${scopeCond}
            GROUP BY d."snapshot_date"`,
          params,
        );
      const byDay = new Map(rows.map((row) => [row.day, money(row.total)]));
      for (const day of dayKeysBetween(firstDay, snapshotEnd)) {
        closing.set(day, byDay.get(day) ?? 0);
      }
    }

    if (lastDay > lastDone) {
      const tailStart =
        addDays(lastDone, 1) > firstDay ? addDays(lastDone, 1) : firstDay;
      const tailDays = dayKeysBetween(tailStart, lastDay);
      if (daysBetween(lastDone, today) > MAX_LIVE_TAIL_DAYS) {
        for (const day of tailDays) closing.set(day, null);
        status = 'partial';
      } else {
        const baseParams: unknown[] = [lastDone];
        const baseScope = this.scopeSql(scope, 'd."cashbox_id"', baseParams);
        const baseRows: Array<{ cashbox_id: string; closing: string }> =
          await this.dataSource.query(
            `SELECT d."cashbox_id"::text AS cashbox_id, d."closing_balance" AS closing
               FROM ${t.daily} d
              WHERE d."snapshot_date" = $1::date AND ${baseScope}`,
            baseParams,
          );
        const balances = new Map<string, number>(
          baseRows.map((row) => [String(row.cashbox_id), money(row.closing)]),
        );
        const histParams: unknown[] = [
          dayStart(addDays(lastDone, 1)),
          dayStart(addDays(lastDay, 1)),
        ];
        const histScope = this.scopeSql(scope, 'h."cashbox_id"', histParams);
        const histRows: Array<{
          cashbox_id: string;
          balance_after: string;
          createdAt: Date | string;
        }> = await this.dataSource.query(
          `SELECT h."cashbox_id"::text AS cashbox_id, h."balance_after", h."createdAt"
             FROM ${t.history} h
            WHERE h."is_deleted" = false
              AND h."createdAt" >= $1 AND h."createdAt" < $2
              AND ${histScope}
            ORDER BY h."createdAt" ASC, h."id" ASC`,
          histParams,
        );
        let cursor = 0;
        for (const day of dayKeysBetween(addDays(lastDone, 1), lastDay)) {
          const nextStart = dayStart(addDays(day, 1)).getTime();
          while (
            cursor < histRows.length &&
            new Date(histRows[cursor].createdAt).getTime() < nextStart
          ) {
            const row = histRows[cursor];
            balances.set(String(row.cashbox_id), money(row.balance_after));
            cursor += 1;
          }
          if (day >= firstDay) {
            let sum = 0;
            for (const value of balances.values()) sum += value;
            closing.set(day, money(sum));
          }
        }
      }
    }
    return { closing, status };
  }

  /**
   * GET /finance/history/daily — kunlik kirim/chiqim (+soni) va kun boshi /
   * oxiri qoldig'i. Qoldiqlar faqat KASSA doirasiga bog'liq (manba / tur /
   * yaratgan filtri ularga ta'sir qilmaydi — kassada pul bitta).
   */
  async historyDaily(input: HistoryDailyInput, now: Date = new Date()) {
    const { from, to, today } = this.resolveRange(input ?? {}, now);
    const operationType = this.optionalEnum(
      input?.operation_type,
      OPERATION_TYPES,
      'operation_type',
    );
    const sourceTypes = this.sourceTypesFilter(input ?? {});
    const sourceUserId = this.optionalId(
      input?.source_user_id,
      'source_user_id',
    );
    const createdBy = this.optionalId(input?.created_by, 'created_by');
    const scope = await this.resolveScope(input ?? {});
    const filtered = Boolean(
      operationType || sourceTypes || sourceUserId || createdBy,
    );

    const t = this.tables();
    // Yarim ochiq oraliq [from boshi, to'dan keyingi kun boshi).
    const params: unknown[] = [dayStart(from), dayStart(addDays(to, 1))];
    const where = [
      'h."is_deleted" = false',
      'h."createdAt" >= $1',
      'h."createdAt" < $2',
      this.scopeSql(scope, 'h."cashbox_id"', params),
    ];
    if (operationType) {
      params.push(operationType);
      where.push(`h."operation_type"::text = $${params.length}`);
    }
    if (sourceTypes) {
      params.push(sourceTypes);
      where.push(`h."source_type"::text = ANY($${params.length}::text[])`);
    }
    if (sourceUserId) {
      params.push(sourceUserId);
      where.push(`h."source_user_id" = $${params.length}`);
    }
    if (createdBy) {
      params.push(createdBy);
      where.push(`h."created_by" = $${params.length}`);
    }
    const flowRows: Array<{
      day: string;
      income: string | null;
      expense: string | null;
      income_count: string | number;
      expense_count: string | number;
    }> = await this.dataSource.query(
      `SELECT to_char(h."createdAt" AT TIME ZONE 'Asia/Tashkent', 'YYYY-MM-DD') AS day,
              COALESCE(SUM(h."amount") FILTER (WHERE h."operation_type" = 'income'), 0) AS income,
              COALESCE(SUM(h."amount") FILTER (WHERE h."operation_type" = 'expense'), 0) AS expense,
              COUNT(*) FILTER (WHERE h."operation_type" = 'income') AS income_count,
              COUNT(*) FILTER (WHERE h."operation_type" = 'expense') AS expense_count
         FROM ${t.history} h
        WHERE ${where.join(' AND ')}
        GROUP BY 1`,
      params,
    );
    const flows = new Map(flowRows.map((row) => [row.day, row]));

    const lastDone = await this.lastSnapshotDate();
    const rangeEnd = to > today ? today : to;
    const seriesStart = addDays(from, -1);
    const series =
      scope.kind === 'empty'
        ? { closing: new Map<string, number | null>(), status: 'ok' as const }
        : seriesStart <= rangeEnd
          ? await this.closingSeries(
              scope,
              seriesStart,
              rangeEnd,
              lastDone,
              today,
            )
          : {
              closing: new Map<string, number | null>(),
              status: 'ok' as const,
            };
    const balanceOf = (day: string): number | null =>
      scope.kind === 'empty'
        ? 0
        : day > today
          ? null
          : (series.closing.get(day) ?? null);

    const totals = {
      income: 0,
      expense: 0,
      net: 0,
      income_count: 0,
      expense_count: 0,
    };
    const days: DailyFlowRow[] = dayKeysBetween(from, to).map((day) => {
      const row = flows.get(day);
      const income = money(row?.income);
      const expense = money(row?.expense);
      const incomeCount = Number(row?.income_count ?? 0);
      const expenseCount = Number(row?.expense_count ?? 0);
      totals.income += income;
      totals.expense += expense;
      totals.income_count += incomeCount;
      totals.expense_count += expenseCount;
      return {
        date: day,
        income,
        expense,
        net: money(income - expense),
        income_count: incomeCount,
        expense_count: expenseCount,
        opening_balance: balanceOf(addDays(day, -1)),
        closing_balance: balanceOf(day),
      };
    });
    totals.income = money(totals.income);
    totals.expense = money(totals.expense);
    totals.net = money(totals.income - totals.expense);

    return {
      statusCode: 200,
      message: 'Kunlik kirim/chiqim',
      data: {
        timezone: 'Asia/Tashkent',
        from,
        to,
        scope: {
          cashbox_type:
            scope.kind === 'type'
              ? scope.type
              : (input?.cashbox_type ?? input?.cashboxType ?? null),
          cashbox_ids: scope.kind === 'ids' ? scope.ids : null,
        },
        filtered,
        balance_status: scope.kind === 'empty' ? 'ok' : series.status,
        last_snapshot_date: lastDone,
        opening_balance: balanceOf(addDays(from, -1)),
        closing_balance: balanceOf(rangeEnd),
        totals,
        days,
      },
    };
  }

  /**
   * GET /finance/financial-balance/daily — Balans sahifasi: KPI kartalarining
   * kunlik snapshot qatori («kechaga nisbatan», 14 kunlik chiziq) va P&L
   * daftarining kunlik kirim/chiqim / kun oxiri qoldig'i («Daftar qoldig'i»,
   * «Davr boshida», «Eng yuqori», «Kunlik kirim va chiqim», waterfall boshi).
   */
  async financialBalanceDaily(
    input: { from_date?: string; to_date?: string },
    now: Date = new Date(),
  ) {
    const { from, to, today } = this.resolveRange(input ?? {}, now);
    const t = this.tables();

    const snapshotRows: Array<Record<string, unknown>> =
      await this.dataSource.query(
        `SELECT to_char("snapshot_date", 'YYYY-MM-DD') AS day, "source", "captured_at",
                "main_balance", "main_balance_cash", "main_balance_card",
                "branch_cashbox_total", "courier_cashbox_total",
                "market_cashbox_total", "market_payable_total",
                "chain_receivable", "provider_receivable",
                "current_situation", "ledger_balance"
           FROM ${t.snapshots}
          WHERE "snapshot_date" BETWEEN $1::date AND $2::date`,
        [addDays(from, -1), to],
      );
    const snapshots = new Map(
      snapshotRows.map((row) => [String(row.day), row]),
    );
    const snapshotOf = (day: string) => {
      const row = snapshots.get(day);
      if (!row) return null;
      const chain = moneyOrNull(row.chain_receivable);
      const provider = moneyOrNull(row.provider_receivable);
      const marketTotal = money(row.market_cashbox_total);
      return {
        source: row.source as 'live' | 'backfill',
        captured_at: row.captured_at ?? null,
        main_balance: money(row.main_balance),
        main_balance_cash: moneyOrNull(row.main_balance_cash),
        main_balance_card: moneyOrNull(row.main_balance_card),
        chain_receivable: chain,
        provider_receivable: provider,
        in_transit:
          chain === null || provider === null ? null : money(chain + provider),
        market_cashbox_total: marketTotal,
        market_payable_total: money(row.market_payable_total),
        markets_debt: money(-marketTotal),
        courier_cashbox_total: money(row.courier_cashbox_total),
        branch_cashbox_total: money(row.branch_cashbox_total),
        current_situation: moneyOrNull(row.current_situation),
        ledger_balance: moneyOrNull(row.ledger_balance),
      };
    };

    // P&L daftari — jonli (append-only, har qatorda balance_after).
    const openingRows: Array<{ balance_after: string | null }> =
      await this.dataSource.query(
        `SELECT "balance_after" FROM ${t.ledger}
          WHERE "is_deleted" = false AND "createdAt" < $1
          ORDER BY "createdAt" DESC, "id" DESC
          LIMIT 1`,
        [dayStart(from)],
      );
    const ledgerRows: Array<{
      day: string;
      income: string | null;
      expense: string | null;
      cnt: string | number;
      closing: string | null;
    }> = await this.dataSource.query(
      `SELECT to_char("createdAt" AT TIME ZONE 'Asia/Tashkent', 'YYYY-MM-DD') AS day,
              COALESCE(SUM("amount") FILTER (WHERE "amount" > 0), 0) AS income,
              COALESCE(SUM(-"amount") FILTER (WHERE "amount" < 0), 0) AS expense,
              COUNT(*) AS cnt,
              (ARRAY_AGG("balance_after" ORDER BY "createdAt" DESC, "id" DESC))[1] AS closing
         FROM ${t.ledger}
        WHERE "is_deleted" = false AND "createdAt" >= $1 AND "createdAt" < $2
        GROUP BY 1`,
      [dayStart(from), dayStart(addDays(to, 1))],
    );
    const ledgerByDay = new Map(ledgerRows.map((row) => [row.day, row]));
    const ledgerOpening = openingRows.length
      ? money(openingRows[0].balance_after)
      : 0;

    let running = ledgerOpening;
    const ledgerTotals = { income: 0, expense: 0, count: 0 };
    let peak: { date: string; balance: number } | null = null;
    const days = dayKeysBetween(from, to).map((day) => {
      const row = ledgerByDay.get(day);
      const opening = running;
      const income = money(row?.income);
      const expense = money(row?.expense);
      const count = Number(row?.cnt ?? 0);
      if (row?.closing !== undefined && row?.closing !== null) {
        running = money(row.closing);
      }
      const future = day > today;
      ledgerTotals.income += income;
      ledgerTotals.expense += expense;
      ledgerTotals.count += count;
      if (!future && (!peak || running > peak.balance)) {
        peak = { date: day, balance: running };
      }
      return {
        date: day,
        snapshot: snapshotOf(day),
        ledger: {
          opening_balance: future ? null : opening,
          closing_balance: future ? null : running,
          income,
          expense,
          net: money(income - expense),
          count,
        },
      };
    });

    const lastPast = days.filter((day) => day.date <= today);
    return {
      statusCode: 200,
      message: 'Kunlik moliyaviy balans',
      data: {
        timezone: 'Asia/Tashkent',
        from,
        to,
        last_snapshot_date: await this.lastSnapshotDate(),
        previous_day: {
          date: addDays(from, -1),
          snapshot: snapshotOf(addDays(from, -1)),
        },
        ledger: {
          opening_balance: ledgerOpening,
          closing_balance: lastPast.length
            ? lastPast[lastPast.length - 1].ledger.closing_balance
            : ledgerOpening,
          income: money(ledgerTotals.income),
          expense: money(ledgerTotals.expense),
          net: money(ledgerTotals.income - ledgerTotals.expense),
          count: ledgerTotals.count,
          peak,
        },
        days,
      },
    };
  }
}
