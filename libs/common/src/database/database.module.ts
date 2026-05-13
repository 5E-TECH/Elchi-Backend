import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';

function readNumber(
  configService: ConfigService,
  key: string,
  fallback: number,
): number {
  const raw = configService.get<string>(key);
  if (raw === undefined || raw === null || String(raw).trim() === '') {
    return fallback;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

@Module({
  imports: [
    TypeOrmModule.forRootAsync({
      useFactory: (configService: ConfigService) => ({
        type: 'postgres',
        url: configService.get<string>('POSTGRES_URI'),
        schema: configService.get<string>('DB_SCHEMA') || 'public',
        autoLoadEntities: true,
        synchronize: false,
        logging: configService.get<string>('NODE_ENV') !== 'production',
        // Defensive timeouts so a misbehaving query / unreachable DB doesn't
        // hang request handlers indefinitely. Pool size is left at the pg
        // driver default (10) — bump DB_POOL_MAX in env if a service hits the
        // ceiling under burst load and your Postgres max_connections allows it.
        extra: {
          max: readNumber(configService, 'DB_POOL_MAX', 10),
          min: readNumber(configService, 'DB_POOL_MIN', 0),
          idleTimeoutMillis: readNumber(
            configService,
            'DB_POOL_IDLE_TIMEOUT_MS',
            30_000,
          ),
          connectionTimeoutMillis: readNumber(
            configService,
            'DB_POOL_CONNECTION_TIMEOUT_MS',
            5_000,
          ),
          statement_timeout: readNumber(
            configService,
            'DB_QUERY_TIMEOUT_MS',
            30_000,
          ),
        },
      }),
      inject: [ConfigService],
    }),
  ],
})
export class DatabaseModule {}
