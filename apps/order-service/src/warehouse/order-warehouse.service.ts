import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { ClientProxy, RpcException } from '@nestjs/microservices';
import { firstValueFrom, timeout, TimeoutError } from 'rxjs';
import { In, type EntityManager } from 'typeorm';
import {
  ORDER_FULFILLMENT_MODES,
  type OrderFulfillmentMode,
  Order_status,
  OutboxEvent,
  OutboxService,
  Roles,
  type WarehouseKind,
  WAREHOUSE_RPC,
} from '@app/common';
import { Order, OrderHolderType } from '../entities/order.entity';
import { OrderItem } from '../entities/order-item.entity';
import { OrderTracking } from '../entities/order-tracking.entity';
import { OrderCustodyEvent } from '../entities/order-custody-event.entity';
import { OrderCustodyService } from '../custody/order-custody.service';
import { OrderLookupService } from '../lookup/order-lookup.service';

/**
 * 6kHnNH9j — ombor ↔ buyurtma oqimi (order-service tomoni).
 *
 * `order-lifecycle.service.ts` da faqat chaqiruv nuqtalari qoladi:
 *   1) yaratish (`create`): `planCreate` → ombor tanlansa `createOnce` ichida,
 *      buyurtma yozuvi bilan BITTA tranzaksiyada `reserveForNewOrder`;
 *      band bo'lmasa — butun buyurtma HQ bilan qayta yaratiladi;
 *   2) har holat/egalik yozuvi (`updateFull` → `writeOrderChanges`):
 *      `onOrderWritten` — kuryerga berish → `out`, bekor posilka filialga
 *      qaytdi → `return` (o'sha omborga) + buyurtma yopiladi;
 *   3) kuryerga berilmasdan o'chirish (`remove`, pochtadan o'chirish):
 *      `onOrderRemoved` → `release`.
 *
 * VkKDSNNn — MARKAZIY OMBOR (2-pog'ona, catalog kaliti
 * `WAREHOUSE_HQ_TIER_ENABLED`). Markaziy ombor buyurtmasi =
 * `fulfillment_source = 'WAREHOUSE'` VA `home_branch_id = HQ id` (yangi ustun
 * yo'q). U HQ'da «qabul qilingan» bo'lib yaratiladi (pochtaga biriktiriladi);
 * HQ'dan chiqishi (filialga jo'natish yoki kuryer) → `out`; HQ'ga bekor
 * bo'lib qaytishi (bekor posilka, qaytarish partiyasi yoki HQ'da bekor) →
 * `return` (Markaziy omborga) va buyurtma yopiladi — marketga topshirilmaydi.
 * HQ id aniqlanmasa HQ-tur mantiq ishlamaydi (fail-closed); viloyat ombori
 * xulqi o'zgarmaydi.
 *
 * RPC XATOSI BUYURTMA HOLATINI BUZMAYDI:
 *   - `reserve` — sinxron, buyurtma tranzaksiyasi ichida. Xato/timeout →
 *     tranzaksiya qaytariladi va buyurtma HQ bilan yaratiladi. Har `reserve`
 *     dan OLDIN alohida (darhol commit) «qo'riqchi» outbox hodisasi yoziladi:
 *     `catalog.warehouse.release` 10 daqiqadan keyin. Buyurtma WAREHOUSE
 *     bo'lib commit bo'lsa qo'riqchi O'SHA tranzaksiyada o'chiriladi; aks
 *     holda (timeout'da band bo'lib qolgan, commit yiqilgan, jarayon o'lgan)
 *     u yetim bandni bo'shatadi (`release` bandsiz buyurtmada — no-op);
 *   - `out` / `release` / `return` — tranzaksion outbox: buyurtma o'zgarishi
 *     bilan bir tranzaksiyada yoziladi, publisher yetkazadi (catalog
 *     idempotent — buyurtma id + harakat kaliti; takror yetkazish no-op).
 *     Patternlar `catalog.warehouse.*` doimiy (poison bo'lmaydi), `out`
 *     `lenient` — tartib almashsa (return oldin kelsa) 409 o'rniga no-op.
 *
 * Pul hisobi (settlement, kassa) va tarif — o'zgarmaydi.
 */
export const WAREHOUSE_RPC_TIMEOUT_MS = 3000;
/** Qo'riqchi `release` kechikishi — buyurtma tranzaksiyasidan ancha uzun. */
export const WAREHOUSE_RESERVE_GUARD_DELAY_MS = 10 * 60_000;
export const WAREHOUSE_RESERVE_GUARD_NOTE = 'order_create_guard';

/** Ombordan buyurtma yaratishi mumkin bo'lganlar (qaror 5). */
const WAREHOUSE_CREATOR_ROLES: string[] = [
  Roles.SUPERADMIN,
  Roles.ADMIN,
  Roles.REGISTRATOR,
  Roles.MARKET,
  Roles.MARKET_OPERATOR,
];

const SYSTEM_ACTOR = { id: null, role: 'system' } as const;

/**
 * VkKDSNNn: HQ'ga qaytish partiyasida omborga QAYTARILMAYDIGAN holatlar —
 * pul harakati bor (sotilgan/to'langan) yoki allaqachon yopilgan.
 */
const RETURN_BATCH_SKIP_STATUSES: Order_status[] = [
  Order_status.RETURNED_TO_MARKET,
  Order_status.SOLD,
  Order_status.PAID,
  Order_status.PARTLY_PAID,
  Order_status.CLOSED,
];

export interface WarehouseCreatePlan {
  warehouse_id: string;
  warehouse_name: string | null;
  /**
   * Buyurtma shu filialda «qabul qilingan» bo'ladi: viloyat ombori — viloyat
   * filiali; Markaziy ombor (VkKDSNNn) — HQ filiali (= HQ id).
   */
  branch_id: string;
  market_id: string | null;
  items: Array<{ product_id: string; quantity: number }>;
  /** VkKDSNNn: ombor turi (catalog `warehouse.kind`; noma'lum — REGIONAL). */
  kind: WarehouseKind;
  /**
   * VkKDSNNn: catalog aniqlagan hudud (`resolve_source.region_id`) —
   * Markaziy ombor buyurtmasining pochtasi shu hududga biriktiriladi.
   */
  region_id: string | null;
}

export interface WarehouseRef {
  id: string;
  name: string | null;
  branch_id: string | null;
  /** VkKDSNNn: catalog `find_by_ids` dagi tur; catalog javob bermasa `null`. */
  kind: WarehouseKind | null;
}

type Requester = { id?: string | null; roles?: string[] | null } | null;

/** `reserve` bo'lmadi — chaqiruvchi buyurtmani HQ bilan qayta yaratadi. */
export class WarehouseReserveFallback extends Error {
  constructor(
    readonly reason: string,
    /** Timeout/5xx — catalog band qilgan bo'lishi mumkin (qo'riqchi bo'shatadi). */
    readonly ambiguous: boolean,
  ) {
    super(`Ombor bandi bo'lmadi (${reason}) — buyurtma HQ orqali`);
    this.name = 'WarehouseReserveFallback';
  }
}

/** Buyurtma qatori uchun `warehouse` (HQ — `null`). */
export function warehouseRefOf(
  row: { warehouse_id?: string | null },
  refs: Map<string, WarehouseRef>,
): WarehouseRef | null {
  const id = text(row?.warehouse_id);
  if (!id) return null;
  return refs.get(id) ?? { id, name: null, branch_id: null, kind: null };
}

export function isWarehouseReserveFallback(
  error: unknown,
): error is WarehouseReserveFallback {
  return error instanceof WarehouseReserveFallback;
}

const text = (value: unknown): string =>
  typeof value === 'string' || typeof value === 'number'
    ? String(value).trim()
    : '';

const idOrNull = (value: unknown): string | null => {
  const raw = text(value);
  return /^[1-9]\d{0,18}$/.test(raw) ? raw : null;
};

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

/** RPC xatosidan `statusCode` (Nest RMQ — oddiy obyekt yoki RpcException). */
const rpcStatus = (error: unknown): number | null => {
  const record =
    error instanceof RpcException
      ? asRecord(error.getError())
      : asRecord(error);
  const status = record?.statusCode ?? record?.status;
  return typeof status === 'number' ? status : null;
};

const rpcCode = (error: unknown): string | null => {
  const record =
    error instanceof RpcException
      ? asRecord(error.getError())
      : asRecord(error);
  return text(record?.code) || null;
};

@Injectable()
export class OrderWarehouseService {
  private readonly logger = new Logger(OrderWarehouseService.name);

  constructor(
    @Inject('CATALOG') private readonly catalogClient: ClientProxy,
    private readonly outbox: OutboxService,
    private readonly custody: OrderCustodyService,
    // VkKDSNNn: HQ id (Markaziy ombor buyurtmasini aniqlash). Ixtiyoriy —
    // usiz (eski spec'lar) hamma ombor buyurtmasi viloyat semantikasida.
    @Optional() private readonly lookup?: OrderLookupService,
  ) {}

  /**
   * VkKDSNNn: HQ filiali id'si (OrderLookupService keshi). Lookup yo'q yoki
   * xato — `null`: chaqiruvchi HQ-tur mantiqni ishlatmaydi (fail-closed).
   */
  private async hqBranchId(): Promise<string | null> {
    if (!this.lookup) return null;
    try {
      return idOrNull(await this.lookup.getHqBranchId());
    } catch (error) {
      this.logger.warn(
        `HQ filiali aniqlanmadi: ${(error as Error)?.message ?? String(error)}`,
      );
      return null;
    }
  }

  private send<T = unknown>(cmd: string, payload: unknown): Promise<T> {
    return firstValueFrom(
      this.catalogClient
        .send<T>({ cmd }, payload)
        .pipe(timeout(WAREHOUSE_RPC_TIMEOUT_MS)),
    );
  }

  private roles(requester: Requester): string[] {
    return (requester?.roles ?? []).map((role) => text(role).toLowerCase());
  }

  private actorOf(requester: Requester) {
    const id = text(requester?.id);
    return /^\d{1,19}$/.test(id)
      ? { id, roles: this.roles(requester) }
      : SYSTEM_ACTOR;
  }

  /**
   * `fulfillment` (gateway: `POST /orders` va ai-confirm, sukut `auto`).
   * Berilmasa — `null`: ichki yo'llar (bot, hamkor, import, qisman sotuv)
   * hozirgidek HQ. Noto'g'ri qiymat — 400.
   */
  fulfillmentMode(raw: unknown): OrderFulfillmentMode | null {
    if (raw === undefined || raw === null || raw === '') return null;
    const value = text(raw).toLowerCase();
    if (!(ORDER_FULFILLMENT_MODES as readonly string[]).includes(value)) {
      throw new RpcException({
        statusCode: 400,
        message: `fulfillment — ${ORDER_FULFILLMENT_MODES.join(' yoki ')}`,
      });
    }
    return value as OrderFulfillmentMode;
  }

  /**
   * Yaratishdan OLDIN manba (qaror 4/5): `auto` + yaratuvchi SA/ADMIN/
   * REGISTRATOR/MARKET/MARKET_OPERATOR + hamma qator katalog mahsuloti +
   * tuman (yoki viloyat) bor + `resolve_source` → `WAREHOUSE`. Aks holda
   * `null` (HQ). Market kaliti `can_order_from_warehouse` ni catalog
   * tekshiradi (fail-closed). SA/ADMIN aniq joylashuv (kuryer, pochta, holat,
   * partiya) bergan bo'lsa — HQ: buyurtma qo'lda joylashtirilyapti.
   * Catalog javob bermasa — HQ (buyurtma yaratish to'xtamaydi).
   *
   * VkKDSNNn: catalog Markaziy omborni tanlasa (`warehouse.kind = 'HQ'`,
   * kalit yoqilgan) — reja `kind: 'HQ'`, faqat HQ id aniq, ombor filiali
   * aynan HQ va hudud (`region_id`) bor bo'lsa. Aks holda `null` (oddiy HQ,
   * market olib keladi) — noaniq HQ-tur buyurtma yaratilmaydi (fail-closed).
   */
  async planCreate(
    dto: {
      fulfillment?: unknown;
      market_id?: unknown;
      district_id?: unknown;
      region_id?: unknown;
      status?: unknown;
      source?: unknown;
      courier_id?: unknown;
      post_id?: unknown;
      current_batch_id?: unknown;
      canceled_post_id?: unknown;
      parent_order_id?: unknown;
      external_id?: unknown;
      items?: Array<{ product_id?: unknown; quantity?: unknown }> | null;
    },
    requester?: Requester,
  ): Promise<WarehouseCreatePlan | null> {
    if (this.fulfillmentMode(dto?.fulfillment) !== 'auto') return null;
    const roles = this.roles(requester ?? null);
    if (!WAREHOUSE_CREATOR_ROLES.some((role) => roles.includes(role))) {
      return null;
    }
    const explicitPlacement = [
      dto.courier_id,
      dto.post_id,
      dto.current_batch_id,
      dto.canceled_post_id,
      dto.parent_order_id,
      dto.external_id,
    ].some((value) => text(value) !== '');
    const explicitStatus =
      text(dto.status) !== '' && text(dto.status) !== Order_status.NEW;
    if (
      explicitPlacement ||
      explicitStatus ||
      text(dto.source).toLowerCase() === 'external'
    ) {
      return null;
    }
    const items = this.catalogItems(dto.items);
    if (!items) return null;
    const districtId = idOrNull(dto.district_id);
    const regionId = idOrNull(dto.region_id);
    if (!districtId && !regionId) return null;
    const marketId = idOrNull(dto.market_id);

    let response: unknown;
    try {
      response = await this.send(WAREHOUSE_RPC.RESOLVE_SOURCE, {
        // Tuman bor bo'lsa — faqat u (catalog: assigned_region ?? region_id,
        // HQ pochtasi bilan AYNI tartib); aks holda viloyat.
        ...(districtId ? { district_id: districtId } : { region_id: regionId }),
        market_id: marketId,
        items,
        requester: {
          id: text(requester?.id) || null,
          roles,
        },
      });
    } catch (error) {
      this.logger.warn(
        `resolve_source javob bermadi — buyurtma HQ orqali: ${(error as Error)?.message ?? String(error)}`,
      );
      return null;
    }
    const result = asRecord(response);
    const warehouse = asRecord(result?.warehouse);
    const warehouseId = idOrNull(warehouse?.id);
    const branchId = idOrNull(warehouse?.branch_id);
    if (result?.source !== 'WAREHOUSE' || !warehouseId || !branchId) {
      return null;
    }
    const kind: WarehouseKind = warehouse?.kind === 'HQ' ? 'HQ' : 'REGIONAL';
    const resolvedRegionId = idOrNull(result?.region_id);
    if (kind === 'HQ') {
      // VkKDSNNn: Markaziy ombor — HQ'da qabul qilinadi va hudud pochtasiga
      // biriktiriladi; HQ id yoki hudud noaniq bo'lsa yaratilmaydi.
      const hqId = await this.hqBranchId();
      if (!hqId || branchId !== hqId || !resolvedRegionId) {
        this.logger.warn(
          `Markaziy ombor #${warehouseId} rejasi rad etildi (HQ id: ${hqId ?? "noma'lum"}, ombor filiali: ${branchId}, hudud: ${resolvedRegionId ?? "yo'q"}) — buyurtma HQ orqali`,
        );
        return null;
      }
    }
    return {
      warehouse_id: warehouseId,
      warehouse_name: text(warehouse?.name) || null,
      branch_id: branchId,
      market_id: marketId,
      items,
      kind,
      region_id: resolvedRegionId,
    };
  }

  /** Hamma qator katalog mahsuloti (`product_id`) va butun son ≥ 1 bo'lsa. */
  private catalogItems(
    raw: Array<{ product_id?: unknown; quantity?: unknown }> | null | undefined,
  ): Array<{ product_id: string; quantity: number }> | null {
    if (!Array.isArray(raw) || !raw.length) return null;
    const items: Array<{ product_id: string; quantity: number }> = [];
    for (const item of raw) {
      const productId = idOrNull(item?.product_id);
      const quantity =
        item?.quantity === undefined || item?.quantity === null
          ? 1
          : Number(item.quantity);
      if (!productId || !Number.isInteger(quantity) || quantity < 1) {
        return null;
      }
      items.push({ product_id: productId, quantity });
    }
    return items;
  }

  /**
   * Buyurtma tranzaksiyasi ICHIDA (`manager`), buyurtma qatori yozilgandan
   * keyin: qo'riqchi → `reserve` → qo'riqchini shu tranzaksiyada o'chirish.
   * Bo'lmasa `WarehouseReserveFallback` (tranzaksiya qaytariladi, buyurtma
   * HQ bilan qayta yaratiladi). Takroriy `reserve` (o'sha buyurtma id) —
   * catalog'da `already: true`, qoldiq ikki marta band bo'lmaydi.
   */
  async reserveForNewOrder(
    input: {
      order_id: string;
      plan: WarehouseCreatePlan;
      requester?: Requester;
    },
    manager: EntityManager,
  ): Promise<void> {
    const orderId = text(input.order_id);
    let guard: OutboxEvent;
    try {
      // Alohida (darhol commit) yozuv — buyurtma tranzaksiyasi qaytarilsa
      // ham qoladi.
      guard = await this.outbox.enqueue(
        'CATALOG',
        WAREHOUSE_RPC.RELEASE,
        {
          order_id: orderId,
          actor: SYSTEM_ACTOR,
          lenient: true,
          note: WAREHOUSE_RESERVE_GUARD_NOTE,
        },
        {
          scheduledAt: new Date(Date.now() + WAREHOUSE_RESERVE_GUARD_DELAY_MS),
        },
      );
    } catch (error) {
      this.logger.warn(
        `Buyurtma #${orderId}: ombor qo'riqchisi yozilmadi — HQ orqali: ${(error as Error)?.message ?? String(error)}`,
      );
      throw new WarehouseReserveFallback('guard_failed', false);
    }

    try {
      await this.send(WAREHOUSE_RPC.RESERVE, {
        order_id: orderId,
        warehouse_id: input.plan.warehouse_id,
        items: input.plan.items,
        market_id: input.plan.market_id,
        actor: this.actorOf(input.requester ?? null),
      });
    } catch (error) {
      const status = rpcStatus(error);
      const definitive =
        !(error instanceof TimeoutError) &&
        status !== null &&
        status >= 400 &&
        status < 500;
      const reason =
        rpcCode(error) ??
        (error instanceof TimeoutError
          ? 'timeout'
          : `status_${status ?? 'unknown'}`);
      this.logger.warn(
        `Buyurtma #${orderId}: ombor #${input.plan.warehouse_id} bandi bo'lmadi (${reason}) — butun buyurtma HQ orqali`,
      );
      if (definitive) {
        // Hech narsa band qilinmagan — qo'riqchi kerak emas (best-effort).
        await this.outbox
          .markPublished(String(guard.id))
          .catch(() => undefined);
      }
      throw new WarehouseReserveFallback(reason, !definitive);
    }

    await manager.getRepository(OutboxEvent).delete({ id: guard.id });
  }

  /**
   * `updateFull` → `writeOrderChanges` ichida (buyurtma saqlangandan va
   * tracking/custody yozilgandan keyin), FAQAT `WAREHOUSE` buyurtmada:
   *   - posilka kuryerga o'tdi (egalik → COURIER) → `out` (outbox);
   *   - bekor posilka kuryerdan o'z ombori filialiga qabul qilindi
   *     (`cancelled (sent)` → `cancelled`, egalik — ombor filiali) →
   *     `return` (o'sha omborga) va buyurtma yopiladi: `returned_to_market`,
   *     egalik MARKET (mahsulot marketning ombordagi qoldig'iga qaytdi; HQ
   *     qaytarish oqimi va marketga topshirish yo'q).
   * Takroriy yozuv (o'tish yo'q) — hech narsa yozilmaydi.
   *
   * VkKDSNNn — Markaziy ombor buyurtmasi (`home_branch_id = HQ id`). HQ'da
   * turishi: egalik HQ yoki BRANCH/<HQ id> (partiya qabuli shakli):
   *   - HQ'dan chiqdi (boshqa filial/kuryer, MARKET emas) yoki kuryerga
   *     berildi → `out` (lenient; bola — yo'q, chiqim otada);
   *   - HQ'da turib `cancelled` ga o'tdi (bekor posilka HQ'ga qabul qilindi
   *     yoki HQ'da to'g'ridan bekor) → `return` (Markaziy omborga) + yopiladi.
   * HQ id aniqlanmasa — viloyat qoidasi (bugungi kod); lekin uydan/HQ'dan
   * boshqa filialga o'tish (Markaziy ombordan jo'natish bo'lishi mumkin —
   * `out` yo'qolmasin) — 503, yozuv bekor (fail-closed).
   */
  async onOrderWritten(
    ctx: {
      order: Order;
      oldStatus: Order_status;
      previousHolderType?: OrderHolderType | null;
      /** VkKDSNNn: yozuvdan oldingi `holder_branch_id`. */
      previousHolderBranchId?: string | null;
      requester?: Requester;
    },
    manager: EntityManager,
  ): Promise<void> {
    const { order } = ctx;
    if (order.fulfillment_source !== 'WAREHOUSE') return;
    const hqId = await this.hqBranchId();
    if (!hqId && this.lookup) {
      this.assertNoUnknownHqDispatch(ctx);
    }
    if (hqId && text(order.home_branch_id) === hqId) {
      await this.onHqWarehouseOrderWritten(ctx, hqId, manager);
      return;
    }
    const actor = this.actorOf(ctx.requester ?? null);

    const handedToCourier =
      order.holder_type === OrderHolderType.COURIER &&
      ctx.previousHolderType !== OrderHolderType.COURIER;
    // Qisman sotuvning bekor bolasi ota buyurtma bandida — chiqim otada.
    if (handedToCourier && !order.parent_order_id) {
      await this.enqueue(manager, WAREHOUSE_RPC.OUT, {
        order_id: String(order.id),
        actor,
        lenient: true,
        note: `Buyurtma #${order.id} kuryerga berildi`,
      });
    }

    const homeBranchId = text(order.home_branch_id);
    const returnedToWarehouseBranch =
      ctx.oldStatus === Order_status.CANCELLED_SENT &&
      order.status === Order_status.CANCELLED &&
      order.holder_type === OrderHolderType.BRANCH &&
      homeBranchId !== '' &&
      text(order.holder_branch_id) === homeBranchId;
    if (returnedToWarehouseBranch) {
      await this.returnToWarehouse(
        order,
        ctx.requester ?? null,
        manager,
        'REGIONAL',
      );
    }
  }

  /**
   * VkKDSNNn (C1): HQ id noma'lum — buyurtma Markaziy ombornikimi, bilib
   * bo'lmaydi. Uydan (BRANCH/home) yoki HQ'dan boshqa filialga o'tish
   * Markaziy ombordan jo'natish bo'lishi mumkin (`out` kerak) — yozuv 503
   * bilan to'xtatiladi. Kuryerga o'tish — bugungi qoida bilan `out`
   * (turdan qat'i nazar), shuning uchun to'xtatilmaydi. Bola — chiqim otada.
   */
  private assertNoUnknownHqDispatch(ctx: {
    order: Order;
    previousHolderType?: OrderHolderType | null;
    previousHolderBranchId?: string | null;
  }): void {
    const { order } = ctx;
    if (order.parent_order_id) return;
    const homeBranchId = text(order.home_branch_id);
    const wasAtHomeOrHq =
      ctx.previousHolderType === OrderHolderType.HQ ||
      (ctx.previousHolderType === OrderHolderType.BRANCH &&
        homeBranchId !== '' &&
        text(ctx.previousHolderBranchId) === homeBranchId);
    const toOtherBranch =
      order.holder_type === OrderHolderType.BRANCH &&
      text(order.holder_branch_id) !== homeBranchId;
    if (wasAtHomeOrHq && toOtherBranch) {
      throw new RpcException({
        statusCode: 503,
        message: "Markaziy filial aniqlanmadi — qayta urinib ko'ring",
      });
    }
  }

  /** VkKDSNNn: Markaziy ombor buyurtmasi (`home_branch_id = hqId`). */
  private async onHqWarehouseOrderWritten(
    ctx: {
      order: Order;
      oldStatus: Order_status;
      previousHolderType?: OrderHolderType | null;
      previousHolderBranchId?: string | null;
      requester?: Requester;
    },
    hqId: string,
    manager: EntityManager,
  ): Promise<void> {
    const { order } = ctx;
    const atHq = (
      type: OrderHolderType | null | undefined,
      branchId: string | null | undefined,
    ) =>
      type === OrderHolderType.HQ ||
      (type === OrderHolderType.BRANCH && text(branchId) === hqId);

    const leftHq =
      atHq(ctx.previousHolderType, ctx.previousHolderBranchId) &&
      !atHq(order.holder_type, order.holder_branch_id) &&
      order.holder_type !== OrderHolderType.MARKET;
    const toCourier =
      order.holder_type === OrderHolderType.COURIER &&
      ctx.previousHolderType !== OrderHolderType.COURIER;
    // Qisman sotuvning bolasi — chiqim ota buyurtmada.
    if ((leftHq || toCourier) && !order.parent_order_id) {
      await this.enqueue(manager, WAREHOUSE_RPC.OUT, {
        order_id: String(order.id),
        actor: this.actorOf(ctx.requester ?? null),
        lenient: true,
        note: leftHq
          ? `Buyurtma #${order.id} markaziy ombordan jo'natildi`
          : `Buyurtma #${order.id} kuryerga berildi`,
      });
    }

    const cancelledAtHq =
      order.status === Order_status.CANCELLED &&
      ctx.oldStatus !== Order_status.CANCELLED &&
      atHq(order.holder_type, order.holder_branch_id);
    if (cancelledAtHq) {
      await this.returnToWarehouse(order, ctx.requester ?? null, manager, 'HQ');
    }
  }

  /**
   * VkKDSNNn: qaytarish partiyasi (`RETURN`) qabul qilindi — partiya
   * servisining QB yangilanishidan KEYIN, o'sha tranzaksiyada. Manzil HQ
   * bo'lsa, undagi Markaziy ombor buyurtmalari (yangi holat bilan) Markaziy
   * omborga qaytariladi va yopiladi. Sotilgan/to'langan/yopilgan — tegilmaydi.
   * Viloyat ombori buyurtmasi (K1) va HQ id noma'lum — hech narsa.
   *
   * ⚠️ «Tegilmaydi» qarori `priorStatusById` (QB yangilanishidan OLDINGI
   * holat) bo'yicha: partiya qabuli HAMMA buyurtmani RECEIVED/NEW ga yozadi,
   * shuning uchun qayta o'qilgan holat bo'yicha sotilgan buyurtmani ajratib
   * bo'lmaydi (partiyada turgan WAITING buyurtma sotilishi mumkin — sotilgan
   * tovar qoldiqqa qaytmasin). Oldingi holati noma'lum buyurtma — tegilmaydi
   * (fail-closed: soxta qoldiqdan ko'ra qaytmagan qoldiq xavfsizroq).
   */
  async onReturnBatchReceived(
    input: {
      orderIds: Array<string | null | undefined>;
      destinationBranchId: string | null | undefined;
      /** Partiya QB yangilanishidan OLDINGI holat (`id` → `status`). */
      priorStatusById: ReadonlyMap<string, Order_status | null | undefined>;
      requester?: Requester;
    },
    manager: EntityManager,
  ): Promise<void> {
    const ids = Array.from(
      new Set(
        (input.orderIds ?? [])
          .map((id) => idOrNull(id))
          .filter((id): id is string => !!id),
      ),
    );
    if (!ids.length) return;
    const hqId = await this.hqBranchId();
    if (!hqId || text(input.destinationBranchId) !== hqId) return;
    const orders = await manager.getRepository(Order).find({
      where: {
        id: In(ids),
        fulfillment_source: 'WAREHOUSE',
        home_branch_id: hqId,
        isDeleted: false,
      },
      order: { id: 'ASC' },
    });
    for (const order of orders) {
      const priorStatus = input.priorStatusById?.get(String(order.id));
      if (
        !priorStatus ||
        RETURN_BATCH_SKIP_STATUSES.includes(priorStatus) ||
        RETURN_BATCH_SKIP_STATUSES.includes(order.status)
      ) {
        if (!priorStatus) {
          this.logger.warn(
            `Qaytarish partiyasi: buyurtma #${order.id} oldingi holati noma'lum — Markaziy omborga qaytarilmadi`,
          );
        }
        continue;
      }
      await this.returnToWarehouse(
        order,
        input.requester ?? null,
        manager,
        'HQ',
      );
    }
  }

  private async returnToWarehouse(
    order: Order,
    requester: Requester,
    manager: EntityManager,
    kind: WarehouseKind,
  ): Promise<void> {
    // VkKDSNNn: tracking `from_status` — kirishdagi holat (viloyat yo'lida
    // doim `cancelled`; partiya yo'lida — `received`/`new`).
    const fromStatus = order.status;
    const parentId = text(order.parent_order_id);
    const items = parentId
      ? (
          await manager
            .getRepository(OrderItem)
            .find({ where: { order_id: String(order.id) } })
        )
          .filter((item) => idOrNull(item.product_id))
          .map((item) => ({
            product_id: String(item.product_id),
            quantity: Number(item.quantity ?? 1),
          }))
      : null;
    await this.enqueue(manager, WAREHOUSE_RPC.RETURN, {
      // Qisman sotuvning bolasi — band ota buyurtmada, faqat bola qatorlari
      // (alohida kalit: ota buyurtmaning boshqa qaytishlari bilan aralashmaydi).
      order_id: parentId || String(order.id),
      ...(items ? { items, idempotency_key: `child-order-${order.id}` } : {}),
      actor: this.actorOf(requester),
      note:
        kind === 'HQ'
          ? `Buyurtma #${order.id} markaziy omborga qaytdi`
          : `Buyurtma #${order.id} bekor — omborga qaytdi`,
    });

    const previous = {
      holder_type: order.holder_type,
      holder_branch_id: order.holder_branch_id,
      holder_courier_id: order.holder_courier_id,
    };
    const now = new Date();
    const handoverBy = /^\d{1,19}$/.test(text(requester?.id))
      ? text(requester?.id)
      : null;
    order.status = Order_status.RETURNED_TO_MARKET;
    order.return_requested = false;
    order.holder_type = OrderHolderType.MARKET;
    order.holder_branch_id = null;
    order.holder_courier_id = null;
    order.last_handover_at = now;
    order.last_handover_by = handoverBy;
    await manager.getRepository(Order).update(
      { id: String(order.id) },
      {
        status: Order_status.RETURNED_TO_MARKET,
        return_requested: false,
        holder_type: OrderHolderType.MARKET,
        holder_branch_id: null,
        holder_courier_id: null,
        last_handover_at: now,
        last_handover_by: handoverBy,
      },
    );
    const changedBy = text(requester?.id) || 'system';
    const changedByRole = text(requester?.id)
      ? this.custody.toTrackingRole(requester?.roles ?? [])
      : 'system';
    const note =
      kind === 'HQ'
        ? 'Markaziy ombor buyurtmasi omborga qaytarildi — qoldiq tiklandi'
        : 'Ombor buyurtmasi omborga qaytarildi — qoldiq tiklandi (HQ qaytarish oqimisiz)';
    await this.custody.createTrackingEvent(
      {
        order_id: String(order.id),
        from_status: fromStatus,
        to_status: Order_status.RETURNED_TO_MARKET,
        changed_by: changedBy,
        changed_by_role: changedByRole,
        action: 'warehouse_returned',
        description:
          kind === 'HQ' ? 'Markaziy omborga qaytarildi' : 'Omborga qaytarildi',
        metadata: { warehouse_id: order.warehouse_id, warehouse_kind: kind },
        note,
      },
      manager.getRepository(OrderTracking),
    );
    await this.custody.createCustodyEvent(
      {
        order_id: String(order.id),
        from_holder_type: previous.holder_type ?? null,
        to_holder_type: OrderHolderType.MARKET,
        from_branch_id: previous.holder_branch_id ?? null,
        to_branch_id: null,
        from_courier_id: previous.holder_courier_id ?? null,
        to_courier_id: null,
        changed_by: changedBy,
        changed_by_role: changedByRole,
        note,
      },
      manager.getRepository(OrderCustodyEvent),
    );
  }

  /**
   * Kuryerga berilmasdan o'chirish (`remove`, o'sha tranzaksiyada) → band
   * bo'shaydi. HQ buyurtma — hech narsa. VkKDSNNn: pochtadan o'chirish
   * (`deleteOrdersFromPostTx`) ham shu yerga — Markaziy ombor bandi osilib
   * qolmasin.
   */
  async onOrderRemoved(
    order: Pick<Order, 'id' | 'fulfillment_source'>,
    requester: Requester | undefined,
    manager: EntityManager,
  ): Promise<void> {
    if (order.fulfillment_source !== 'WAREHOUSE') return;
    await this.enqueue(manager, WAREHOUSE_RPC.RELEASE, {
      order_id: String(order.id),
      actor: this.actorOf(requester ?? null),
      lenient: true,
      note: `Buyurtma #${order.id} o'chirildi`,
    });
  }

  /** Qisman sotuvning bekor bolasi — ota buyurtma manbasini meros oladi. */
  inheritedFields(parent: Pick<Order, 'fulfillment_source' | 'warehouse_id'>) {
    return parent.fulfillment_source === 'WAREHOUSE' && parent.warehouse_id
      ? {
          fulfillment_source: 'WAREHOUSE' as const,
          warehouse_id: String(parent.warehouse_id),
        }
      : { fulfillment_source: 'HQ' as const, warehouse_id: null };
  }

  private async enqueue(
    manager: EntityManager,
    pattern: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    await this.outbox.enqueue('CATALOG', pattern, payload, { manager });
  }

  /**
   * Ro'yxat/detal boyitishi: `warehouse: { id, name, branch_id, kind }`.
   * Catalog javob bermasa — id bilan, nom/filial/tur `null` (manba belgisi
   * baribir `fulfillment_source` da). VkKDSNNn: `kind` — catalog'dagi tur
   * (REGIONAL | HQ).
   */
  async loadWarehouseRefs(
    ids: Array<string | null | undefined>,
  ): Promise<Map<string, WarehouseRef>> {
    const unique = Array.from(
      new Set(ids.map((id) => idOrNull(id)).filter((id): id is string => !!id)),
    );
    const map = new Map<string, WarehouseRef>(
      unique.map((id) => [id, { id, name: null, branch_id: null, kind: null }]),
    );
    if (!unique.length) return map;
    try {
      const response = await this.send<{ data?: unknown }>(
        WAREHOUSE_RPC.FIND_BY_IDS,
        { ids: unique },
      );
      const rows = Array.isArray(asRecord(response)?.data)
        ? (asRecord(response)?.data as unknown[])
        : [];
      for (const raw of rows) {
        const row = asRecord(raw);
        const id = idOrNull(row?.id);
        if (!row || !id || !map.has(id)) continue;
        map.set(id, {
          id,
          name: text(row.name) || null,
          branch_id: idOrNull(row.branch_id),
          kind: row.kind === 'HQ' || row.kind === 'REGIONAL' ? row.kind : null,
        });
      }
    } catch (error) {
      this.logger.warn(
        `catalog.warehouse.find_by_ids javob bermadi: ${(error as Error)?.message ?? String(error)}`,
      );
    }
    return map;
  }
}
