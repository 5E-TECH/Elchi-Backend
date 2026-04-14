import * as dotenv from 'dotenv';
import { DataSource, DataSourceOptions } from 'typeorm';

dotenv.config({ path: '.env.production' });
dotenv.config();

const postgresUri = process.env.POSTGRES_URI;
if (!postgresUri) {
  throw new Error('POSTGRES_URI is required for db-prepare');
}

type SchemaConfig = {
  schema: string;
  entities: string[];
};

const schemaConfigs: SchemaConfig[] = [
  { schema: 'identity_schema', entities: ['apps/identity-service/src/entities/*.entity.ts', 'dist/apps/identity-service/**/*.entity.js'] },
  { schema: 'order_schema', entities: ['apps/order-service/src/entities/*.entity.ts', 'dist/apps/order-service/**/*.entity.js'] },
  { schema: 'catalog_schema', entities: ['apps/catalog-service/src/entities/*.entity.ts', 'dist/apps/catalog-service/**/*.entity.js'] },
  { schema: 'logistics_schema', entities: ['apps/logistics-service/src/entities/*.entity.ts', 'dist/apps/logistics-service/**/*.entity.js'] },
  { schema: 'finance_schema', entities: ['apps/finance-service/src/entities/*.entity.ts', 'dist/apps/finance-service/**/*.entity.js'] },
  { schema: 'notification_schema', entities: ['apps/notification-service/src/entities/*.entity.ts', 'dist/apps/notification-service/**/*.entity.js'] },
  { schema: 'integration_schema', entities: ['apps/integration-service/src/entities/*.entity.ts', 'dist/apps/integration-service/**/*.entity.js'] },
  { schema: 'branch_schema', entities: ['apps/branch-service/src/entities/*.entity.ts', 'dist/apps/branch-service/**/*.entity.js'] },
  { schema: 'investor_schema', entities: ['apps/investor-service/src/entities/*.entity.ts', 'dist/apps/investor-service/**/*.entity.js'] },
  { schema: 'c2c_schema', entities: ['apps/c2c-service/src/entities/*.entity.ts', 'dist/apps/c2c-service/**/*.entity.js'] },
  { schema: 'search_schema', entities: ['apps/search-service/src/entities/*.entity.ts', 'dist/apps/search-service/**/*.entity.js'] },
];

function makeBaseOptions(): Omit<DataSourceOptions, 'schema' | 'entities'> {
  return {
    type: 'postgres',
    url: postgresUri,
    synchronize: false,
    logging: false,
  };
}

async function bootstrapSchema({ schema, entities }: SchemaConfig): Promise<void> {
  const ds = new DataSource({
    ...makeBaseOptions(),
    schema,
    entities,
  } as DataSourceOptions);

  await ds.initialize();
  try {
    await ds.query(`CREATE SCHEMA IF NOT EXISTS "${schema}"`);
    await ds.synchronize();
    // eslint-disable-next-line no-console
    console.log(`[db-prepare] synchronized schema: ${schema}`);
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

async function main(): Promise<void> {
  for (const cfg of schemaConfigs) {
    await bootstrapSchema(cfg);
  }
  await runOrderMigrations();
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('[db-prepare] failed:', err);
  process.exit(1);
});
