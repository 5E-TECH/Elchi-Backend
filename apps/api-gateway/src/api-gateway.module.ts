import { Module } from '@nestjs/common';
import { ApiGatewayController } from './api-gateway.controller';
import { ApiGatewayService } from './api-gateway.service';
import { ConfigModule, ConfigService } from '@nestjs/config';
import {
  AppLoggerModule,
  RmqModule,
  gatewayValidationSchema,
} from '@app/common';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import { APP_GUARD } from '@nestjs/core';
import { JwtStrategy } from './auth/jwt.strategy';
import { JwtAuthGuard } from './auth/jwt-auth.guard';
import { RolesGuard } from './auth/roles.guard';
import { SelfGuard } from './auth/self.guard';
import { AuthGatewayController } from './auth-gateway.controller';
import { CatalogGatewayController } from './catalog-gateway.controller';
import { HealthController } from './health.controller';
import { SearchGatewayController } from './search-gateway.controller';
import { LogisticsGatewayController } from './logistics-gateway.controller';
import { OrderGatewayController } from './order-gateway.controller';
import { FinanceGatewayController } from './finance-gateway.controller';
import { AnalyticsGatewayController } from './analytics-gateway.controller';
import { NotificationGatewayController } from './notification-gateway.controller';
import { IntegrationGatewayController } from './integration-gateway.controller';
import { WebhookGatewayController } from './webhook-gateway.controller';
import { InvestorGatewayController } from './investor-gateway.controller';
import { BranchGatewayController } from './branch-gateway.controller';
import { FileGatewayController } from './file-gateway.controller';
import { ScanGatewayController } from './scan-gateway.controller';
import { PrinterGatewayController } from './printer-gateway.controller';
import { ExcelGatewayController } from './excel-gateway.controller';
import { RealtimeGateway } from './realtime/realtime.gateway';
import { RealtimeController } from './realtime/realtime.controller';
import { AuditGatewayController } from './audit-gateway.controller';
import { AuditEnrichmentService } from './audit/audit-enrichment.service';
import type { StringValue } from 'ms';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: './.env',
      validationSchema: gatewayValidationSchema,
    }),
    AppLoggerModule.forRoot({ serviceName: 'api-gateway' }),
    PassportModule,
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        secret: configService.getOrThrow<string>('ACCESS_TOKEN_KEY'),
        signOptions: {
          expiresIn: (configService.get<string>('ACCESS_TOKEN_TIME') ??
            '15m') as StringValue,
        },
      }),
    }),
    ThrottlerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        // Global per-IP rate limit. Sensitive endpoints (login/refresh)
        // override this with @Throttle({ default: { ... } }) to a stricter
        // value (AUTH_THROTTLE_LIMIT). Health endpoints are exempted via
        // @SkipThrottle().
        throttlers: [
          {
            name: 'default',
            ttl: configService.get<number>('THROTTLE_TTL_MS', 60_000),
            limit: configService.get<number>('THROTTLE_LIMIT', 60),
          },
        ],
      }),
    }),
    // Core services
    RmqModule.register({ name: 'IDENTITY' }),
    RmqModule.register({ name: 'ORDER' }),
    RmqModule.register({ name: 'CATALOG' }),
    RmqModule.register({ name: 'LOGISTICS' }),
    RmqModule.register({ name: 'FINANCE' }),
    RmqModule.register({ name: 'NOTIFICATION' }),
    RmqModule.register({ name: 'INTEGRATION' }),
    RmqModule.register({ name: 'ANALYTICS' }),
    // New services
    RmqModule.register({ name: 'BRANCH' }),
    RmqModule.register({ name: 'INVESTOR' }),
    RmqModule.register({ name: 'FILE' }),
    RmqModule.register({ name: 'C2C' }),
    RmqModule.register({ name: 'SEARCH' }),
  ],
  controllers: [
    ApiGatewayController,
    AuthGatewayController,
    CatalogGatewayController,
    OrderGatewayController,
    LogisticsGatewayController,
    SearchGatewayController,
    FinanceGatewayController,
    NotificationGatewayController,
    IntegrationGatewayController,
    WebhookGatewayController,
    InvestorGatewayController,
    BranchGatewayController,
    FileGatewayController,
    ScanGatewayController,
    AnalyticsGatewayController,
    PrinterGatewayController,
    ExcelGatewayController,
    RealtimeController,
    AuditGatewayController,
    HealthController,
    // TODO: Qolgan gateway controllerlarni qo'shish
    // FinanceGatewayController,
    // NotificationGatewayController,
    // IntegrationGatewayController,
    // AnalyticsGatewayController,
    // BranchGatewayController,
    // InvestorGatewayController,
    // FileGatewayController,
    // C2cGatewayController,
  ],
  providers: [
    ApiGatewayService,
    JwtStrategy,
    JwtAuthGuard,
    RolesGuard,
    SelfGuard,
    RealtimeGateway,
    AuditEnrichmentService,
    { provide: APP_GUARD, useClass: ThrottlerGuard },
  ],
})
export class ApiGatewayModule {}
