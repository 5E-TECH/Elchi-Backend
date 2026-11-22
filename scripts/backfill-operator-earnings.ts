/**
 * O'tgan sotuvlarga operator komissiyasi — JORIY stavka bo'yicha, BARCHA
 * market operatorlari uchun bir yo'la (bir martalik, qayta yurgizish xavfsiz).
 *
 * Nega: komissiya sotuv paytida yoziladi. Stavka keyin belgilangan bo'lsa,
 * o'sha sotuvlarga komissiya yozilmay qolgan. Ega qarori (2026-11-21): ularga
 * ham hozirgi stavka bo'yicha haq hisoblansin. Market paneldagi «O'tgan
 * sotuvlarga hisoblash» tugmasi buni bitta operator uchun qiladi va faqat
 * market akkauntida bor — bu skript hammasini qiladi.
 *
 * Nima qiladi: holati sold / paid / partly_paid, o'chirilmagan, market
 * operatoriga bog'langan (`operator_id`) va komissiya qatori UMUMAN yo'q
 * buyurtmalarga `finance_schema.operator_earnings` qatori qo'shadi (stavka
 * surati bilan) va har operator uchun `finance_schema.activity_logs` ga audit
 * yozadi. Mavjud qatorlarga tegmaydi, kassa/daftarga ta'sir qilmaydi.
 * Faqat matn bo'lib yozilgan operator (`operator_id` yo'q) avtomatik
 * bog'lanmaydi — buni market «Biriktirish» orqali qiladi.
 * Mantiq: apps/finance-service/src/operator-earning-backfill/
 *
 * Ishga tushirish (server'da; to'liq yo'riqnoma —
 * docs/ops/operator-earnings-backfill.md):
 *   npm run -s db:backfill-operator-earnings              # DRY-RUN (sukut)
 *   npm run -s db:backfill-operator-earnings -- --apply   # yozish
 *
 * Bayroqlar:
 *   --apply              yozish (yo'q bo'lsa — faqat hisobot, DRY-RUN);
 *   --dry-run            aniq dry-run (`--apply` dan ustun);
 *   --batch=<n>          bitta tranzaksiyadagi buyurtmalar (sukut 1000, ≤5000);
 *   --report-limit=<n>   hisobotdagi market/operator qatorlari (sukut 100).
 *
 * Chiqish kodlari: 0 — muvaffaqiyat, 1 — xato, 2 — sozlama xatosi.
 */
import * as dotenv from 'dotenv';
import { DataSource } from 'typeorm';
import {
  formatEarningBackfillReport,
  parseEarningBackfillArgs,
  type EarningBackfillArgs,
} from '../apps/finance-service/src/operator-earning-backfill/operator-earning-backfill';
import { runOperatorEarningBackfill } from '../apps/finance-service/src/operator-earning-backfill/operator-earning-backfill.runner';

async function main(): Promise<number> {
  dotenv.config();
  const uri = process.env.POSTGRES_URI;
  let args: EarningBackfillArgs;
  try {
    args = parseEarningBackfillArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`[backfill] ${(error as Error).message}`);
    return 2;
  }
  if (!uri) {
    console.error('[backfill] POSTGRES_URI berilmagan');
    return 2;
  }

  const ds = new DataSource({ type: 'postgres', url: uri, logging: false });
  await ds.initialize();
  // Advisory lock va `SET lock_timeout` sessiyaga bog'liq — BITTA ulanish.
  const runner = ds.createQueryRunner();
  await runner.connect();
  try {
    const report = await runOperatorEarningBackfill(runner, args, (line) =>
      console.log(line),
    );
    for (const line of formatEarningBackfillReport(report, args.reportLimit)) {
      console.log(line);
    }
    if (!args.apply && report.planned > 0) {
      console.log('');
      console.log(
        '[backfill] Bu faqat hisobot. Yozish uchun: npm run -s db:backfill-operator-earnings -- --apply',
      );
    }
    return 0;
  } catch (error) {
    console.error(`[backfill] xato: ${(error as Error).message}`);
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
