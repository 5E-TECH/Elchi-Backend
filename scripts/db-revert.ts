import * as dotenv from 'dotenv';
import { DataSource } from 'typeorm';

/**
 * 63HO6cBU (PR-C, Z3-1) — order migratsiyalaridan OXIRGISINI qaytaradi
 * (`db:prepare` bilan bir xil ulanish: `.env.production`, `order_schema`,
 * `migrations/*.ts`). `npm run migration:revert` bu yerda yaramaydi:
 * tsconfig-paths yuklanmaydi va `DB_SCHEMA` siz «Nothing to revert» deb
 * exit 0 qaytaradi.
 *
 *   npm run db:revert -- --expect=SettlementMarketPaidByBranch1716000000246
 *
 * `--expect` majburiy: oxirgi bajarilgan migratsiya aynan shu bo'lmasa hech
 * narsa qilinmaydi (exit 1) — noto'g'ri migratsiya qaytarilmasin. Muvaffaqiyatda
 * yangi oxirgi migratsiya chiqariladi (tekshiruv uchun).
 */
dotenv.config({ path: '.env.production', override: true });

const postgresUri = process.env.POSTGRES_URI;
if (!postgresUri) {
  throw new Error('POSTGRES_URI is required for db-revert (.env.production)');
}

const expectArg = process.argv
  .slice(2)
  .find((arg) => arg.startsWith('--expect='));
const expected = expectArg?.slice('--expect='.length).trim();
if (!expected) {
  throw new Error(
    '--expect=<MigrationName> is required (e.g. --expect=SettlementMarketPaidByBranch1716000000246)',
  );
}

type MigrationRow = { name: string; timestamp: string };

async function lastExecuted(ds: DataSource): Promise<MigrationRow | null> {
  const table = `"order_schema"."${ds.options.migrationsTableName ?? 'migrations'}"`;
  const rows = await ds.query<MigrationRow[]>(
    `SELECT name, timestamp::text AS timestamp FROM ${table} ORDER BY timestamp DESC, id DESC LIMIT 1`,
  );
  return rows[0] ?? null;
}

async function main(): Promise<void> {
  const ds = new DataSource({
    type: 'postgres',
    url: postgresUri,
    synchronize: false,
    logging: false,
    schema: 'order_schema',
    entities: [],
    migrations: ['migrations/*.ts', 'dist/migrations/*.js'],
  });

  await ds.initialize();
  try {
    const last = await lastExecuted(ds);
    if (!last || last.name !== expected) {
      throw new Error(
        `[db-revert] oxirgi bajarilgan migratsiya '${last?.name ?? '(yo`q)'}', kutilgan '${expected}' — hech narsa qaytarilmadi`,
      );
    }
    await ds.undoLastMigration({ transaction: 'all' });
    const now = await lastExecuted(ds);
    console.log(
      `[db-revert] qaytarildi: ${expected}; endi oxirgisi: ${now?.name ?? '(yo`q)'} (${now?.timestamp ?? '-'})`,
    );
  } finally {
    await ds.destroy();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
