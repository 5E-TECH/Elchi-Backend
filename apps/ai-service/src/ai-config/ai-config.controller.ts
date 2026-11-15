import { Controller, Logger } from '@nestjs/common';
import {
  Ctx,
  MessagePattern,
  Payload,
  RmqContext,
} from '@nestjs/microservices';
import {
  AI_CONFIG_ERROR_CODES as C,
  AI_CONFIG_PATTERNS as P,
  RmqService,
  captureException,
  type AiConfigRequester,
  type AiConfigRpcResult,
} from '@app/common';
import { AiConfigEnv } from './ai-config-env';
import { aiConfigError } from './ai-config-errors';
import {
  startAiConfigWindow,
  type AiConfigDeadline,
} from './ai-config-deadline';
import { checkConfigWrite } from './ai-config-requester';
import { AiConfigHistoryService } from './ai-config-history.service';
import { AiConfigViewService } from './ai-config-view.service';
import { AiKeyStoreService, type AiKeyOpResult } from './ai-key-store.service';

/**
 * `ai.config.*` RMQ handler'lari (be-brief §6.2).
 *
 * ⚠️ HECH QACHON THROW QILMAYDI va DOIM ACK: natija
 * `{ ok: true, data } | { ok: false, error: { statusCode, message, code, … } }`.
 * Kalit xabari DLQ'ga tushmasligi kerak (navbatning o'zida ham DLX yo'q).
 *
 * Yozuvlar: `checkConfigWrite` (imzo kind `gateway`, navbat, superadmin,
 * flag, ruxsat ro'yxati, step-up) → `sent_at` oynasi → handler.
 * Javobdagi `data` — doim yangilangan `AiConfigView`.
 */
type Data = Record<string, unknown> | undefined;

@Controller()
export class AiConfigController {
  private readonly logger = new Logger(AiConfigController.name);

  constructor(
    private readonly rmq: RmqService,
    private readonly env: AiConfigEnv,
    private readonly store: AiKeyStoreService,
    private readonly view: AiConfigViewService,
    private readonly history: AiConfigHistoryService,
  ) {}

  @MessagePattern({ cmd: P.GET })
  get(@Payload() data: Data, @Ctx() ctx: RmqContext) {
    return this.respond(ctx, P.GET, async () => {
      const requester = this.reader(data);
      if (!requester) return aiConfigError(C.NOT_ALLOWED);
      return { ok: true, data: await this.view.build(requester.id) };
    });
  }

  @MessagePattern({ cmd: P.HISTORY })
  getHistory(@Payload() data: Data, @Ctx() ctx: RmqContext) {
    return this.respond(ctx, P.HISTORY, async () => {
      if (!this.reader(data)) return aiConfigError(C.NOT_ALLOWED);
      return { ok: true, data: await this.history.page(data ?? {}) };
    });
  }

  @MessagePattern({ cmd: P.KEY_SET })
  keySet(@Payload() data: Data, @Ctx() ctx: RmqContext) {
    return this.write(ctx, data, P.KEY_SET, true, (r, d) =>
      this.store.set(r, data ?? {}, d),
    );
  }

  @MessagePattern({ cmd: P.KEY_VERIFY })
  keyVerify(@Payload() data: Data, @Ctx() ctx: RmqContext) {
    return this.write(ctx, data, P.KEY_VERIFY, false, (r, d) =>
      this.store.verifyInUse(r, d),
    );
  }

  @MessagePattern({ cmd: P.KEY_RESTORE })
  keyRestore(@Payload() data: Data, @Ctx() ctx: RmqContext) {
    return this.write(ctx, data, P.KEY_RESTORE, true, (r, d) =>
      this.store.restore(r, data ?? {}, d),
    );
  }

  @MessagePattern({ cmd: P.KEY_DEACTIVATE })
  keyDeactivate(@Payload() data: Data, @Ctx() ctx: RmqContext) {
    return this.write(ctx, data, P.KEY_DEACTIVATE, true, (r, d) =>
      this.store.deactivate(r, data ?? {}, d),
    );
  }

  @MessagePattern({ cmd: P.KEY_FORGET_PREVIOUS })
  keyForget(@Payload() data: Data, @Ctx() ctx: RmqContext) {
    return this.write(ctx, data, P.KEY_FORGET_PREVIOUS, true, (r, d) =>
      this.store.forgetPrevious(r, data ?? {}, d),
    );
  }

  // ------------------------------------------------------------------

  /** O'qish (GET/history): faqat superadmin roli (imzo talab qilinmaydi). */
  private reader(data: Data): AiConfigRequester | null {
    const r = data?.requester as Record<string, unknown> | undefined;
    if (!r || (typeof r.id !== 'string' && typeof r.id !== 'number'))
      return null;
    const roles = Array.isArray(r.roles)
      ? r.roles.filter((x): x is string => typeof x === 'string')
      : [];
    if (!roles.map((x) => x.toLowerCase()).includes('superadmin')) return null;
    return { id: String(r.id), roles };
  }

  private write(
    ctx: RmqContext,
    data: Data,
    cmd: string,
    stepUp: boolean,
    op: (
      requester: AiConfigRequester,
      deadline: AiConfigDeadline,
    ) => Promise<AiKeyOpResult>,
  ) {
    return this.respond(ctx, cmd, async () => {
      const check = checkConfigWrite(ctx, data, this.env.access(), { stepUp });
      if (!check.ok) return aiConfigError(check.code);
      const window = startAiConfigWindow(data?.sent_at);
      if (!window.ok) return aiConfigError(C.EXPIRED);
      const result = await op(check.requester, window.deadline);
      if (!result.ok) return result;
      return { ok: true, data: await this.view.build(check.requester.id) };
    });
  }

  /** Throw qilmaydi, doim ack. Kutilmagan xato → 500 (kodsiz, matnsiz). */
  private async respond(
    ctx: RmqContext,
    cmd: string,
    fn: () => Promise<AiConfigRpcResult<unknown>>,
  ): Promise<AiConfigRpcResult<unknown>> {
    try {
      return await fn();
    } catch (err) {
      captureException(err, { rmq_pattern: cmd });
      this.logger.error(
        `${cmd} kutilmagan xato: ${(err as Error)?.name ?? 'Error'}`,
      );
      return {
        ok: false,
        error: { statusCode: 500, message: 'Ichki xato' },
      };
    } finally {
      try {
        this.rmq.ack(ctx);
      } catch {
        /* kanal yopilgan — xabar TTL bilan yo'qoladi */
      }
    }
  }
}
