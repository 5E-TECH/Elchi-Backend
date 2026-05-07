import * as dotenv from 'dotenv';
import { DataSource, DataSourceOptions } from 'typeorm';
import { PostgresConnectionOptions } from 'typeorm/driver/postgres/PostgresConnectionOptions';

dotenv.config({ path: '.env.production', override: true });

const postgresUri = process.env.POSTGRES_URI;
if (!postgresUri) {
  throw new Error('POSTGRES_URI is required for db-prepare (.env.production)');
}

type SchemaConfig = {
  schema: string;
};

type BasePostgresOptions = Omit<
  PostgresConnectionOptions,
  'schema' | 'entities' | 'migrations'
>;

const schemaConfigs: SchemaConfig[] = [
  { schema: 'identity_schema' },
  { schema: 'order_schema' },
  { schema: 'catalog_schema' },
  { schema: 'logistics_schema' },
  { schema: 'finance_schema' },
  { schema: 'notification_schema' },
  { schema: 'integration_schema' },
  { schema: 'branch_schema' },
  { schema: 'investor_schema' },
  { schema: 'c2c_schema' },
  { schema: 'search_schema' },
];

function makeBaseOptions(): BasePostgresOptions {
  return {
    type: 'postgres',
    url: postgresUri,
    synchronize: false,
    logging: false,
  };
}

async function bootstrapSchema({ schema }: SchemaConfig): Promise<void> {
  const ds = new DataSource({
    ...makeBaseOptions(),
    schema: 'public',
  } as DataSourceOptions);

  await ds.initialize();
  try {
    await ds.query(`CREATE SCHEMA IF NOT EXISTS "${schema}"`);
    // eslint-disable-next-line no-console
    console.log(`[db-prepare] ensured schema: ${schema}`);
  } finally {
    await ds.destroy();
  }
}

async function runOrderMigrations(): Promise<void> {
  const ds = new DataSource({
    ...makeBaseOptions(),
    schema: 'order_schema',
    entities: ['apps/**/src/entities/*.entity.ts', 'dist/**/entities/*.entity.js'],
    migrations: ['migrations/*.ts', 'dist/migrations/*.js'],
  } as DataSourceOptions);

  await ds.initialize();
  try {
    await ds.runMigrations();
    // eslint-disable-next-line no-console
    console.log('[db-prepare] order migrations completed');
  } finally {
    await ds.destroy();
  }
}

async function verifyOrderRelations(): Promise<void> {
  const ds = new DataSource({
    ...makeBaseOptions(),
    schema: 'order_schema',
  } as DataSourceOptions);

  await ds.initialize();
  try {
    const requiredForeignKeys = [
      { table_name: 'order_items', column_name: 'order_id' },
      { table_name: 'order_tracking', column_name: 'order_id' },
    ];

    const rows = (await ds.query(
      `
      SELECT
        tc.table_name,
        kcu.column_name,
        ccu.table_name AS foreign_table_name,
        ccu.column_name AS foreign_column_name,
        tc.constraint_name
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu
        ON tc.constraint_name = kcu.constraint_name
       AND tc.table_schema = kcu.table_schema
      JOIN information_schema.constraint_column_usage ccu
        ON tc.constraint_name = ccu.constraint_name
       AND tc.table_schema = ccu.table_schema
      WHERE tc.constraint_type = 'FOREIGN KEY'
        AND tc.table_schema = 'order_schema'
        AND ccu.table_name = 'orders'
        AND ccu.column_name = 'id'
      `,
    )) as Array<{
      table_name: string;
      column_name: string;
      foreign_table_name: string;
      foreign_column_name: string;
      constraint_name: string;
    }>;

    const existing = new Set(
      rows.map((row) => `${row.table_name}.${row.column_name}`),
    );
    const missing = requiredForeignKeys
      .map((fk) => `${fk.table_name}.${fk.column_name}`)
      .filter((key) => !existing.has(key));

    if (missing.length > 0) {
      throw new Error(
        `[db-prepare] order_schema relation constraints missing for: ${missing.join(
          ', ',
        )}`,
      );
    }

    // eslint-disable-next-line no-console
    console.log('[db-prepare] order relations verified');
  } finally {
    await ds.destroy();
  }
}

async function ensureOrderRelations(): Promise<void> {
  const ds = new DataSource({
    ...makeBaseOptions(),
    schema: 'order_schema',
  } as DataSourceOptions);

  await ds.initialize();
  try {
    // Remove orphan rows before adding FK constraints.
    await ds.query(`
      DELETE FROM order_schema.order_items oi
      WHERE NOT EXISTS (
        SELECT 1 FROM order_schema.orders o WHERE o.id = oi.order_id
      )
    `);

    await ds.query(`
      DELETE FROM order_schema.order_tracking ot
      WHERE NOT EXISTS (
        SELECT 1 FROM order_schema.orders o WHERE o.id = ot.order_id
      )
    `);

    // Ensure FK from order_items.order_id -> orders.id
    await ds.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1
          FROM information_schema.table_constraints tc
          JOIN information_schema.key_column_usage kcu
            ON tc.constraint_name = kcu.constraint_name
           AND tc.table_schema = kcu.table_schema
          JOIN information_schema.constraint_column_usage ccu
            ON tc.constraint_name = ccu.constraint_name
           AND tc.table_schema = ccu.table_schema
          WHERE tc.constraint_type = 'FOREIGN KEY'
            AND tc.table_schema = 'order_schema'
            AND tc.table_name = 'order_items'
            AND kcu.column_name = 'order_id'
            AND ccu.table_name = 'orders'
            AND ccu.column_name = 'id'
        ) THEN
          ALTER TABLE order_schema.order_items
            ADD CONSTRAINT "FK_order_items_order_id"
            FOREIGN KEY (order_id)
            REFERENCES order_schema.orders(id)
            ON DELETE CASCADE ON UPDATE NO ACTION;
        END IF;
      END
      $$;
    `);

    // Ensure FK from order_tracking.order_id -> orders.id
    await ds.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1
          FROM information_schema.table_constraints tc
          JOIN information_schema.key_column_usage kcu
            ON tc.constraint_name = kcu.constraint_name
           AND tc.table_schema = kcu.table_schema
          JOIN information_schema.constraint_column_usage ccu
            ON tc.constraint_name = ccu.constraint_name
           AND tc.table_schema = ccu.table_schema
          WHERE tc.constraint_type = 'FOREIGN KEY'
            AND tc.table_schema = 'order_schema'
            AND tc.table_name = 'order_tracking'
            AND kcu.column_name = 'order_id'
            AND ccu.table_name = 'orders'
            AND ccu.column_name = 'id'
        ) THEN
          ALTER TABLE order_schema.order_tracking
            ADD CONSTRAINT "FK_order_tracking_order_id"
            FOREIGN KEY (order_id)
            REFERENCES order_schema.orders(id)
            ON DELETE CASCADE ON UPDATE NO ACTION;
        END IF;
      END
      $$;
    `);

    // eslint-disable-next-line no-console
    console.log('[db-prepare] order relations repaired/ensured');
  } finally {
    await ds.destroy();
  }
}

async function main(): Promise<void> {
  for (const cfg of schemaConfigs) {
    await bootstrapSchema(cfg);
  }
  await runOrderMigrations();
  await ensureOrderRelations();
  await verifyOrderRelations();
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('[db-prepare] failed:', err);
  process.exit(1);
});
