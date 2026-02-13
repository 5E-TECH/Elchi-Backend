import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CatalogServiceController } from './catalog-service.controller';
import { CatalogServiceService } from './catalog-service.service';
import { RmqModule, DatabaseModule, catalogValidationSchema } from '@app/common';
import { Product } from './entities/product.entity';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: './.env',
      validationSchema: catalogValidationSchema,
    }),
    RmqModule,
    RmqModule.register({ name: 'SEARCH' }),
    DatabaseModule,
    TypeOrmModule.forFeature([Product]),
  ],
  controllers: [CatalogServiceController],
  providers: [CatalogServiceService],
})
export class CatalogServiceModule {}
