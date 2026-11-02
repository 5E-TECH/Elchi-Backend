/**
 * Pochta ↔ buyurtma TARIXINI eski yozuvlardan tiklash (bir martalik, qayta
 * yurgizish xavfsiz).
 *
 * Migratsiya 1716000000201 `order_schema.post_order_memberships` jadvalini,
 * jonli trigger'ni va har buyurtmaning HOZIRGI pochtasi uchun seed qatorini
 * yaratadi. Bu skript migratsiyadan OLDINGI davrni to'ldiradi — eski
 * pochtalar ichida bo'lib, keyin boshqa pochtaga o'tgan / chiqarilgan
 * buyurtmalar uchun YOPIQ turishlar (joined_at, left_at, next_post_id) va
 * seed qatorining `joined_at` ini tarixdagi haqiqiy kirgan vaqtga suradi.
 *
 * Manbalar (ustunlik tartibida; quyisi faqat yuqorisidan oldingi davrni
 * to'ldiradi):
 *   1) order_schema.outbox_events      — 'search.index.upsert' (Order) surati;
 *   2) order_schema.activity_logs      — Order new_value / o'chirilganda
 *                                         old_value dagi post_id, canceled_post_id;
 *   3) logistics_schema.activity_logs  — scanAssignOrder `{ courier_id, post_id }`.
 * Mantiq (sof, unit-testlangan):
 *   apps/order-service/src/post-membership/post-membership-backfill.ts
 * DB qismi:
 *   apps/order-service/src/post-membership/post-membership-backfill.runner.ts
 *
 * Ishga tushirish (server'da, DB lokal):
 *   POSTGRES_URI=... node -r ts-node/register -r tsconfig-paths/register \
 *     scripts/backfill-post-order-memberships.ts            # DRY-RUN (sukut)
 *   POSTGRES_URI=... node -r ts-node/register -r tsconfig-paths/register \
 *     scripts/backfill-post-order-memberships.ts --apply    # yozish
 *
 * Bayroqlar:
 *   --apply              yozish (yo'q bo'lsa — faqat hisobot, DRY-RUN);
 *   --dry-run            aniq dry-run (`--apply` dan ustun);
 *   --batch=<n>          bir paketdagi buyurtmalar (sukut 2000);
 *   --report-limit=<n>   hisobotda ko'rsatiladigan pochtalar (sukut 50).
 *
 * Hisobotdagi `order_quantity` — FAQAT ishora (checksum emas).
 *
 * Chiqish kodlari: 0 — muvaffaqiyat, 1 — xato, 2 — sozlama xatosi.
 */
import * as dotenv from 'dotenv';
import { DataSource } from 'typeorm';
import {
  formatBackfillReport,
  parseBackfillArgs,
  type BackfillArgs,
} from '../apps/order-service/src/post-membership/post-membership-backfill';
import { runPostMembershipBackfill } from '../apps/order-service/src/post-membership/post-membership-backfill.runner';

async function main(): Promise<number> {
  dotenv.config();
  const uri = process.env.POSTGRES_URI;
  let args: BackfillArgs;
  try {
    args = parseBackfillArgs(process.argv.slice(2));
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
  // Vaqtinchalik jadval sessiyaga bog'liq — BITTA ulanish.
  const runner = ds.createQueryRunner();
  await runner.connect();
  try {
    const report = await runPostMembershipBackfill(runner, args, (line) =>
      console.log(line),
    );
    for (const line of formatBackfillReport(report, args.reportLimit)) {
      console.log(line);
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
