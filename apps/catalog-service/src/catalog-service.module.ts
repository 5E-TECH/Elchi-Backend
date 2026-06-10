import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CatalogServiceController } from './catalog-service.controller';
import { CatalogServiceService } from './catalog-service.service';
import { AppLoggerModule, RmqModule, DatabaseModule, catalogValidationSchema, ActivityLogModule } from '@app/common';
import { Product } from './entities/product.entity';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: './.env',
      validationSchema: catalogValidationSchema,
    }),
    AppLoggerModule.forRoot({ serviceName: 'catalog-service' }),
    RmqModule,
    RmqModule.register({ name: 'SEARCH' }),
    RmqModule.register({ name: 'IDENTITY' }),
    DatabaseModule,
    TypeOrmModule.forFeature([Product]),
    ActivityLogModule.forService('catalog-service'),
  ],
  controllers: [CatalogServiceController],
  providers: [CatalogServiceService],
})
export class CatalogServiceModule {}
