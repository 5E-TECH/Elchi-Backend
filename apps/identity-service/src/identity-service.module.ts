import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { TypeOrmModule } from '@nestjs/typeorm';
import { RmqModule, DatabaseModule, identityValidationSchema } from '@app/common';
import { IdentityController } from './identity.controller';
import { UserServiceService } from './user-service.service';
import { AuthService } from './auth/auth.service';
import { User } from './entities/user.entity';
import { BcryptEncryption } from './common/bcrypt.encryption';
import type { StringValue } from 'ms';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: './.env',
      validationSchema: identityValidationSchema,
    }),
    RmqModule,
    RmqModule.register({ name: 'SEARCH' }),
    DatabaseModule,
    TypeOrmModule.forFeature([User]),
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
  ],
  controllers: [IdentityController],
  providers: [UserServiceService, AuthService, BcryptEncryption],
})
export class IdentityServiceModule {}
