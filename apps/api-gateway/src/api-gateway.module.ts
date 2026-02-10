// import { Module } from '@nestjs/common';
// import { ApiGatewayController } from './api-gateway.controller';
// import { ApiGatewayService } from './api-gateway.service';

// @Module({
//   imports: [],
//   controllers: [ApiGatewayController],
//   providers: [ApiGatewayService],
// })
// export class ApiGatewayModule {}


// apps/api-gateway/src/api-gateway.module.ts
import { Module } from '@nestjs/common';
import { ApiGatewayController } from './api-gateway.controller';
import { ApiGatewayService } from './api-gateway.service';
import { ConfigModule } from '@nestjs/config';
import { RmqModule } from '@app/common';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: './.env',
    }),
    // Gateway USER servisga xabar yuborish huquqini olyapti
    RmqModule.register({ name: 'USER' }), 
  ],
  controllers: [ApiGatewayController],
  providers: [ApiGatewayService],
})
export class ApiGatewayModule {}