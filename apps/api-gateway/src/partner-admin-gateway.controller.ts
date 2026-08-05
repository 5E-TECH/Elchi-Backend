import {
  Body,
  Controller,
  Get,
  Inject,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { firstValueFrom } from 'rxjs';
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
  CreatePartnerRequestDto,
  SetPartnerActiveRequestDto,
} from './dto/partner.swagger.dto';

/**
 * Elchi Partner API hamkorlarini boshqarish (admin). Bu — hamkor kaliti bilan
 * kiriladigan `/partner/*` EMAS: bu Elchi adminlari hamkor yaratadigan,
 * kalitini rotate qiladigan, faollashtiradigan JWT+rol bilan himoyalangan panel.
 * Haqiqiy logika integration-service'da; kalit hash, secret AES, har amal
 * activity-log. Kontrakt: docs/PARTNER_API.md §7.3.
 */
@ApiTags('Partners (admin)')
@ApiBearerAuth()
@Controller('admin/partners')
@UseGuards(JwtAuthGuard, RolesGuard)
export class PartnerAdminGatewayController {
  constructor(
    @Inject('INTEGRATION') private readonly integrationClient: ClientProxy,
  ) {}

  /** Yozuv amallari uchun audit aktori (JWT'dan). */
  private auditActor(req: { user?: { sub?: string; roles?: string[] } }) {
    return { id: req.user?.sub ?? null, roles: req.user?.roles ?? [] };
  }

  @Post()
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN)
  @ApiOperation({ summary: 'Hamkor yaratish (API kalit BIR MARTA qaytadi)' })
  @ApiBody({ type: CreatePartnerRequestDto })
  create(
    @Body() dto: CreatePartnerRequestDto,
    @Req() req: { user?: { sub?: string; roles?: string[] } },
  ) {
    return firstValueFrom(
      this.integrationClient.send(
        { cmd: 'integration.partner.create' },
        { ...dto, requester: this.auditActor(req) },
      ),
    );
  }

  @Get()
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN)
  @ApiOperation({ summary: 'Hamkorlar ro‘yxati (sirlarsiz)' })
  list() {
    return firstValueFrom(
      this.integrationClient.send({ cmd: 'integration.partner.list' }, {}),
    );
  }

  @Post(':id/rotate-key')
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN)
  @ApiOperation({ summary: 'API kalitni yangilash (eski darhol ishlamaydi)' })
  @ApiParam({ name: 'id' })
  rotateKey(
    @Param('id') id: string,
    @Req() req: { user?: { sub?: string; roles?: string[] } },
  ) {
    return firstValueFrom(
      this.integrationClient.send(
        { cmd: 'integration.partner.rotate_key' },
        { id, requester: this.auditActor(req) },
      ),
    );
  }

  @Post(':id/status')
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN)
  @ApiOperation({ summary: 'Hamkorni faollashtirish/o‘chirish' })
  @ApiParam({ name: 'id' })
  @ApiBody({ type: SetPartnerActiveRequestDto })
  setActive(
    @Param('id') id: string,
    @Body() dto: SetPartnerActiveRequestDto,
    @Req() req: { user?: { sub?: string; roles?: string[] } },
  ) {
    return firstValueFrom(
      this.integrationClient.send(
        { cmd: 'integration.partner.set_active' },
        { id, is_active: dto.is_active, requester: this.auditActor(req) },
      ),
    );
  }
}
