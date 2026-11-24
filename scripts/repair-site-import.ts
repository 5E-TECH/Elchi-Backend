/**
 * Sayt importi hodisasini tiklash (2026-11-24, bir martalik, qayta yurgizish
 * xavfsiz).
 *
 * Nega: «Tashqi saytlar» skanidan qabul qilingan 58 ta buyurtma bitta tumanga
 * (Bektemir) va Toshkent shahri pochtasiga tushgan (sabab va tuzatish — PR
 * #780). Bu skript ularga saytdagi haqiqiy tumanni yozadi va o'z viloyatining
 * YANGI pochtasiga ko'chiradi. Shartlar: site-import-repair.runner.ts.
 *
 *   npm run -s db:repair-site-import                # DRY-RUN (sukut)
 *   npm run -s db:repair-site-import -- --apply     # yozish
 *   … -- --extra=<buyurtma>:<sayt>:<saytdagi id>:<SOATO>,…   # qo'shimcha
 *
 * Yo'riqnoma: docs/ops/site-import-repair.md. Chiqish kodlari: 0 — bajarildi,
 * 1 — xato, 2 — sozlama xatosi.
 */
import * as dotenv from 'dotenv';
import { DataSource } from 'typeorm';
import {
  formatSiteImportRepairReport,
  mergeSiteImportRows,
  parseSiteImportRepairArgs,
  type SiteImportRepairRow,
} from '../apps/order-service/src/site-import-repair/site-import-repair';
import { SITE_IMPORT_2026_11_24 } from '../apps/order-service/src/site-import-repair/site-import-2026-11-24';
import { runSiteImportRepair } from '../apps/order-service/src/site-import-repair/site-import-repair.runner';

async function main(): Promise<number> {
  dotenv.config();
  const uri = process.env.POSTGRES_URI;
  let apply: boolean;
  let rows: SiteImportRepairRow[];
  try {
    const args = parseSiteImportRepairArgs(process.argv.slice(2));
    apply = args.apply;
    rows = mergeSiteImportRows(SITE_IMPORT_2026_11_24, args.extra);
  } catch (error) {
    console.error(`[repair] ${(error as Error).message}`);
    return 2;
  }
  if (!uri) {
    console.error('[repair] POSTGRES_URI berilmagan');
    return 2;
  }

  const ds = new DataSource({ type: 'postgres', url: uri, logging: false });
  await ds.initialize();
  const runner = ds.createQueryRunner();
  await runner.connect();
  try {
    const report = await runSiteImportRepair(runner, rows, { apply });
    for (const line of formatSiteImportRepairReport(report)) {
      console.log(line);
    }
    return 0;
  } catch (error) {
    console.error(
      `[repair] xato (hech narsa yozilmadi): ${(error as Error).message}`,
    );
    return 1;
  } finally {
    await runner.release();
    await ds.destroy();
  }
}

if (require.main === module) {
  main()
    .then((code) => process.exit(code))
    .catch((error: unknown) => {
      console.error(error);
      process.exit(1);
    });
}
