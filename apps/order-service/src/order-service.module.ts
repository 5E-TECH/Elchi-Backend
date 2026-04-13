import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { OrderServiceController } from './order-service.controller';
import { OrderServiceService } from './order-service.service';
import { RmqModule, DatabaseModule, orderValidationSchema } from '@app/common';
import { Order } from './entities/order.entity';
import { OrderItem } from './entities/order-item.entity';
import { OrderTracking } from './entities/order-tracking.entity';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: './.env',
      validationSchema: orderValidationSchema,
    }),
    RmqModule,
    RmqModule.register({ name: 'SEARCH' }),
    RmqModule.register({ name: 'IDENTITY' }),
    RmqModule.register({ name: 'LOGISTICS' }),
    RmqModule.register({ name: 'CATALOG' }),
    RmqModule.register({ name: 'FINANCE' }),
    RmqModule.register({ name: 'INTEGRATION' }),
    DatabaseModule,
    TypeOrmModule.forFeature([Order, OrderItem, OrderTracking]),
  ],
  controllers: [OrderServiceController],
  providers: [OrderServiceService],
})
export class OrderServiceModule {}
