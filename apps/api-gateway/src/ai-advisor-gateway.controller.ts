import {
  BadRequestException,
  Body,
  Controller,
  GatewayTimeoutException,
  Get,
  HttpCode,
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
  ApiBearerAuth,
  ApiBody,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiResponse,
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

/** `successRes` konverti: `{statusCode, message, data}` (round-4 #654 openapi). */
const envelope = (description: string, data: Record<string, unknown>) => ({
  description,
  schema: {
    type: 'object',
    required: ['statusCode', 'message', 'data'],
    properties: {
      statusCode: { type: 'integer', example: 200 },
      message: { type: 'string' },
      data,
    },
  },
});
const nullableString = { type: 'string', nullable: true };
const ref = {
  type: 'object',
  nullable: true,
  properties: { id: { type: 'string' }, name: nullableString },
};
const ruleKey = {
  type: 'string',
  enum: ['R1', 'R2', 'R3', 'R4', 'R5', 'R6', 'R7', 'R8'],
};
const nullableTime = { type: 'string', format: 'date-time', nullable: true };
const userRef = ref;
/** `AiAdvisorAlertListItem` (shartnoma §7.2). */
const listItem = {
  type: 'object',
  required: [
    'id',
    'rule_key',
    'severity',
    'status',
    'title',
    'branch',
    'subject',
    'headline_amount',
    'facts',
    'occurrences',
    'first_at',
    'last_at',
    'first_fact_at',
    'last_fact_at',
    'explanation_status',
    'reopened_from_id',
  ],
  properties: {
    id: { type: 'string' },
    rule_key: ruleKey,
    severity: { type: 'string', enum: ['critical', 'warning'] },
    status: { type: 'string', enum: ['new', 'seen', 'resolved', 'dismissed'] },
    title: { type: 'string' },
    branch: ref,
    subject: {
      type: 'object',
      required: ['kind', 'id', 'name'],
      properties: {
        kind: {
          type: 'string',
          enum: ['branch', 'courier', 'market', 'cashbox', 'system'],
        },
        id: nullableString,
        name: nullableString,
      },
    },
    headline_amount: { type: 'number', nullable: true },
    facts: { type: 'object', additionalProperties: true },
    occurrences: { type: 'integer' },
    first_at: { type: 'string', format: 'date-time' },
    last_at: { type: 'string', format: 'date-time' },
    first_fact_at: nullableTime,
    last_fact_at: nullableTime,
    explanation_status: {
      type: 'string',
      enum: ['none', 'pending', 'ready', 'failed'],
    },
    reopened_from_id: nullableString,
  },
};
/** `AiAdvisorAlertDetail` (shartnoma §7.3). */
const detail = {
  type: 'object',
  required: listItem.required,
  properties: {
    ...listItem.properties,
    rule: {
      type: 'object',
      properties: {
        key: ruleKey,
        severity: { type: 'string', enum: ['critical', 'warning'] },
        thresholds: {
          type: 'object',
          additionalProperties: { type: 'number' },
        },
      },
    },
    evidence: { type: 'object', additionalProperties: true },
    links: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          kind: { type: 'string' },
          href: { type: 'string' },
          entity_id: nullableString,
          primary: { type: 'boolean' },
        },
      },
    },
    explanation_md: nullableString,
    explanation_error: {
      type: 'string',
      nullable: true,
      enum: ['budget_exceeded', 'ai_disabled', 'error', null],
    },
    explanation_error_scope: {
      type: 'string',
      nullable: true,
      enum: ['advisor', 'global', null],
    },
    explanation_retry_at: nullableTime,
    explanation_requested_at: nullableTime,
    explanation_poll_after_ms: { type: 'integer', nullable: true },
    explained_at: nullableTime,
    seen_at: nullableTime,
    seen_by: userRef,
    resolved_at: nullableTime,
    resolved_by: userRef,
    resolution_note: nullableString,
    reopened_from: {
      type: 'object',
      nullable: true,
      properties: {
        id: { type: 'string' },
        status: { type: 'string' },
        resolved_at: nullableTime,
      },
    },
    history: {
      type: 'array',
      description: 'Faqat `?include=history` (≤ 50)',
      items: {
        type: 'object',
        properties: {
          at: { type: 'string', format: 'date-time' },
          event: {
            type: 'string',
            enum: [
              'opened',
              'occurred',
              'seen',
              'explained',
              'resolved',
              'dismissed',
            ],
          },
          by: userRef,
          note: nullableString,
        },
      },
    },
  },
};
const settings = {
  type: 'object',
  properties: {
    version: { type: 'integer' },
    rules: { type: 'object', additionalProperties: true },
    limits: { type: 'object', additionalProperties: true },
    telegram: { type: 'object', nullable: true },
    budget: { type: 'object', nullable: true },
    schedule: { type: 'object', nullable: true },
    updated_at: { type: 'string', format: 'date-time', nullable: true },
    updated_by: ref,
  },
};

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
  @ApiOkResponse(
    envelope('Nishonlar va banner', {
      type: 'object',
      properties: {
        alerts: {
          type: 'object',
          properties: {
            new: { type: 'integer' },
            open: { type: 'integer' },
            critical: { type: 'integer' },
            critical_open: { type: 'integer' },
            critical_rule_keys: { type: 'array', items: ruleKey },
            critical_open_rule_keys: { type: 'array', items: ruleKey },
          },
        },
        recommendations: { type: 'object', nullable: true },
        budget: { type: 'object', nullable: true },
        usd_uzs_rate: { type: 'number', nullable: true },
        generated_at: { type: 'string', format: 'date-time' },
      },
    }),
  )
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
  @ApiOkResponse(
    envelope('Ro‘yxat', {
      type: 'object',
      properties: {
        items: { type: 'array', items: listItem },
        meta: {
          type: 'object',
          properties: {
            page: { type: 'integer' },
            limit: { type: 'integer' },
            total: { type: 'integer' },
            totalPages: { type: 'integer' },
          },
        },
        counts: {
          type: 'object',
          properties: {
            by_status: {
              type: 'object',
              properties: {
                new: { type: 'integer' },
                seen: { type: 'integer' },
                resolved: { type: 'integer' },
                dismissed: { type: 'integer' },
              },
            },
          },
        },
      },
    }),
  )
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
  @ApiOkResponse(envelope('Tafsilot', detail))
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
  @ApiOkResponse(envelope('Yangilangan tafsilot', detail))
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

  @Post('alerts/:id/explain')
  @HttpCode(202)
  @Roles(RoleEnum.SUPERADMIN)
  @ApiParam({
    name: 'id',
    description: 'Ogohlantirish ID si',
    schema: { type: 'string', pattern: '^\\d{1,18}$' },
  })
  @ApiResponse({
    status: 202,
    description:
      '`{statusCode: 202, message: "Explanation queued", data: {alert_id, explanation_status: pending|ready, explanation_md, explained_at, cached, poll_after_ms}}`',
  })
  @ApiOperation({
    summary: 'AI maslahatchi: AI izohini so‘rash (faqat superadmin, doim 202)',
    description:
      'Tana yo‘q. LLM sinxron kutilmaydi: `202 data = {alert_id, explanation_status: pending|ready, explanation_md, explained_at, cached, poll_after_ms}`. ' +
      '`ready` — keshdan (`cached: true`, narx 0). `pending` (3 daqiqadan yangi) — qayta navbat yo‘q. ' +
      'Natija: `GET /ai/advisor/alerts/:id` poll (`poll_after_ms`) yoki realtime `ai.advisor.alert_changed {change: explanation}`. ' +
      'Xatolar: 404 `AI_ADVISOR_ALERT_NOT_FOUND`; 409 `AI_ADVISOR_ALERT_CLOSED {alert_status}`; ' +
      '429 `AI_ADVISOR_BUDGET_EXCEEDED {scope: global, period: day, reset_at, retry_after_seconds}`; ' +
      '503 `AI_ADVISOR_AI_DISABLED {reason: ai_disabled|feature_disabled|budget_unreadable}`. 429/503 `explanation_status` ni o‘zgartirmaydi. ' +
      'Jiddiy ogohlantirishlarga izoh avtomatik (tick’dan keyin, ≤ 5 ta). Pul amali yo‘q.',
  })
  explainAlert(
    @Param('id') id: string,
    @Req() req: AuthedRequest,
  ): Promise<unknown> {
    return this.call(AI_ADVISOR_PATTERNS.ALERTS_EXPLAIN, {
      requester: this.requester(req),
      id: this.alertId(id),
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
  @ApiOkResponse(envelope('Sozlamalar', settings))
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
  @ApiOkResponse(envelope('To‘liq sozlamalar', settings))
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
