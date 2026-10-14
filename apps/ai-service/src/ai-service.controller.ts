import {
  Controller,
  HttpException,
  Logger,
  OnApplicationBootstrap,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  Ctx,
  MessagePattern,
  Payload,
  RmqContext,
  RpcException,
} from '@nestjs/microservices';
import {
  AI_MODEL_DEFAULTS,
  ClaudeService,
  RmqService,
  executeAndAck,
  type AiDistrictPickRequest,
  type AiDistrictPickResponse,
  type AiDraftAttachPreviewRequest,
  type AiDraftConfirmContextRequest,
  type AiDraftLinkItem,
  type AiOrderExtractRequest,
  type AiOrderExtractResponse,
  type AiProductDisambiguateRequest,
  type AiProductDisambiguateResponse,
  type AiRequester,
  type AiStatusResponse,
} from '@app/common';
import { errorRes } from '../../../libs/common/helpers/response';
import { AiBudgetService } from './budget/ai-budget.service';
import { AiDraftService } from './draft/ai-draft.service';
import { DistrictPickService } from './district-pick/district-pick.service';
import {
  evaluateModelPolicy,
  modelPolicyProblems,
} from './models/ai-model-policy';
import { OrderExtractService } from './order-extract/order-extract.service';
import { ProductDisambiguateService } from './product-disambiguate/product-disambiguate.service';
import { runAiHandler } from './rpc/run-ai-handler';
import { AiUsageService } from './usage/ai-usage.service';
import { nextTashkentMidnight, tashkentDay } from './usage/tashkent-day';

const LOG_ERROR_MAX_CHARS = 300;

/**
 * ai-service RMQ handler'lari (navbat `ai_queue`, id `AI`).
 *
 * ⚠️ Har handler `executeAndAck` bilan — `executeIdempotent` ATAYLAB
 * ishlatilmaydi (AI natijasi keshlanmaydi, har qayta chaqiruv yangi pul).
 *
 * - `ai.order.extract` / `ai.product.disambiguate` — `runAiHandler` ichida:
 *   eskirgan xabar Anthropic'ga bormaydi va AI xatosi HECH QACHON throw
 *   bo'lmaydi → xabar doim ack, requeue va ikki marta to'lov yo'q.
 * - Admin handler'lar (cap.raise, usage.*) kutilmagan xatoni `RpcException`
 *   ga o'raydi — xabar DLQ'ga ketadi, requeue bo'lmaydi.
 */
@Controller()
export class AiServiceController implements OnApplicationBootstrap {
  private readonly logger = new Logger(AiServiceController.name);

  constructor(
    private readonly rmqService: RmqService,
    private readonly config: ConfigService,
    private readonly claude: ClaudeService,
    private readonly orderExtract: OrderExtractService,
    private readonly disambiguate: ProductDisambiguateService,
    private readonly usage: AiUsageService,
    private readonly budget: AiBudgetService,
    private readonly drafts: AiDraftService,
    private readonly districtPick: DistrictPickService,
  ) {}

  /**
   * LP3RKvXY #2 (TC3): ekstraksiya modeli kuchsiz/noma'lum bo'lsa startda
   * ERROR — boot YIQILMAYDI (ega qarori), holat `ai.status.model_policy` da.
   */
  onApplicationBootstrap(): void {
    const models = this.currentModels();
    for (const problem of modelPolicyProblems(
      models,
      evaluateModelPolicy(models),
    )) {
      this.logger.error(problem);
    }
  }

  @MessagePattern({ cmd: 'ai.health' })
  health(@Ctx() ctx: RmqContext) {
    return executeAndAck(this.rmqService, ctx, () => ({
      service: 'ai-service',
      status: 'ok',
      ai: this.claude.isEnabled() ? 'enabled' : 'disabled',
      timestamp: new Date().toISOString(),
    }));
  }

  @MessagePattern({ cmd: 'ai.status' })
  status(@Ctx() ctx: RmqContext): Promise<AiStatusResponse> {
    return executeAndAck(this.rmqService, ctx, () => this.buildStatus());
  }

  @MessagePattern({ cmd: 'ai.order.extract' })
  extractOrders(
    @Payload() data: AiOrderExtractRequest,
    @Ctx() ctx: RmqContext,
  ): Promise<AiOrderExtractResponse> {
    return executeAndAck(this.rmqService, ctx, () =>
      runAiHandler(
        data,
        (dl) => this.orderExtract.extract(data, dl),
        this.logger,
        'ai.order.extract',
      ),
    );
  }

  @MessagePattern({ cmd: 'ai.product.disambiguate' })
  disambiguateProducts(
    @Payload() data: AiProductDisambiguateRequest,
    @Ctx() ctx: RmqContext,
  ): Promise<AiProductDisambiguateResponse> {
    return executeAndAck(this.rmqService, ctx, () =>
      runAiHandler(
        data,
        (dl) => this.disambiguate.pick(data, dl),
        this.logger,
        'ai.product.disambiguate',
      ),
    );
  }

  /**
   * 5Z1ZvvzE: tuman LLM fallback'i — faqat INDEKS (`choice`). `runAiHandler`
   * ichida: eskirgan xabar Anthropic'ga bormaydi, AI xatosi throw bo'lmaydi.
   */
  @MessagePattern({ cmd: 'ai.district.pick' })
  pickDistricts(
    @Payload() data: AiDistrictPickRequest,
    @Ctx() ctx: RmqContext,
  ): Promise<AiDistrictPickResponse> {
    return executeAndAck(this.rmqService, ctx, () =>
      runAiHandler(
        data,
        (dl) => this.districtPick.pick(data, dl),
        this.logger,
        'ai.district.pick',
      ),
    );
  }

  @MessagePattern({ cmd: 'ai.cap.raise' })
  raiseCap(
    @Payload()
    data: { extra_usd: number; reason: string; requester: AiRequester },
    @Ctx() ctx: RmqContext,
  ) {
    return executeAndAck(this.rmqService, ctx, () =>
      this.adminCall('ai.cap.raise', () =>
        this.budget.raise(data?.extra_usd, data?.reason, data?.requester),
      ),
    );
  }

  @MessagePattern({ cmd: 'ai.usage.summary' })
  usageSummary(
    @Payload() data: { from?: string; to?: string } | null,
    @Ctx() ctx: RmqContext,
  ) {
    return executeAndAck(this.rmqService, ctx, () =>
      this.adminCall('ai.usage.summary', () =>
        this.usage.summary(data?.from, data?.to),
      ),
    );
  }

  /** (Celz3rKJ) "Moliyaviy balans → AI xarajat" paneli (gateway: SUPERADMIN/ADMIN). */
  @MessagePattern({ cmd: 'ai.usage.dashboard' })
  usageDashboard(
    @Payload() data: { from?: string; to?: string } | null,
    @Ctx() ctx: RmqContext,
  ) {
    return executeAndAck(this.rmqService, ctx, () =>
      this.adminCall('ai.usage.dashboard', () =>
        this.usage.dashboard(data?.from, data?.to),
      ),
    );
  }

  /** (Celz3rKJ) AI orqali yaratilgan buyurtmalar ro'yxati. */
  @MessagePattern({ cmd: 'ai.usage.ai_orders' })
  usageAiOrders(
    @Payload() data: { from?: string; to?: string; limit?: number } | null,
    @Ctx() ctx: RmqContext,
  ) {
    return executeAndAck(this.rmqService, ctx, () =>
      this.adminCall('ai.usage.ai_orders', () =>
        this.usage.aiOrders(data?.from, data?.to, data?.limit),
      ),
    );
  }

  /**
   * ai-confirm natijasi: xarajat jurnaliga order_ids va (vncdmXOy) audit
   * iziga `ai_order_draft_item` (order_id, item_index, edited_fields).
   * `items` berilmasa (eski gateway) — faqat jurnal, xulq avvalgidek.
   * Draft bog'lanishi BIRINCHI — nizo tekshiruvining asosiy manbai.
   */
  @MessagePattern({ cmd: 'ai.usage.link_orders' })
  linkOrders(
    @Payload()
    data: {
      draft_id: string;
      order_ids: string[];
      market_id: string;
      items?: AiDraftLinkItem[];
      confirmed_by?: string;
    },
    @Ctx() ctx: RmqContext,
  ) {
    return executeAndAck(this.rmqService, ctx, () =>
      this.adminCall('ai.usage.link_orders', async () => {
        const draft = Array.isArray(data?.items)
          ? await this.drafts.linkItems(
              data.draft_id,
              data.market_id,
              data.items,
              data.confirmed_by,
            )
          : null;
        const usage = await this.usage.linkOrders(
          data?.draft_id,
          data?.order_ids,
          data?.market_id,
        );
        return draft ? { ...usage, ...draft } : usage;
      }),
    );
  }

  /** vncdmXOy: AI taklifi snapshot'i (gateway ai-parse oxirida, fire-and-forget). */
  @MessagePattern({ cmd: 'ai.draft.attach_preview' })
  attachPreview(
    @Payload() data: AiDraftAttachPreviewRequest,
    @Ctx() ctx: RmqContext,
  ) {
    return executeAndAck(this.rmqService, ctx, () =>
      this.adminCall('ai.draft.attach_preview', () =>
        this.drafts.attachPreview(
          data?.draft_id,
          data?.market_id,
          data?.previews,
        ),
      ),
    );
  }

  /** vncdmXOy: ai-confirm audit konteksti (model, prompt, snapshot, xarajat). */
  @MessagePattern({ cmd: 'ai.draft.confirm_context' })
  confirmContext(
    @Payload() data: AiDraftConfirmContextRequest,
    @Ctx() ctx: RmqContext,
  ) {
    return executeAndAck(this.rmqService, ctx, () =>
      this.adminCall('ai.draft.confirm_context', () =>
        this.drafts.confirmContext(data?.market_id, data?.draft_ids),
      ),
    );
  }

  /** vncdmXOy: `GET /orders/:id/ai-trace` (SUPERADMIN/ADMIN) — null: AI emas. */
  @MessagePattern({ cmd: 'ai.draft.trace_by_order' })
  traceByOrder(@Payload() data: { order_id: string }, @Ctx() ctx: RmqContext) {
    return executeAndAck(this.rmqService, ctx, () =>
      this.adminCall('ai.draft.trace_by_order', () =>
        this.drafts.traceByOrder(data?.order_id),
      ),
    );
  }

  /**
   * `ai.status` javobi. Faqat HOLAT — kalit qiymati hech qachon qaytmaydi.
   * Shift holatini o'qib bo'lmasa (DB xatosi) `cap.state = 'unknown'` —
   * status so'rovining o'zi hech qachon yiqilmaydi.
   */
  private async buildStatus(): Promise<AiStatusResponse> {
    const models = this.currentModels();
    return {
      enabled: this.claude.isEnabled(),
      key_state: this.claude.keyState().state,
      models,
      model_policy: evaluateModelPolicy(models),
      cap: await this.readCap(),
      usage_persist_failures: this.readPersistFailures(),
    };
  }

  private async readCap(): Promise<AiStatusResponse['cap']> {
    try {
      return await this.budget.status();
    } catch (err) {
      this.logger.warn(`ai_status_cap_read_failed: ${describeError(err)}`);
      const now = new Date();
      const capRaw = Number(this.config.get<unknown>('AI_DAILY_USD_CAP'));
      const capUsd = Number.isFinite(capRaw) && capRaw > 0 ? capRaw : 0;
      return {
        period_key: tashkentDay(now),
        spent_usd: 0,
        cap_usd: capUsd,
        override_usd: 0,
        effective_cap_usd: capUsd,
        ratio: 0,
        state: 'unknown',
        reset_at: nextTashkentMidnight(now),
      };
    }
  }

  private readPersistFailures(): number {
    try {
      const n = this.usage.persistFailures();
      return typeof n === 'number' && Number.isFinite(n) ? n : 0;
    } catch {
      return 0;
    }
  }

  private currentModels(): AiStatusResponse['models'] {
    return {
      order: this.modelName('AI_ORDER_MODEL', AI_MODEL_DEFAULTS.order),
      vision: this.modelName('AI_ORDER_VISION_MODEL', AI_MODEL_DEFAULTS.vision),
      classify: this.modelName('AI_CLASSIFY_MODEL', AI_MODEL_DEFAULTS.classify),
    };
  }

  private modelName(key: string, fallback: string): string {
    const raw = this.config.get<unknown>(key);
    const value = typeof raw === 'string' ? raw.trim() : '';
    return value || fallback;
  }

  /**
   * Admin handler o'rami: kutilmagan xato `RpcException` ga aylanadi —
   * `executeAndAck` uni DLQ'ga yuboradi (requeue YO'Q). HTTP-uslubdagi xato
   * (masalan 400) status kodi bilan saqlanadi. Payload logga chiqmaydi.
   */
  private async adminCall<T>(cmd: string, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof RpcException) throw err;
      if (err instanceof HttpException) {
        throw new RpcException(errorRes(err.message, err.getStatus()));
      }
      this.logger.error(`ai_admin_failed cmd=${cmd}: ${describeError(err)}`);
      throw new RpcException(errorRes(`${cmd} bajarilmadi`, 500));
    }
  }
}

function describeError(err: unknown): string {
  if (err instanceof Error) {
    const name = err.constructor?.name || err.name;
    return `${name}: ${err.message}`.slice(0, LOG_ERROR_MAX_CHARS);
  }
  return 'non-error throw';
}
