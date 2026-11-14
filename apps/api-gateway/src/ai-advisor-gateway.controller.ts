import {
  Body,
  Controller,
  GatewayTimeoutException,
  Get,
  Inject,
  Patch,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { ApiBearerAuth, ApiBody, ApiOperation, ApiTags } from '@nestjs/swagger';
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
import { AiAdvisorSettingsPatchDto } from './dto/ai-advisor.dto';

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
