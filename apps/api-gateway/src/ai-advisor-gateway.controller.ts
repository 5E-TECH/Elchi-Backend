import {
  BadRequestException,
  Body,
  Controller,
  GatewayTimeoutException,
  Get,
  Inject,
  Param,
  Patch,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import {
  ApiBearerAuth,
  ApiBody,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import { firstValueFrom, TimeoutError, timeout } from 'rxjs';
import {
  AI_ADVISOR_PATTERNS,
  RMQ_GATEWAY_TIMEOUT,
  Roles as RoleEnum,
  requestContext,
  type AiAdvisorRequester,
} from '@app/common';
import { JwtAuthGuard } from './auth/jwt-auth.guard';
import { Roles } from './auth/roles.decorator';
import { RolesGuard } from './auth/roles.guard';
import {
  AiAdvisorAlertGetQueryDto,
  AiAdvisorAlertPatchDto,
  AiAdvisorAlertsQueryDto,
  AiAdvisorSettingsPatchDto,
} from './dto/ai-advisor.dto';

interface AuthedRequest {
  user?: { sub?: string | number; roles?: unknown[] };
}

/**
 * BE-5 (LhTIno57) — AI maslahatchi: ogohlantirishlar R1–R8. API shartnomasi
 * v0.3. FAQAT superadmin (ega qarori 1) — ADMIN ham 403. Barcha ish
 * ai-service'da; ai-service rolni qayta tekshiradi.
 *
 * ⚠️ `ai.*` RPC'lar qayta yuborilmaydi, har biri `RMQ_GATEWAY_TIMEOUT`
 * (8 s) bilan; timeout → 504. ai-service javobi (`successRes` konverti)
 * o'zgarishsiz qaytariladi; kodli xatolar (`AI_ADVISOR_*`) filtr orqali.
 */
@ApiTags('AI advisor')
@ApiBearerAuth()
@Controller('ai/advisor')
@UseGuards(JwtAuthGuard, RolesGuard)
export class AiAdvisorGatewayController {
  constructor(@Inject('AI') private readonly aiClient: ClientProxy) {}

  @Get('overview')
  @Roles(RoleEnum.SUPERADMIN)
  @ApiOperation({
    summary: 'AI maslahatchi: tab nishonlari va banner (faqat superadmin)',
    description:
      '`data` = `{alerts{new, open, critical, critical_open, critical_rule_keys[], critical_open_rule_keys[]}, recommendations, budget, usd_uzs_rate, generated_at}`. ' +
      '`critical` = jiddiy VA `new`; `critical_rule_keys` — ayni to‘plam, `MAX(last_at) DESC`. `open` — filtrsiz new+seen. ' +
      '`recommendations`, `budget`, `usd_uzs_rate` — BE-4/BE-1, hozircha null.',
  })
  overview(@Req() req: AuthedRequest): Promise<unknown> {
    return this.call(AI_ADVISOR_PATTERNS.OVERVIEW, {
      requester: this.requester(req),
    });
  }

  @Get('alerts')
  @Roles(RoleEnum.SUPERADMIN)
  @ApiOperation({
    summary: 'AI maslahatchi: ogohlantirishlar ro‘yxati (faqat superadmin)',
    description:
      'Holatni O‘ZGARTIRMAYDI. `data` = `{items[AiAdvisorAlertListItem], meta{page, limit, total, totalPages}, counts{by_status{new, seen, resolved, dismissed}}}`. ' +
      '`counts.by_status` — `status` filtrisiz, qolgan filtrlar bilan. Saralash oxirida doim `id DESC`. ' +
      'Noto‘g‘ri query — kodsiz 400.',
  })
  listAlerts(
    @Query() query: AiAdvisorAlertsQueryDto,
    @Req() req: AuthedRequest,
  ): Promise<unknown> {
    return this.call(AI_ADVISOR_PATTERNS.ALERTS_LIST, {
      requester: this.requester(req),
      query: { ...query },
    });
  }

  @Get('alerts/:id')
  @Roles(RoleEnum.SUPERADMIN)
  @ApiParam({
    name: 'id',
    description: 'Ogohlantirish ID si',
    schema: { type: 'string', pattern: '^\\d{1,18}$' },
  })
  @ApiOperation({
    summary:
      'AI maslahatchi: ogohlantirish tafsiloti — ochilganda «Ko‘rildi» (faqat superadmin)',
    description:
      '`new` bo‘lsa atomik `new → seen` (`seen_at`, `seen_by`), javob yangi holat bilan; boshqa holatga tegmaydi; audit yo‘q. ' +
      '⚠️ Prefetch/hover’da YUBORILMASIN. `?include=history` — `history[]` (≤ 50). ' +
      '`explanation_status=pending` bo‘lsa `explanation_poll_after_ms` oralig‘ida qayta so‘rang; 3 daqiqadan eski `pending` — `failed` + `error`. ' +
      'Xatolar: 404 `AI_ADVISOR_ALERT_NOT_FOUND`, 400 (ID, kodsiz).',
  })
  getAlert(
    @Param('id') id: string,
    @Query() query: AiAdvisorAlertGetQueryDto,
    @Req() req: AuthedRequest,
  ): Promise<unknown> {
    return this.call(AI_ADVISOR_PATTERNS.ALERTS_GET, {
      requester: this.requester(req),
      id: this.alertId(id),
      mark_seen: true,
      include: query?.include ? [query.include] : [],
    });
  }

  @Patch('alerts/:id')
  @Roles(RoleEnum.SUPERADMIN)
  @ApiParam({
    name: 'id',
    description: 'Ogohlantirish ID si',
    schema: { type: 'string', pattern: '^\\d{1,18}$' },
  })
  @ApiOperation({
    summary:
      'AI maslahatchi: «Hal qilindi» / «Ahamiyatsiz» (faqat superadmin, audit)',
    description:
      'Faqat `new|seen` dan. `resolved` — `note` majburiy 3–500 (trim), `dismissed` — ixtiyoriy ≤ 500. ' +
      'Idempotent: ayni foydalanuvchi ayni holatni qayta yuborsa — 200, o‘zgarishsiz. Javob — yangilangan tafsilot. ' +
      'Xatolar: 400 `AI_ADVISOR_NOTE_INVALID {reason: required|too_short|too_long, min_length, max_length}`; 400 kodsiz (`status`); ' +
      '404 `AI_ADVISOR_ALERT_NOT_FOUND`; 409 `AI_ADVISOR_ALERT_CLOSED {alert_status}`. Audit `ai.advisor.alert.resolve|dismiss`. Pul amali yo‘q.',
  })
  @ApiBody({ type: AiAdvisorAlertPatchDto })
  updateAlert(
    @Param('id') id: string,
    @Body() dto: AiAdvisorAlertPatchDto,
    @Req() req: AuthedRequest,
  ): Promise<unknown> {
    return this.call(AI_ADVISOR_PATTERNS.ALERTS_UPDATE, {
      requester: this.requester(req),
      id: this.alertId(id),
      status: dto.status,
      note: dto.note ?? null,
    });
  }

  @Get('settings')
  @Roles(RoleEnum.SUPERADMIN)
  @ApiOperation({
    summary: 'AI maslahatchi: sozlamalar — qoidalar R1–R8 (faqat superadmin)',
    description:
      '`data` = `{version, rules{R1..R8: {enabled, severity, telegram, <chegaralar>}}, limits{rules{<R>{<maydon>{min, max, step, unit, default}}}}, ' +
      'telegram, budget, schedule, updated_at, updated_by{id, name}}`. `severity` — qotirilgan (R2, R6, R7 critical; qolgani warning). ' +
      '`telegram`/`budget`/`schedule` — BE-1, hozircha null. Qator yo‘q — `version: 1` va sukutlar.',
  })
  getSettings(@Req() req: AuthedRequest): Promise<unknown> {
    return this.call(AI_ADVISOR_PATTERNS.SETTINGS_GET, {
      requester: this.requester(req),
    });
  }

  @Patch('settings')
  @Roles(RoleEnum.SUPERADMIN)
  @ApiOperation({
    summary:
      'AI maslahatchi: sozlamalarni o‘zgartirish (faqat superadmin, audit)',
    description:
      'Qisman (deep merge), hammasi yoki hech narsa; `version` MAJBURIY. Xatolar: 400 `AI_ADVISOR_INVALID_RULE {field, min, max}`; ' +
      '400 `AI_ADVISOR_INVALID_SETTING {field}` (noma’lum kalit, `version` yo‘q, `severity`, `telegram`/`budget`/`schedule`); ' +
      '409 `AI_ADVISOR_SETTINGS_CONFLICT {version}`. O‘zgarish keyingi tekshiruvdan qo‘llanadi. Javob — to‘liq sozlamalar. ' +
      'Audit `ai.advisor.settings.update` (eski → yangi). O‘zgarishsiz PATCH — `version` oshmaydi.',
  })
  @ApiBody({ type: AiAdvisorSettingsPatchDto })
  updateSettings(
    @Body() dto: AiAdvisorSettingsPatchDto,
    @Req() req: AuthedRequest,
  ): Promise<unknown> {
    return this.call(AI_ADVISOR_PATTERNS.SETTINGS_UPDATE, {
      requester: this.requester(req),
      patch: { ...dto },
    });
  }

  // ─── Yordamchilar ───────────────────────────────────────────────────────

  private alertId(id: string): string {
    if (!/^\d{1,18}$/.test(String(id ?? ''))) {
      throw new BadRequestException("Ogohlantirish ID si noto'g'ri");
    }
    return String(id);
  }

  private requester(req: AuthedRequest): AiAdvisorRequester {
    const roles = Array.isArray(req?.user?.roles)
      ? req.user.roles
          .map((r) => (typeof r === 'string' ? r.trim().toLowerCase() : ''))
          .filter(Boolean)
      : [];
    return {
      id: String(req?.user?.sub ?? ''),
      roles,
      name: requestContext.get()?.userName ?? null,
    };
  }

  private async call<T>(cmd: string, payload: object): Promise<T> {
    try {
      return await firstValueFrom(
        this.aiClient
          .send<T>({ cmd }, payload)
          .pipe(timeout(RMQ_GATEWAY_TIMEOUT)),
      );
    } catch (err) {
      if (err instanceof TimeoutError) {
        throw new GatewayTimeoutException('AI service javob bermadi');
      }
      throw err;
    }
  }
}
