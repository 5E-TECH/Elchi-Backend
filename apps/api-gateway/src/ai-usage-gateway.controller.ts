import {
  BadRequestException,
  Controller,
  GatewayTimeoutException,
  Get,
  Inject,
  Logger,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { firstValueFrom, Observable, TimeoutError, timeout } from 'rxjs';
import {
  RMQ_GATEWAY_TIMEOUT,
  Roles as RoleEnum,
  TASHKENT_OFFSET_MINUTES,
} from '@app/common';
import { JwtAuthGuard } from './auth/jwt-auth.guard';
import { Roles } from './auth/roles.decorator';
import { RolesGuard } from './auth/roles.guard';
import {
  AiUsageAiOrdersQueryDto,
  AiUsageDashboardQueryDto,
} from './dto/ai.swagger.dto';
import { successRes } from '../../../libs/common/helpers/response';

/** Sana berilmasa — oxirgi 30 kun (ai-service `AI_USAGE_SUMMARY_DEFAULT_DAYS`). */
const DEFAULT_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

function tashkentToday(now: Date = new Date()): string {
  return new Date(now.getTime() + TASHKENT_OFFSET_MINUTES * 60 * 1000)
    .toISOString()
    .slice(0, 10);
}

function addDays(ymd: string, days: number): string {
  return new Date(Date.parse(`${ymd}T00:00:00Z`) + days * DAY_MS)
    .toISOString()
    .slice(0, 10);
}

type AiUsageDashboardReply = {
  from?: string;
  to?: string;
  summary?: { aiOrderCount?: number } & Record<string, unknown>;
} & Record<string, unknown>;

type AiOrdersReply = {
  items?: Array<{ orderId?: string } & Record<string, unknown>>;
} & Record<string, unknown>;

/**
 * (Celz3rKJ) "Moliyaviy balans → AI xarajat" paneli (BeePost
 * `ai-usage/dashboard`, `ai-usage/ai-orders` naqshi):
 *  - `GET /ai-usage/dashboard` — jami xarajat USD/so'm, area/feature/model
 *    kesimi, Toshkent kuni bo'yicha trend (xarajat + chaqiruv + AI buyurtma),
 *    buyurtma manbasi (AI / qo'lda / tashqi / filial);
 *  - `GET /ai-usage/ai-orders` — AI orqali yaratilgan buyurtmalar ro'yxati.
 *
 * Faqat SUPERADMIN, ADMIN (boshqa rol — 403). Hech biri Anthropic'ni
 * chaqirmaydi: ai-service jurnali + order-service agregati. Har `send`
 * `timeout(RMQ_GATEWAY_TIMEOUT)` bilan, qayta urinishsiz.
 *
 * Davr gateway'da BIR MARTA aniqlanadi (berilmasa oxirgi 30 kun) va IKKALA
 * servisga ham aniq sanalar bilan yuboriladi — AI xarajati va buyurtmalar
 * soni AYNI Toshkent kunlari oynasida.
 */
@ApiTags('AI')
@ApiBearerAuth()
@Controller('ai-usage')
@UseGuards(JwtAuthGuard, RolesGuard)
export class AiUsageGatewayController {
  private readonly logger = new Logger(AiUsageGatewayController.name);

  constructor(
    @Inject('AI') private readonly aiClient: ClientProxy,
    @Inject('ORDER') private readonly orderClient: ClientProxy,
  ) {}

  @Get('dashboard')
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN)
  @ApiOperation({
    summary:
      "AI xarajat paneli: USD/so'm, feature/model kesimi, kunlik trend (Toshkent), buyurtma manbasi",
  })
  async dashboard(@Query() query: AiUsageDashboardQueryDto) {
    const { from, to } = this.resolveRange(query);
    const failedParts: string[] = [];

    const [ai, sources] = await Promise.all([
      this.call(
        this.aiClient
          .send<AiUsageDashboardReply>(
            { cmd: 'ai.usage.dashboard' },
            { from, to },
          )
          .pipe(timeout(RMQ_GATEWAY_TIMEOUT)),
      ),
      firstValueFrom(
        this.orderClient
          .send<{
            internal?: number;
            external?: number;
            branch?: number;
            total?: number;
            applied_range?: unknown;
          }>(
            { cmd: 'order.analytics.source_distribution' },
            { startDate: from, endDate: to },
          )
          .pipe(timeout(RMQ_GATEWAY_TIMEOUT)),
      ).catch((error: unknown) => {
        this.logger.warn(
          `ai-usage dashboard: buyurtma manbasi olinmadi: ${error instanceof Error ? error.message : String(error)}`,
        );
        failedParts.push('orderSources');
        return null;
      }),
    ]);

    const aiOrders = Number(ai?.summary?.aiOrderCount ?? 0) || 0;
    const orderSources = sources
      ? {
          total: Number(sources.total ?? 0) || 0,
          ai: aiOrders,
          // AI buyurtmalar ham `internal` (market/operator) — qo'lda = qolgani.
          manual: Math.max(0, (Number(sources.internal ?? 0) || 0) - aiOrders),
          external: Number(sources.external ?? 0) || 0,
          branch: Number(sources.branch ?? 0) || 0,
          applied_range: sources.applied_range ?? null,
        }
      : null;

    return successRes({
      ...ai,
      orderSources,
      degraded: failedParts.length > 0,
      failed_parts: failedParts,
    });
  }

  @Get('ai-orders')
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN)
  @ApiOperation({
    summary: "AI orqali yaratilgan buyurtmalar ro'yxati (eng yangisi birinchi)",
  })
  async aiOrders(@Query() query: AiUsageAiOrdersQueryDto) {
    const { from, to } = this.resolveRange(query);
    const ai = await this.call(
      this.aiClient
        .send<AiOrdersReply>(
          { cmd: 'ai.usage.ai_orders' },
          { from, to, ...(query?.limit ? { limit: query.limit } : {}) },
        )
        .pipe(timeout(RMQ_GATEWAY_TIMEOUT)),
    );
    const items = Array.isArray(ai?.items) ? ai.items : [];
    const ids = items
      .map((item) => String(item?.orderId ?? ''))
      .filter((id) => /^\d+$/.test(id));

    // Buyurtma raqami / holati / summasi — order-service'dan (mijoz telefoni
    // va ismi ATAYLAB olinmaydi: panelda kerak emas).
    let degraded = false;
    const byId = new Map<
      string,
      { order_number: unknown; status: unknown; total_price: unknown }
    >();
    if (ids.length) {
      try {
        const res = await firstValueFrom(
          this.orderClient
            .send<{ data?: unknown }>({ cmd: 'order.summary_by_ids' }, { ids })
            .pipe(timeout(RMQ_GATEWAY_TIMEOUT)),
        );
        const rows = Array.isArray(res?.data) ? res.data : [];
        for (const row of rows as Array<Record<string, unknown>>) {
          byId.set(String(row?.id), {
            order_number: row?.order_number ?? null,
            status: row?.status ?? null,
            total_price: row?.total_price ?? null,
          });
        }
      } catch (error: unknown) {
        degraded = true;
        this.logger.warn(
          `ai-usage ai-orders: buyurtma xulosalari olinmadi: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    return successRes({
      ...ai,
      items: items.map((item) => {
        const order = byId.get(String(item?.orderId ?? ''));
        return {
          ...item,
          orderNumber: order?.order_number ?? null,
          status: order?.status ?? null,
          totalPrice:
            order?.total_price === null || order?.total_price === undefined
              ? null
              : Number(order.total_price),
        };
      }),
      degraded,
    });
  }

  private resolveRange(query?: { fromDate?: string; toDate?: string }): {
    from: string;
    to: string;
  } {
    const to = query?.toDate ?? tashkentToday();
    const from = query?.fromDate ?? addDays(to, -(DEFAULT_DAYS - 1));
    // YYYY-MM-DD satrlari leksikografik tartibda sana tartibiga teng.
    if (from > to) {
      throw new BadRequestException(
        'fromDate sanasi toDate sanasidan keyin bo‘lishi mumkin emas',
      );
    }
    return { from, to };
  }

  /** RPC javobi; rxjs timeout → 504, boshqa xato o'zgarishsiz yuqoriga. */
  private async call<T>(source: Observable<T>): Promise<T> {
    try {
      return await firstValueFrom(source);
    } catch (error: unknown) {
      if (error instanceof TimeoutError) {
        throw new GatewayTimeoutException('AI service javob bermadi');
      }
      throw error;
    }
  }
}
