import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { LogisticsServiceController } from './logistics-service.controller';
import { LogisticsServiceService } from './logistics-service.service';
import { AppLoggerModule, RmqModule, DatabaseModule, logisticsValidationSchema, ActivityLogModule } from '@app/common';
import { Post } from './entities/post.entity';
import { Region } from './entities/region.entity';
import { District } from './entities/district.entity';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: './.env',
      validationSchema: logisticsValidationSchema,
    }),
    AppLoggerModule.forRoot({ serviceName: 'logistics-service' }),
    RmqModule,
    RmqModule.register({ name: 'ORDER' }),
    RmqModule.register({ name: 'BRANCH' }),
    RmqModule.register({ name: 'IDENTITY' }),
    RmqModule.register({ name: 'SEARCH' }),
    DatabaseModule,
    TypeOrmModule.forFeature([Post, Region, District]),
    ActivityLogModule.forService('logistics-service'),
  ],
  controllers: [LogisticsServiceController],
  providers: [LogisticsServiceService],
})
export class LogisticsServiceModule {}
