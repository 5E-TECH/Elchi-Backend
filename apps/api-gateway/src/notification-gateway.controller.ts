import {
  Body,
  Controller,
  Delete,
  GatewayTimeoutException,
  Get,
  Inject,
  Param,
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
  ApiParam,
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
  FindTelegramMarketsQueryDto,
  SendNotificationRequestDto,
  UpdateTelegramMarketRequestDto,
} from './dto/notification.swagger.dto';

@ApiTags('Notification')
@Controller('notifications')
export class NotificationGatewayController {
  constructor(
    @Inject('NOTIFICATION') private readonly notificationClient: ClientProxy,
  ) {}

  private async send<T = any>(
    pattern: object,
    payload: object,
    timeoutMs = 8000,
  ): Promise<T> {
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

  @Get()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get notification configs' })
  @ApiQuery({ name: 'market_id', required: false })
  @ApiQuery({ name: 'group_type', required: false })
  @ApiQuery({ name: 'is_active', required: false, type: Boolean })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  listNotifications(@Query() query: FindTelegramMarketsQueryDto) {
    return this.send({ cmd: 'notification.telegram.find_all' }, query);
  }

  @Get(':id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get one notification config by id' })
  @ApiParam({ name: 'id', example: '10' })
  findOneNotification(@Param('id') id: string) {
    return this.send({ cmd: 'notification.telegram.find_one' }, { id });
  }

  @Post()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Create notification config' })
  @ApiBody({ type: CreateTelegramMarketRequestDto })
  createNotification(@Body() dto: CreateTelegramMarketRequestDto) {
    return this.send({ cmd: 'notification.telegram.create' }, dto);
  }

  @Patch(':id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Update notification config' })
  @ApiParam({ name: 'id', example: '10' })
  @ApiBody({ type: UpdateTelegramMarketRequestDto })
  updateNotification(
    @Param('id') id: string,
    @Body() dto: UpdateTelegramMarketRequestDto,
  ) {
    return this.send({ cmd: 'notification.telegram.update' }, { ...dto, id });
  }

  @Delete(':id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Delete notification config' })
  @ApiParam({ name: 'id', example: '10' })
  deleteNotification(@Param('id') id: string) {
    return this.send({ cmd: 'notification.telegram.delete' }, { id });
  }

  @Post('connect-by-token')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN, RoleEnum.OPERATOR)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Connect telegram group by group token' })
  @ApiBody({ type: ConnectTelegramByTokenRequestDto })
  connectByToken(@Body() dto: ConnectTelegramByTokenRequestDto) {
    return this.send({ cmd: 'notification.telegram.connect_by_token' }, dto);
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
