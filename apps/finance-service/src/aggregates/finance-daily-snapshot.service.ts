import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
  Optional,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ClientProxy } from '@nestjs/microservices';
import { DataSource, EntityManager } from 'typeorm';
import { rmqSend } from '@app/common';
import { Cashbox } from '../entities/cashbox.entity';
import { CashboxHistory } from '../entities/cashbox-history.entity';
import { FinancialBalanceHistory } from '../entities/financial-balance-history.entity';
import { FinanceCashboxDaily } from '../entities/finance-cashbox-daily.entity';
import { FinanceDailySnapshot } from '../entities/finance-daily-snapshot.entity';
import {
  addDays,
  dayEnd,
  dayKeysBetween,
  dayStart,
  money,
  moneyOrNull,
  tashkentDayKey,
} from './finance-day.util';

/** Bir yugurishda ko'pi bilan shuncha kun (qolgani keyingi tick'da). */
const MAX_DAYS_PER_RUN = 400;
const FIRST_TICK_MS = 60_000;
const TICK_MS = 10 * 60_000;
/** Kunlar orasidagi tanaffus — catch-up bazani band qilib qo'ymasin. */
const PAUSE_BETWEEN_DAYS_MS = 25;
/**
 * Zanjirdagi / kargodagi qarz faqat kun tugaganidan keyin shuncha vaqt ichida
 * olinsa «kun oxiri» deb yoziladi (`source = 'live'`); kechroq — NULL
 * (`backfill`): boshqa paytning raqami o'tgan kunniki sifatida saqlanmaydi.
 */
const LIVE_CAPTURE_WINDOW_MS = 6 * 3_600_000;

export type SnapshotDayResult = 'done' | 'exists' | 'locked' | 'gap';

export interface SnapshotRunResult {
  processed: string[];
  skipped: string[];
  stopped: SnapshotDayResult | null;
}

interface LiveReceivables {
  chain_receivable: number | null;
  provider_receivable: number | null;
}

const quote = (tablePath: string) =>
  tablePath
    .split('.')
    .map((part) => `"${part}"`)
    .join('.');

/**
 * qzjTMWPb — moliya kunlik balans snapshot'i (O'QISH MODELI).
 *
 * HAR KUNI (Toshkent kuni tugagach) ikki jadval to'ldiriladi:
 *   • `finance_cashbox_daily` — har kassa uchun kun boshi / oxiri qoldig'i
 *     (oxirgi `cashbox_history.balance_after`), kunlik kirim/chiqim va soni;
 *   • `finance_daily_snapshots` — kompaniya holati (asosiy kassa, filial /
 *     kuryer / market kassalari yig'indisi, daftar qoldig'i, zanjirdagi va
 *     kargodagi qarz, umumiy holat).
 *
 * ⚠️ PUL XULQIGA TA'SIR YO'Q: faqat `SELECT` + o'z jadvallariga `INSERT`.
 * Kassa balanslari, `cashbox_history`, P&L daftari o'zgarmaydi.
 *
 * IDEMPOTENT VA KO'P REPLIKADA XAVFSIZ:
 *   • har kun — alohida qisqa tranzaksiya, `pg_try_advisory_xact_lock`
 *     ostida: bir vaqtda faqat bitta replika yozadi, qolgani shu tick'ni
 *     tashlab ketadi (navbat kutmaydi);
 *   • kun yakunlangani belgisi — `finance_daily_snapshots` qatori (UNIQUE
 *     `snapshot_date`); qulf olingach qayta tekshiriladi → ikki marta
 *     yozilmaydi. Tranzaksiya yiqilsa hech narsa qolmaydi (keyingi tick
 *     qaytadan qiladi);
 *   • kun D faqat D−1 yakunlangan bo'lsa quriladi (yoki D tarixning birinchi
 *     kuni bo'lsa) — zanjirda teshik qolmaydi.
 *
 * BACKFILL (o'tgan kunlar) — alohida skript YO'Q, ayni yo'l: jadval bo'sh
 * bo'lsa job `cashbox_history` ning birinchi kunidan boshlab kechagacha har
 * kunni ketma-ket quradi (bir yugurishda ≤ MAX_DAYS_PER_RUN kun). Kun D
 * narxi = D kunining tarix qatorlari (IDX_CASHBOX_HISTORY_CREATED_AT) + D−1
 * dagi nol bo'lmagan kassalar soni — butun tarix bir so'rovda
 * skanerlanmaydi, har kun o'z tranzaksiyasida, kunlar orasida tanaffus.
 * Backfill kunlarida `chain_receivable` / `provider_receivable` /
 * `current_situation` NULL (`source = 'backfill'`) — ular buyurtma
 * hisob-kitobidan olinadi va o'tgan kun uchun tiklab bo'lmaydi; kassa
 * yig'indilari va daftar qoldig'i esa tarixdan ANIQ tiklanadi.
 *
 * Qayta qurish (masalan tarix qatori keyin soft-delete qilinsa):
 *   DELETE FROM finance_schema.finance_daily_snapshots WHERE snapshot_date >= 'X';
 *   DELETE FROM finance_schema.finance_cashbox_daily  WHERE snapshot_date >= 'X';
 * — keyingi tick X dan boshlab qayta quradi. O'chirish faqat O'QISH
 * MODELIGA tegadi.
 *
 * O'chirish: `FINANCE_DAILY_SNAPSHOT_DISABLED=true` (job ishga tushmaydi;
 * endpointlar oqimlarni baribir qaytaradi, qoldiqlar `pending`).
 */
@Injectable()
export class FinanceDailySnapshotService
  implements OnModuleInit, OnModuleDestroy
{
  static readonly ADVISORY_LOCK_KEY = 947_310_176;

  private readonly logger = new Logger(FinanceDailySnapshotService.name);
  private timer: ReturnType<typeof setInterval> | null = null;
  private firstTimer: ReturnType<typeof setTimeout> | null = null;
  private running = false;

  constructor(
    private readonly dataSource: DataSource,
    @Optional() private readonly config?: ConfigService,
    @Optional() @Inject('ORDER') private readonly orderClient?: ClientProxy,
    @Optional()
    @Inject('INTEGRATION')
    private readonly integrationClient?: ClientProxy,
  ) {}

  private enabled(): boolean {
    const raw = this.config?.get<unknown>('FINANCE_DAILY_SNAPSHOT_DISABLED');
    return !(raw === true || String(raw ?? '').toLowerCase() === 'true');
  }

  onModuleInit(): void {
    if (!this.enabled()) {
      this.logger.log("Kunlik moliya snapshot'i o'chirilgan (env)");
      return;
    }
    this.firstTimer = setTimeout(() => void this.tick(), FIRST_TICK_MS);
    this.firstTimer.unref?.();
    this.timer = setInterval(() => void this.tick(), TICK_MS);
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.firstTimer) clearTimeout(this.firstTimer);
    if (this.timer) clearInterval(this.timer);
    this.firstTimer = null;
    this.timer = null;
  }

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

  /** Oxirgi yakunlangan kun ('YYYY-MM-DD') yoki null. */
  async lastSnapshotDate(): Promise<string | null> {
    const { snapshots } = this.tables();
    const rows: Array<{ day: string | null }> = await this.dataSource.query(
      `SELECT to_char(MAX("snapshot_date"), 'YYYY-MM-DD') AS day FROM ${snapshots}`,
    );
    return rows?.[0]?.day ?? null;
  }

  /** Kassa tarixining birinchi Toshkent kuni yoki null (tarix bo'sh). */
  async firstActivityDay(): Promise<string | null> {
    const { history } = this.tables();
    const rows: Array<{ first: Date | string | null }> =
      await this.dataSource.query(
        `SELECT MIN("createdAt") AS first FROM ${history} WHERE "is_deleted" = false`,
      );
    const first = rows?.[0]?.first;
    return first ? tashkentDayKey(new Date(first)) : null;
  }

  async tick(now: Date = new Date()): Promise<SnapshotRunResult | null> {
    if (this.running) return null;
    this.running = true;
    try {
      const result = await this.catchUp(now);
      if (result.processed.length) {
        this.logger.log(
          `Kunlik moliya snapshot'i: ${result.processed.length} kun (${result.processed[0]} → ${result.processed[result.processed.length - 1]})`,
        );
      }
      return result;
    } catch (error) {
      this.logger.warn(
        `Kunlik moliya snapshot'i: ${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    } finally {
      this.running = false;
    }
  }

  /**
   * Yakunlanmagan kunlarni (oxirgi snapshot'dan keyingi kundan KECHAGACHA)
   * ketma-ket quradi. Bugun hech qachon yozilmaydi (kun hali tugamagan).
   */
  async catchUp(now: Date = new Date()): Promise<SnapshotRunResult> {
    const result: SnapshotRunResult = {
      processed: [],
      skipped: [],
      stopped: null,
    };
    const yesterday = addDays(tashkentDayKey(now), -1);
    const last = await this.lastSnapshotDate();
    const start = last ? addDays(last, 1) : await this.firstActivityDay();
    if (!start || start > yesterday) return result;

    const lastAllowed = addDays(start, MAX_DAYS_PER_RUN - 1);
    const end = lastAllowed < yesterday ? lastAllowed : yesterday;
    const days = dayKeysBetween(start, end);

    // Zanjir / kargo qarzi — faqat kechagi kun uchun va faqat kun tugaganiga
    // ko'p bo'lmagan bo'lsa (RPC tranzaksiyadan TASHQARIDA).
    const live =
      days.includes(yesterday) &&
      now.getTime() - dayEnd(yesterday).getTime() <= LIVE_CAPTURE_WINDOW_MS
        ? await this.fetchLiveReceivables()
        : null;

    for (const [index, day] of days.entries()) {
      const status = await this.snapshotDay(
        day,
        day === yesterday ? live : null,
        now,
      );
      if (status === 'done') result.processed.push(day);
      else if (status === 'exists') result.skipped.push(day);
      else {
        result.stopped = status;
        break;
      }
      if (index < days.length - 1) {
        await new Promise((resolve) =>
          setTimeout(resolve, PAUSE_BETWEEN_DAYS_MS),
        );
      }
    }
    return result;
  }

  private async fetchLiveReceivables(): Promise<LiveReceivables> {
    const chain = this.orderClient
      ? await rmqSend<{
          data?: { chain_receivable?: unknown; branch_receivable?: unknown };
        }>(
          this.orderClient,
          { cmd: 'order.settlement.financial_balance_summary' },
          {},
        )
          .then((res) =>
            moneyOrNull(
              res?.data?.chain_receivable ?? res?.data?.branch_receivable,
            ),
          )
          .catch(() => null)
      : null;
    const provider = this.integrationClient
      ? await rmqSend<{ data?: { outstanding_amount?: unknown } }>(
          this.integrationClient,
          { cmd: 'integration.receivable.outstanding_total' },
          {},
        )
          .then((res) => moneyOrNull(res?.data?.outstanding_amount ?? 0))
          .catch(() => null)
      : null;
    return { chain_receivable: chain, provider_receivable: provider };
  }

  /**
   * Bitta kunni quradi (tranzaksiya + advisory qulf). Qaytaradi:
   *   'done'   — yozildi; 'exists' — boshqa replika allaqachon yozgan;
   *   'locked' — qulf band (boshqa replika ishlayapti) → shu yugurish to'xtaydi;
   *   'gap'    — D−1 yakunlanmagan (tartib buzilmasin) → to'xtaydi.
   */
  snapshotDay(
    day: string,
    live: LiveReceivables | null,
    now: Date = new Date(),
  ): Promise<SnapshotDayResult> {
    return this.dataSource.transaction(async (manager) => {
      const lockRows: Array<{ locked: boolean }> = await manager.query(
        'SELECT pg_try_advisory_xact_lock($1::bigint) AS locked',
        [FinanceDailySnapshotService.ADVISORY_LOCK_KEY],
      );
      if (!lockRows?.[0]?.locked) return 'locked';

      const t = this.tables();
      const exists: unknown[] = await manager.query(
        `SELECT 1 FROM ${t.snapshots} WHERE "snapshot_date" = $1::date`,
        [day],
      );
      if (exists.length) return 'exists';
      if (!(await this.previousDayReady(manager, day))) return 'gap';

      // Yiqilgan / qo'lda yarim o'chirilgan holatdan qolgan qatorlar.
      await manager.query(
        `DELETE FROM ${t.daily} WHERE "snapshot_date" = $1::date`,
        [day],
      );
      await manager.query(
        `WITH prev AS (
           SELECT "cashbox_id", "closing_balance", "closing_cash", "closing_card"
             FROM ${t.daily}
            WHERE "snapshot_date" = $1::date - 1
         ),
         day_hist AS (
           SELECT h."id", h."cashbox_id", h."operation_type", h."amount",
                  h."balance_after", h."balance_cash_after",
                  h."balance_card_after", h."createdAt"
             FROM ${t.history} h
            WHERE h."is_deleted" = false
              AND h."createdAt" >= $2 AND h."createdAt" < $3
         ),
         last_row AS (
           SELECT DISTINCT ON ("cashbox_id") "cashbox_id", "balance_after",
                  "balance_cash_after", "balance_card_after"
             FROM day_hist
            ORDER BY "cashbox_id", "createdAt" DESC, "id" DESC
         ),
         flows AS (
           SELECT "cashbox_id",
                  COALESCE(SUM("amount") FILTER (WHERE "operation_type" = 'income'), 0) AS income,
                  COALESCE(SUM("amount") FILTER (WHERE "operation_type" = 'expense'), 0) AS expense,
                  (COUNT(*) FILTER (WHERE "operation_type" = 'income'))::int AS income_count,
                  (COUNT(*) FILTER (WHERE "operation_type" = 'expense'))::int AS expense_count
             FROM day_hist
            GROUP BY "cashbox_id"
         ),
         ids AS (
           SELECT "cashbox_id" FROM prev
           UNION
           SELECT "cashbox_id" FROM flows
         )
         INSERT INTO ${t.daily}
           ("snapshot_date", "cashbox_id", "cashbox_type", "user_id",
            "opening_balance", "closing_balance", "closing_cash", "closing_card",
            "income", "expense", "income_count", "expense_count")
         SELECT $1::date, ids."cashbox_id", c."cashbox_type"::text, c."user_id",
                COALESCE(p."closing_balance", 0),
                COALESCE(l."balance_after", p."closing_balance", 0),
                CASE WHEN l."cashbox_id" IS NOT NULL THEN l."balance_cash_after" ELSE p."closing_cash" END,
                CASE WHEN l."cashbox_id" IS NOT NULL THEN l."balance_card_after" ELSE p."closing_card" END,
                COALESCE(f.income, 0), COALESCE(f.expense, 0),
                COALESCE(f.income_count, 0), COALESCE(f.expense_count, 0)
           FROM ids
           JOIN ${t.cashboxes} c ON c."id" = ids."cashbox_id"
           LEFT JOIN prev p ON p."cashbox_id" = ids."cashbox_id"
           LEFT JOIN last_row l ON l."cashbox_id" = ids."cashbox_id"
           LEFT JOIN flows f ON f."cashbox_id" = ids."cashbox_id"
          WHERE COALESCE(l."balance_after", p."closing_balance", 0) <> 0
             OR COALESCE(f.income_count, 0) + COALESCE(f.expense_count, 0) > 0`,
        // Yarim ochiq oraliq [kun boshi, ertasi kun boshi): mikrosoniyali
        // 23:59:59.9995 qatori ham aynan shu kunga tushadi.
        [day, dayStart(day), dayStart(addDays(day, 1))],
      );

      // Kompaniya yig'indilari — jonli hisob bilan AYNI filtr (faol kassalar).
      const sums: Array<{
        cashbox_type: string;
        total: string | null;
        positive: string | null;
        cash: string | null;
        card: string | null;
        cnt: number | string;
      }> = await manager.query(
        `SELECT d."cashbox_type",
                SUM(d."closing_balance") AS total,
                SUM(GREATEST(d."closing_balance", 0)) AS positive,
                SUM(d."closing_cash") AS cash,
                SUM(d."closing_card") AS card,
                COUNT(*) AS cnt
           FROM ${t.daily} d
           JOIN ${t.cashboxes} c ON c."id" = d."cashbox_id" AND c."is_deleted" = false
          WHERE d."snapshot_date" = $1::date
          GROUP BY d."cashbox_type"`,
        [day],
      );
      const byType = new Map(sums.map((row) => [row.cashbox_type, row]));
      const total = (type: string) => money(byType.get(type)?.total);
      const ledgerRows: Array<{ balance_after: string | null }> =
        await manager.query(
          `SELECT "balance_after" FROM ${t.ledger}
            WHERE "is_deleted" = false AND "createdAt" < $1
            ORDER BY "createdAt" DESC, "id" DESC
            LIMIT 1`,
          [dayStart(addDays(day, 1))],
        );

      const main = byType.get('main');
      const mainBalance = total('main');
      const marketTotal = total('markets');
      const chain = live?.chain_receivable ?? null;
      const provider = live?.provider_receivable ?? null;
      const isLive = chain !== null && provider !== null;
      const cashboxCount = sums.reduce((acc, row) => acc + Number(row.cnt), 0);

      await manager.query(
        `INSERT INTO ${t.snapshots}
           ("snapshot_date", "source", "captured_at", "main_balance",
            "main_balance_cash", "main_balance_card", "branch_cashbox_total",
            "courier_cashbox_total", "market_cashbox_total",
            "market_payable_total", "chain_receivable", "provider_receivable",
            "current_situation", "ledger_balance", "cashbox_count")
         VALUES ($1::date, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
         ON CONFLICT ("snapshot_date") DO NOTHING`,
        [
          day,
          isLive ? 'live' : 'backfill',
          now,
          mainBalance,
          main ? moneyOrNull(main.cash) : null,
          main ? moneyOrNull(main.card) : null,
          total('branch'),
          total('couriers'),
          marketTotal,
          money(byType.get('markets')?.positive),
          isLive ? chain : null,
          isLive ? provider : null,
          isLive ? money(mainBalance + chain + provider - marketTotal) : null,
          moneyOrNull(ledgerRows?.[0]?.balance_after),
          cashboxCount,
        ],
      );
      return 'done';
    });
  }

  /**
   * D−1 yakunlanganmi? Birinchi kun istisno: D dan oldin hech qanday
   * snapshot ham, kassa tarixi ham bo'lmasa — D zanjirning boshi.
   */
  private async previousDayReady(
    manager: EntityManager,
    day: string,
  ): Promise<boolean> {
    const t = this.tables();
    const prev: unknown[] = await manager.query(
      `SELECT 1 FROM ${t.snapshots} WHERE "snapshot_date" = $1::date - 1`,
      [day],
    );
    if (prev.length) return true;
    const earlierSnapshot: unknown[] = await manager.query(
      `SELECT 1 FROM ${t.snapshots} WHERE "snapshot_date" < $1::date LIMIT 1`,
      [day],
    );
    if (earlierSnapshot.length) return false;
    const earlierHistory: unknown[] = await manager.query(
      `SELECT 1 FROM ${t.history} WHERE "is_deleted" = false AND "createdAt" < $1 LIMIT 1`,
      [dayStart(day)],
    );
    return earlierHistory.length === 0;
  }
}
