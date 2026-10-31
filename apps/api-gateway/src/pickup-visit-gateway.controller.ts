import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  GatewayTimeoutException,
  Get,
  Headers,
  Inject,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiExtraModels,
  ApiHeader,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { firstValueFrom, timeout, TimeoutError } from 'rxjs';
import { Roles as RoleEnum } from '@app/common';
import { JwtAuthGuard } from './auth/jwt-auth.guard';
import { Roles } from './auth/roles.decorator';
import { RolesGuard } from './auth/roles.guard';
import {
  CreatePickupVisitRequestDto,
  FindPickupVisitsQueryDto,
  PickupVisitCreatedDto,
  PickupVisitListDto,
} from './dto/pickup-visit.swagger.dto';

interface JwtUser {
  sub: string;
  roles?: string[];
}

/** Tashrifni qayd qiladigan xodimlar (market qarzini oshiradi). */
export const PICKUP_VISIT_WRITE_ROLES = [
  RoleEnum.SUPERADMIN,
  RoleEnum.ADMIN,
  RoleEnum.REGISTRATOR,
] as const;

const RPC_TIMEOUT_MS = 8000;

/**
 * B824gOu5 — kuryer chaqiruvi (pickup) tashrifi.
 *
 * Summa va chegara har so'rovda logistics sozlamasidan
 * (`delivery_pricing_settings.pickup_fee`, `pickup_free_from_count`) olinadi va
 * finance-service'ga server tomondan uzatiladi: klient yubora olmaydi, kodda
 * yo'q. Hisob finance'da (`computePickupFee`). `Idempotency-Key` majburiy.
 */
@ApiTags('Finance')
@ApiExtraModels(PickupVisitCreatedDto, PickupVisitListDto)
@Controller('finance/pickup-visits')
export class PickupVisitGatewayController {
  constructor(
    @Inject('FINANCE') private readonly financeClient: ClientProxy,
    @Inject('LOGISTICS') private readonly logisticsClient: ClientProxy,
    @Inject('IDENTITY') private readonly identityClient: ClientProxy,
  ) {}

  private send<T = unknown>(
    client: ClientProxy,
    cmd: string,
    payload: object,
  ): Promise<T> {
    return firstValueFrom(
      client.send<T>({ cmd }, payload).pipe(timeout(RPC_TIMEOUT_MS)),
    ).catch((error: unknown) => {
      if (error instanceof TimeoutError) {
        throw new GatewayTimeoutException(
          'Xizmat vaqtida javob bermadi (timeout)',
        );
      }
      throw error;
    });
  }

  /** `courier_id` haqiqatan kuryer foydalanuvchimi. */
  private async assertCourier(courierId: string): Promise<void> {
    const res = await this.send<{
      data?: { role?: unknown; roles?: unknown };
    }>(this.identityClient, 'identity.user.find_by_id', { id: courierId });
    const user = res?.data;
    const roles = Array.isArray(user?.roles) ? user.roles : [user?.role];
    if (!roles.some((role) => role === RoleEnum.COURIER)) {
      throw new BadRequestException('courier_id kuryerga tegishli emas');
    }
  }

  @Post()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(...PICKUP_VISIT_WRITE_ROLES)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Pickup tashrifini qayd qilish',
    description:
      "Bitta tashrif — bitta yozuv. 1…(`pickup_free_from_count` − 1) posilka → `pickup_fee` market qarzini oshiradi (market kassasida `source_type=pickup_fee` chiqim, P&L daftarida kirim), `pickup_free_from_count` va undan ko'p → `fee: 0`, `is_free: true` (yozuv baribir yaratiladi). Buyurtma narxi va settlement'iga tegmaydi. " +
      "Ayni `Idempotency-Key` bilan takror — 200 va o'sha yozuv (`idempotent: true`); ayni kalit boshqa tashrif bilan — 409.",
  })
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  @ApiCreatedResponse({ type: PickupVisitCreatedDto })
  async create(
    @Body() dto: CreatePickupVisitRequestDto,
    @Req() req: { user: JwtUser },
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    const key = String(idempotencyKey ?? '').trim();
    if (!key || key.length > 255) {
      throw new BadRequestException(
        'Idempotency-Key sarlavhasi majburiy (1-255 belgi)',
      );
    }
    await this.assertCourier(dto.courier_id);
    const settings = await this.send<{
      data?: { pickup_fee?: unknown; pickup_free_from_count?: unknown };
    }>(this.logisticsClient, 'logistics.delivery.settings.get', {});
    return this.send(this.financeClient, 'finance.pickup_visit.record', {
      market_id: dto.market_id,
      courier_id: dto.courier_id,
      parcel_count: dto.parcel_count,
      occurred_at: dto.occurred_at,
      idempotency_key: key,
      created_by: String(req.user.sub),
      settings: {
        pickup_fee: settings?.data?.pickup_fee,
        pickup_free_from_count: settings?.data?.pickup_free_from_count,
      },
    });
  }

  @Get()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(...PICKUP_VISIT_WRITE_ROLES, RoleEnum.MARKET)
  @ApiBearerAuth()
  @ApiOperation({
    summary: "Pickup tashriflari ro'yxati",
    description:
      "Yangisi tepada; `summary` — AYNI filtr bo'yicha: daromad, pullik va tekin tashriflar soni, posilkalar. MARKET — faqat o'zi.",
  })
  @ApiOkResponse({ type: PickupVisitListDto })
  findAll(
    @Query() query: FindPickupVisitsQueryDto,
    @Req() req: { user: JwtUser },
  ) {
    const roles = req.user.roles ?? [];
    const isStaff = PICKUP_VISIT_WRITE_ROLES.some((role) =>
      roles.includes(role),
    );
    const own = String(req.user.sub);
    if (!isStaff && query.market_id && query.market_id !== own) {
      throw new ForbiddenException('Boshqa market tashriflari yopiq');
    }
    return this.send(this.financeClient, 'finance.pickup_visit.find_all', {
      ...query,
      market_id: isStaff ? query.market_id : own,
    });
  }
}
