import { Controller, Get, Inject } from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';

@Controller()
export class ApiGatewayController {
  constructor(@Inject('USER') private userClient: ClientProxy) {}

  @Get()
  getHello() {
    // Gatewaydan turib User servisga xabar yuboramiz
    return this.userClient.send({ cmd: 'salom_ber' }, {});
  }
  
}