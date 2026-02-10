// import { Module } from '@nestjs/common';
// import { UserServiceController } from './user-service.controller';
// import { UserServiceService } from './user-service.service';

// @Module({
//   imports: [],
//   controllers: [UserServiceController],
//   providers: [UserServiceService],
// })
// export class UserServiceModule {}



// apps/user-service/src/user-service.module.ts
import { Module } from '@nestjs/common';
import { UserServiceController } from './user-service.controller';
import { UserServiceService } from './user-service.service';
import { ConfigModule } from '@nestjs/config';
import { RmqModule, DatabaseModule } from '@app/common'; // Bizning liblar

@Module({
  imports: [
    // 1. Env fayllarni o'qish uchun
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: './.env',
    }),
    // 2. RabbitMQ ga ulanish (o'zini 'USER' deb tanishtiradi)
    RmqModule, 
    // 3. Bazaga ulanish
    DatabaseModule, 
  ],
  controllers: [UserServiceController],
  providers: [UserServiceService],
})
export class UserServiceModule {}