import { Inject, Injectable, Logger } from '@nestjs/common';
import { ClientProxy, RpcException } from '@nestjs/microservices';
import { firstValueFrom, timeout, TimeoutError } from 'rxjs';
import type { EntityManager } from 'typeorm';
import {
  ORDER_FULFILLMENT_MODES,
  type OrderFulfillmentMode,
  Order_status,
  OutboxEvent,
  OutboxService,
  Roles,
  WAREHOUSE_RPC,
} from '@app/common';
import { Order, OrderHolderType } from '../entities/order.entity';
import { OrderItem } from '../entities/order-item.entity';
import { OrderTracking } from '../entities/order-tracking.entity';
import { OrderCustodyEvent } from '../entities/order-custody-event.entity';
import { OrderCustodyService } from '../custody/order-custody.service';

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
 *   3) kuryerga berilmasdan o'chirish (`remove`): `onOrderRemoved` → `release`.
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

export interface WarehouseCreatePlan {
  warehouse_id: string;
  warehouse_name: string | null;
  /** Viloyat filiali — buyurtma shu yerda «qabul qilingan» bo'ladi. */
  branch_id: string;
  market_id: string | null;
  items: Array<{ product_id: string; quantity: number }>;
}

export interface WarehouseRef {
  id: string;
  name: string | null;
  branch_id: string | null;
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
  return refs.get(id) ?? { id, name: null, branch_id: null };
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
  ) {}

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
    return {
      warehouse_id: warehouseId,
      warehouse_name: text(warehouse?.name) || null,
      branch_id: branchId,
      market_id: marketId,
      items,
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
   */
  async onOrderWritten(
    ctx: {
      order: Order;
      oldStatus: Order_status;
      previousHolderType?: OrderHolderType | null;
      requester?: Requester;
    },
    manager: EntityManager,
  ): Promise<void> {
    const { order } = ctx;
    if (order.fulfillment_source !== 'WAREHOUSE') return;
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
      await this.returnToWarehouse(order, ctx.requester ?? null, manager);
    }
  }

  private async returnToWarehouse(
    order: Order,
    requester: Requester,
    manager: EntityManager,
  ): Promise<void> {
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
      note: `Buyurtma #${order.id} bekor — omborga qaytdi`,
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
      'Ombor buyurtmasi omborga qaytarildi — qoldiq tiklandi (HQ qaytarish oqimisiz)';
    await this.custody.createTrackingEvent(
      {
        order_id: String(order.id),
        from_status: Order_status.CANCELLED,
        to_status: Order_status.RETURNED_TO_MARKET,
        changed_by: changedBy,
        changed_by_role: changedByRole,
        action: 'warehouse_returned',
        description: 'Omborga qaytarildi',
        metadata: { warehouse_id: order.warehouse_id },
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
   * bo'shaydi. HQ buyurtma — hech narsa.
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
   * Ro'yxat/detal boyitishi: `warehouse: { id, name, branch_id }`. Catalog
   * javob bermasa — id bilan, nom/filial `null` (manba belgisi baribir
   * `fulfillment_source` da).
   */
  async loadWarehouseRefs(
    ids: Array<string | null | undefined>,
  ): Promise<Map<string, WarehouseRef>> {
    const unique = Array.from(
      new Set(ids.map((id) => idOrNull(id)).filter((id): id is string => !!id)),
    );
    const map = new Map<string, WarehouseRef>(
      unique.map((id) => [id, { id, name: null, branch_id: null }]),
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
