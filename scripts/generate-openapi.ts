/**
 * Standalone OpenAPI generator for the Elchi API Gateway.
 *
 * The gateway is a pure HTTP→RMQ proxy with NO database of its own, so the Nest
 * app can be instantiated (DI graph built) WITHOUT rabbitmq/postgres running —
 * ClientProxy instances connect lazily on first .send(), which we never call.
 * That lets us build the Swagger document offline and dump it to a static file.
 *
 * Usage:  npm run openapi:generate
 *   (node -r ts-node/register -r tsconfig-paths/register scripts/generate-openapi.ts)
 * Output: docs/frontend/openapi.json
 */

// Satisfy gatewayValidationSchema (Joi) with placeholder values BEFORE the Nest
// modules are required. None are used for document generation — they only let
// ConfigModule validate successfully.
const ENV_DEFAULTS: Record<string, string> = {
  NODE_ENV: 'development',
  PORT: '3004',
  ACCESS_TOKEN_KEY: 'openapi_dummy_access_key',
  ACCESS_TOKEN_TIME: '15m',
  RABBITMQ_URI: 'amqp://guest:guest@localhost:5672',
  RABBITMQ_IDENTITY_QUEUE: 'identity_queue',
  RABBITMQ_ORDER_QUEUE: 'order_queue',
  RABBITMQ_CATALOG_QUEUE: 'catalog_queue',
  RABBITMQ_LOGISTICS_QUEUE: 'logistics_queue',
  RABBITMQ_FINANCE_QUEUE: 'finance_queue',
  RABBITMQ_NOTIFICATION_QUEUE: 'notification_queue',
  RABBITMQ_INTEGRATION_QUEUE: 'integration_queue',
  RABBITMQ_ANALYTICS_QUEUE: 'analytics_queue',
  RABBITMQ_BRANCH_QUEUE: 'branch_queue',
  RABBITMQ_INVESTOR_QUEUE: 'investor_queue',
  RABBITMQ_FILE_QUEUE: 'file_queue',
  RABBITMQ_C2C_QUEUE: 'c2c_queue',
  RABBITMQ_SEARCH_QUEUE: 'search_queue',
};
for (const [key, value] of Object.entries(ENV_DEFAULTS)) {
  if (!process.env[key]) process.env[key] = value;
}

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { ApiGatewayModule } from '../apps/api-gateway/src/api-gateway.module';

async function main() {
  const app = await NestFactory.create(ApiGatewayModule, {
    logger: false,
    abortOnError: false,
  });

  const config = new DocumentBuilder()
    .setTitle('Elchi API Gateway')
    .setDescription('API Gateway docs for all microservice routes')
    .setVersion('1.0.0')
    .addBearerAuth()
    .build();

  const document = SwaggerModule.createDocument(app, config);

  const outPath = join(process.cwd(), 'docs', 'frontend', 'openapi.json');
  writeFileSync(outPath, JSON.stringify(document, null, 2), 'utf8');

  const pathCount = Object.keys(document.paths ?? {}).length;
  const opCount = Object.values(document.paths ?? {}).reduce(
    (sum, item) => sum + Object.keys(item ?? {}).length,
    0,
  );
  // eslint-disable-next-line no-console
  console.log(
    `OpenAPI written → ${outPath}\n  paths: ${pathCount}  operations: ${opCount}`,
  );

  await app.close();
  process.exit(0);
}

main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error('OpenAPI generation failed:', error);
  process.exit(1);
});
