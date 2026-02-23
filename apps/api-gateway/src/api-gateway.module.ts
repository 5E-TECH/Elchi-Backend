import { Module } from '@nestjs/common';
import { ApiGatewayController } from './api-gateway.controller';
import { ApiGatewayService } from './api-gateway.service';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { RmqModule, gatewayValidationSchema } from '@app/common';
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
import type { StringValue } from 'ms';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: './.env',
      validationSchema: gatewayValidationSchema,
    }),
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
    ThrottlerModule.forRoot({
      throttlers: [{ ttl: 60000, limit: 60 }],
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
    LogisticsGatewayController,
    SearchGatewayController,
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
    { provide: APP_GUARD, useClass: ThrottlerGuard },
  ],
})
export class ApiGatewayModule {}
