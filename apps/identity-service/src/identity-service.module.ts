import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { TypeOrmModule } from '@nestjs/typeorm';
import {
  AppLoggerModule,
  RmqModule,
  DatabaseModule,
  identityValidationSchema,
  ActivityLogModule,
} from '@app/common';
import { IdentityController } from './identity.controller';
import { UserServiceService } from './user-service.service';
import { AuthService } from './auth/auth.service';
import { AuthSessionService } from './auth/auth-session.service';
import { SessionKickPublisher } from './auth/session-kick.publisher';
import { User } from './entities/user.entity';
import { CourierRegion } from './entities/courier-region.entity';
import { UserSession } from './entities/user-session.entity';
import { BcryptEncryption } from '../../../libs/common/helpers/bcrypt';
import type { StringValue } from 'ms';

import { ScheduleModule } from '@nestjs/schedule';
import { OtpCode } from './entities/otp-code.entity';
import { OtpService } from './otp/otp.service';
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: './.env',
      validationSchema: identityValidationSchema,
    }),
    AppLoggerModule.forRoot({ serviceName: 'identity-service' }),
    RmqModule,
    RmqModule.register({ name: 'SEARCH' }),
    RmqModule.register({ name: 'CATALOG' }),
    RmqModule.register({ name: 'ORDER' }),
    RmqModule.register({ name: 'LOGISTICS' }),
    RmqModule.register({ name: 'FINANCE' }),
    RmqModule.register({ name: 'BRANCH' }),
    // OTP SMS (rkz0yBxr) notification-service orqali.
    RmqModule.register({ name: 'NOTIFICATION' }),
    // (Elchi Pochta #3, 2026-10-24) `auth.sessions.kick` → gateway navbati
    // (RABBITMQ_GATEWAY_QUEUE; sozlanmasa e'lon qilinmaydi).
    RmqModule.register({ name: 'GATEWAY' }),
    ScheduleModule.forRoot(),
    DatabaseModule,
    ActivityLogModule.forService('identity-service'),
    TypeOrmModule.forFeature([User, OtpCode, CourierRegion, UserSession]),
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        secret: configService.getOrThrow<string>('ACCESS_TOKEN_KEY'),
        signOptions: {
          expiresIn: (configService.get<string>('ACCESS_TOKEN_TIME') ??
            '1h') as StringValue,
        },
      }),
    }),
  ],
  controllers: [IdentityController],
  providers: [
    UserServiceService,
    AuthService,
    AuthSessionService,
    SessionKickPublisher,
    BcryptEncryption,
    OtpService,
  ],
})
export class IdentityServiceModule {}
