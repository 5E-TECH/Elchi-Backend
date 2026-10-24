import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CatalogServiceController } from './catalog-service.controller';
import { CatalogServiceService } from './catalog-service.service';
import {
  AppLoggerModule,
  RmqModule,
  DatabaseModule,
  catalogValidationSchema,
  ActivityLogModule,
} from '@app/common';
import { Product } from './entities/product.entity';
import {
  WAREHOUSE_CONTROLLERS,
  WAREHOUSE_ENTITIES,
  WAREHOUSE_PROVIDERS,
} from './warehouse';

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
    // hY7uacJu: ombor moduli — filial/viloyat (BRANCH) va tuman → hudud
    // (LOGISTICS) o'qish uchun.
    RmqModule.register({ name: 'BRANCH' }),
    RmqModule.register({ name: 'LOGISTICS' }),
    DatabaseModule,
    TypeOrmModule.forFeature([Product, ...WAREHOUSE_ENTITIES]),
    ActivityLogModule.forService('catalog-service'),
  ],
  controllers: [CatalogServiceController, ...WAREHOUSE_CONTROLLERS],
  providers: [CatalogServiceService, ...WAREHOUSE_PROVIDERS],
})
export class CatalogServiceModule {}
