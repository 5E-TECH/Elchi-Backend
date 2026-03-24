import {
  Body,
  Controller,
  Delete,
  GatewayTimeoutException,
  Get,
  Inject,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import {
  ApiBearerAuth,
  ApiBody,
  ApiOperation,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import { firstValueFrom, TimeoutError, timeout } from 'rxjs';
import { Roles } from './auth/roles.decorator';
import { JwtAuthGuard } from './auth/jwt-auth.guard';
import { RolesGuard } from './auth/roles.guard';
import { Roles as RoleEnum } from '@app/common';
import {
  ConnectTelegramByTokenRequestDto,
  CreateTelegramMarketRequestDto,
  DeleteTelegramMarketRequestDto,
  FindTelegramMarketsQueryDto,
  SendNotificationRequestDto,
  UpdateTelegramMarketRequestDto,
} from './dto/notification.swagger.dto';

@ApiTags('Notification')
@Controller('notification')
export class NotificationGatewayController {
  constructor(@Inject('NOTIFICATION') private readonly notificationClient: ClientProxy) {}

  private async send<T = any>(pattern: object, payload: object, timeoutMs = 8000): Promise<T> {
    return firstValueFrom(
      this.notificationClient.send(pattern, payload).pipe(timeout(timeoutMs)),
    ).catch((error: unknown) => {
      if (error instanceof TimeoutError) {
        throw new GatewayTimeoutException('Notification service response timeout');
      }
      throw error;
    });
  }

  @Get('health')
  @ApiOperation({ summary: 'Notification service health check' })
  health() {
    return this.send({ cmd: 'notification.health' }, {});
  }

  @Post('telegram')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Create telegram market config' })
  @ApiBody({ type: CreateTelegramMarketRequestDto })
  createTelegramMarket(@Body() dto: CreateTelegramMarketRequestDto) {
    return this.send({ cmd: 'notification.telegram.create' }, dto);
  }

  @Get('telegram')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Find telegram market configs' })
  @ApiQuery({ name: 'market_id', required: false })
  @ApiQuery({ name: 'group_type', required: false })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  findAllTelegramMarkets(@Query() query: FindTelegramMarketsQueryDto) {
    return this.send({ cmd: 'notification.telegram.find_all' }, query);
  }

  @Patch('telegram')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Update telegram market config' })
  @ApiBody({ type: UpdateTelegramMarketRequestDto })
  updateTelegramMarket(@Body() dto: UpdateTelegramMarketRequestDto) {
    return this.send({ cmd: 'notification.telegram.update' }, dto);
  }

  @Post('telegram/connect-by-token')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN, RoleEnum.OPERATOR)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Connect telegram group by group_token text' })
  @ApiBody({ type: ConnectTelegramByTokenRequestDto })
  connectByToken(@Body() dto: ConnectTelegramByTokenRequestDto) {
    return this.send({ cmd: 'notification.telegram.connect_by_token' }, dto);
  }

  @Delete('telegram')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Delete telegram market config' })
  @ApiBody({ type: DeleteTelegramMarketRequestDto })
  deleteTelegramMarket(@Body() dto: DeleteTelegramMarketRequestDto) {
    return this.send({ cmd: 'notification.telegram.delete' }, dto);
  }

  @Post('send')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN, RoleEnum.OPERATOR)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Send notification to telegram group(s)' })
  @ApiBody({ type: SendNotificationRequestDto })
  sendNotification(@Body() dto: SendNotificationRequestDto) {
    return this.send({ cmd: 'notification.send' }, dto);
  }
}
