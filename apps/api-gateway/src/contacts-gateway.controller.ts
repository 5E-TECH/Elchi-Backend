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
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiBody,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import { firstValueFrom, timeout } from 'rxjs';
import { CONTACT_PATTERNS, Roles as RoleEnum } from '@app/common';
import { JwtAuthGuard } from './auth/jwt-auth.guard';
import { Roles } from './auth/roles.decorator';
import { RolesGuard } from './auth/roles.guard';
import { ParseBigintIdPipe } from './pipes/parse-bigint-id.pipe';
import {
  ContactSettingsEnvelopeDto,
  MarketResponsibleBulkEnvelopeDto,
  MarketResponsibleBulkRequestDto,
  MarketResponsibleEnvelopeDto,
  MyContactsEnvelopeDto,
  ResponsiblesEnvelopeDto,
  SetMarketResponsibleRequestDto,
  UpdateContactSettingsRequestDto,
} from './dto/contacts.swagger.dto';

interface JwtUser {
  sub: string;
  roles?: string[];
}

/** identity RPC muddati (boshqa identity yo'llari bilan bir xil). */
const CONTACTS_RPC_TIMEOUT_MS = 8000;
/** Bulk: 500 qator + har biriga jurnal yozuvi. */
const CONTACTS_BULK_TIMEOUT_MS = 20000;

/**
 * T7 (QPq2C1co) «Aloqa raqamlari».
 *
 * Kuryer va filial menejeri marketga to'g'ridan-to'g'ri qo'ng'iroq qilmaydi:
 * ular viloyat logistiga, market — o'z Elchi mas'uliga bog'lanadi.
 *  - Sozlamalar (zaxira raqamlar, sukut mas'ul) va market mas'ullarini
 *    biriktirish — FAQAT SUPERADMIN / ADMIN (aks holda 403; identity ham
 *    qayta tekshiradi).
 *  - `GET /users/me/contacts` — har xodim o'z aloqa kartasini oladi.
 *
 * ⚠️ TARTIB: statik `markets/responsibles`, `markets/responsible/bulk`
 * parametrli `markets/:id/...` dan farq qiladi (segmentlar soni), to'qnashuv
 * yo'q.
 */
@ApiTags('Contacts')
@ApiBearerAuth()
@Controller()
@UseGuards(JwtAuthGuard, RolesGuard)
export class ContactsGatewayController {
  constructor(
    @Inject('IDENTITY') private readonly identityClient: ClientProxy,
  ) {}

  private requester(req: { user: JwtUser }) {
    return { id: String(req?.user?.sub ?? ''), roles: req?.user?.roles ?? [] };
  }

  private send<T = unknown>(
    cmd: string,
    payload: unknown,
    ms = CONTACTS_RPC_TIMEOUT_MS,
  ): Promise<T> {
    return firstValueFrom(
      this.identityClient.send<T>({ cmd }, payload).pipe(timeout(ms)),
    );
  }

  @Get('settings/contacts')
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN)
  @ApiOperation({
    summary: "Aloqa sozlamalari: zaxira raqamlar va sukut market mas'uli",
  })
  @ApiOkResponse({ type: ContactSettingsEnvelopeDto })
  @ApiForbiddenResponse({ description: 'Superadmin/admin emas' })
  getContactSettings(@Req() req: { user: JwtUser }) {
    return this.send(CONTACT_PATTERNS.SETTINGS_GET, {
      requester: this.requester(req),
    });
  }

  @Patch('settings/contacts')
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN)
  @ApiOperation({
    summary: "Aloqa sozlamalarini o'zgartirish",
    description:
      "Bo'sh tana — 400. `support_phones` (0–2) `+998XXXXXXXXX` ga normallanadi, takrorsiz; aks holda 400 `SUPPORT_PHONES_INVALID`. `default_market_responsible_id`: xodim yo'q — 404, rol mos emas — 400 `RESPONSIBLE_ROLE_INVALID`, nofaol — 400 `RESPONSIBLE_INACTIVE`. Javob — GET shakli. Jurnal: `settings.contacts_updated`.",
  })
  @ApiBody({ type: UpdateContactSettingsRequestDto })
  @ApiOkResponse({ type: ContactSettingsEnvelopeDto })
  @ApiBadRequestResponse({
    description:
      "Bo'sh tana / SUPPORT_PHONES_INVALID / RESPONSIBLE_ROLE_INVALID / RESPONSIBLE_INACTIVE",
  })
  @ApiNotFoundResponse({ description: 'Xodim topilmadi' })
  @ApiForbiddenResponse({ description: 'Superadmin/admin emas' })
  updateContactSettings(
    @Req() req: { user: JwtUser },
    @Body() dto: UpdateContactSettingsRequestDto,
  ) {
    return this.send(CONTACT_PATTERNS.SETTINGS_UPDATE, {
      dto: {
        support_phones: dto?.support_phones,
        default_market_responsible_id: dto?.default_market_responsible_id,
      },
      requester: this.requester(req),
    });
  }

  @Get('markets/responsibles')
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN)
  @ApiOperation({
    summary:
      "Market mas'uli nomzodlari (superadmin, admin, registrator, logist)",
    description:
      "`market_count` — xodimga biriktirilgan marketlar (nofaol mas'ul ham sanaladi), `default_market_count` — sukutdagi (biriktirilmagan) marketlar. Ko'pi bilan 200 nomzod.",
  })
  @ApiQuery({ name: 'search', required: false, type: String })
  @ApiOkResponse({ type: ResponsiblesEnvelopeDto })
  @ApiForbiddenResponse({ description: 'Superadmin/admin emas' })
  listResponsibles(
    @Req() req: { user: JwtUser },
    @Query('search') search?: string,
  ) {
    return this.send(CONTACT_PATTERNS.RESPONSIBLES_LIST, {
      search: typeof search === 'string' ? search : undefined,
      requester: this.requester(req),
    });
  }

  @Post('markets/responsible/bulk')
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN)
  @ApiOperation({
    summary: "Marketlarni mas'ulga o'tkazish (yoki sukutga qaytarish)",
    description:
      "`responsible_id: null` — sukutga. Faqat berilgan marketlar o'zgaradi. `moved_from` — boshqa mas'uldan ko'chganlar soni. Jurnal: har market uchun `market.responsible_assigned`.",
  })
  @ApiBody({ type: MarketResponsibleBulkRequestDto })
  @ApiOkResponse({ type: MarketResponsibleBulkEnvelopeDto })
  @ApiBadRequestResponse({
    description:
      'NOT_A_MARKET / RESPONSIBLE_ROLE_INVALID / RESPONSIBLE_INACTIVE',
  })
  @ApiNotFoundResponse({ description: 'Xodim topilmadi' })
  @ApiForbiddenResponse({ description: 'Superadmin/admin emas' })
  bulkAssignResponsible(
    @Req() req: { user: JwtUser },
    @Body() dto: MarketResponsibleBulkRequestDto,
  ) {
    return this.send(
      CONTACT_PATTERNS.RESPONSIBLE_BULK,
      {
        responsible_id: dto.responsible_id,
        market_ids: dto.market_ids,
        requester: this.requester(req),
      },
      CONTACTS_BULK_TIMEOUT_MS,
    );
  }

  @Patch('markets/:id/responsible')
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN)
  @ApiOperation({ summary: "Bitta marketning mas'ulini o'zgartirish" })
  @ApiParam({ name: 'id', description: 'Market ID' })
  @ApiBody({ type: SetMarketResponsibleRequestDto })
  @ApiOkResponse({ type: MarketResponsibleEnvelopeDto })
  @ApiBadRequestResponse({
    description: 'RESPONSIBLE_ROLE_INVALID / RESPONSIBLE_INACTIVE',
  })
  @ApiNotFoundResponse({ description: 'Market yoki xodim topilmadi' })
  @ApiForbiddenResponse({ description: 'Superadmin/admin emas' })
  setMarketResponsible(
    @Req() req: { user: JwtUser },
    @Param('id', ParseBigintIdPipe) id: string,
    @Body() dto: SetMarketResponsibleRequestDto,
  ) {
    return this.send(CONTACT_PATTERNS.RESPONSIBLE_SET, {
      market_id: id,
      responsible_id: dto.responsible_id,
      requester: this.requester(req),
    });
  }

  @Get('users/me/contacts')
  @Roles(
    RoleEnum.SUPERADMIN,
    RoleEnum.ADMIN,
    RoleEnum.REGISTRATOR,
    RoleEnum.LOGIST,
    RoleEnum.MANAGER,
    RoleEnum.BRANCH,
    RoleEnum.COURIER,
    RoleEnum.MARKET,
    RoleEnum.MARKET_OPERATOR,
    RoleEnum.OPERATOR,
    RoleEnum.INVESTOR,
  )
  @ApiOperation({
    summary: "O'z aloqa kartasi («Elchi mas'ulingiz» / «Viloyatingiz logisti»)",
    description:
      "Market / market operatori — Elchi mas'uli (biriktirilgan → sukut → zaxira raqamlar). Kuryer — viloyati logisti (super kuryer — `courier_regions` logistlari, ≤ 5; `serves_all_regions` — zaxira). Menejer / branch — filial viloyati logisti. Logist yo'q/nofaol — zaxira raqamlar (`user_id`/`name`/`role` null); ular ham bo'sh — `contacts: []`, `source: null`. Boshqa rollar — `kind: 'none'`.",
  })
  @ApiOkResponse({ type: MyContactsEnvelopeDto })
  getMyContacts(@Req() req: { user: JwtUser }) {
    return this.send(CONTACT_PATTERNS.MY_CONTACTS, {
      user_id: String(req?.user?.sub ?? ''),
    });
  }
}
