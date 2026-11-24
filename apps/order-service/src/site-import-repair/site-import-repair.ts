/**
 * Sayt importi hodisasini tiklash (2026-11-24) — sof qism: bayroqlar, qo'shimcha
 * qatorlar, hisobot. DB qismi — `site-import-repair.runner.ts`.
 */
export interface SiteImportRepairRow {
  order_id: string;
  /** Ulanish slug'i — buyurtmada `operator = 'external_<slug>'`. */
  site: string;
  external_id: string;
  /** Saytdagi haqiqiy tuman SOATO kodi (7 raqam). */
  sato: string;
}

export interface SiteImportRepairArgs {
  apply: boolean;
  /** Shu relizgacha yana noto'g'ri tushgan buyurtmalar (`--extra`). */
  extra: SiteImportRepairRow[];
}

export interface SiteImportRepairPlanRow {
  order_id: string;
  site: string;
  old_post_id: string | null;
  new_post_id: string | null;
  district_id: string;
  district: string;
  region_id: string;
  region: string;
}

export interface SiteImportRepairReport {
  apply: boolean;
  run_id: string;
  planned: SiteImportRepairPlanRow[];
  skipped: Array<{ order_id: string; reason: string }>;
  /** Xuddi shunday buzilgan, lekin ro'yxatda yo'q buyurtmalar. */
  unlisted: Array<{ order_id: string; site: string; status: string }>;
  customers: number;
}

const EXTRA_ITEM =
  /^(\d{1,18}):([a-z0-9_-]{1,50}):([A-Za-z0-9_-]{1,64}):(\d{7})$/;

/** `--extra=<buyurtma>:<sayt>:<saytdagi id>:<SOATO>,…` */
function parseExtra(value: string): SiteImportRepairRow[] {
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => {
      const match = EXTRA_ITEM.exec(item);
      if (!match) {
        throw new Error(
          `--extra noto'g'ri: «${item}» (kerak: buyurtma:sayt:saytdagi_id:SOATO)`,
        );
      }
      const [, order_id, site, external_id, sato] = match;
      return { order_id, site, external_id, sato };
    });
}

export function parseSiteImportRepairArgs(
  argv: readonly string[],
): SiteImportRepairArgs {
  const args: SiteImportRepairArgs = { apply: false, extra: [] };
  let dryRun = false;
  for (const arg of argv) {
    if (arg === '--apply') args.apply = true;
    else if (arg === '--dry-run') dryRun = true;
    else if (arg.startsWith('--extra=')) {
      args.extra = parseExtra(arg.slice('--extra='.length));
    } else throw new Error(`noma'lum bayroq: ${arg}`);
  }
  if (dryRun) args.apply = false;
  return args;
}

/** Bitta buyurtma ikki marta uchrasa — xato (qaysi kod to'g'riligi noaniq). */
export function mergeSiteImportRows(
  ...lists: ReadonlyArray<readonly SiteImportRepairRow[]>
): SiteImportRepairRow[] {
  const byId = new Map<string, SiteImportRepairRow>();
  for (const row of lists.flat()) {
    if (byId.has(row.order_id)) {
      throw new Error(`buyurtma #${row.order_id} ro'yxatda ikki marta`);
    }
    byId.set(row.order_id, row);
  }
  return [...byId.values()];
}

export function formatSiteImportRepairReport(
  report: SiteImportRepairReport,
): string[] {
  const lines = [
    `== Sayt importini tiklash — ${report.apply ? 'YOZILDI' : 'DRY-RUN (hech narsa yozilmadi)'}`,
    `run_id: ${report.run_id}`,
    `${report.apply ? 'Tuzatildi' : 'Tuzatiladi'}: ${report.planned.length} ta buyurtma, ${report.customers} ta mijoz kartasi`,
  ];
  const byRegion = new Map<string, number>();
  for (const row of report.planned) {
    const key = `${row.region} (#${row.region_id})`;
    byRegion.set(key, (byRegion.get(key) ?? 0) + 1);
  }
  for (const [region, count] of [...byRegion].sort((a, b) => b[1] - a[1])) {
    lines.push(`  ${region}: ${count} ta`);
  }
  for (const row of report.planned) {
    lines.push(
      `  #${row.order_id} ${row.site}: ${row.district} / ${row.region}, ` +
        `pochta ${row.old_post_id ?? '-'} → ${row.new_post_id ?? 'yangi'}`,
    );
  }
  lines.push(`O'tkazib yuborildi: ${report.skipped.length} ta`);
  for (const row of report.skipped) {
    lines.push(`  #${row.order_id}: ${row.reason}`);
  }
  if (report.unlisted.length) {
    lines.push(
      `⚠️ Ro'yxatda YO'Q, lekin xuddi shunday buzilgan: ${report.unlisted.length} ta`,
    );
    for (const row of report.unlisted) {
      lines.push(`  #${row.order_id} ${row.site} (${row.status})`);
    }
  }
  return lines;
}
