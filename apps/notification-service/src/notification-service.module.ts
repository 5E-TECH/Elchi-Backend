import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { NotificationServiceController } from './notification-service.controller';
import { NotificationServiceService } from './notification-service.service';
import {
  AppLoggerModule,
  RmqModule,
  DatabaseModule,
  notificationValidationSchema,
  ActivityLogModule,
} from '@app/common';
import { TelegramMarket } from './entities/telegram-market.entity';
import { Notification } from './entities/notification.entity';
import { NotificationInboxService } from './notification-inbox.service';
import { NotificationBotUpdateService } from './notification-bot.update';
import { OrderBotUpdateService } from './order-bot.update';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: './.env',
      validationSchema: notificationValidationSchema,
    }),
    AppLoggerModule.forRoot({ serviceName: 'notification-service' }),
    RmqModule,
    RmqModule.register({ name: 'IDENTITY' }),
    RmqModule.register({ name: 'ORDER' }),
    // Realtime push: emits `realtime.notify` to the gateway's RMQ queue so
    // connected socket.io clients receive new notifications live.
    RmqModule.register({ name: 'GATEWAY' }),
    DatabaseModule,
    ActivityLogModule.forService('notification-service'),
    TypeOrmModule.forFeature([TelegramMarket, Notification]),
  ],
  controllers: [NotificationServiceController],
  providers: [
    NotificationServiceService,
    NotificationInboxService,
    NotificationBotUpdateService,
    OrderBotUpdateService,
  ],
})
export class NotificationServiceModule {}
