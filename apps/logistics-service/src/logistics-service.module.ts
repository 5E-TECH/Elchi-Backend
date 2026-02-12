import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { LogisticsServiceController } from './logistics-service.controller';
import { LogisticsServiceService } from './logistics-service.service';
import { RmqModule, DatabaseModule, logisticsValidationSchema } from '@app/common';
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
    RmqModule,
    DatabaseModule,
    TypeOrmModule.forFeature([Post, Region, District]),
  ],
  controllers: [LogisticsServiceController],
  providers: [LogisticsServiceService],
})
export class LogisticsServiceModule {}
