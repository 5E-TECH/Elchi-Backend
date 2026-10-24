import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';
import {
  ActivityAction,
  ActivityLogService,
  type StockMovementRefType,
  type StockMovementType,
  type StockReservationStatus,
  WAREHOUSE_ERROR_CODES,
  WAREHOUSE_MAX_QTY,
  WAREHOUSE_LOW_STOCK_MAX,
  WAREHOUSE_NOTE_MAX,
  WAREHOUSE_REASON_MIN,
} from '@app/common';
import { Warehouse } from './entities/warehouse.entity';
import { WarehouseStock } from './entities/warehouse-stock.entity';
import { StockMovement } from './entities/stock-movement.entity';
import { StockReservation } from './entities/stock-reservation.entity';
import { Product } from '../entities/product.entity';
import {
  findProductsByCode,
  loadProducts,
  WarehouseProductRow,
} from './warehouse-products';
import {
  badRequest,
  compareIds,
  mapWarehouseDbError,
  normalizeActor,
  normalizeOrderItems,
  normalizeStockLines,
  notFoundWarehouse,
  optionalIdempotencyKey,
  requireIdempotencyKey,
  returnedRows,
  rpcError,
  StockLine,
  tableRef,
  toId,
  toInt,
  toOptionalId,
  toOptionalText,
  WarehouseActor,
  WarehouseActorInput,
} from './warehouse.util';

interface LockedWarehouse {
  id: string;
  name: string;
  status: string;
  branch_id: string;
  low_stock_default: number;
}

interface StockRow {
  id: string;
  product_id: string;
  market_id: string;
  on_hand: number;
  reserved: number;
  low_stock_threshold: number | null;
}

interface ReservationRow {
  id: string;
  order_id: string;
  warehouse_id: string;
  product_id: string;
  market_id: string;
  qty: number;
  returned_qty: number;
  status: StockReservationStatus;
}

interface MovementResult {
  movement_id: string;
  on_hand: number;
  reserved: number;
}

interface Tables {
  warehouses: string;
  stock: string;
  movements: string;
  reservations: string;
  products: string;
}

/** Kirim/inventarizatsiya qatori mahsulotga bog'langandan keyin. */
interface ResolvedLine {
  product: WarehouseProductRow;
  value: number;
}

export interface StockInInput {
  warehouse_id: unknown;
  lines: unknown;
  market_id?: unknown;
  note?: unknown;
  idempotency_key?: unknown;
  actor?: WarehouseActorInput | null;
}

export interface InventoryInput {
  warehouse_id: unknown;
  lines: unknown;
  reason?: unknown;
  market_id?: unknown;
  idempotency_key?: unknown;
  actor?: WarehouseActorInput | null;
}

export interface ReserveInput {
  order_id: unknown;
  warehouse_id: unknown;
  items: unknown;
  market_id?: unknown;
  actor?: WarehouseActorInput | null;
}

export interface OrderOpInput {
  order_id: unknown;
  actor?: WarehouseActorInput | null;
  note?: unknown;
}

export interface ReturnInput extends OrderOpInput {
  items?: unknown;
  idempotency_key?: unknown;
}

const ORDER_LOCK_NAMESPACE = 'catalog.warehouse.order:';

/**
 * hY7uacJu: qoldiqni o'zgartiradigan HAMMA amal shu yerda — har biri bitta
 * tranzaksiya:
 *   1) buyurtma amallari — `pg_advisory_xact_lock(buyurtma)` (bitta
 *      buyurtmaning reserve/release/out/return'i ketma-ket);
 *   2) ombor qatori `FOR NO KEY UPDATE` (pauza va shu ombordagi boshqa
 *      yozuvlar bilan ketma-ket; FK tekshiruvlarini bloklamaydi);
 *   3) qoldiq qatorlari `FOR UPDATE`, `product_id` o'sish tartibida
 *      (deadlock yo'q);
 *   4) qoldiq o'zgarishi + `stock_movements` qatori (UNIQUE
 *      `idempotency_key`) — bir tranzaksiyada.
 * Qulf tartibi hamma joyda bir xil: buyurtma → ombor → qoldiq.
 * DB CHECK'lari (`on_hand ≥ 0`, `0 ≤ reserved ≤ on_hand`) oxirgi himoya.
 */
@Injectable()
export class WarehouseStockService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly activityLog: ActivityLogService,
  ) {}

  // ------------------------------------------------------------------
  // Tranzaksiya primitivlari
  // ------------------------------------------------------------------

  private async tx<T>(
    work: (manager: EntityManager) => Promise<T>,
  ): Promise<T> {
    try {
      return await this.dataSource.transaction('READ COMMITTED', work);
    } catch (error) {
      mapWarehouseDbError(error);
    }
  }

  private tables(manager: EntityManager): Tables {
    return {
      warehouses: tableRef(manager, Warehouse),
      stock: tableRef(manager, WarehouseStock),
      movements: tableRef(manager, StockMovement),
      reservations: tableRef(manager, StockReservation),
      products: tableRef(manager, Product),
    };
  }

  private async lockOrder(manager: EntityManager, orderId: string) {
    await manager.query(
      `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`,
      [`${ORDER_LOCK_NAMESPACE}${orderId}`],
    );
  }

  private async lockWarehouse(
    manager: EntityManager,
    warehouseId: string,
  ): Promise<LockedWarehouse> {
    const t = this.tables(manager);
    const rows: LockedWarehouse[] = await manager.query(
      `SELECT "id"::text AS id, "name", "status", "branch_id"::text AS branch_id,
              "low_stock_default"
         FROM ${t.warehouses}
        WHERE "id" = $1 AND "is_deleted" = false
        FOR NO KEY UPDATE`,
      [warehouseId],
    );
    if (!rows.length) notFoundWarehouse(warehouseId);
    return rows[0];
  }

  /** Yo'q qoldiq qatorlarini 0 bilan yaratadi (poygasiz: ON CONFLICT). */
  private async ensureStockRows(
    manager: EntityManager,
    warehouseId: string,
    products: WarehouseProductRow[],
  ) {
    if (!products.length) return;
    const t = this.tables(manager);
    await manager.query(
      `INSERT INTO ${t.stock} ("warehouse_id", "product_id", "market_id")
       SELECT $1::bigint, x.product_id, x.market_id
         FROM unnest($2::bigint[], $3::bigint[]) AS x(product_id, market_id)
       ON CONFLICT ("warehouse_id", "product_id") DO NOTHING`,
      [
        warehouseId,
        products.map((product) => product.id),
        products.map((product) => product.user_id),
      ],
    );
  }

  private async lockStockRows(
    manager: EntityManager,
    warehouseId: string,
    productIds: string[],
  ): Promise<Map<string, StockRow>> {
    if (!productIds.length) return new Map();
    const t = this.tables(manager);
    const rows: StockRow[] = await manager.query(
      `SELECT "id"::text AS id, "product_id"::text AS product_id,
              "market_id"::text AS market_id, "on_hand", "reserved",
              "low_stock_threshold"
         FROM ${t.stock}
        WHERE "warehouse_id" = $1 AND "product_id" = ANY($2::bigint[])
        ORDER BY "product_id" ASC
        FOR UPDATE`,
      [warehouseId, productIds],
    );
    return new Map(rows.map((row) => [row.product_id, row]));
  }

  private async readStockRows(
    manager: EntityManager,
    warehouseId: string,
    productIds: string[],
  ): Promise<Map<string, StockRow>> {
    if (!productIds.length) return new Map();
    const t = this.tables(manager);
    const rows: StockRow[] = await manager.query(
      `SELECT "id"::text AS id, "product_id"::text AS product_id,
              "market_id"::text AS market_id, "on_hand", "reserved",
              "low_stock_threshold"
         FROM ${t.stock}
        WHERE "warehouse_id" = $1 AND "product_id" = ANY($2::bigint[])`,
      [warehouseId, productIds],
    );
    return new Map(rows.map((row) => [row.product_id, row]));
  }

  /**
   * Qoldiq qatorini o'zgartiradi va harakatni yozadi (bitta tranzaksiyada).
   * `qty` — jurnaldagi ishorali son (tur bo'yicha).
   */
  private async applyMovement(
    manager: EntityManager,
    warehouseId: string,
    row: StockRow,
    change: {
      type: StockMovementType;
      qty: number;
      onHandDelta: number;
      reservedDelta: number;
      refType: StockMovementRefType;
      refId: string;
      actor: WarehouseActor;
      note?: string | null;
      key: string;
    },
  ): Promise<MovementResult> {
    const t = this.tables(manager);
    const updated = returnedRows<{ on_hand: number; reserved: number }>(
      await manager.query(
        `UPDATE ${t.stock}
            SET "on_hand" = "on_hand" + $2,
                "reserved" = "reserved" + $3,
                "last_movement_at" = now(),
                "updatedAt" = now()
          WHERE "id" = $1
        RETURNING "on_hand", "reserved"`,
        [row.id, change.onHandDelta, change.reservedDelta],
      ),
    );
    const after = updated[0];
    row.on_hand = after.on_hand;
    row.reserved = after.reserved;
    const inserted: Array<{ id: string }> = await manager.query(
      `INSERT INTO ${t.movements}
         ("warehouse_id", "product_id", "market_id", "type", "qty",
          "on_hand_after", "reserved_after", "ref_type", "ref_id",
          "actor_id", "actor_role", "note", "idempotency_key")
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
       RETURNING "id"::text AS id`,
      [
        warehouseId,
        row.product_id,
        row.market_id,
        change.type,
        change.qty,
        after.on_hand,
        after.reserved,
        change.refType,
        change.refId,
        change.actor.id,
        change.actor.role,
        change.note ?? null,
        change.key,
      ],
    );
    return {
      movement_id: inserted[0].id,
      on_hand: after.on_hand,
      reserved: after.reserved,
    };
  }

  /**
   * Kirim/inventarizatsiya qatorlarini mahsulotga bog'laydi: `product_id`
   * yoki skaner kodi (`barcode` / `sku_code`). Topilmagan, bir nechta
   * marketda topilgan (market tanlanmagan), o'chirilgan yoki boshqa
   * marketniki — HAMMASI birga 400 (hech narsa yozilmaydi). Bir mahsulot
   * qatorlari qo'shiladi (`merge`) yoki takror 400 (`unique`).
   */
  private async resolveLines(
    manager: EntityManager,
    lines: StockLine[],
    marketId: string | null,
    mode: 'merge' | 'unique',
  ): Promise<ResolvedLine[]> {
    const byId = await loadProducts(
      manager,
      lines.map((line) => line.product_id).filter((id): id is string => !!id),
    );
    const problems: string[] = [];
    const merged = new Map<string, ResolvedLine>();
    for (const line of lines) {
      let product: WarehouseProductRow | undefined;
      if (line.product_id) {
        product = byId.get(line.product_id);
        if (!product) {
          problems.push(`#${line.product_id} — mahsulot topilmadi`);
          continue;
        }
      } else {
        const code = line.code as string;
        const found = await findProductsByCode(manager, code, marketId);
        if (!found.length) {
          problems.push(`«${code.slice(0, 40)}» — mahsulot topilmadi`);
          continue;
        }
        if (found.length > 1) {
          problems.push(
            `«${code.slice(0, 40)}» — bir nechta marketda bor, marketni tanlang (market_id)`,
          );
          continue;
        }
        product = found[0];
      }
      if (product.is_deleted) {
        problems.push(`«${product.name}» — mahsulot o'chirilgan`);
        continue;
      }
      if (marketId && product.user_id !== marketId) {
        problems.push(`«${product.name}» — tanlangan marketniki emas`);
        continue;
      }
      const existing = merged.get(product.id);
      if (existing) {
        if (mode === 'unique') {
          problems.push(`«${product.name}» — ikki marta kiritilgan`);
          continue;
        }
        existing.value += line.value;
        if (existing.value > WAREHOUSE_MAX_QTY) {
          problems.push(
            `«${product.name}» — jami ${WAREHOUSE_MAX_QTY} donadan oshmasligi kerak`,
          );
        }
        continue;
      }
      merged.set(product.id, { product, value: line.value });
    }
    if (problems.length) {
      const shown = problems.slice(0, 10).join('; ');
      badRequest(
        `Qatorlar hal qilinmadi — hech narsa yozilmadi: ${shown}${
          problems.length > 10 ? ` (+${problems.length - 10})` : ''
        }`,
      );
    }
    return Array.from(merged.values()).sort((a, b) =>
      compareIds(a.product.id, b.product.id),
    );
  }

  // ------------------------------------------------------------------
  // Kirim (IN)
  // ------------------------------------------------------------------

  /**
   * Admin kirimi (qaror 3): darhol qoldiqqa, filial tasdig'isiz. To'xtatilgan
   * omborga ham mumkin (qoldiq saqlanadi). `Idempotency-Key` bilan qayta
   * yuborilgan AYNI so'rov — avvalgi natija (`replayed: true`), boshqa
   * tarkibli — 409.
   */
  async stockIn(input: StockInInput) {
    const warehouseId = toId(input?.warehouse_id, 'warehouse_id');
    const key = requireIdempotencyKey(input?.idempotency_key);
    const lines = normalizeStockLines(input?.lines, 'qty', 1);
    const marketId = toOptionalId(input?.market_id, 'market_id');
    const note =
      toOptionalText(input?.note, 'note', WAREHOUSE_NOTE_MAX) ?? null;
    const actor = normalizeActor(input?.actor);

    const result = await this.tx(async (manager) => {
      const t = this.tables(manager);
      const warehouse = await this.lockWarehouse(manager, warehouseId);
      const resolved = await this.resolveLines(
        manager,
        lines,
        marketId,
        'merge',
      );

      const previous: Array<{
        id: string;
        product_id: string;
        qty: number;
        on_hand_after: number;
        reserved_after: number;
      }> = await manager.query(
        `SELECT "id"::text AS id, "product_id"::text AS product_id, "qty",
                "on_hand_after", "reserved_after"
           FROM ${t.movements}
          WHERE "warehouse_id" = $1 AND "ref_type" = 'stock_in' AND "ref_id" = $2
          ORDER BY "product_id" ASC`,
        [warehouseId, key],
      );
      if (previous.length) {
        const same =
          previous.length === resolved.length &&
          resolved.every((line) =>
            previous.some(
              (row) =>
                row.product_id === line.product.id && row.qty === line.value,
            ),
          );
        if (!same) {
          rpcError(
            409,
            "Bu Idempotency-Key boshqa tarkibli kirim uchun ishlatilgan — yangi so'rovga yangi kalit bering",
            { code: WAREHOUSE_ERROR_CODES.IDEMPOTENCY_CONFLICT },
          );
        }
        return {
          warehouse,
          replayed: true,
          lines: resolved.map((line) => {
            const row = previous.find(
              (item) => item.product_id === line.product.id,
            )!;
            return {
              line,
              movement: {
                movement_id: row.id,
                on_hand: row.on_hand_after,
                reserved: row.reserved_after,
              },
            };
          }),
        };
      }

      await this.ensureStockRows(
        manager,
        warehouseId,
        resolved.map((line) => line.product),
      );
      const rows = await this.lockStockRows(
        manager,
        warehouseId,
        resolved.map((line) => line.product.id),
      );
      const applied: Array<{ line: ResolvedLine; movement: MovementResult }> =
        [];
      for (const line of resolved) {
        const row = rows.get(line.product.id)!;
        const movement = await this.applyMovement(manager, warehouseId, row, {
          type: 'IN',
          qty: line.value,
          onHandDelta: line.value,
          reservedDelta: 0,
          refType: 'stock_in',
          refId: key,
          actor,
          note,
          key: `stock_in:${warehouseId}:${key}:${line.product.id}`,
        });
        applied.push({ line, movement });
      }
      return { warehouse, replayed: false, lines: applied };
    });

    const totalQty = result.lines.reduce(
      (sum, item) => sum + item.line.value,
      0,
    );
    if (!result.replayed) {
      void this.activityLog.log({
        entity_type: 'Warehouse',
        entity_id: warehouseId,
        action: 'warehouse.stock_in',
        new_value: {
          positions: result.lines.length,
          total_qty: totalQty,
          lines: result.lines.slice(0, 50).map((item) => ({
            product_id: item.line.product.id,
            qty: item.line.value,
            on_hand_after: item.movement.on_hand,
          })),
        },
        user_id: actor.id,
        user_role: actor.role,
        metadata: { idempotency_key: key, market_id: marketId },
        description: `Ombor #${warehouseId} ga kirim: ${result.lines.length} pozitsiya, ${totalQty} dona`,
      });
    }

    return {
      warehouse_id: warehouseId,
      warehouse_name: result.warehouse.name,
      replayed: result.replayed,
      positions: result.lines.length,
      total_qty: totalQty,
      lines: result.lines.map((item) => ({
        product_id: item.line.product.id,
        product_name: item.line.product.name,
        market_id: item.line.product.user_id,
        sku_code: item.line.product.sku_code,
        barcode: item.line.product.barcode,
        qty: item.line.value,
        on_hand: item.movement.on_hand,
        reserved: item.movement.reserved,
        available: item.movement.on_hand - item.movement.reserved,
        movement_id: item.movement.movement_id,
      })),
    };
  }

  // ------------------------------------------------------------------
  // Inventarizatsiya (ADJUST)
  // ------------------------------------------------------------------

  /**
   * Haqiqiy sonni kiritib farqni tuzatish: har qatorda `counted` — sanalgan
   * dona (mutlaq qiymat). Sabab majburiy. `counted < reserved` — 409 (band
   * qilingan buyurtmalar bor; avval ular bekor/chiqim qilinsin). Farqi 0
   * qator yozilmaydi (`unchanged`).
   */
  async inventory(input: InventoryInput) {
    const warehouseId = toId(input?.warehouse_id, 'warehouse_id');
    const key = requireIdempotencyKey(input?.idempotency_key);
    const lines = normalizeStockLines(input?.lines, 'counted', 0);
    const marketId = toOptionalId(input?.market_id, 'market_id');
    const reason = toOptionalText(input?.reason, 'reason', WAREHOUSE_NOTE_MAX);
    if (!reason || reason.length < WAREHOUSE_REASON_MIN) {
      badRequest(
        `Sabab (reason) majburiy — kamida ${WAREHOUSE_REASON_MIN} belgi`,
      );
    }
    const actor = normalizeActor(input?.actor);

    const result = await this.tx(async (manager) => {
      const t = this.tables(manager);
      await this.lockWarehouse(manager, warehouseId);
      const resolved = await this.resolveLines(
        manager,
        lines,
        marketId,
        'unique',
      );

      const previous: Array<{
        id: string;
        product_id: string;
        qty: number;
        on_hand_after: number;
        reserved_after: number;
      }> = await manager.query(
        `SELECT "id"::text AS id, "product_id"::text AS product_id, "qty",
                "on_hand_after", "reserved_after"
           FROM ${t.movements}
          WHERE "warehouse_id" = $1 AND "ref_type" = 'inventory' AND "ref_id" = $2`,
        [warehouseId, key],
      );
      if (previous.length) {
        const conflict = previous.some((row) => {
          const line = resolved.find(
            (item) => item.product.id === row.product_id,
          );
          return !line || line.value !== row.on_hand_after;
        });
        if (conflict) {
          rpcError(
            409,
            'Bu Idempotency-Key boshqa tarkibli inventarizatsiya uchun ishlatilgan — yangi kalit bering',
            { code: WAREHOUSE_ERROR_CODES.IDEMPOTENCY_CONFLICT },
          );
        }
        return {
          replayed: true,
          lines: resolved.map((line) => {
            const row = previous.find(
              (item) => item.product_id === line.product.id,
            );
            return {
              line,
              before: row ? row.on_hand_after - row.qty : line.value,
              after: row ? row.on_hand_after : line.value,
              reserved: row ? row.reserved_after : 0,
              movement_id: row?.id ?? null,
            };
          }),
        };
      }

      await this.ensureStockRows(
        manager,
        warehouseId,
        resolved.filter((line) => line.value > 0).map((line) => line.product),
      );
      const rows = await this.lockStockRows(
        manager,
        warehouseId,
        resolved.map((line) => line.product.id),
      );
      const blocked = resolved.filter((line) => {
        const row = rows.get(line.product.id);
        return row ? line.value < row.reserved : false;
      });
      if (blocked.length) {
        const shown = blocked
          .slice(0, 10)
          .map(
            (line) =>
              `«${line.product.name}»: band ${rows.get(line.product.id)!.reserved} dona`,
          )
          .join('; ');
        rpcError(
          409,
          `Haqiqiy son band qilingan donadan kam bo'la olmaydi — avval buyurtmalar bekor qilinsin yoki kuryerga berilsin: ${shown}`,
          { code: WAREHOUSE_ERROR_CODES.STOCK_INSUFFICIENT },
        );
      }

      const out: Array<{
        line: ResolvedLine;
        before: number;
        after: number;
        reserved: number;
        movement_id: string | null;
      }> = [];
      for (const line of resolved) {
        const row = rows.get(line.product.id);
        const before = row?.on_hand ?? 0;
        const delta = line.value - before;
        if (!row || delta === 0) {
          out.push({
            line,
            before,
            after: before,
            reserved: row?.reserved ?? 0,
            movement_id: null,
          });
          continue;
        }
        const movement = await this.applyMovement(manager, warehouseId, row, {
          type: 'ADJUST',
          qty: delta,
          onHandDelta: delta,
          reservedDelta: 0,
          refType: 'inventory',
          refId: key,
          actor,
          note: reason,
          key: `inventory:${warehouseId}:${key}:${line.product.id}`,
        });
        out.push({
          line,
          before,
          after: movement.on_hand,
          reserved: movement.reserved,
          movement_id: movement.movement_id,
        });
      }
      return { replayed: false, lines: out };
    });

    const changed = result.lines.filter((item) => item.movement_id);
    if (!result.replayed && changed.length) {
      void this.activityLog.log({
        entity_type: 'Warehouse',
        entity_id: warehouseId,
        action: 'warehouse.inventory',
        new_value: {
          changed: changed.length,
          lines: changed.slice(0, 50).map((item) => ({
            product_id: item.line.product.id,
            before: item.before,
            after: item.after,
          })),
        },
        user_id: actor.id,
        user_role: actor.role,
        metadata: { idempotency_key: key, reason },
        description: `Ombor #${warehouseId} inventarizatsiyasi: ${changed.length} pozitsiya tuzatildi`,
      });
    }

    return {
      warehouse_id: warehouseId,
      replayed: result.replayed,
      reason,
      changed: changed.length,
      unchanged: result.lines.length - changed.length,
      lines: result.lines.map((item) => ({
        product_id: item.line.product.id,
        product_name: item.line.product.name,
        market_id: item.line.product.user_id,
        counted: item.line.value,
        before: item.before,
        after: item.after,
        delta: item.after - item.before,
        reserved: item.reserved,
        available: item.after - item.reserved,
        movement_id: item.movement_id,
      })),
    };
  }

  // ------------------------------------------------------------------
  // Mahsulot chegarasi
  // ------------------------------------------------------------------

  /** «Kam qoldiq» chegarasi: son — shu mahsulot uchun; `null` — ombor sukuti. */
  async setThreshold(input: {
    warehouse_id: unknown;
    product_id: unknown;
    low_stock_threshold: unknown;
    actor?: WarehouseActorInput | null;
  }) {
    const warehouseId = toId(input?.warehouse_id, 'warehouse_id');
    const productId = toId(input?.product_id, 'product_id');
    const raw = input?.low_stock_threshold;
    if (raw === undefined) {
      badRequest('low_stock_threshold majburiy (son yoki null — ombor sukuti)');
    }
    const threshold =
      raw === null
        ? null
        : toInt(raw, 'low_stock_threshold', 0, WAREHOUSE_LOW_STOCK_MAX);
    const actor = normalizeActor(input?.actor);

    const result = await this.tx(async (manager) => {
      const t = this.tables(manager);
      const warehouse = await this.lockWarehouse(manager, warehouseId);
      const products = await loadProducts(manager, [productId]);
      const product = products.get(productId);
      if (!product || product.is_deleted) {
        rpcError(404, `Mahsulot #${productId} topilmadi`);
      }
      await this.ensureStockRows(manager, warehouseId, [product]);
      const rows = await this.lockStockRows(manager, warehouseId, [productId]);
      const row = rows.get(productId)!;
      const before = row.low_stock_threshold;
      await manager.query(
        `UPDATE ${t.stock} SET "low_stock_threshold" = $2, "updatedAt" = now()
          WHERE "id" = $1`,
        [row.id, threshold],
      );
      return { warehouse, row, before };
    });

    void this.activityLog.logChange({
      entity_type: 'WarehouseStock',
      entity_id: result.row.id,
      action: ActivityAction.UPDATED,
      old_value: { low_stock_threshold: result.before },
      new_value: { low_stock_threshold: threshold },
      user_id: actor.id,
      user_role: actor.role,
      metadata: { warehouse_id: warehouseId, product_id: productId },
    });

    return {
      warehouse_id: warehouseId,
      product_id: productId,
      low_stock_threshold: threshold,
      effective_threshold: threshold ?? result.warehouse.low_stock_default,
      on_hand: result.row.on_hand,
      reserved: result.row.reserved,
      available: result.row.on_hand - result.row.reserved,
    };
  }

  // ------------------------------------------------------------------
  // Buyurtma RPC'lari (order-service)
  // ------------------------------------------------------------------

  private async orderReservations(
    manager: EntityManager,
    orderId: string,
  ): Promise<ReservationRow[]> {
    const t = this.tables(manager);
    return manager.query(
      `SELECT "id"::text AS id, "order_id"::text AS order_id,
              "warehouse_id"::text AS warehouse_id,
              "product_id"::text AS product_id, "market_id"::text AS market_id,
              "qty", "returned_qty", "status"
         FROM ${t.reservations}
        WHERE "order_id" = $1
        ORDER BY "product_id" ASC, "id" ASC`,
      [orderId],
    );
  }

  /** Buyurtmaning umumiy holati: faol qatorlar ustun. */
  private orderStatus(rows: ReservationRow[]): StockReservationStatus | 'NONE' {
    if (!rows.length) return 'NONE';
    if (rows.some((row) => row.status === 'RESERVED')) return 'RESERVED';
    if (rows.some((row) => row.status === 'OUT')) return 'OUT';
    const last = rows.reduce((a, b) => (compareIds(a.id, b.id) >= 0 ? a : b));
    return last.status;
  }

  private reservationView(rows: ReservationRow[]) {
    return rows.map((row) => ({
      reservation_id: row.id,
      warehouse_id: row.warehouse_id,
      product_id: row.product_id,
      market_id: row.market_id,
      qty: row.qty,
      returned_qty: row.returned_qty,
      status: row.status,
    }));
  }

  private async setReservationStatus(
    manager: EntityManager,
    reservationId: string,
    status: StockReservationStatus,
    extra: { returnedQtyDelta?: number } = {},
  ) {
    const t = this.tables(manager);
    const stampColumn =
      status === 'RELEASED'
        ? '"released_at"'
        : status === 'OUT'
          ? '"out_at"'
          : '"returned_at"';
    await manager.query(
      `UPDATE ${t.reservations}
          SET "status" = $2,
              "returned_qty" = "returned_qty" + $3,
              ${stampColumn} = now(),
              "updatedAt" = now()
        WHERE "id" = $1`,
      [reservationId, status, extra.returnedQtyDelta ?? 0],
    );
  }

  /**
   * Buyurtma yaratildi (qaror 7): hamma mahsulot uchun band. Ombor FAOL va
   * HAMMA qator yetarli bo'lmasa — 409, hech narsa yozilmaydi (qaror 4:
   * bo'linmaydi; order-service HQ'ga o'tadi). Takroriy chaqiruv (shu ombor,
   * shu tarkib) — `already: true`, qoldiq o'zgarmaydi.
   */
  async reserve(input: ReserveInput) {
    const orderId = toId(input?.order_id, 'order_id');
    const warehouseId = toId(input?.warehouse_id, 'warehouse_id');
    const items = normalizeOrderItems(input?.items);
    if (!items.length)
      badRequest("items — kamida bitta mahsulot bo'lishi kerak");
    const marketId = toOptionalId(input?.market_id, 'market_id');
    const actor = normalizeActor(input?.actor);

    return this.tx(async (manager) => {
      const t = this.tables(manager);
      await this.lockOrder(manager, orderId);
      const existing = (await this.orderReservations(manager, orderId)).filter(
        (row) => row.status === 'RESERVED' || row.status === 'OUT',
      );
      if (existing.length) {
        const same =
          existing.every(
            (row) =>
              row.status === 'RESERVED' && row.warehouse_id === warehouseId,
          ) &&
          existing.length === items.length &&
          items.every((item) =>
            existing.some(
              (row) =>
                row.product_id === item.product_id && row.qty === item.quantity,
            ),
          );
        if (!same) {
          rpcError(
            409,
            'Buyurtma allaqachon boshqa ombor yoki tarkib bilan band qilingan — avval release qiling',
            {
              code: WAREHOUSE_ERROR_CODES.ORDER_ALREADY_RESERVED,
              reservations: this.reservationView(existing),
            },
          );
        }
        // Faqat o'qish (qulfsiz): takroriy chaqiruv hech narsa yozmaydi.
        const stock = await this.readStockRows(
          manager,
          warehouseId,
          items.map((item) => item.product_id),
        );
        return {
          order_id: orderId,
          warehouse_id: warehouseId,
          status: 'RESERVED' as const,
          already: true,
          items: existing.map((row) => {
            const s = stock.get(row.product_id);
            return {
              product_id: row.product_id,
              quantity: row.qty,
              reservation_id: row.id,
              on_hand: s?.on_hand ?? 0,
              reserved: s?.reserved ?? 0,
              available: (s?.on_hand ?? 0) - (s?.reserved ?? 0),
            };
          }),
        };
      }

      const warehouse = await this.lockWarehouse(manager, warehouseId);
      if (warehouse.status !== 'ACTIVE') {
        rpcError(409, "Ombor to'xtatilgan — yangi buyurtma tushmaydi", {
          code: WAREHOUSE_ERROR_CODES.PAUSED,
          warehouse_id: warehouseId,
        });
      }
      const products = await loadProducts(
        manager,
        items.map((item) => item.product_id),
      );
      const invalid = items.filter((item) => {
        const product = products.get(item.product_id);
        return (
          !product ||
          product.is_deleted ||
          (marketId !== null && product.user_id !== marketId)
        );
      });
      if (invalid.length) {
        badRequest(
          `Mahsulot topilmadi, o'chirilgan yoki buyurtma marketiga tegishli emas: ${invalid
            .map((item) => `#${item.product_id}`)
            .join(', ')}`,
        );
      }
      const stock = await this.lockStockRows(
        manager,
        warehouseId,
        items.map((item) => item.product_id),
      );
      const shortages = items
        .map((item) => {
          const row = stock.get(item.product_id);
          const available = row ? row.on_hand - row.reserved : 0;
          return {
            product_id: item.product_id,
            name: products.get(item.product_id)?.name ?? null,
            required: item.quantity,
            available: Math.max(0, available),
          };
        })
        .filter((item) => item.available < item.required);
      if (shortages.length) {
        rpcError(409, 'Omborda yetmaydi — butun buyurtma HQ orqali ketadi', {
          code: WAREHOUSE_ERROR_CODES.STOCK_INSUFFICIENT,
          warehouse_id: warehouseId,
          shortages,
        });
      }

      const reserved: Array<{
        product_id: string;
        quantity: number;
        reservation_id: string;
        on_hand: number;
        reserved: number;
        available: number;
      }> = [];
      for (const item of items) {
        const row = stock.get(item.product_id)!;
        const inserted: Array<{ id: string }> = await manager.query(
          `INSERT INTO ${t.reservations}
             ("order_id", "warehouse_id", "product_id", "market_id", "qty", "status")
           VALUES ($1, $2, $3, $4, $5, 'RESERVED')
           RETURNING "id"::text AS id`,
          [orderId, warehouseId, item.product_id, row.market_id, item.quantity],
        );
        const reservationId = inserted[0].id;
        const movement = await this.applyMovement(manager, warehouseId, row, {
          type: 'RESERVE',
          qty: item.quantity,
          onHandDelta: 0,
          reservedDelta: item.quantity,
          refType: 'order',
          refId: orderId,
          actor,
          key: `order:${orderId}:reserve:${reservationId}`,
        });
        reserved.push({
          product_id: item.product_id,
          quantity: item.quantity,
          reservation_id: reservationId,
          on_hand: movement.on_hand,
          reserved: movement.reserved,
          available: movement.on_hand - movement.reserved,
        });
      }
      return {
        order_id: orderId,
        warehouse_id: warehouseId,
        status: 'RESERVED' as const,
        already: false,
        items: reserved,
      };
    });
  }

  /**
   * RESERVED qatorlarni bo'shatadi (`reserved −n`). `release` va
   * `return` (kuryerga berilmagan buyurtma) shu yerdan.
   */
  private async releaseRows(
    manager: EntityManager,
    orderId: string,
    rows: ReservationRow[],
    actor: WarehouseActor,
    note: string | null,
  ) {
    if (!rows.length) return [];
    const warehouseId = rows[0].warehouse_id;
    await this.lockWarehouse(manager, warehouseId);
    const stock = await this.lockStockRows(
      manager,
      warehouseId,
      rows.map((row) => row.product_id),
    );
    const out: Array<{
      product_id: string;
      quantity: number;
      on_hand: number;
      reserved: number;
    }> = [];
    for (const row of rows) {
      const stockRow = stock.get(row.product_id)!;
      const movement = await this.applyMovement(
        manager,
        warehouseId,
        stockRow,
        {
          type: 'RELEASE',
          qty: -row.qty,
          onHandDelta: 0,
          reservedDelta: -row.qty,
          refType: 'order',
          refId: orderId,
          actor,
          note,
          key: `order:${orderId}:release:${row.id}`,
        },
      );
      await this.setReservationStatus(manager, row.id, 'RELEASED');
      row.status = 'RELEASED';
      out.push({
        product_id: row.product_id,
        quantity: row.qty,
        on_hand: movement.on_hand,
        reserved: movement.reserved,
      });
    }
    return out;
  }

  /**
   * Bekor (kuryerga berilmasdan): band bo'shaydi (qaror 7). Bandi yo'q
   * buyurtma (HQ manbali) — `status: 'NONE'`, xato emas; allaqachon
   * bo'shatilgan — `changed: false`. Kuryerga berilgan (OUT) — 409:
   * `catalog.warehouse.return` ishlating.
   */
  async release(input: OrderOpInput) {
    const orderId = toId(input?.order_id, 'order_id');
    const actor = normalizeActor(input?.actor);
    const note =
      toOptionalText(input?.note, 'note', WAREHOUSE_NOTE_MAX) ?? null;

    return this.tx(async (manager) => {
      await this.lockOrder(manager, orderId);
      const rows = await this.orderReservations(manager, orderId);
      const reserved = rows.filter((row) => row.status === 'RESERVED');
      if (!reserved.length) {
        if (rows.some((row) => row.status === 'OUT')) {
          rpcError(
            409,
            "Buyurtma kuryerga berilgan — bandni bo'shatib bo'lmaydi, qaytganda catalog.warehouse.return",
            {
              code: WAREHOUSE_ERROR_CODES.ORDER_ALREADY_OUT,
              reservations: this.reservationView(rows),
            },
          );
        }
        return {
          order_id: orderId,
          status: this.orderStatus(rows),
          changed: false,
          items: [],
        };
      }
      const items = await this.releaseRows(
        manager,
        orderId,
        reserved,
        actor,
        note,
      );
      return {
        order_id: orderId,
        warehouse_id: reserved[0].warehouse_id,
        status: 'RELEASED' as const,
        changed: true,
        items,
      };
    });
  }

  /**
   * Kuryerga berildi (qaror 7): `on_hand −n`, `reserved −n`. Takroriy — no-op.
   * Bandi yo'q — `NONE`; faqat bo'shatilgan band — 409 (bekor qilingan
   * buyurtma kuryerga berilmaydi).
   */
  async out(input: OrderOpInput) {
    const orderId = toId(input?.order_id, 'order_id');
    const actor = normalizeActor(input?.actor);
    const note =
      toOptionalText(input?.note, 'note', WAREHOUSE_NOTE_MAX) ?? null;

    return this.tx(async (manager) => {
      await this.lockOrder(manager, orderId);
      const rows = await this.orderReservations(manager, orderId);
      const reserved = rows.filter((row) => row.status === 'RESERVED');
      if (!reserved.length) {
        const status = this.orderStatus(rows);
        if (status === 'RELEASED') {
          rpcError(
            409,
            "Buyurtma bandi bo'shatilgan (bekor qilingan) — chiqim qilib bo'lmaydi",
            {
              code: WAREHOUSE_ERROR_CODES.ORDER_RELEASED,
            },
          );
        }
        return { order_id: orderId, status, changed: false, items: [] };
      }
      const warehouseId = reserved[0].warehouse_id;
      await this.lockWarehouse(manager, warehouseId);
      const stock = await this.lockStockRows(
        manager,
        warehouseId,
        reserved.map((row) => row.product_id),
      );
      const items: Array<{
        product_id: string;
        quantity: number;
        on_hand: number;
        reserved: number;
      }> = [];
      for (const row of reserved) {
        const stockRow = stock.get(row.product_id)!;
        const movement = await this.applyMovement(
          manager,
          warehouseId,
          stockRow,
          {
            type: 'OUT',
            qty: -row.qty,
            onHandDelta: -row.qty,
            reservedDelta: -row.qty,
            refType: 'order',
            refId: orderId,
            actor,
            note,
            key: `order:${orderId}:out:${row.id}`,
          },
        );
        await this.setReservationStatus(manager, row.id, 'OUT');
        items.push({
          product_id: row.product_id,
          quantity: row.qty,
          on_hand: movement.on_hand,
          reserved: movement.reserved,
        });
      }
      return {
        order_id: orderId,
        warehouse_id: warehouseId,
        status: 'OUT' as const,
        changed: true,
        items,
      };
    });
  }

  /**
   * Bekor/qaytish — O'SHA omborga (qaror 8):
   *   - kuryerga berilgan (OUT) qatorlar → `on_hand +n` (RETURN);
   *   - hali berilmagan (RESERVED) qatorlar → band bo'shaydi (RELEASE).
   * `items` — qisman qaytish (qisman sotuv): faqat shu mahsulot/son; berilmasa
   * qolgan hammasi. Takroriy chaqiruv no-op: harakat kaliti
   * `order:{id}:return:{qator}:{idempotency_key|full}`. Bir buyurtmada bir
   * necha qisman qaytish bo'lsa — har biriga alohida `idempotency_key`.
   */
  async return(input: ReturnInput) {
    const orderId = toId(input?.order_id, 'order_id');
    const actor = normalizeActor(input?.actor);
    const note =
      toOptionalText(input?.note, 'note', WAREHOUSE_NOTE_MAX) ?? null;
    const requested = normalizeOrderItems(input?.items);
    const suffix = optionalIdempotencyKey(input?.idempotency_key) ?? 'full';

    return this.tx(async (manager) => {
      const t = this.tables(manager);
      await this.lockOrder(manager, orderId);
      const rows = await this.orderReservations(manager, orderId);
      if (!rows.length) {
        return {
          order_id: orderId,
          status: 'NONE' as const,
          changed: false,
          released: [],
          returned: [],
          skipped: [],
        };
      }

      const reserved = rows.filter((row) => row.status === 'RESERVED');
      const released = await this.releaseRows(
        manager,
        orderId,
        reserved,
        actor,
        note,
      );

      const outRows = rows.filter((row) => row.status === 'OUT');
      const plan: Array<{ row: ReservationRow; quantity: number }> = [];
      if (requested.length) {
        for (const item of requested) {
          const row = outRows.find(
            (candidate) => candidate.product_id === item.product_id,
          );
          const remaining = row ? row.qty - row.returned_qty : 0;
          if (!row || item.quantity > remaining) {
            badRequest(
              `Mahsulot #${item.product_id}: qaytariladigan ${item.quantity} dona kuryerga berilgan qoldiqdan (${remaining}) ko'p`,
            );
          }
          plan.push({ row, quantity: item.quantity });
        }
      } else {
        for (const row of outRows) {
          const remaining = row.qty - row.returned_qty;
          if (remaining > 0) plan.push({ row, quantity: remaining });
        }
      }

      const returned: Array<{
        product_id: string;
        quantity: number;
        on_hand: number;
        reserved: number;
      }> = [];
      const skipped: Array<{ product_id: string; quantity: number }> = [];
      if (plan.length) {
        const keys = plan.map(
          (item) => `order:${orderId}:return:${item.row.id}:${suffix}`,
        );
        const done: Array<{ idempotency_key: string }> = await manager.query(
          `SELECT "idempotency_key" FROM ${t.movements} WHERE "idempotency_key" = ANY($1::text[])`,
          [keys],
        );
        const doneKeys = new Set(done.map((row) => row.idempotency_key));
        const todo = plan.filter((_, index) => !doneKeys.has(keys[index]));
        plan
          .filter((_, index) => doneKeys.has(keys[index]))
          .forEach((item) =>
            skipped.push({
              product_id: item.row.product_id,
              quantity: item.quantity,
            }),
          );
        if (todo.length) {
          const warehouseId = todo[0].row.warehouse_id;
          await this.lockWarehouse(manager, warehouseId);
          const stock = await this.lockStockRows(
            manager,
            warehouseId,
            todo.map((item) => item.row.product_id),
          );
          for (const item of todo) {
            const stockRow = stock.get(item.row.product_id)!;
            const movement = await this.applyMovement(
              manager,
              warehouseId,
              stockRow,
              {
                type: 'RETURN',
                qty: item.quantity,
                onHandDelta: item.quantity,
                reservedDelta: 0,
                refType: 'order',
                refId: orderId,
                actor,
                note,
                key: `order:${orderId}:return:${item.row.id}:${suffix}`,
              },
            );
            const fully = item.row.returned_qty + item.quantity >= item.row.qty;
            await this.setReservationStatus(
              manager,
              item.row.id,
              fully ? 'RETURNED' : 'OUT',
              { returnedQtyDelta: item.quantity },
            );
            item.row.returned_qty += item.quantity;
            if (fully) item.row.status = 'RETURNED';
            returned.push({
              product_id: item.row.product_id,
              quantity: item.quantity,
              on_hand: movement.on_hand,
              reserved: movement.reserved,
            });
          }
        }
      }

      return {
        order_id: orderId,
        warehouse_id: rows[rows.length - 1].warehouse_id,
        status: this.orderStatus(rows),
        changed: released.length > 0 || returned.length > 0,
        released,
        returned,
        skipped,
      };
    });
  }

  /** Buyurtma bandi holati (order-service / buyurtma tafsiloti uchun). */
  async orderState(input: { order_id: unknown }) {
    const orderId = toId(input?.order_id, 'order_id');
    const manager = this.dataSource.manager;
    const rows = await this.orderReservations(manager, orderId);
    return {
      order_id: orderId,
      status: this.orderStatus(rows),
      warehouse_id: rows.length ? rows[rows.length - 1].warehouse_id : null,
      reservations: this.reservationView(rows),
    };
  }
}
