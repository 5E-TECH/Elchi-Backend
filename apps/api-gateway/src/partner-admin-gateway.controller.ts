import {
  Body,
  Controller,
  Get,
  Inject,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { firstValueFrom, timeout } from 'rxjs';
import { Roles as RoleEnum } from '@app/common';
import {
  ApiBearerAuth,
  ApiBody,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import { JwtAuthGuard } from './auth/jwt-auth.guard';
import { Roles } from './auth/roles.decorator';
import { RolesGuard } from './auth/roles.guard';
import {
  CreatePartnerRequestDto,
  SetPartnerActiveRequestDto,
  UpdatePartnerRequestDto,
} from './dto/partner.swagger.dto';
import {
  LinkPartnerMarketRequestDto,
  PartnerMarketLinkResponseDto,
  PartnerMarketListResponseDto,
} from './dto/partner-market-admin.swagger.dto';

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
      this.integrationClient
        .send(
          { cmd: 'integration.partner.create' },
          { ...dto, requester: this.auditActor(req) },
        )
        .pipe(timeout(8000)),
    );
  }

  @Get()
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN)
  @ApiOperation({ summary: 'Hamkorlar ro‘yxati (sirlarsiz)' })
  list() {
    return firstValueFrom(
      this.integrationClient
        .send({ cmd: 'integration.partner.list' }, {})
        .pipe(timeout(8000)),
    );
  }

  /**
   * Chiquvchi webhook outbox monitori.
   *
   * Marshrut `:id`li marshrutlardan OLDIN e'lon qilinadi — aks holda
   * `/admin/partners/webhooks` "webhooks" nomli hamkor id'si deb o'qilardi.
   */
  @Get('webhooks')
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN)
  @ApiOperation({
    summary: 'Hamkor webhook outbox jurnali (yetkazilgan/kutilayotgan/xato)',
  })
  @ApiQuery({ name: 'partner_id', required: false })
  @ApiQuery({ name: 'status', required: false })
  @ApiQuery({ name: 'page', required: false })
  @ApiQuery({ name: 'limit', required: false })
  listWebhooks(
    @Query('partner_id') partnerId?: string,
    @Query('status') status?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return firstValueFrom(
      this.integrationClient
        .send(
          { cmd: 'integration.partner.webhook.list' },
          {
            partner_id: partnerId,
            status,
            page: page ? Number(page) : undefined,
            limit: limit ? Number(limit) : undefined,
          },
        )
        .pipe(timeout(8000)),
    );
  }

  @Post('webhooks/:webhookId/retry')
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN)
  @ApiOperation({
    summary:
      "Muvaffaqiyatsiz webhookni qayta navbatga qo'yish va darhol urinib ko'rish",
  })
  @ApiParam({ name: 'webhookId' })
  retryWebhook(
    @Param('webhookId') webhookId: string,
    @Req() req: { user?: { sub?: string; roles?: string[] } },
  ) {
    return firstValueFrom(
      this.integrationClient
        .send(
          { cmd: 'integration.partner.webhook.retry' },
          { id: webhookId, requester: this.auditActor(req) },
        )
        .pipe(timeout(20000)),
    );
  }

  /**
   * SINOV WEBHOOKI.
   *
   * Webhook zanjiri uch narsaga bog'liq: manzil yetib boradimi, imzo mos
   * keladimi, qabul qiluvchi 2xx qaytaradimi. Ilgari bularni bilish uchun
   * HAQIQIY sotuvni kutish kerak edi — xato bo'lsa o'sha buyurtmaning
   * hodisasi yo'qolardi. Bu marshrut sinxron tekshiradi va to'liq
   * diagnostika qaytaradi; outbox'ga qator YOZILMAYDI.
   */
  /**
   * Hamkordan kelgan posilkalar bog'lanishi.
   *
   * ⚠️ RO'YXAT YUPQA: bog'lanish bor (ularning buyurtma raqami ↔ bizning
   * buyurtma id'si), status va summa YO'Q. Ular buyurtmaning o'zida, boshqa
   * sxemada — bu yerda qo'shish har qator uchun alohida so'rov (N+1) talab
   * qilardi. UI har qatordan buyurtma sahifasiga havola qiladi.
   *
   * ⚠️ `:id/shipments` `webhooks` dan KEYIN e'lon qilinadi, lekin
   * to'qnashmaydi: `webhooks` bir segmentli literal, bu ikki segmentli.
   */
  @Get(':id/shipments')
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN)
  @ApiOperation({
    summary: "Hamkordan kelgan posilkalar (buyurtma bog'lanishi)",
  })
  @ApiParam({ name: 'id' })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  listPartnerShipments(
    @Param('id') id: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return firstValueFrom(
      this.integrationClient
        .send(
          { cmd: 'integration.partner.shipment.list' },
          {
            partner_id: id,
            page: page ? Number(page) : undefined,
            limit: limit ? Number(limit) : undefined,
          },
        )
        .pipe(timeout(8000)),
    );
  }

  /**
   * T1 K1 (s6xY4f5C) — hamkorning faol sotuvchilari (`partner_market_refs`).
   * Yangi → eski; sahifalashsiz. Market topilmasa maydonlari `null`.
   */
  @Get(':id/markets')
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN)
  @ApiOperation({
    summary: 'Hamkor sotuvchilari (bog‘langan Elchi marketlari)',
  })
  @ApiParam({ name: 'id' })
  @ApiOkResponse({ type: PartnerMarketListResponseDto })
  @ApiNotFoundResponse({ description: 'Hamkor topilmadi' })
  listMarkets(@Param('id') id: string) {
    return firstValueFrom(
      this.integrationClient
        .send({ cmd: 'integration.partner.markets.list' }, { partner_id: id })
        .pipe(timeout(10000)),
    );
  }

  /**
   * T1 K1 — hamkor sotuvchisini Elchi'dagi MAVJUD marketga bog'lash.
   * Keyin hamkorning `POST /partner/markets` chaqiruvi idempotent (200),
   * `POST /partner/shipments` esa shu marketga ruxsat beradi.
   */
  @Post(':id/markets')
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN)
  @ApiOperation({
    summary:
      'Hamkor sotuvchisini mavjud Elchi marketiga bog‘lash. Market tarifi ' +
      'o‘zgarmaydi. O‘chirilgan bog‘lanish bo‘lsa — tiklanadi.',
  })
  @ApiParam({ name: 'id' })
  @ApiBody({ type: LinkPartnerMarketRequestDto })
  @ApiCreatedResponse({ type: PartnerMarketLinkResponseDto })
  @ApiNotFoundResponse({
    description: 'Hamkor yoki market topilmadi (o‘chirilgan / market emas)',
  })
  @ApiConflictResponse({
    description:
      '`code`: PARTNER_SELLER_TAKEN — sotuvchi shu hamkorda bog‘langan; ' +
      'PARTNER_MARKET_TAKEN — market boshqa hamkorga bog‘langan',
  })
  linkMarket(
    @Param('id') id: string,
    @Body() dto: LinkPartnerMarketRequestDto,
    @Req() req: { user?: { sub?: string; roles?: string[] } },
  ) {
    return firstValueFrom(
      this.integrationClient
        .send(
          { cmd: 'integration.partner.markets.link' },
          {
            partner_id: id,
            external_seller_id: dto.external_seller_id,
            elchi_market_id: dto.elchi_market_id,
            requester: this.auditActor(req),
          },
        )
        .pipe(timeout(15000)),
    );
  }

  @Post(':id/webhook-test')
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN)
  @ApiOperation({
    summary:
      'Sinov webhookini yuborish — haqiqiy buyurtmaga tegmaydi. ' +
      '`url` berilsa saqlangan manzildan ustun turadi (saqlashdan OLDIN sinash). ' +
      "`target: 'main'|'sandbox'` — qaysi manzil/sekret; berilmasa sandbox yoqiq va " +
      "manzili bo'lsa sandbox, aks holda asosiy (jeU3eztP).",
  })
  @ApiOkResponse({
    description:
      '{ ok, url, target, secret_used, http_status, duration_ms, response_body, ' +
      'error, signature_sent, secret_configured, event_id }',
  })
  @ApiParam({ name: 'id' })
  testWebhook(
    @Param('id') id: string,
    @Body() body: { url?: string | null; target?: 'main' | 'sandbox' | null },
    @Req() req: { user?: { sub?: string; roles?: string[] } },
  ) {
    // Sinov TASHQI so'rov qiladi (15s timeout) — gateway kutishi undan
    // uzunroq bo'lishi kerak, aks holda natija o'qilmay qoladi.
    // (Izoh `.send()` va `.pipe()` ORASIGA qo'yilmaydi: `gateway-rpc-timeout`
    // darvozasi matn bo'yicha tekshiradi va oraliqdagi izoh uni chalg'itadi.)
    return firstValueFrom(
      this.integrationClient
        .send(
          { cmd: 'integration.partner.webhook.test' },
          {
            id,
            url: body?.url ?? null,
            target: body?.target ?? null,
            requester: this.auditActor(req),
          },
        )
        .pipe(timeout(25000)),
    );
  }

  @Patch(':id')
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN)
  @ApiOperation({
    summary:
      'Hamkor sozlamalari: webhook manzili/sekreti, SANDBOX manzili, ' +
      "IP ro'yxati, nom. API kalit BU YERDA o‘zgarmaydi — buning uchun " +
      'rotate-key bor. `webhook_url` qo‘yilganda sozlama yo‘qligi tufayli ' +
      'kutib turgan hodisalar avtomatik navbatga qaytariladi ' +
      '(`requeued_webhooks`).',
  })
  @ApiParam({ name: 'id' })
  @ApiBody({ type: UpdatePartnerRequestDto })
  update(
    @Param('id') id: string,
    @Body() dto: UpdatePartnerRequestDto,
    @Req() req: { user?: { sub?: string; roles?: string[] } },
  ) {
    return firstValueFrom(
      this.integrationClient
        .send(
          { cmd: 'integration.partner.update' },
          { id, ...dto, requester: this.auditActor(req) },
        )
        .pipe(timeout(8000)),
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
      this.integrationClient
        .send(
          { cmd: 'integration.partner.rotate_key' },
          { id, requester: this.auditActor(req) },
        )
        .pipe(timeout(8000)),
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
      this.integrationClient
        .send(
          { cmd: 'integration.partner.set_active' },
          { id, is_active: dto.is_active, requester: this.auditActor(req) },
        )
        .pipe(timeout(8000)),
    );
  }
}
