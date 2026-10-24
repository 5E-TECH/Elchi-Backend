import {
  BadRequestException,
  Controller,
  GatewayTimeoutException,
  Get,
  Inject,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import { firstValueFrom, timeout, TimeoutError } from 'rxjs';
import { parseUzPhoneSearch, Roles as RoleEnum } from '@app/common';
import { successRes } from '../../../libs/common/helpers/response';
import { JwtAuthGuard } from './auth/jwt-auth.guard';
import { Roles } from './auth/roles.decorator';
import { RolesGuard } from './auth/roles.guard';

interface JwtUser {
  sub: string;
  roles?: string[];
}

/** hiqRNhkI: javobdagi takliflar soni (BeePost `take(10)`). */
export const CUSTOMER_SUGGEST_LIMIT = 10;
/**
 * Market doirasidagi rollar uchun identity'dan olinadigan nomzodlar —
 * keyin order-service xulosasi bilan SHU marketda buyurtmasi borlarigacha
 * qisqartiriladi. To'liq (9 raqamli) raqamda nomzod odatda bitta.
 */
export const CUSTOMER_SUGGEST_CANDIDATES = 50;

/**
 * hiqRNhkI: buyurtma yaratadigan rollar (POST /orders + market operatori).
 * Kuryer, mijoz, investor, logist, ichki operator — YO'Q.
 */
export const CUSTOMER_SUGGEST_ROLES: string[] = [
  RoleEnum.SUPERADMIN,
  RoleEnum.ADMIN,
  RoleEnum.REGISTRATOR,
  RoleEnum.MANAGER,
  RoleEnum.BRANCH,
  RoleEnum.MARKET,
  RoleEnum.MARKET_OPERATOR,
];

const ID_RE = /^\d+$/;
const RPC_TIMEOUT_MS = 8000;

export interface CustomerSuggestion {
  id: string;
  name: string | null;
  phone_number: string | null;
  extra_number: string | null;
  address: string | null;
  region_id: string | null;
  district_id: string | null;
  /** Shu marketdagi buyurtmalar soni (market konteksti bo'lmasa null). */
  orders_count: number | null;
  /** Shu marketdagi `created`/`new` buyurtmalar soni. */
  new_orders_count: number | null;
  /** `new_orders_count > 0` — "Diqqat! Yangi holatdagi buyurtma bor". */
  has_new_orders: boolean;
  /** Eng yangi `created`/`new` buyurtma id'lari (ko'pi bilan 5). */
  new_order_ids: string[];
  last_order_at: string | null;
  /**
   * 9444UAa8 — qaysi raqam mos keldi: `phone` (asosiy), `extra_number`
   * («Qo'shimcha raqam: …» belgisi) yoki `name`.
   */
  matched_by: CustomerMatchedBy;
}

export type CustomerMatchedBy = 'phone' | 'extra_number' | 'name';

const CUSTOMER_MATCHED_BY: readonly CustomerMatchedBy[] = [
  'phone',
  'extra_number',
  'name',
];

interface MarketSummaryItem {
  customer_id: string;
  orders: number;
  new_orders: number;
  new_order_ids?: string[];
  last_order_at?: string | Date | null;
}

const text = (value: unknown): string | null =>
  typeof value === 'string' || typeof value === 'number' ? String(value) : null;

/**
 * MIJOZNI TELEFON BO'YICHA TAKLIF QILISH (hiqRNhkI).
 *
 * Qidiruvning o'zi identity'da allaqachon bor edi (`identity.customer.search`,
 * `parseUzPhoneSearch` — formatdan qat'i nazar), lekin HTTP orqali ochilmagan
 * edi: operator mavjud mijoz raqamini kiritganda ism/tuman/manzil har safar
 * qo'lda yozilardi.
 *
 * DOIRA (shaxsiy ma'lumot oqib chiqmasin — fix3 RBAC-01 tamoyili):
 *   - SUPERADMIN / ADMIN — barcha mijozlar; `market_id` berilsa shu marketdagi
 *     buyurtma xulosasi qo'shiladi;
 *   - MARKET — FAQAT o'z marketida buyurtmasi bo'lgan mijozlar (query'dagi
 *     `market_id` e'tiborsiz — token `sub`);
 *   - MARKET_OPERATOR — biriktirilgan marketi (identity `user.market_id`;
 *     biriktirilmagan bo'lsa 400);
 *   - REGISTRATOR / MANAGER / BRANCH — `market_id` MAJBURIY (buyurtma shu
 *     market uchun yaratiladi), faqat shu marketdagi mijozlar.
 *
 * Javob — oq ro'yxatdagi maydonlar (parol, username, tariflar va h.k. YO'Q).
 * Telefon jurnalga yozilmaydi.
 */
@ApiTags('Customers')
@Controller('customers')
export class CustomerGatewayController {
  constructor(
    @Inject('IDENTITY') private readonly identityClient: ClientProxy,
    @Inject('ORDER') private readonly orderClient: ClientProxy,
  ) {}

  private async send<T>(
    client: ClientProxy,
    pattern: { cmd: string },
    payload: object,
    service: string,
  ): Promise<T> {
    return firstValueFrom(
      client.send<T>(pattern, payload).pipe(timeout(RPC_TIMEOUT_MS)),
    ).catch((error: unknown) => {
      if (error instanceof TimeoutError) {
        throw new GatewayTimeoutException(
          `${service} service response timeout`,
        );
      }
      throw error;
    });
  }

  private normalizeRoles(user?: JwtUser): string[] {
    return (user?.roles ?? []).map((role) =>
      String(role ?? '')
        .trim()
        .toLowerCase(),
    );
  }

  private async resolveOperatorMarketId(user: JwtUser): Promise<string> {
    const profile: unknown = await this.send(
      this.identityClient,
      { cmd: 'identity.user.find_by_id' },
      { id: user?.sub },
      'Identity',
    ).catch(() => null);
    return (
      text(
        (profile as { data?: { market_id?: unknown } } | null)?.data?.market_id,
      ) ?? ''
    ).trim();
  }

  /**
   * Qaysi market konteksti va natija shu market mijozlari bilan
   * CHEKLANADIMI (`scoped`).
   */
  async resolveScope(
    user: JwtUser,
    queryMarketId?: string,
  ): Promise<{ marketId: string | null; scoped: boolean }> {
    const roles = this.normalizeRoles(user);
    const requested = String(queryMarketId ?? '').trim();
    if (requested && !ID_RE.test(requested)) {
      throw new BadRequestException("market_id noto'g'ri");
    }

    if (roles.includes(RoleEnum.SUPERADMIN) || roles.includes(RoleEnum.ADMIN)) {
      return { marketId: requested || null, scoped: false };
    }
    if (roles.includes(RoleEnum.MARKET)) {
      const own = String(user?.sub ?? '').trim();
      if (!ID_RE.test(own)) {
        throw new BadRequestException('Market aniqlanmadi');
      }
      return { marketId: own, scoped: true };
    }
    if (roles.includes(RoleEnum.MARKET_OPERATOR)) {
      const marketId = await this.resolveOperatorMarketId(user);
      if (!ID_RE.test(marketId)) {
        throw new BadRequestException(
          'Operator hech qaysi marketga biriktirilmagan',
        );
      }
      return { marketId, scoped: true };
    }
    // REGISTRATOR / MANAGER / BRANCH (RolesGuard boshqasini o'tkazmaydi).
    if (!requested) {
      throw new BadRequestException(
        'market_id majburiy — mijoz shu market buyurtmalari ichidan qidiriladi',
      );
    }
    return { marketId: requested, scoped: true };
  }

  @Get('suggest')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(...CUSTOMER_SUGGEST_ROLES)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      'Mijozni telefon bo`yicha taklif qilish (buyurtma yaratish formasi)',
    description:
      "Telefon har qanday formatda (+998 90 123 45 67, 901234567, 0901234567; kamida 7 raqam). Asosiy telefon VA qo'shimcha raqam (`extra_number`, 9444UAa8) bo'yicha qidiriladi; `matched_by`: `phone` | `extra_number` | `name` — qaysi raqam mos kelgani («Qo'shimcha raqam: …» belgisi shundan). Market/market operatori/filial xodimi faqat shu marketda buyurtmasi bo'lgan mijozlarni ko'radi (qo'shimcha raqam bo'yicha topilganlar ham); admin — hammasini. Har taklifda shu marketdagi `orders_count`, `new_orders_count`, `has_new_orders` (takroriy buyurtma ogohlantirishi). Ko'pi bilan 10 ta.",
  })
  @ApiQuery({ name: 'phone', required: true, example: '901234567' })
  @ApiQuery({
    name: 'market_id',
    required: false,
    description:
      'Registrator/menejer/filial uchun majburiy; admin uchun ixtiyoriy (xulosa uchun); market/operator uchun e`tiborsiz.',
  })
  async suggest(
    @Query('phone') phone: string | undefined,
    @Query('market_id') marketId: string | undefined,
    @Req() req: { user: JwtUser },
  ) {
    const phoneText = typeof phone === 'string' ? phone.trim() : '';
    if (!parseUzPhoneSearch(phoneText)) {
      throw new BadRequestException(
        "phone — telefon raqam kerak (kamida 7 raqam; faqat raqam, +, bo'sh joy, qavs, tire)",
      );
    }
    const scope = await this.resolveScope(req.user, marketId);

    const searchRes = await this.send<{ data?: unknown[] }>(
      this.identityClient,
      { cmd: 'identity.customer.search' },
      {
        search: phoneText,
        limit: scope.scoped
          ? CUSTOMER_SUGGEST_CANDIDATES
          : CUSTOMER_SUGGEST_LIMIT,
        // 9444UAa8: qo'shimcha raqam bo'yicha ham. Topilganlar ham pastdagi
        // market doirasi filtridan o'tadi (doiradan tashqari mijoz chiqmaydi).
        match_extra_number: true,
      },
      'Identity',
    );
    const candidates = (Array.isArray(searchRes?.data) ? searchRes.data : [])
      .filter(
        (row): row is Record<string, unknown> =>
          !!row && typeof row === 'object',
      )
      .filter((row) => ID_RE.test(text(row.id) ?? ''));

    let summaries: Map<string, MarketSummaryItem> | null = null;
    if (scope.marketId && candidates.length) {
      const summaryRes = await this.send<{
        data?: { items?: MarketSummaryItem[] };
      }>(
        this.orderClient,
        { cmd: 'order.customer.market_summary' },
        {
          market_id: scope.marketId,
          customer_ids: candidates.map((row) => text(row.id)),
        },
        'Order',
      );
      summaries = new Map(
        (summaryRes?.data?.items ?? []).map((item) => [
          String(item.customer_id),
          item,
        ]),
      );
    }

    const rows = scope.scoped
      ? candidates.filter((row) => summaries?.has(text(row.id) ?? ''))
      : candidates;

    const data: CustomerSuggestion[] = rows
      .slice(0, CUSTOMER_SUGGEST_LIMIT)
      .map((row) => {
        const id = text(row.id) ?? '';
        const summary = summaries?.get(id);
        const hasMarket = summaries !== null;
        const lastOrderAt = summary?.last_order_at;
        return {
          id,
          name: text(row.name),
          phone_number: text(row.phone_number),
          extra_number: text(row.extra_number),
          address: text(row.address),
          region_id: text(row.region_id),
          district_id: text(row.district_id),
          orders_count: hasMarket ? Number(summary?.orders ?? 0) : null,
          new_orders_count: hasMarket ? Number(summary?.new_orders ?? 0) : null,
          has_new_orders: Number(summary?.new_orders ?? 0) > 0,
          new_order_ids: (summary?.new_order_ids ?? []).map(String),
          last_order_at:
            lastOrderAt instanceof Date
              ? lastOrderAt.toISOString()
              : (text(lastOrderAt) ?? null),
          matched_by: CUSTOMER_MATCHED_BY.includes(
            row.matched_by as CustomerMatchedBy,
          )
            ? (row.matched_by as CustomerMatchedBy)
            : 'phone',
        };
      });

    return successRes(data, 200, 'Customer suggestions');
  }
}
