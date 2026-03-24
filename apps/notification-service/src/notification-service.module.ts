import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { NotificationServiceController } from './notification-service.controller';
import { NotificationServiceService } from './notification-service.service';
import { RmqModule, DatabaseModule, notificationValidationSchema } from '@app/common';
import { TelegramMarket } from './entities/telegram-market.entity';
import { NotificationBotUpdateService } from './notification-bot.update';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: './.env',
      validationSchema: notificationValidationSchema,
    }),
    RmqModule,
    RmqModule.register({ name: 'IDENTITY' }),
    DatabaseModule,
    TypeOrmModule.forFeature([TelegramMarket]),
  ],
  controllers: [NotificationServiceController],
  providers: [NotificationServiceService, NotificationBotUpdateService],
})
export class NotificationServiceModule {}
