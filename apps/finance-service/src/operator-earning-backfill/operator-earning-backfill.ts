/**
 * O'tgan sotuvlarga operator komissiyasi (bir martalik ops skripti) — SOF
 * qism: bayroqlar, hisobot yig'ish va matni. DB qismi:
 * `operator-earning-backfill.runner.ts`; ishga tushirish:
 * `scripts/backfill-operator-earnings.ts`.
 *
 * Ega qarori (2026-11-21): o'tgan sotuvlarga ham JORIY stavka bo'yicha haq
 * hisoblansin. Market paneldagi «O'tgan sotuvlarga hisoblash» tugmasi
 * (`finance.operator.earning.backfill`) har operator uchun alohida bosiladi
 * va faqat market akkauntida — bu skript hammasini bir yo'la qiladi.
 */

export const EARNING_BACKFILL_DEFAULT_BATCH = 1000;
export const EARNING_BACKFILL_DEFAULT_REPORT_LIMIT = 100;

export interface EarningBackfillArgs {
  /** `false` — faqat hisobot (DRY-RUN), hech narsa yozilmaydi. */
  apply: boolean;
  /** Bitta tranzaksiyadagi buyurtmalar. */
  batchSize: number;
  /** Hisobotda ko'rsatiladigan market/operator qatorlari. */
  reportLimit: number;
}

export function parseEarningBackfillArgs(
  argv: readonly string[],
): EarningBackfillArgs {
  const known = /^--(apply|dry-run|batch=.*|report-limit=.*)$/;
  const unknown = argv.filter((arg) => !known.test(arg));
  if (unknown.length) {
    throw new Error(`noma'lum bayroq: ${unknown.join(' ')}`);
  }
  const flag = (name: string) => argv.includes(`--${name}`);
  const num = (name: string, fallback: number, max: number): number => {
    const prefix = `--${name}=`;
    const raw = argv.find((arg) => arg.startsWith(prefix));
    if (raw === undefined) return fallback;
    const value = Number(raw.slice(prefix.length));
    if (!Number.isInteger(value) || value < 1 || value > max) {
      throw new Error(
        `--${name} 1..${max} oralig'idagi butun son bo'lishi kerak`,
      );
    }
    return value;
  };
  return {
    // `--dry-run` doim ustun: ikkalasi berilsa ham yozilmaydi.
    apply: flag('apply') && !flag('dry-run'),
    batchSize: num('batch', EARNING_BACKFILL_DEFAULT_BATCH, 5000),
    reportLimit: num(
      'report-limit',
      EARNING_BACKFILL_DEFAULT_REPORT_LIMIT,
      100_000,
    ),
  };
}

/** Komissiya yozilmagan bitta sotilgan buyurtma (SQL'dan, matn ko'rinishida). */
export interface EarningCandidate {
  order_id: string;
  market_id: string | null;
  market_name: string | null;
  operator_id: string;
  operator_name: string | null;
  operator_deleted: boolean;
  commission_type: string;
  /** numeric(14,2) — matn (aniq). */
  commission_value: string;
  total_price: string;
  /** SQL'da `round(..., 2)` — matn (aniq). */
  amount: string;
}

/** "123.45" → 12345 (tiyin). numeric(14,2) uchun xavfsiz butun son. */
export function toCents(value: string | number | null | undefined): number {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
}

export function formatCents(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  const whole = Math.floor(abs / 100)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  const frac = (abs % 100).toString().padStart(2, '0');
  return `${sign}${whole}.${frac}`;
}

export interface EarningBackfillGroup {
  market_id: string | null;
  market_name: string | null;
  operator_id: string;
  operator_name: string | null;
  operator_deleted: boolean;
  commission_type: string;
  commission_value: string;
  /** Yoziladigan (dry-run) / yozishga urinilgan (apply) buyurtmalar. */
  planned: number;
  planned_cents: number;
  /** Haqiqatda yozilgan qatorlar (faqat apply). */
  created: number;
  created_cents: number;
}

/** Hisobot uchun qo'shimcha sanoqlar — hech biriga tegilmaydi. */
export interface EarningBackfillStats {
  /** Operatorli (`operator_id`) sotilgan buyurtmalar. */
  sold_with_operator: number;
  /** Tirik komissiya qatori bor — tegilmaydi. */
  already_recorded: number;
  /** Faqat o'chirilgan (rollback) qatori bor — tegilmaydi, qo'lda ko'riladi. */
  deleted_row_only: number;
  /** Operatorida hozir stavka yo'q — yozilmaydi. */
  operator_without_rate: number;
  /** `operator_id` market operatori emas (boshqa rol) — yozilmaydi. */
  operator_other_role: number;
  /** Operator faqat matn bo'lib yozilgan (`operator_id` yo'q) — «Biriktirish». */
  unlinked_text_only: number;
}

export interface EarningBackfillReport {
  apply: boolean;
  run_id: string;
  stats: EarningBackfillStats;
  /** Stavka bo'yicha summasi 0 chiqqanlar (masalan narx 0) — yozilmaydi. */
  zero_amount: number;
  planned: number;
  planned_cents: number;
  created: number;
  created_cents: number;
  groups: EarningBackfillGroup[];
}

const groupKey = (c: { market_id: string | null; operator_id: string }) =>
  `${c.market_id ?? '-'}:${c.operator_id}`;

/** Paketdagi nomzodlarni (market, operator) bo'yicha guruhlarga qo'shadi. */
export function addPlanned(
  groups: Map<string, EarningBackfillGroup>,
  candidates: readonly EarningCandidate[],
): void {
  for (const c of candidates) {
    const key = groupKey(c);
    let group = groups.get(key);
    if (!group) {
      group = {
        market_id: c.market_id,
        market_name: c.market_name,
        operator_id: c.operator_id,
        operator_name: c.operator_name,
        operator_deleted: c.operator_deleted,
        commission_type: c.commission_type,
        commission_value: c.commission_value,
        planned: 0,
        planned_cents: 0,
        created: 0,
        created_cents: 0,
      };
      groups.set(key, group);
    }
    group.planned += 1;
    group.planned_cents += toCents(c.amount);
  }
}

export function addCreated(
  groups: Map<string, EarningBackfillGroup>,
  created: ReadonlyArray<{
    market_id: string | null;
    operator_id: string;
    amount: string;
  }>,
): void {
  for (const row of created) {
    const group = groups.get(groupKey(row));
    if (!group) continue;
    group.created += 1;
    group.created_cents += toCents(row.amount);
  }
}

/** Eng katta summa birinchi; teng bo'lsa market, keyin operator id bo'yicha. */
export function sortGroups(
  groups: Iterable<EarningBackfillGroup>,
): EarningBackfillGroup[] {
  const byId = (a: string | null, b: string | null) =>
    BigInt(a ?? '0') < BigInt(b ?? '0')
      ? -1
      : BigInt(a ?? '0') > BigInt(b ?? '0')
        ? 1
        : 0;
  return [...groups].sort(
    (a, b) =>
      b.planned_cents - a.planned_cents ||
      byId(a.market_id, b.market_id) ||
      byId(a.operator_id, b.operator_id),
  );
}

const rateLabel = (type: string, value: string) =>
  type === 'percent'
    ? `${Number(value)}%`
    : type === 'fixed'
      ? `${formatCents(toCents(value))} / buyurtma`
      : `${type} ${value}`;

export function formatEarningBackfillReport(
  report: EarningBackfillReport,
  reportLimit: number,
): string[] {
  const s = report.stats;
  const lines: string[] = [
    '',
    `=== O'tgan sotuvlarga operator komissiyasi — ${
      report.apply ? 'YOZISH' : 'DRY-RUN (faqat hisobot, hech narsa yozilmadi)'
    } ===`,
    `run_id: ${report.run_id}`,
    '',
    `Operatorli sotilgan buyurtmalar:            ${s.sold_with_operator}`,
    `  komissiya allaqachon yozilgan (tegilmaydi): ${s.already_recorded}`,
    `  ${report.apply ? 'yozildi' : 'yoziladi'} (joriy stavka bilan):        ${
      report.apply ? report.created : report.planned
    } ta, jami ${formatCents(
      report.apply ? report.created_cents : report.planned_cents,
    )}`,
  ];
  if (report.apply && report.created !== report.planned) {
    lines.push(
      `  shu orada boshqa yo'l bilan yozilgan (o'tkazildi): ${
        report.planned - report.created
      }`,
    );
  }
  lines.push(
    `  summasi 0 chiqdi (masalan narx 0) — yozilmaydi: ${report.zero_amount}`,
    `  operatorida stavka yo'q — yozilmaydi:        ${s.operator_without_rate}`,
    `  operator boshqa rolda — yozilmaydi:          ${s.operator_other_role}`,
    `  faqat o'chirilgan (rollback) qatori bor — tegilmaydi: ${s.deleted_row_only}`,
    `Operatorga bog'lanmagan (faqat matn) sotuvlar — market «Biriktirish» qiladi: ${s.unlinked_text_only}`,
    '',
  );

  const groups = report.groups;
  if (!groups.length) {
    lines.push("Yoziladigan buyurtma yo'q.");
    return lines;
  }
  const markets = new Set(groups.map((g) => g.market_id ?? '-'));
  const operators = new Set(groups.map((g) => g.operator_id));
  lines.push(
    `Market/operator bo'yicha (${markets.size} market, ${operators.size} operator; summa kamayish tartibida):`,
  );
  for (const g of groups.slice(0, reportLimit)) {
    const market = g.market_id
      ? `market #${g.market_id}${g.market_name ? ` «${g.market_name}»` : ''}`
      : 'market —';
    const operator = `operator #${g.operator_id}${
      g.operator_name ? ` «${g.operator_name}»` : ''
    }${g.operator_deleted ? " (o'chirilgan)" : ''}`;
    const done = report.apply
      ? ` → yozildi ${g.created} ta, ${formatCents(g.created_cents)}`
      : '';
    lines.push(
      `  ${market} · ${operator} · stavka ${rateLabel(
        g.commission_type,
        g.commission_value,
      )}: ${g.planned} ta, ${formatCents(g.planned_cents)}${done}`,
    );
  }
  if (groups.length > reportLimit) {
    lines.push(
      `  … yana ${groups.length - reportLimit} qator (--report-limit=<n>)`,
    );
  }
  return lines;
}
