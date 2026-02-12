import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { C2cServiceController } from './c2c-service.controller';
import { C2cServiceService } from './c2c-service.service';
import { RmqModule, DatabaseModule, c2cValidationSchema } from '@app/common';
import { Listing } from './entities/listing.entity';
import { C2COrder } from './entities/c2c-order.entity';
import { Review } from './entities/review.entity';
import { Dispute } from './entities/dispute.entity';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: './.env',
      validationSchema: c2cValidationSchema,
    }),
    RmqModule,
    DatabaseModule,
    TypeOrmModule.forFeature([Listing, C2COrder, Review, Dispute]),
  ],
  controllers: [C2cServiceController],
  providers: [C2cServiceService],
})
export class C2cServiceModule {}
