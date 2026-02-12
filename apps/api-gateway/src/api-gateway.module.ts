// import { Module } from '@nestjs/common';
// import { ApiGatewayController } from './api-gateway.controller';
// import { ApiGatewayService } from './api-gateway.service';

// @Module({
//   imports: [],
//   controllers: [ApiGatewayController],
//   providers: [ApiGatewayService],
// })
// export class ApiGatewayModule {}


// apps/api-gateway/src/api-gateway.module.ts
import { Module } from '@nestjs/common';
import { ApiGatewayController } from './api-gateway.controller';
import { ApiGatewayService } from './api-gateway.service';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { RmqModule } from '@app/common';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { JwtStrategy } from './auth/jwt.strategy';
import type { StringValue } from 'ms';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: './.env',
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
    // Gateway USER servisga xabar yuborish huquqini olyapti
    RmqModule.register({ name: 'USER' }), 
  ],
  controllers: [ApiGatewayController],
  providers: [ApiGatewayService, JwtStrategy],
})
export class ApiGatewayModule {}
