import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AppLoggerModule, DatabaseModule, RmqModule, searchValidationSchema } from '@app/common';
import { SearchDocument } from './entities/search-document.entity';
import { SearchServiceController } from './search-service.controller';
import { SearchServiceService } from './search-service.service';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: './.env',
      validationSchema: searchValidationSchema,
    }),
    AppLoggerModule.forRoot({ serviceName: 'search-service' }),
    RmqModule,
    DatabaseModule,
    TypeOrmModule.forFeature([SearchDocument]),
  ],
  controllers: [SearchServiceController],
  providers: [SearchServiceService],
})
export class SearchServiceModule {}
