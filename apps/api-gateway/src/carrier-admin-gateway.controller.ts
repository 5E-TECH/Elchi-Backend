import {
  Body,
  Controller,
  Get,
  Inject,
  Param,
  Patch,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { firstValueFrom, timeout } from 'rxjs';
import { Roles as RoleEnum } from '@app/common';
import {
  ApiBearerAuth,
  ApiBody,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import { JwtAuthGuard } from './auth/jwt-auth.guard';
import { Roles } from './auth/roles.decorator';
import { RolesGuard } from './auth/roles.guard';
import {
  CreateCarrierAccountRequestDto,
  SetCarrierActiveRequestDto,
  UpdateCarrierAccountRequestDto,
} from './dto/carrier.swagger.dto';

type AdminRequest = { user?: { sub?: string; roles?: string[] } };

/**
 * create / rotate-key / status(true): integration identity tekshiruvi
 * ≤ 6.5 s (`IDENTITY_ADMIN_OPTS.deadlineMs`) + DB. Bir martalik kalit javobi
 * yo'qolmasligi uchun (rotate'da eski kalit allaqachon o'chgan bo'ladi)
 * gateway ancha uzoqroq kutadi.
 */
const CARRIER_IDENTITY_TIMEOUT_MS = 20000;

/**
 * Carrier API akkauntlarini boshqarish (admin) — tashqi yetkazuvchi
 * kompaniyaga kurier akkaunti va `X-Api-Key` berish.
 *
 * Bu `/carrier/*` EMAS: bu yerga Elchi adminlari JWT bilan kiradi. Logika
 * integration-service'da (`CarrierAccountService`): kalit hash, kurier
 * tekshiruvi (role = courier, faol), har amal activity-log.
 * Kontrakt va onboarding: docs/public/CARRIER_API.md. Yashirin rollback
 * toggle'i (`rollback_enabled`, faqat shu yerda): docs/ops/carrier-rollback.md.
 */
@ApiTags('Carriers (admin)')
@ApiBearerAuth()
@Controller('admin/carriers')
@UseGuards(JwtAuthGuard, RolesGuard)
export class CarrierAdminGatewayController {
  constructor(
    @Inject('INTEGRATION') private readonly integrationClient: ClientProxy,
  ) {}

  private auditActor(req: AdminRequest) {
    return { id: req.user?.sub ?? null, roles: req.user?.roles ?? [] };
  }

  @Post()
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN)
  @ApiOperation({
    summary:
      'Carrier akkaunt yaratish — kurierga bog‘lanadi, API kalit BIR MARTA qaytadi',
  })
  @ApiBody({ type: CreateCarrierAccountRequestDto })
  create(
    @Body() dto: CreateCarrierAccountRequestDto,
    @Req() req: AdminRequest,
  ) {
    return firstValueFrom(
      this.integrationClient
        .send(
          { cmd: 'integration.carrier.create' },
          { ...dto, requester: this.auditActor(req) },
        )
        .pipe(timeout(CARRIER_IDENTITY_TIMEOUT_MS)),
    );
  }

  @Get()
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN)
  @ApiOperation({ summary: 'Carrier akkauntlar ro‘yxati (kalitsiz)' })
  list() {
    return firstValueFrom(
      this.integrationClient
        .send({ cmd: 'integration.carrier.list' }, {})
        .pipe(timeout(8000)),
    );
  }

  @Patch(':id')
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN)
  @ApiOperation({
    summary:
      'Nom, IP ro‘yxati va rollback ruxsatini yangilash. Kurier va kalit bu yerda o‘zgarmaydi.',
    description:
      '`rollback_enabled` (ixtiyoriy, alohida yoki name/ip_allowlist bilan birga) — kompaniya ' +
      '`status: rollback` yubora oladimi; sukut false, keyingi so‘rovdan kuchga kiradi, ' +
      'activity-log’ga eski → yangi qiymat yoziladi. Kompaniyaga berilgan hujjatda rollback ' +
      'YASHIRIN — yoqishdan oldin docs/ops/carrier-rollback.md.',
  })
  @ApiParam({ name: 'id' })
  @ApiBody({ type: UpdateCarrierAccountRequestDto })
  update(
    @Param('id') id: string,
    @Body() dto: UpdateCarrierAccountRequestDto,
    @Req() req: AdminRequest,
  ) {
    return firstValueFrom(
      this.integrationClient
        .send(
          { cmd: 'integration.carrier.update' },
          { id, ...dto, requester: this.auditActor(req) },
        )
        .pipe(timeout(8000)),
    );
  }

  @Post(':id/rotate-key')
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN)
  @ApiOperation({ summary: 'API kalitni yangilash (eski darhol ishlamaydi)' })
  @ApiParam({ name: 'id' })
  rotateKey(@Param('id') id: string, @Req() req: AdminRequest) {
    return firstValueFrom(
      this.integrationClient
        .send(
          { cmd: 'integration.carrier.rotate_key' },
          { id, requester: this.auditActor(req) },
        )
        .pipe(timeout(CARRIER_IDENTITY_TIMEOUT_MS)),
    );
  }

  @Post(':id/status')
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN)
  @ApiOperation({ summary: 'Carrier akkauntni faollashtirish/o‘chirish' })
  @ApiParam({ name: 'id' })
  @ApiBody({ type: SetCarrierActiveRequestDto })
  setActive(
    @Param('id') id: string,
    @Body() dto: SetCarrierActiveRequestDto,
    @Req() req: AdminRequest,
  ) {
    return firstValueFrom(
      this.integrationClient
        .send(
          { cmd: 'integration.carrier.set_active' },
          { id, is_active: dto.is_active, requester: this.auditActor(req) },
        )
        .pipe(timeout(CARRIER_IDENTITY_TIMEOUT_MS)),
    );
  }
}
