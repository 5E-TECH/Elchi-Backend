import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  GatewayTimeoutException,
  Get,
  HttpException,
  HttpStatus,
  Inject,
  Logger,
  NotFoundException,
  Optional,
  Param,
  Patch,
  Post,
  Query,
  Req,
  Res,
  ServiceUnavailableException,
  UseGuards,
} from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import {
  ApiBearerAuth,
  ApiBody,
  ApiOkResponse,
  ApiOperation,
  ApiProduces,
  ApiTags,
} from '@nestjs/swagger';
import type { Response } from 'express';
import { firstValueFrom, Observable, TimeoutError, timeout } from 'rxjs';
import {
  RMQ_GATEWAY_TIMEOUT,
  Roles as RoleEnum,
  requestContext,
  type AiAssistantAccessState,
  type AiAssistantEvent,
  type AiAssistantRequester,
} from '@app/common';
import { JwtAuthGuard } from './auth/jwt-auth.guard';
import { Roles } from './auth/roles.decorator';
import { RolesGuard } from './auth/roles.guard';
import {
  AiAssistantAccessUpdateDto,
  AiAssistantConversationsQueryDto,
  AiAssistantMessageDto,
} from './dto/ai-assistant.dto';
import { successRes } from '../../../libs/common/helpers/response';

/** SSE: birinchi hodisa (meta) shu vaqt ichida kelishi kerak. */
export const AI_ASSISTANT_SSE_FIRST_MS = 60_000;
/**
 * SSE: hodisalar orasidagi maksimal sukut. Bitta Claude qadami (thinking)
 * 55 s gacha matnsiz o'tishi mumkin (ANTHROPIC_TIMEOUT_MS) — zaxira bilan.
 */
export const AI_ASSISTANT_SSE_EACH_MS = 120_000;
/** Cloudflare (~100 s) ulanishni uzmasligi uchun izoh-ping. */
export const AI_ASSISTANT_SSE_HEARTBEAT_MS = 15_000;

interface AuthedRequest {
  user?: {
    sub?: string | number;
    roles?: unknown[];
    branch_id?: string | number | null;
  };
  on?: (event: 'close', listener: () => void) => unknown;
}

/**
 * F7PWp6cK — AI moliyaviy yordamchi (superadmin + superadmin tanlagan
 * adminlar). Barcha ish ai-service'da (Claude + faqat o'qiydigan tool'lar);
 * gateway — ruxsat oldindan tekshiruvi (403/429/503 SSE ochilishidan OLDIN)
 * va SSE uzatish.
 *
 *  - `POST  /ai/assistant/messages`          — savol → SSE (SA, ADMIN+ruxsat);
 *  - `GET   /ai/assistant/conversations`     — o'z suhbatlari ro'yxati;
 *  - `GET   /ai/assistant/conversations/:id` — suhbat xabarlari (o'ziniki);
 *  - `GET   /ai/assistant/access/me`         — o'z holati (menyu/limit);
 *  - `GET   /ai/assistant/access`            — adminlar ruxsatlari (SA);
 *  - `PATCH /ai/assistant/access`            — ruxsat/limit berish (SA).
 *
 * ⚠️ ai.* RPC'lar qayta yuborilmaydi (retry yo'q), har biri timeout bilan.
 */
@ApiTags('AI')
@ApiBearerAuth()
@Controller('ai/assistant')
@UseGuards(JwtAuthGuard, RolesGuard)
export class AiAssistantGatewayController {
  private readonly logger = new Logger(AiAssistantGatewayController.name);

  constructor(
    @Inject('AI') private readonly aiClient: ClientProxy,
    @Optional()
    @Inject('IDENTITY')
    private readonly identityClient?: ClientProxy,
  ) {}

  @Post('messages')
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN)
  @ApiOperation({
    summary: 'AI moliyaviy yordamchiga savol (SSE oqimi)',
    description:
      'Javob `text/event-stream`: `event: meta` {conversation_id, message_id, model, max_steps} → ' +
      '`step` {step} → `delta` {step, text} (oraliq matn) → `tool_call` {step, id, tool, input} → ' +
      '`tool_result` {step, id, tool, ok, records, period, truncated} → … → `done` {conversation_id, message_id, ' +
      'answer, stop, steps, sources[], usage{input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, cost_usd}, ' +
      'limits{daily_limit, used_today, remaining_today}} yoki `error` {code, message, conversation_id?, reset_at?}. ' +
      'Har 15 s `: ping` izohi. SSE ochilishidan OLDIN: rol/ruxsat yo‘q → 403, funksiya o‘chiq → 503, ' +
      'kunlik limit tugagan → 429. Yakuniy matn — faqat `done.answer`.',
  })
  @ApiBody({ type: AiAssistantMessageDto })
  @ApiProduces('text/event-stream')
  async postMessage(
    @Body() dto: AiAssistantMessageDto,
    @Req() req: AuthedRequest,
    @Res() res: Response,
  ): Promise<void> {
    const requester = this.requester(req);
    const access = await this.accessState(requester);
    this.assertCanAsk(access);

    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();

    const write = (event: string, data: unknown) => {
      if (res.writableEnded) return;
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };
    const heartbeat = setInterval(() => {
      if (!res.writableEnded) res.write(': ping\n\n');
    }, AI_ASSISTANT_SSE_HEARTBEAT_MS);
    const end = () => {
      clearInterval(heartbeat);
      if (!res.writableEnded) res.end();
    };

    const subscription = this.aiClient
      .send<AiAssistantEvent>(
        { cmd: 'ai.assistant.message' },
        {
          requester,
          conversation_id: dto.conversation_id ?? null,
          message: dto.message,
          trace_id: requestContext.getTraceId() ?? null,
        },
      )
      .pipe(
        timeout({
          first: AI_ASSISTANT_SSE_FIRST_MS,
          each: AI_ASSISTANT_SSE_EACH_MS,
        }),
      )
      .subscribe({
        next: (event) => {
          const type =
            event && typeof event === 'object' && typeof event.type === 'string'
              ? event.type
              : 'message';
          write(type, event);
        },
        error: (err: unknown) => {
          const isTimeout = err instanceof TimeoutError;
          if (!isTimeout) {
            this.logger.warn(
              `ai.assistant.message oqimi xato bilan tugadi: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
          write('error', {
            type: 'error',
            code: isTimeout ? 'network' : 'ai_error',
            message: isTimeout
              ? "AI javobi kechikdi — qayta urinib ko'ring"
              : 'AI xatosi — keyinroq urinib ko‘ring',
          });
          end();
        },
        complete: end,
      });

    // Mijoz ulanishni uzsa — obuna yopiladi (ai-service ishni tugatib,
    // auditni baribir yozadi; javob suhbat tarixida ko'rinadi).
    req.on?.('close', () => {
      subscription.unsubscribe();
      clearInterval(heartbeat);
    });
  }

  @Get('conversations')
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN)
  @ApiOperation({
    summary: 'AI yordamchi: o‘z suhbatlarim (yangisi birinchi)',
    description:
      '`data` = {items[{id, title, turns, last_message_at, created_at, cost_usd}], total, limit, offset}. ' +
      'Ruxsatsiz admin — 403.',
  })
  async conversations(
    @Query() query: AiAssistantConversationsQueryDto,
    @Req() req: AuthedRequest,
  ) {
    const requester = this.requester(req);
    this.assertCanRead(await this.accessState(requester));
    const data = await this.call(
      this.aiClient
        .send<unknown>(
          { cmd: 'ai.assistant.conversations' },
          { requester, limit: query?.limit, offset: query?.offset },
        )
        .pipe(timeout(RMQ_GATEWAY_TIMEOUT)),
    );
    return successRes(data);
  }

  @Get('conversations/:id')
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN)
  @ApiOperation({
    summary: 'AI yordamchi: suhbat xabarlari (faqat o‘ziniki)',
    description:
      '`data` = {id, title, turns, created_at, last_message_at, cost_usd, messages[{id, role: user|assistant, text, ' +
      'created_at, sources?[{tool, period, records, truncated, ok}], stop?}]}. Begona/yo‘q — 404.',
  })
  async conversation(@Param('id') id: string, @Req() req: AuthedRequest) {
    if (!/^\d{1,19}$/.test(String(id ?? ''))) {
      throw new BadRequestException("Suhbat ID si noto'g'ri");
    }
    const requester = this.requester(req);
    this.assertCanRead(await this.accessState(requester));
    const data = await this.call(
      this.aiClient
        .send<unknown>(
          { cmd: 'ai.assistant.conversations' },
          { requester, conversation_id: String(id) },
        )
        .pipe(timeout(RMQ_GATEWAY_TIMEOUT)),
    );
    return successRes(data);
  }

  @Get('access/me')
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN)
  @ApiOperation({
    summary: 'AI yordamchi: mening holatim (menyuni ko‘rsatish, limit)',
    description:
      '`data` = {allowed, reason: null|role_forbidden|access_disabled|feature_disabled|ai_disabled, ' +
      'feature_enabled, daily_limit, used_today, remaining_today, reset_at}.',
  })
  async me(@Req() req: AuthedRequest) {
    return successRes(await this.accessState(this.requester(req)));
  }

  @Get('access')
  @Roles(RoleEnum.SUPERADMIN)
  @ApiOperation({
    summary: 'AI yordamchi ruxsatlari (faqat superadmin)',
    description:
      '`data` = {feature_enabled, default_daily_limit, model, items[{user_id, enabled, daily_limit, ' +
      'effective_daily_limit, updated_by, updated_at}]}. Adminlar ro‘yxati — mavjud `GET /admins` dan.',
  })
  @ApiOkResponse({ description: 'Ruxsatlar ro‘yxati' })
  async listAccess() {
    const data = await this.call(
      this.aiClient
        .send<unknown>({ cmd: 'ai.assistant.access.list' }, {})
        .pipe(timeout(RMQ_GATEWAY_TIMEOUT)),
    );
    return successRes(data);
  }

  @Patch('access')
  @Roles(RoleEnum.SUPERADMIN)
  @ApiOperation({
    summary:
      'AI yordamchi ruxsatini berish/olish va kunlik limit (faqat superadmin)',
    description:
      'Faqat ADMIN rolli foydalanuvchiga (boshqa rol — 400, topilmasa — 404). Superadmin ruxsatsiz ham doim foydalanadi. ' +
      '`daily_limit: null` — sukut (100).',
  })
  @ApiBody({ type: AiAssistantAccessUpdateDto })
  async updateAccess(
    @Body() dto: AiAssistantAccessUpdateDto,
    @Req() req: AuthedRequest,
  ) {
    await this.assertAdminTarget(dto.user_id);
    const data = await this.call(
      this.aiClient
        .send<unknown>(
          { cmd: 'ai.assistant.access.update' },
          {
            requester: this.requester(req),
            user_id: dto.user_id,
            enabled: dto.enabled,
            daily_limit: dto.daily_limit ?? null,
          },
        )
        .pipe(timeout(RMQ_GATEWAY_TIMEOUT)),
    );
    return successRes(data);
  }

  // ─── Yordamchilar ───────────────────────────────────────────────────────

  private requester(req: AuthedRequest): AiAssistantRequester {
    const roles = Array.isArray(req?.user?.roles)
      ? req.user.roles
          .map((r) => (typeof r === 'string' ? r.trim().toLowerCase() : ''))
          .filter(Boolean)
      : [];
    const branch = req?.user?.branch_id;
    return {
      id: String(req?.user?.sub ?? ''),
      roles,
      branch_id:
        branch === null || branch === undefined ? null : String(branch),
    };
  }

  private accessState(
    requester: AiAssistantRequester,
  ): Promise<AiAssistantAccessState> {
    return this.call(
      this.aiClient
        .send<AiAssistantAccessState>(
          { cmd: 'ai.assistant.access.check' },
          { requester },
        )
        .pipe(timeout(RMQ_GATEWAY_TIMEOUT)),
    );
  }

  /** Savol berish: rol/ruxsat → 403, funksiya/AI o'chiq → 503, limit → 429. */
  private assertCanAsk(access: AiAssistantAccessState): void {
    this.assertCanRead(access);
    if (
      access.reason === 'feature_disabled' ||
      access.reason === 'ai_disabled'
    ) {
      throw new ServiceUnavailableException({
        statusCode: 503,
        code: access.reason,
        message:
          access.reason === 'feature_disabled'
            ? "AI yordamchi hozircha o'chirilgan"
            : "AI xizmati o'chiq",
      });
    }
    if (access.remaining_today <= 0) {
      throw new HttpException(
        {
          statusCode: HttpStatus.TOO_MANY_REQUESTS,
          code: 'daily_limit',
          message: 'Bugungi savollar limiti tugadi',
          daily_limit: access.daily_limit,
          used_today: access.used_today,
          reset_at: access.reset_at,
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }

  /** Tarixni o'qish: faqat rol/ruxsat (funksiya o'chiq bo'lsa ham tarix ochiq). */
  private assertCanRead(access: AiAssistantAccessState): void {
    if (
      access?.reason === 'role_forbidden' ||
      access?.reason === 'access_disabled' ||
      !access
    ) {
      throw new ForbiddenException({
        statusCode: 403,
        code: access?.reason ?? 'role_forbidden',
        message:
          'AI yordamchi faqat superadmin va ruxsat berilgan adminlar uchun',
      });
    }
  }

  /** PATCH /access: maqsad foydalanuvchi ADMIN bo'lishi shart. */
  private async assertAdminTarget(userId: string): Promise<void> {
    if (!this.identityClient) {
      throw new ServiceUnavailableException('Identity xizmati ulanmagan');
    }
    let user: { roles?: unknown; role?: unknown } | null = null;
    try {
      const res = await firstValueFrom(
        this.identityClient
          .send<{
            data?: { roles?: unknown; role?: unknown } | null;
          }>({ cmd: 'identity.user.find_by_id' }, { id: userId })
          .pipe(timeout(RMQ_GATEWAY_TIMEOUT)),
      );
      user = res?.data ?? null;
    } catch (err) {
      const status =
        err && typeof err === 'object'
          ? Number(
              (err as { statusCode?: unknown; status?: unknown }).statusCode ??
                (err as { status?: unknown }).status,
            )
          : NaN;
      if (status === 404)
        throw new NotFoundException('Foydalanuvchi topilmadi');
      if (err instanceof TimeoutError) {
        throw new GatewayTimeoutException('Identity xizmati javob bermadi');
      }
      throw new ServiceUnavailableException(
        'Foydalanuvchini tekshirib bo‘lmadi',
      );
    }
    if (!user) throw new NotFoundException('Foydalanuvchi topilmadi');
    const roles = (
      Array.isArray(user.roles) ? user.roles : user.role ? [user.role] : []
    ).map((r) => (typeof r === 'string' ? r.toLowerCase() : ''));
    if (!roles.includes(RoleEnum.ADMIN)) {
      throw new BadRequestException(
        'Ruxsat faqat ADMIN rolli foydalanuvchiga beriladi',
      );
    }
  }

  private async call<T>(source: Observable<T>): Promise<T> {
    try {
      return await firstValueFrom(source);
    } catch (err) {
      if (err instanceof TimeoutError) {
        throw new GatewayTimeoutException('AI xizmati javob bermadi');
      }
      throw err;
    }
  }
}
