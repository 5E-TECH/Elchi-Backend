import { Injectable, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, In, Repository } from 'typeorm';
import {
  ActivityAction,
  ActivityLogService,
  formatProductSkuCode,
  type HqWarehouseReason,
  parseProductSkuCode,
  productBarcodeLookupVariants,
  STOCK_MOVEMENT_TYPES,
  type StockMovementType,
  WAREHOUSE_ADDRESS_MAX,
  WAREHOUSE_HQ_TIER_FLAG,
  WAREHOUSE_LOW_STOCK_DEFAULT,
  WAREHOUSE_LOW_STOCK_MAX,
  WAREHOUSE_NAME_MAX,
  WAREHOUSE_NOTE_MAX,
  WAREHOUSE_STOCK_LEVELS,
  type WarehouseKind,
  type WarehouseSourceReason,
  type WarehouseStatus,
  type WarehouseStockLevel,
  warehouseStockLevel,
  Roles,
} from '@app/common';
import { Warehouse } from './entities/warehouse.entity';
import { WarehouseStock } from './entities/warehouse-stock.entity';
import { StockMovement } from './entities/stock-movement.entity';
import { StockReservation } from './entities/stock-reservation.entity';
import { Product } from '../entities/product.entity';
import {
  HQ_ID_READ_WAIT_MS,
  WarehouseBranchInfo,
  WarehouseDirectoryService,
  WarehouseMarketInfo,
  WarehouseUserInfo,
} from './warehouse-directory.service';
import {
  findProductsByCode,
  loadProducts,
  productColumns,
  productView,
  WarehouseProductRow,
} from './warehouse-products';
import {
  badRequest,
  hasAnyRole,
  mapWarehouseDbError,
  normalizeActor,
  normalizeOrderItems,
  notFoundWarehouse,
  OrderItem,
  pagination,
  returnedRows,
  rpcError,
  tableRef,
  toId,
  toInt,
  toOptionalId,
  toOptionalText,
  WarehouseActorInput,
  WarehouseScope,
} from './warehouse.util';

interface WarehouseStatsRow {
  warehouse_id: string;
  positions: number;
  markets: number;
  on_hand: string | number;
  reserved: string | number;
  out_count: number;
  low_count: number;
}

interface LastMovementRow {
  warehouse_id: string;
  id: string;
  type: StockMovementType;
  qty: number;
  ref_type: string | null;
  ref_id: string | null;
  createdAt: Date;
}

interface StockListRow extends WarehouseProductRow {
  stock_id: string;
  product_id: string;
  market_id: string;
  on_hand: number;
  reserved: number;
  low_stock_threshold: number | null;
  threshold: number;
  last_movement_at: Date | null;
}

interface MovementListRow {
  id: string;
  type: StockMovementType;
  qty: number;
  on_hand_after: number;
  reserved_after: number;
  ref_type: string | null;
  ref_id: string | null;
  actor_id: string | null;
  actor_role: string | null;
  note: string | null;
  createdAt: Date;
  product_id: string;
  market_id: string;
  product_name: string;
  sku_code: string | null;
  barcode: string | null;
}

type MarketStockRow = WarehouseProductRow & {
  warehouse_id: string;
  product_id: string;
  on_hand: number;
  reserved: number;
  threshold: number;
  warehouse_status: WarehouseStatus;
};

export interface WarehouseWriteInput {
  branch_id?: unknown;
  name?: unknown;
  manager_user_id?: unknown;
  address?: unknown;
  low_stock_default?: unknown;
  note?: unknown;
}

const LEVEL_SQL: Record<WarehouseStockLevel, string> = {
  out: `(s."on_hand" - s."reserved") <= 0`,
  low: `(s."on_hand" - s."reserved") > 0 AND (s."on_hand" - s."reserved") <= COALESCE(s."low_stock_threshold", w."low_stock_default")`,
  ok: `(s."on_hand" - s."reserved") > COALESCE(s."low_stock_threshold", w."low_stock_default")`,
};

const num = (value: unknown): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

/** Satr yoki son → kesilgan satr; boshqa tur (obyekt, massiv) — ''. */
const str = (value: unknown): string =>
  typeof value === 'string' || typeof value === 'number'
    ? String(value).trim()
    : '';

/** Pa1KaXmj: HQ filialidagi ombor nomi sukuti (UI atamasi). */
const HQ_WAREHOUSE_DEFAULT_NAME = 'Markaziy ombor';

const asList = (raw: unknown): string[] =>
  (Array.isArray(raw)
    ? (raw as unknown[])
    : typeof raw === 'string'
      ? raw.split(',')
      : []
  )
    .map((item) => str(item))
    .filter(Boolean);

/** VkKDSNNn: manba javobidagi qator (`resolve_source.items`). */
interface SourceLine {
  product_id: string;
  name: string | null;
  required: number;
  available: number;
  enough: boolean;
}

/** Yetishmovchilik (`shortages`, VkKDSNNn: `hq_shortages`). */
type SourceShortage = Omit<SourceLine, 'enough'>;

const shortagesOf = (lines: SourceLine[]): SourceShortage[] =>
  lines
    .filter((line) => !line.enough)
    .map(({ product_id, name, required, available }) => ({
      product_id,
      name,
      required,
      available,
    }));

/**
 * VkKDSNNn: Markaziy ombor (2-pog'ona) ko'rib chiqiladigan viloyat sabablari
 * — viloyat ombori yo'q, to'xtatilgan yoki qoldig'i yetmaydi. Qolganlari
 * (MARKET_NOT_ALLOWED, NO_ITEMS, NO_REGION, PRODUCT_INVALID) — buyurtma
 * umuman ombordan bo'la olmaydi.
 */
const HQ_TIER_REASONS = new Set<WarehouseSourceReason>([
  'NO_WAREHOUSE',
  'WAREHOUSE_PAUSED',
  'INSUFFICIENT_STOCK',
]);

/**
 * hY7uacJu: ombor moduli — o'qish va ombor boshqaruvi (CRUD, pauza).
 * Qoldiqni o'zgartiruvchi amallar — `WarehouseStockService`.
 *
 * Ruxsat gateway'da; bu yerda `scope` (filial xodimi — faqat o'z filiali
 * ombori, begonasi 404 — mavjudligi oshkor bo'lmaydi) va market egaligi.
 */
@Injectable()
export class WarehouseService {
  constructor(
    @InjectRepository(Warehouse)
    private readonly warehouseRepo: Repository<Warehouse>,
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly directory: WarehouseDirectoryService,
    private readonly activityLog: ActivityLogService,
    // VkKDSNNn: OXIRIDA va @Optional — mavjud spec'lar 4 arg bilan quradi
    // (config yo'q → Markaziy ombor pog'onasi o'chiq).
    @Optional() private readonly config?: ConfigService,
  ) {}

  private get manager(): EntityManager {
    return this.dataSource.manager;
  }

  private t(
    entity:
      | typeof Warehouse
      | typeof WarehouseStock
      | typeof StockMovement
      | typeof StockReservation
      | typeof Product,
  ) {
    return tableRef(this.manager, entity);
  }

  // ------------------------------------------------------------------
  // Yordamchilar
  // ------------------------------------------------------------------

  private async getWarehouse(
    id: unknown,
    scope?: WarehouseScope | null,
  ): Promise<Warehouse> {
    const warehouseId = toId(id, 'warehouse_id');
    let warehouse: Warehouse | null;
    try {
      warehouse = await this.warehouseRepo.findOne({
        where: { id: warehouseId, isDeleted: false },
      });
    } catch (error) {
      mapWarehouseDbError(error);
    }
    if (!warehouse) notFoundWarehouse(warehouseId);
    if (scope && warehouse.branch_id !== String(scope.branch_id)) {
      // Begona filial ombori — mavjudligi oshkor bo'lmaydi.
      notFoundWarehouse(warehouseId);
    }
    return warehouse;
  }

  private async stats(ids: string[]): Promise<Map<string, WarehouseStatsRow>> {
    if (!ids.length) return new Map();
    const rows: WarehouseStatsRow[] = await this.manager.query(
      `SELECT s."warehouse_id"::text AS warehouse_id,
              count(*)::int AS positions,
              count(DISTINCT s."market_id")::int AS markets,
              COALESCE(sum(s."on_hand"), 0)::bigint AS on_hand,
              COALESCE(sum(s."reserved"), 0)::bigint AS reserved,
              count(*) FILTER (WHERE ${LEVEL_SQL.out})::int AS out_count,
              count(*) FILTER (WHERE ${LEVEL_SQL.low})::int AS low_count
         FROM ${this.t(WarehouseStock)} s
         JOIN ${this.t(Warehouse)} w ON w."id" = s."warehouse_id"
        WHERE s."warehouse_id" = ANY($1::bigint[])
        GROUP BY s."warehouse_id"`,
      [ids],
    );
    return new Map(rows.map((row) => [row.warehouse_id, row]));
  }

  private async reservedOrders(ids: string[]): Promise<Map<string, number>> {
    if (!ids.length) return new Map();
    const rows: Array<{ warehouse_id: string; orders: number }> =
      await this.manager.query(
        `SELECT "warehouse_id"::text AS warehouse_id,
                count(DISTINCT "order_id")::int AS orders
           FROM ${this.t(StockReservation)}
          WHERE "warehouse_id" = ANY($1::bigint[]) AND "status" = 'RESERVED'
          GROUP BY "warehouse_id"`,
        [ids],
      );
    return new Map(rows.map((row) => [row.warehouse_id, row.orders]));
  }

  private async lastMovements(
    ids: string[],
  ): Promise<Map<string, LastMovementRow>> {
    if (!ids.length) return new Map();
    const rows: LastMovementRow[] = await this.manager.query(
      `SELECT DISTINCT ON ("warehouse_id")
              "warehouse_id"::text AS warehouse_id, "id"::text AS id, "type",
              "qty", "ref_type", "ref_id", "createdAt"
         FROM ${this.t(StockMovement)}
        WHERE "warehouse_id" = ANY($1::bigint[])
        ORDER BY "warehouse_id", "createdAt" DESC, "id" DESC`,
      [ids],
    );
    return new Map(rows.map((row) => [row.warehouse_id, row]));
  }

  private summaryView(
    stats: WarehouseStatsRow | undefined,
    reservedOrders: number,
  ) {
    const onHand = num(stats?.on_hand);
    const reserved = num(stats?.reserved);
    return {
      positions: stats?.positions ?? 0,
      markets: stats?.markets ?? 0,
      on_hand: onHand,
      reserved,
      available: onHand - reserved,
      reserved_orders: reservedOrders,
      low_count: stats?.low_count ?? 0,
      out_count: stats?.out_count ?? 0,
    };
  }

  /**
   * Pa1KaXmj: ombor turi. Filial ma'lumoti bo'lsa — uning turi (`is_hq`);
   * filial olinmagan bo'lsa (servis javob bermadi) — keshlangan HQ id bilan
   * solishtiriladi. Aniqlanmasa — `REGIONAL` (eski xulq).
   */
  private kindOf(
    branchId: string,
    branch: WarehouseBranchInfo | null | undefined,
    hqBranchId: string | null,
  ): WarehouseKind {
    if (branch) return branch.is_hq ? 'HQ' : 'REGIONAL';
    return hqBranchId !== null && String(branchId) === hqBranchId
      ? 'HQ'
      : 'REGIONAL';
  }

  /**
   * Pa1KaXmj: HQ filial id o'qish yo'li uchun — keshdan darhol, aks holda
   * ko'pi bilan `HQ_ID_READ_WAIT_MS` (branch-service sekin bo'lsa javob
   * kechikmaydi); aniqlanmasa `null` — `kindOf` zaxirasi.
   */
  private hqBranchIdForRead(): Promise<string | null> {
    return this.directory.getHqBranchId({ maxWaitMs: HQ_ID_READ_WAIT_MS });
  }

  private branchView(branch: WarehouseBranchInfo | null | undefined) {
    if (!branch) return null;
    return {
      id: branch.id,
      name: branch.name,
      type: branch.type,
      status: branch.status,
      address: branch.address,
    };
  }

  private warehouseView(
    warehouse: Warehouse,
    extra: {
      branch?: WarehouseBranchInfo | null;
      manager?: WarehouseUserInfo | null;
      stats?: WarehouseStatsRow;
      reservedOrders?: number;
      lastMovement?: LastMovementRow;
      hqBranchId?: string | null;
    },
  ) {
    const branch = extra.branch ?? null;
    const manager = extra.manager ?? null;
    const last = extra.lastMovement;
    return {
      id: warehouse.id,
      name: warehouse.name,
      status: warehouse.status,
      kind: this.kindOf(warehouse.branch_id, branch, extra.hqBranchId ?? null),
      branch_id: warehouse.branch_id,
      branch: this.branchView(branch),
      region: branch?.region ?? null,
      manager_user_id: warehouse.manager_user_id,
      manager: manager
        ? {
            id: manager.id,
            name: manager.name,
            phone_number: manager.phone_number,
          }
        : null,
      address: warehouse.address,
      // «Bo'sh qolsa, filial manzili olinadi» (dizayn).
      effective_address: warehouse.address ?? branch?.address ?? null,
      low_stock_default: warehouse.low_stock_default,
      note: warehouse.note,
      paused_at: warehouse.paused_at,
      paused_by: warehouse.paused_by,
      created_by: warehouse.created_by,
      created_at: warehouse.createdAt,
      updated_at: warehouse.updatedAt,
      summary: this.summaryView(extra.stats, extra.reservedOrders ?? 0),
      last_movement: last
        ? {
            id: last.id,
            type: last.type,
            qty: last.qty,
            ref_type: last.ref_type,
            ref_id: last.ref_id,
            created_at: last.createdAt,
          }
        : null,
    };
  }

  private normalizeWrite(dto: WarehouseWriteInput, mode: 'create' | 'update') {
    const name = toOptionalText(dto?.name, 'name', WAREHOUSE_NAME_MAX);
    if (mode === 'update' && name === null) {
      badRequest("Ombor nomi bo'sh bo'lishi mumkin emas");
    }
    const managerUserId =
      dto?.manager_user_id === undefined
        ? undefined
        : toOptionalId(dto.manager_user_id, 'manager_user_id');
    const address = toOptionalText(
      dto?.address,
      'address',
      WAREHOUSE_ADDRESS_MAX,
    );
    const note = toOptionalText(dto?.note, 'note', WAREHOUSE_NOTE_MAX);
    const lowStockDefault =
      dto?.low_stock_default === undefined || dto?.low_stock_default === null
        ? undefined
        : toInt(
            dto.low_stock_default,
            'low_stock_default',
            0,
            WAREHOUSE_LOW_STOCK_MAX,
          );
    return { name, managerUserId, address, note, lowStockDefault };
  }

  private async assertBranchManager(branchId: string, userId: string) {
    const managers = await this.directory.getBranchManagerIds(branchId);
    if (!managers.includes(userId)) {
      badRequest(
        "Mas'ul xodim shu filialning menejeri bo'lishi kerak (filial xodimlari ro'yxatidan tanlang)",
      );
    }
  }

  private auditSnapshot(warehouse: Warehouse) {
    return {
      name: warehouse.name,
      branch_id: warehouse.branch_id,
      manager_user_id: warehouse.manager_user_id,
      address: warehouse.address,
      low_stock_default: warehouse.low_stock_default,
      note: warehouse.note,
      status: warehouse.status,
    };
  }

  // ------------------------------------------------------------------
  // Ombor boshqaruvi (SUPERADMIN/ADMIN — gateway)
  // ------------------------------------------------------------------

  /**
   * Ombor ochish (qaror 1): faqat FAOL REGIONAL/HYBRID filialda yoki HQ'da
   * (Pa1KaXmj — «Markaziy ombor»), bitta filial — bitta ombor. Nom berilmasa
   * «<filial> ombori» (HQ'da — «Markaziy ombor»). Markaziy omborga mas'ul
   * menejer biriktirilmaydi (`manager_user_id` — 400, sukut `null`).
   */
  async create(
    dto: WarehouseWriteInput,
    requester?: WarehouseActorInput | null,
  ) {
    const branchId = toId(dto?.branch_id, 'branch_id');
    const input = this.normalizeWrite(dto, 'create');
    const actor = normalizeActor(requester);

    const branch = await this.directory.getBranch(branchId, {
      strict: true,
      fresh: true,
    });
    if (!branch) rpcError(404, `Filial #${branchId} topilmadi`);
    if (!branch.can_host_warehouse) {
      badRequest(
        "Ombor faqat faol filialda (HQ, REGIONAL yoki HYBRID) ochiladi — topshirish punktida ombor yo'q",
      );
    }
    const isHq = branch.is_hq;
    if (isHq && input.managerUserId) {
      badRequest("Markaziy omborga mas'ul menejer biriktirilmaydi");
    }
    if (input.managerUserId) {
      await this.assertBranchManager(branchId, input.managerUserId);
    }
    const existing = await this.warehouseRepo.findOne({
      where: { branch_id: branchId, isDeleted: false },
    });
    if (existing) {
      rpcError(409, `Bu filialda ombor allaqachon ochilgan (#${existing.id})`, {
        warehouse_id: existing.id,
      });
    }

    const name =
      input.name ??
      (isHq
        ? HQ_WAREHOUSE_DEFAULT_NAME
        : `${branch.name || `Filial #${branchId}`} ombori`.slice(
            0,
            WAREHOUSE_NAME_MAX,
          ));
    // XtcEyQjb: tanlanmagan (yoki `null`) — filialning birinchi faol menejeri.
    // Pa1KaXmj: Markaziy omborda mas'ul yo'q — har doim `null`.
    const managerUserId = isHq
      ? null
      : (input.managerUserId ??
        (await this.directory.getFirstActiveBranchManagerId(branchId)));
    let saved: Warehouse;
    try {
      saved = await this.warehouseRepo.save(
        this.warehouseRepo.create({
          branch_id: branchId,
          name,
          manager_user_id: managerUserId,
          address: input.address ?? null,
          low_stock_default:
            input.lowStockDefault ?? WAREHOUSE_LOW_STOCK_DEFAULT,
          note: input.note ?? null,
          status: 'ACTIVE',
          paused_at: null,
          paused_by: null,
          created_by: actor.id,
        }),
      );
    } catch (error) {
      mapWarehouseDbError(error);
    }

    void this.activityLog.log({
      entity_type: 'Warehouse',
      entity_id: saved.id,
      action: ActivityAction.CREATED,
      new_value: this.auditSnapshot(saved),
      user_id: actor.id,
      user_role: actor.role,
      description: isHq
        ? `Markaziy ombor #${saved.id} ochildi (HQ filiali #${branchId})`
        : `Ombor #${saved.id} ochildi (filial #${branchId})`,
    });

    return this.findOne(saved.id, null);
  }

  /**
   * Ombor ma'lumotlari (filial o'zgarmaydi). `null` — maydonni tozalash.
   * Pa1KaXmj: Markaziy omborda `manager_user_id` — 400, `null` — `null`
   * qoladi (avtomatik tanlov yo'q).
   */
  async update(
    id: unknown,
    dto: WarehouseWriteInput,
    requester?: WarehouseActorInput | null,
  ) {
    if (dto && 'branch_id' in dto && dto.branch_id !== undefined) {
      badRequest("Ombor filialini o'zgartirib bo'lmaydi — yangi ombor oching");
    }
    const warehouse = await this.getWarehouse(id, null);
    const input = this.normalizeWrite(dto, 'update');
    const actor = normalizeActor(requester);
    const before = this.auditSnapshot(warehouse);

    const isHq =
      input.managerUserId !== undefined &&
      (await this.directory.getBranch(warehouse.branch_id, { strict: true }))
        ?.is_hq === true;
    if (isHq && input.managerUserId) {
      badRequest("Markaziy omborga mas'ul menejer biriktirilmaydi");
    }
    if (input.managerUserId) {
      await this.assertBranchManager(warehouse.branch_id, input.managerUserId);
    }
    if (input.name) warehouse.name = input.name;
    if (input.managerUserId !== undefined) {
      // XtcEyQjb: `manager_user_id: null` — filialning birinchi faol menejeri
      // (yo'q bo'lsa null). Pa1KaXmj: Markaziy omborda — `null`.
      warehouse.manager_user_id = isHq
        ? null
        : (input.managerUserId ??
          (await this.directory.getFirstActiveBranchManagerId(
            warehouse.branch_id,
          )));
    }
    if (input.address !== undefined) warehouse.address = input.address;
    if (input.note !== undefined) warehouse.note = input.note;
    if (input.lowStockDefault !== undefined) {
      warehouse.low_stock_default = input.lowStockDefault;
    }
    try {
      await this.warehouseRepo.save(warehouse);
    } catch (error) {
      mapWarehouseDbError(error);
    }

    void this.activityLog.logChange({
      entity_type: 'Warehouse',
      entity_id: warehouse.id,
      action: ActivityAction.UPDATED,
      old_value: before,
      new_value: this.auditSnapshot(warehouse),
      user_id: actor.id,
      user_role: actor.role,
    });
    return this.findOne(warehouse.id, null);
  }

  /**
   * Faol ↔ To'xtatilgan (qaror 1). Qoldiq joyida qoladi; to'xtatilgan omborga
   * yangi band tushmaydi (`reserve` 409, `resolve_source` HQ). Mavjud
   * bandlar ishlayveradi (kuryerga berish/qaytish). Takroriy — `changed:false`.
   * `UPDATE` qatorni qulflaydi — parallel `reserve` bilan ketma-ket.
   */
  async setStatus(
    id: unknown,
    status: WarehouseStatus,
    requester?: WarehouseActorInput | null,
    rawNote?: unknown,
  ) {
    const warehouseId = toId(id, 'warehouse_id');
    const actor = normalizeActor(requester);
    const note = toOptionalText(rawNote, 'note', WAREHOUSE_NOTE_MAX) ?? null;
    let updated: Array<{ id: string }>;
    try {
      const result: unknown = await this.manager.query(
        `UPDATE ${this.t(Warehouse)}
            SET "status" = $2,
                "paused_at" = CASE WHEN $2 = 'PAUSED' THEN now() ELSE NULL END,
                "paused_by" = CASE WHEN $2 = 'PAUSED' THEN $3::bigint ELSE NULL END,
                "updatedAt" = now()
          WHERE "id" = $1 AND "is_deleted" = false AND "status" <> $2
        RETURNING "id"::text AS id`,
        [warehouseId, status, actor.id],
      );
      updated = returnedRows<{ id: string }>(result);
    } catch (error) {
      mapWarehouseDbError(error);
    }
    const changed = updated.length > 0;
    if (!changed) {
      // Yo'q yoki allaqachon shu holatda.
      await this.getWarehouse(warehouseId, null);
    } else {
      void this.activityLog.log({
        entity_type: 'Warehouse',
        entity_id: warehouseId,
        action: ActivityAction.STATUS_CHANGE,
        old_value: { status: status === 'PAUSED' ? 'ACTIVE' : 'PAUSED' },
        new_value: { status },
        user_id: actor.id,
        user_role: actor.role,
        metadata: note ? { note } : null,
        description:
          status === 'PAUSED'
            ? `Ombor #${warehouseId} to'xtatildi`
            : `Ombor #${warehouseId} qayta yoqildi`,
      });
    }
    const view = await this.findOne(warehouseId, null);
    return { ...view, changed };
  }

  // ------------------------------------------------------------------
  // O'qish
  // ------------------------------------------------------------------

  /**
   * Omborlar ro'yxati (dizayn `superadmin--warehouse-list`): har qatorda
   * filial, viloyat, mas'ul xodim, jami/band/kam qolgan, oxirgi harakat,
   * holat. `summary` — ko'rinadigan HAMMA omborlar bo'yicha (filtrsiz),
   * `counts` — viloyat/qidiruv filtridan keyin holat bo'yicha.
   */
  async findAll(
    query: {
      status?: unknown;
      region_id?: unknown;
      search?: unknown;
      page?: unknown;
      limit?: unknown;
    } = {},
    scope?: WarehouseScope | null,
  ) {
    const status = str(query?.status).toUpperCase();
    if (status && status !== 'ACTIVE' && status !== 'PAUSED') {
      badRequest('status — ACTIVE yoki PAUSED');
    }
    const regionId = toOptionalId(query?.region_id, 'region_id');
    const search = str(query?.search).toLowerCase();
    const { page, limit, offset } = pagination(
      query?.page,
      query?.limit,
      50,
      200,
    );

    const warehouses = await this.warehouseRepo.find({
      where: {
        isDeleted: false,
        ...(scope ? { branch_id: String(scope.branch_id) } : {}),
      },
      order: { name: 'ASC', id: 'ASC' },
    });
    const ids = warehouses.map((warehouse) => warehouse.id);
    const [branches, stats, reservedOrders, lastMovements, managers, hqId] =
      await Promise.all([
        this.directory.getBranches(warehouses.map((w) => w.branch_id)),
        this.stats(ids),
        this.reservedOrders(ids),
        this.lastMovements(ids),
        this.directory.getUsers(
          warehouses
            .map((w) => w.manager_user_id)
            .filter((id): id is string => !!id),
        ),
        warehouses.length ? this.hqBranchIdForRead() : Promise.resolve(null),
      ]);

    const views = warehouses.map((warehouse) =>
      this.warehouseView(warehouse, {
        branch: branches.get(warehouse.branch_id),
        manager: warehouse.manager_user_id
          ? managers.get(warehouse.manager_user_id)
          : null,
        stats: stats.get(warehouse.id),
        reservedOrders: reservedOrders.get(warehouse.id),
        lastMovement: lastMovements.get(warehouse.id),
        hqBranchId: hqId,
      }),
    );

    const summary = views.reduce(
      (acc, view) => {
        acc.warehouses += 1;
        if (view.status === 'ACTIVE') acc.active += 1;
        else acc.paused += 1;
        acc.positions += view.summary.positions;
        acc.on_hand += view.summary.on_hand;
        acc.reserved += view.summary.reserved;
        acc.available += view.summary.available;
        acc.reserved_orders += view.summary.reserved_orders;
        acc.low_count += view.summary.low_count;
        acc.out_count += view.summary.out_count;
        return acc;
      },
      {
        warehouses: 0,
        active: 0,
        paused: 0,
        positions: 0,
        on_hand: 0,
        reserved: 0,
        available: 0,
        reserved_orders: 0,
        low_count: 0,
        out_count: 0,
      },
    );

    const filtered = views.filter((view) => {
      if (regionId && view.region?.id !== regionId) return false;
      if (search) {
        const haystack =
          `${view.name} ${view.branch?.name ?? ''} ${view.region?.name ?? ''}`.toLowerCase();
        if (!haystack.includes(search)) return false;
      }
      return true;
    });
    const counts = {
      all: filtered.length,
      active: filtered.filter((view) => view.status === 'ACTIVE').length,
      paused: filtered.filter((view) => view.status === 'PAUSED').length,
    };
    const items = status
      ? filtered.filter((view) => view.status === status)
      : filtered;

    return {
      data: items.slice(offset, offset + limit),
      total: items.length,
      page,
      limit,
      counts,
      summary,
    };
  }

  /** Bitta ombor (dizayn `superadmin--warehouse-detail` / `manager--warehouse-detail` sarlavhasi va KPI). */
  async findOne(id: unknown, scope?: WarehouseScope | null) {
    const warehouse = await this.getWarehouse(id, scope);
    const ids = [warehouse.id];
    const [
      branch,
      stats,
      reservedOrders,
      lastMovements,
      managers,
      counts,
      hqId,
    ] = await Promise.all([
      this.directory.getBranch(warehouse.branch_id),
      this.stats(ids),
      this.reservedOrders(ids),
      this.lastMovements(ids),
      this.directory.getUsers(
        warehouse.manager_user_id ? [warehouse.manager_user_id] : [],
      ),
      this.manager.query<Array<{ movements: number }>>(
        `SELECT count(*)::int AS movements FROM ${this.t(StockMovement)}
            WHERE "warehouse_id" = $1`,
        [warehouse.id],
      ),
      this.hqBranchIdForRead(),
    ]);
    return {
      ...this.warehouseView(warehouse, {
        branch,
        manager: warehouse.manager_user_id
          ? managers.get(warehouse.manager_user_id)
          : null,
        stats: stats.get(warehouse.id),
        reservedOrders: reservedOrders.get(warehouse.id),
        lastMovement: lastMovements.get(warehouse.id),
        hqBranchId: hqId,
      }),
      movements_count: counts[0]?.movements ?? 0,
    };
  }

  /**
   * Qoldiq jadvali: mahsulot, kod (zavod shtrix kodi yoki ELC-P), market,
   * qoldiq/band/mavjud, chegara, «Hisob vazni», holat. Filtrlar: market,
   * holat (`level` — ok,low,out; vergul bilan bir nechta), qidiruv (nom,
   * Elchi kodi, shtrix kod). Saralash: qoldiq o'sishi bo'yicha (tugaganlar
   * tepada), keyin nom.
   */
  async listStock(
    id: unknown,
    query: {
      market_id?: unknown;
      level?: unknown;
      search?: unknown;
      page?: unknown;
      limit?: unknown;
      all?: unknown;
    } = {},
    scope?: WarehouseScope | null,
    restrictMarketId?: string | null,
  ) {
    const warehouse = await this.getWarehouse(id, scope);
    const marketId =
      restrictMarketId ?? toOptionalId(query?.market_id, 'market_id');
    const levels = asList(query?.level).map((level) => level.toLowerCase());
    const invalidLevel = levels.find(
      (level) => !(WAREHOUSE_STOCK_LEVELS as readonly string[]).includes(level),
    );
    if (invalidLevel) badRequest('level — ok, low, out (vergul bilan)');
    const exportAll = query?.all === true || query?.all === 'true';
    const { page, limit, offset } = exportAll
      ? { page: 1, limit: 10_000, offset: 0 }
      : pagination(query?.page, query?.limit, 20, 200);

    const params: unknown[] = [warehouse.id];
    const where: string[] = [`s."warehouse_id" = $1`];
    if (marketId) {
      params.push(marketId);
      where.push(`s."market_id" = $${params.length}`);
    }
    const search = str(query?.search);
    if (search) {
      params.push(`%${search.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`);
      const parts = [`p."name" ILIKE $${params.length}`];
      const skuId = parseProductSkuCode(search);
      if (skuId) {
        params.push(formatProductSkuCode(skuId));
        parts.push(`p."sku_code" = $${params.length}`);
      }
      const barcodes = productBarcodeLookupVariants(search);
      if (barcodes.length) {
        params.push(barcodes);
        parts.push(`p."barcode" = ANY($${params.length}::text[])`);
      }
      where.push(`(${parts.join(' OR ')})`);
    }
    const baseWhere = where.join(' AND ');
    const levelWhere = levels.length
      ? ` AND (${levels.map((level) => `(${LEVEL_SQL[level as WarehouseStockLevel]})`).join(' OR ')})`
      : '';
    const from = `${this.t(WarehouseStock)} s
      JOIN ${this.t(Warehouse)} w ON w."id" = s."warehouse_id"
      JOIN ${this.t(Product)} p ON p."id" = s."product_id"`;

    const [rows, totals, facets, marketFacet] = await Promise.all([
      this.manager.query<StockListRow[]>(
        `SELECT s."id"::text AS stock_id, s."product_id"::text AS product_id,
                s."market_id"::text AS market_id, s."on_hand", s."reserved",
                s."low_stock_threshold",
                COALESCE(s."low_stock_threshold", w."low_stock_default") AS threshold,
                s."last_movement_at", ${productColumns()}
           FROM ${from}
          WHERE ${baseWhere}${levelWhere}
          ORDER BY s."on_hand" ASC, lower(p."name") ASC, s."id" ASC
          LIMIT ${limit} OFFSET ${offset}`,
        params,
      ),
      this.manager.query<Array<{ total: number }>>(
        `SELECT count(*)::int AS total FROM ${from} WHERE ${baseWhere}${levelWhere}`,
        params,
      ),
      this.manager.query<
        Array<{ all_count: number; ok: number; low: number; out: number }>
      >(
        `SELECT count(*)::int AS all_count,
                count(*) FILTER (WHERE ${LEVEL_SQL.ok})::int AS ok,
                count(*) FILTER (WHERE ${LEVEL_SQL.low})::int AS low,
                count(*) FILTER (WHERE ${LEVEL_SQL.out})::int AS out
           FROM ${from} WHERE ${baseWhere}`,
        params,
      ),
      this.manager.query<Array<{ market_id: string; positions: number }>>(
        `SELECT s."market_id"::text AS market_id, count(*)::int AS positions
           FROM ${this.t(WarehouseStock)} s
          WHERE s."warehouse_id" = $1${restrictMarketId ? ` AND s."market_id" = $2` : ''}
          GROUP BY s."market_id"`,
        restrictMarketId ? [warehouse.id, restrictMarketId] : [warehouse.id],
      ),
    ]);

    const markets = await this.directory.getMarkets(
      Array.from(
        new Set([
          ...rows.map((row) => row.market_id),
          ...marketFacet.map((row) => row.market_id),
        ]),
      ),
    );
    const marketName = (marketId: string) =>
      markets.get(marketId)?.name ?? null;

    return {
      warehouse: {
        id: warehouse.id,
        name: warehouse.name,
        status: warehouse.status,
      },
      data: rows.map((row) => {
        const available = row.on_hand - row.reserved;
        const threshold = num(row.threshold);
        return {
          stock_id: row.stock_id,
          product: productView(row),
          market: { id: row.market_id, name: marketName(row.market_id) },
          on_hand: row.on_hand,
          reserved: row.reserved,
          available,
          low_stock_threshold: row.low_stock_threshold,
          threshold,
          level: warehouseStockLevel(available, threshold),
          last_movement_at: row.last_movement_at,
        };
      }),
      total: totals[0]?.total ?? 0,
      page,
      limit,
      facets: {
        levels: {
          all: facets[0]?.all_count ?? 0,
          ok: facets[0]?.ok ?? 0,
          low: facets[0]?.low ?? 0,
          out: facets[0]?.out ?? 0,
        },
        markets: marketFacet
          .map((row) => ({
            id: row.market_id,
            name: marketName(row.market_id),
            positions: row.positions,
          }))
          .sort((a, b) =>
            String(a.name ?? '').localeCompare(String(b.name ?? '')),
          ),
      },
    };
  }

  /**
   * Harakatlar jurnali (sahifalash): tur, ishorali son, mahsulot, market,
   * manba (buyurtma №, kirim, inventarizatsiya), aktyor (ism + rol), izoh.
   * Eng yangisi tepada.
   */
  async listMovements(
    id: unknown,
    query: {
      type?: unknown;
      product_id?: unknown;
      market_id?: unknown;
      ref_type?: unknown;
      ref_id?: unknown;
      from?: unknown;
      to?: unknown;
      page?: unknown;
      limit?: unknown;
    } = {},
    scope?: WarehouseScope | null,
  ) {
    const warehouse = await this.getWarehouse(id, scope);
    const types = asList(query?.type).map((type) => type.toUpperCase());
    const badType = types.find(
      (type) => !(STOCK_MOVEMENT_TYPES as readonly string[]).includes(type),
    );
    if (badType)
      badRequest(`type — ${STOCK_MOVEMENT_TYPES.join(', ')} (vergul bilan)`);
    const productId = toOptionalId(query?.product_id, 'product_id');
    const marketId = toOptionalId(query?.market_id, 'market_id');
    const refType = str(query?.ref_type);
    if (
      refType &&
      !['stock_in', 'inventory', 'order', 'move'].includes(refType)
    ) {
      badRequest('ref_type — stock_in, inventory, order, move');
    }
    const refId = str(query?.ref_id).slice(0, 128);
    const parseDate = (raw: unknown, field: string): Date | null => {
      const value = str(raw);
      if (!value) return null;
      const date = new Date(value);
      if (Number.isNaN(date.getTime())) badRequest(`${field} — ISO sana`);
      return date;
    };
    const from = parseDate(query?.from, 'from');
    const to = parseDate(query?.to, 'to');
    const { page, limit, offset } = pagination(
      query?.page,
      query?.limit,
      20,
      200,
    );

    const params: unknown[] = [warehouse.id];
    const where: string[] = [`m."warehouse_id" = $1`];
    const push = (sql: string, value: unknown) => {
      params.push(value);
      where.push(sql.replace('?', `$${params.length}`));
    };
    if (types.length) push(`m."type" = ANY(?::text[])`, types);
    if (productId) push(`m."product_id" = ?`, productId);
    if (marketId) push(`m."market_id" = ?`, marketId);
    if (refType) push(`m."ref_type" = ?`, refType);
    if (refId) push(`m."ref_id" = ?`, refId);
    if (from) push(`m."createdAt" >= ?`, from);
    if (to) push(`m."createdAt" < ?`, to);
    const whereSql = where.join(' AND ');

    const [rows, totals] = await Promise.all([
      this.manager.query<MovementListRow[]>(
        `SELECT m."id"::text AS id, m."type", m."qty", m."on_hand_after",
                m."reserved_after", m."ref_type", m."ref_id",
                m."actor_id"::text AS actor_id, m."actor_role", m."note",
                m."createdAt", m."product_id"::text AS product_id,
                m."market_id"::text AS market_id,
                p."name" AS product_name, p."sku_code", p."barcode"
           FROM ${this.t(StockMovement)} m
           JOIN ${this.t(Product)} p ON p."id" = m."product_id"
          WHERE ${whereSql}
          ORDER BY m."createdAt" DESC, m."id" DESC
          LIMIT ${limit} OFFSET ${offset}`,
        params,
      ),
      this.manager.query<Array<{ total: number }>>(
        `SELECT count(*)::int AS total FROM ${this.t(StockMovement)} m WHERE ${whereSql}`,
        params,
      ),
    ]);

    const [markets, actors] = await Promise.all([
      this.directory.getMarkets(rows.map((row) => row.market_id)),
      this.directory.getUserSummaries(
        rows
          .map((row) => row.actor_id)
          .filter((value): value is string => !!value),
      ),
    ]);

    return {
      warehouse: {
        id: warehouse.id,
        name: warehouse.name,
        status: warehouse.status,
      },
      data: rows.map((row) => {
        const actor = row.actor_id ? actors.get(row.actor_id) : undefined;
        return {
          id: row.id,
          type: row.type,
          qty: row.qty,
          on_hand_after: row.on_hand_after,
          reserved_after: row.reserved_after,
          ref_type: row.ref_type,
          ref_id: row.ref_id,
          order_id: row.ref_type === 'order' ? row.ref_id : null,
          note: row.note,
          created_at: row.createdAt,
          product: {
            id: row.product_id,
            name: row.product_name,
            sku_code: row.sku_code,
            barcode: row.barcode,
          },
          market: {
            id: row.market_id,
            name: markets.get(row.market_id)?.name ?? null,
          },
          actor: row.actor_id
            ? {
                id: row.actor_id,
                name: actor?.name ?? null,
                role: row.actor_role ?? actor?.role ?? null,
              }
            : row.actor_role
              ? { id: null, name: null, role: row.actor_role }
              : null,
        };
      }),
      total: totals[0]?.total ?? 0,
      page,
      limit,
    };
  }

  /**
   * Kirim/inventarizatsiya skaneri: kod (`ELC-P-…` yoki zavod shtrix kodi)
   * → mahsulot(lar) + SHU ombordagi qoldiq (`stock: null` — omborda hali
   * yo'q, «0 · yangi»). Topilmasa `data: []` (404 emas).
   */
  async lookup(
    id: unknown,
    query: { code?: unknown; market_id?: unknown },
    scope?: WarehouseScope | null,
  ) {
    const warehouse = await this.getWarehouse(id, scope);
    const code = str(query?.code);
    if (!code) badRequest("code bo'sh bo'lishi mumkin emas");
    if (code.length > 512) badRequest('code 512 belgidan oshmasligi kerak');
    const marketId = toOptionalId(query?.market_id, 'market_id');
    const products = await findProductsByCode(this.manager, code, marketId);
    const stock: Array<{
      product_id: string;
      on_hand: number;
      reserved: number;
      threshold: number;
    }> = products.length
      ? await this.manager.query(
          `SELECT s."product_id"::text AS product_id, s."on_hand", s."reserved",
                  COALESCE(s."low_stock_threshold", w."low_stock_default") AS threshold
             FROM ${this.t(WarehouseStock)} s
             JOIN ${this.t(Warehouse)} w ON w."id" = s."warehouse_id"
            WHERE s."warehouse_id" = $1 AND s."product_id" = ANY($2::bigint[])`,
          [warehouse.id, products.map((product) => product.id)],
        )
      : [];
    const markets = await this.directory.getMarkets(
      products.map((product) => product.user_id),
    );
    return {
      warehouse: {
        id: warehouse.id,
        name: warehouse.name,
        status: warehouse.status,
      },
      code,
      matched_by: !products.length
        ? null
        : code.toUpperCase().startsWith('ELC-P-')
          ? 'sku_code'
          : 'barcode',
      data: products.map((product) => {
        const row = stock.find((item) => item.product_id === product.id);
        const available = row ? row.on_hand - row.reserved : 0;
        return {
          product: productView(product),
          market: {
            id: product.user_id,
            name: markets.get(product.user_id)?.name ?? null,
          },
          stock: row
            ? {
                on_hand: row.on_hand,
                reserved: row.reserved,
                available,
                threshold: num(row.threshold),
                level: warehouseStockLevel(available, num(row.threshold)),
              }
            : null,
        };
      }),
    };
  }

  /**
   * Market «Ombordagi qoldiq» (dizayn `market--products-warehouse-stock`):
   * FAQAT shu marketning mahsulotlari (IDOR: `marketId` gateway'da tokendan).
   * Ustunlar — barcha omborlar (to'xtatilgani ham, belgisi bilan); katakda
   * MAVJUD dona; `total_available` — faqat FAOL omborlar.
   */
  async marketStock(
    rawMarketId: unknown,
    query: {
      search?: unknown;
      low_only?: unknown;
      page?: unknown;
      limit?: unknown;
    } = {},
  ) {
    const marketId = toId(rawMarketId, 'market_id');
    const lowOnly = query?.low_only === true || query?.low_only === 'true';
    const search = str(query?.search);
    const { page, limit, offset } = pagination(
      query?.page,
      query?.limit,
      50,
      500,
    );

    const warehouses = await this.warehouseRepo.find({
      where: { isDeleted: false },
      order: { name: 'ASC', id: 'ASC' },
    });
    const params: unknown[] = [marketId];
    let searchSql = '';
    if (search) {
      params.push(`%${search.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`);
      searchSql = ` AND p."name" ILIKE $${params.length}`;
    }
    const [rows, productTotals, branches, hqId] = await Promise.all([
      this.manager.query<MarketStockRow[]>(
        `SELECT s."warehouse_id"::text AS warehouse_id,
                s."product_id"::text AS product_id, s."on_hand", s."reserved",
                COALESCE(s."low_stock_threshold", w."low_stock_default") AS threshold,
                w."status" AS warehouse_status, ${productColumns()}
           FROM ${this.t(WarehouseStock)} s
           JOIN ${this.t(Warehouse)} w ON w."id" = s."warehouse_id" AND w."is_deleted" = false
           JOIN ${this.t(Product)} p ON p."id" = s."product_id"
          WHERE s."market_id" = $1${searchSql}
          ORDER BY lower(p."name") ASC, p."id" ASC`,
        params,
      ),
      this.manager.query<Array<{ total: number }>>(
        `SELECT count(*)::int AS total FROM ${this.t(Product)}
          WHERE "user_id" = $1 AND "is_deleted" = false`,
        [marketId],
      ),
      this.directory.getBranches(warehouses.map((w) => w.branch_id)),
      warehouses.length ? this.hqBranchIdForRead() : Promise.resolve(null),
    ]);

    const byProduct = new Map<
      string,
      {
        product: ReturnType<typeof productView>;
        cells: Array<{
          warehouse_id: string;
          warehouse_status: WarehouseStatus;
          on_hand: number;
          reserved: number;
          available: number;
          threshold: number;
          level: WarehouseStockLevel;
        }>;
      }
    >();
    for (const row of rows) {
      const entry = byProduct.get(row.product_id) ?? {
        product: productView(row),
        cells: [],
      };
      const available = row.on_hand - row.reserved;
      const threshold = num(row.threshold);
      entry.cells.push({
        warehouse_id: row.warehouse_id,
        warehouse_status: row.warehouse_status,
        on_hand: row.on_hand,
        reserved: row.reserved,
        available,
        threshold,
        level: warehouseStockLevel(available, threshold),
      });
      byProduct.set(row.product_id, entry);
    }

    let lowPositions = 0;
    let outPositions = 0;
    let totalAvailable = 0;
    const activeWithStock = new Set<string>();
    const items = Array.from(byProduct.values()).map((entry) => {
      const active = entry.cells.filter(
        (cell) => cell.warehouse_status === 'ACTIVE',
      );
      const totalActive = active.reduce(
        (sum, cell) => sum + Math.max(0, cell.available),
        0,
      );
      active.forEach((cell) => {
        if (cell.level === 'low') lowPositions += 1;
        if (cell.level === 'out') outPositions += 1;
        if (cell.available > 0) activeWithStock.add(cell.warehouse_id);
      });
      totalAvailable += totalActive;
      return {
        ...entry,
        total_available: totalActive,
        total_on_hand: entry.cells.reduce((sum, cell) => sum + cell.on_hand, 0),
        has_low: active.some((cell) => cell.level !== 'ok'),
      };
    });
    const visible = lowOnly ? items.filter((item) => item.has_low) : items;

    return {
      market_id: marketId,
      warehouses: warehouses.map((warehouse) => {
        const branch = branches.get(warehouse.branch_id);
        return {
          id: warehouse.id,
          name: warehouse.name,
          status: warehouse.status,
          kind: this.kindOf(warehouse.branch_id, branch, hqId),
          branch: branch ? { id: branch.id, name: branch.name } : null,
          region: branch?.region ?? null,
        };
      }),
      data: visible.slice(offset, offset + limit),
      total: visible.length,
      page,
      limit,
      summary: {
        products_total: productTotals[0]?.total ?? 0,
        products_in_warehouses: items.length,
        total_available: totalAvailable,
        warehouses_total: warehouses.length,
        warehouses_active: warehouses.filter((w) => w.status === 'ACTIVE')
          .length,
        warehouses_paused: warehouses.filter((w) => w.status === 'PAUSED')
          .length,
        active_warehouses_with_stock: activeWithStock.size,
        low_positions: lowPositions,
        out_positions: outPositions,
      },
    };
  }

  // ------------------------------------------------------------------
  // Buyurtma manbasi (qaror 4) — order-service va yaratish formasi
  // ------------------------------------------------------------------

  /**
   * Hudud (viloyat/logistika hududi) filialidagi omborlar, id bo'yicha.
   * Pa1KaXmj: faqat viloyat filiallari (REGIONAL/HYBRID) — Markaziy ombor
   * (HQ) hech qachon nomzod emas, HQ'ning `region_id` si mos kelsa ham.
   * VkKDSNNn: Markaziy ombor — alohida 2-pog'ona (`hqTierWarehouse`, kalit
   * bilan), bu ro'yxatga kirmaydi.
   */
  private async candidatesForRegion(regionId: string) {
    const warehouses = await this.warehouseRepo.find({
      where: { isDeleted: false },
      order: { id: 'ASC' },
    });
    const branches = await this.directory.getBranches(
      warehouses.map((warehouse) => warehouse.branch_id),
    );
    return warehouses
      .map((warehouse) => ({
        warehouse,
        branch: branches.get(warehouse.branch_id) ?? null,
      }))
      .filter(
        (item): item is { warehouse: Warehouse; branch: WarehouseBranchInfo } =>
          !!item.branch &&
          item.branch.regional &&
          item.branch.region_id === regionId,
      );
  }

  private candidateView(item: {
    warehouse: Warehouse;
    branch: WarehouseBranchInfo;
  }) {
    return {
      id: item.warehouse.id,
      name: item.warehouse.name,
      status: item.warehouse.status,
      kind: this.kindOf(item.warehouse.branch_id, item.branch, null),
      branch_id: item.branch.id,
      branch_name: item.branch.name,
      region_id: item.branch.region_id,
      region_name: item.branch.region?.name ?? null,
    };
  }

  private async resolveRegion(input: {
    region_id?: unknown;
    district_id?: unknown;
  }) {
    const regionId = toOptionalId(input?.region_id, 'region_id');
    if (regionId) return regionId;
    const districtId = toOptionalId(input?.district_id, 'district_id');
    if (!districtId) return null;
    return this.directory.regionForDistrict(districtId);
  }

  /**
   * VkKDSNNn: Markaziy ombor pog'onasi kaliti (`WAREHOUSE_HQ_TIER_ENABLED`).
   * ConfigService Joi'dan o'tgan boolean qaytaradi; ehtiyot uchun satr
   * ko'rinishi ham tushuniladi ('true' / '1' / 'yes', katta-kichik harf
   * farqsiz). Config yo'q (spec) yoki boshqa qiymat — o'chiq (order-gateway
   * `isAiOrderEnabled` naqshi).
   */
  private hqTierEnabled(): boolean {
    const raw: unknown = this.config?.get<unknown>(WAREHOUSE_HQ_TIER_FLAG);
    if (typeof raw === 'boolean') return raw;
    return (
      typeof raw === 'string' &&
      ['true', '1', 'yes'].includes(raw.trim().toLowerCase())
    );
  }

  /**
   * VkKDSNNn: Markaziy ombor (2-pog'ona nomzodi) — HQ filial id aniq, filial
   * haqiqatan HQ va faol (`can_host_warehouse`) bo'lsa, o'sha filialdagi
   * (o'chirilmagan) ombor. Aks holda `null` — fail-closed: HQ id kelmasa
   * (branch-service sekin/uzilgan, `HQ_ID_READ_WAIT_MS`) yoki filial
   * olinmasa Markaziy ombor tanlanmaydi. Holat (FAOL/to'xtatilgan) —
   * chaqiruvchida.
   */
  private async hqTierWarehouse(): Promise<{
    warehouse: Warehouse;
    branch: WarehouseBranchInfo;
  } | null> {
    const hqId = await this.hqBranchIdForRead();
    if (!hqId) return null;
    const branch = await this.directory.getBranch(hqId);
    if (!branch?.is_hq || !branch.can_host_warehouse) return null;
    // HQ filialida ko'pi bilan bitta ombor (UQ_warehouses_branch_id).
    const warehouse = await this.warehouseRepo.findOne({
      where: { branch_id: hqId, isDeleted: false },
    });
    return warehouse ? { warehouse, branch } : null;
  }

  /**
   * `source: HQ` natijasi (market olib keladi). VkKDSNNn: `resolveSource`
   * ichidagi yopilmadan ajratildi — ikkala pog'ona ham ishlatadi; maydonlar
   * va ularning tartibi o'zgarmagan.
   */
  private hqSource(
    reason: WarehouseSourceReason,
    extra: Record<string, unknown> = {},
  ) {
    return {
      source: 'HQ' as const,
      reason,
      region_id: null as string | null,
      warehouse: null as ReturnType<WarehouseService['candidateView']> | null,
      items: [] as SourceLine[],
      shortages: [] as SourceShortage[],
      ...extra,
    };
  }

  /**
   * VkKDSNNn: mahsulotlar yaroqliligi (ikkala pog'ona uchun bitta qoida):
   * topilmagan, o'chirilgan yoki (market berilgan bo'lsa) begona market
   * mahsuloti — yaroqsiz. `invalid` — qatorlar tartibida.
   */
  private async validateProducts(items: OrderItem[], marketId: string | null) {
    const products = await loadProducts(
      this.manager,
      items.map((item) => item.product_id),
    );
    const invalid = items
      .filter((item) => {
        const product = products.get(item.product_id);
        return (
          !product ||
          product.is_deleted ||
          (marketId !== null && product.user_id !== marketId)
        );
      })
      .map((item) => item.product_id);
    return { products, invalid };
  }

  /**
   * VkKDSNNn: bitta ombordagi qatorlar — kerak / mavjud (band ayirilgan) /
   * yetarlimi. Ikkala pog'ona ham shu hisobni ishlatadi.
   */
  private async stockLines(
    warehouseId: string,
    items: OrderItem[],
    products: Map<string, WarehouseProductRow>,
  ): Promise<SourceLine[]> {
    const stock: Array<{
      product_id: string;
      on_hand: number;
      reserved: number;
    }> = await this.manager.query(
      `SELECT "product_id"::text AS product_id, "on_hand", "reserved"
           FROM ${this.t(WarehouseStock)}
          WHERE "warehouse_id" = $1 AND "product_id" = ANY($2::bigint[])`,
      [warehouseId, items.map((item) => item.product_id)],
    );
    return items.map((item) => {
      const row = stock.find((entry) => entry.product_id === item.product_id);
      const available = row ? Math.max(0, row.on_hand - row.reserved) : 0;
      return {
        product_id: item.product_id,
        name: products.get(item.product_id)?.name ?? null,
        required: item.quantity,
        available,
        enough: available >= item.quantity,
      };
    });
  }

  /**
   * Manba (qaror 4/5): buyurtma hududi filialida FAOL ombor bo'lsa va HAMMA
   * mahsulot yetarli bo'lsa — o'sha ombor, aks holda butun buyurtma HQ
   * (bo'linmaydi). Faqat O'QIYDI — haqiqiy tekshiruv `reserve` da (qulf
   * ostida); poyga bo'lsa `reserve` 409 → HQ.
   *
   * Market (yoki market operatori) yaratayotgan bo'lsa — market kaliti
   * `can_order_from_warehouse` yoqilgan bo'lishi shart (sukut o'chiq;
   * aniqlanmasa — HQ, fail-closed).
   *
   * VkKDSNNn — 2-pog'ona (faqat `WAREHOUSE_HQ_TIER_ENABLED` yoqilganda):
   * viloyat ombori yo'q / to'xtatilgan / qoldig'i yetmasa — Markaziy ombor
   * (HQ filiali) ko'rib chiqiladi. Hammasi yetarli bo'lsa `source: WAREHOUSE`,
   * `warehouse.kind: HQ` va viloyat sababi `regional_reason` /
   * `regional_warehouse` / `regional_shortages` da. Markaziy ombor ham to'g'ri
   * kelmasa — viloyat natijasi (`reason` — viloyat sababi) + `hq_reason`
   * (`HQ_WAREHOUSE_REASONS`), bo'lsa `hq_warehouse` / `hq_shortages`.
   * Kalit o'chiq bo'lsa javob 1-bosqichdagi bilan AYNAN bir xil (yangi
   * maydon yo'q).
   */
  async resolveSource(input: {
    region_id?: unknown;
    district_id?: unknown;
    items?: unknown;
    market_id?: unknown;
    requester?: WarehouseActorInput | null;
  }) {
    const items = normalizeOrderItems(input?.items);
    const marketId = toOptionalId(input?.market_id, 'market_id');
    const regional = await this.resolveRegional(input, items, marketId);
    if (regional.source === 'WAREHOUSE') return regional;
    // I1: kalit o'chiq — javob 1-bosqichdagidek (yangi maydon yo'q).
    if (!this.hqTierEnabled()) return regional;
    // MARKET_NOT_ALLOWED, NO_ITEMS, NO_REGION, PRODUCT_INVALID — buyurtma
    // umuman ombordan bo'la olmaydi, 2-pog'ona yo'q.
    if (!HQ_TIER_REASONS.has(regional.reason)) return regional;
    // Yuqoridagi uch sababda `region_id` doim bor (ehtiyot).
    const regionId = regional.region_id;
    if (!regionId) return regional;

    const hq = await this.hqTierWarehouse();
    if (!hq) {
      return {
        ...regional,
        hq_reason: 'NO_HQ_WAREHOUSE' as HqWarehouseReason,
      };
    }
    const view = this.candidateView(hq);
    if (hq.warehouse.status !== 'ACTIVE') {
      return {
        ...regional,
        hq_reason: 'HQ_WAREHOUSE_PAUSED' as HqWarehouseReason,
        hq_warehouse: view,
      };
    }
    // Viloyat ombori yo'q/to'xtatilgan bo'lsa mahsulotlar hali
    // tekshirilmagan — Markaziy ombor uchun ham AYNI qoida.
    const { products, invalid } = await this.validateProducts(items, marketId);
    if (invalid.length) {
      return this.hqSource('PRODUCT_INVALID', {
        region_id: regionId,
        invalid_product_ids: invalid,
      });
    }
    const lines = await this.stockLines(hq.warehouse.id, items, products);
    if (lines.every((line) => line.enough)) {
      return {
        source: 'WAREHOUSE' as const,
        reason: 'OK' as const,
        region_id: regionId,
        warehouse: view,
        items: lines,
        shortages: [] as SourceShortage[],
        regional_reason: regional.reason,
        regional_warehouse: regional.warehouse,
        regional_shortages: regional.shortages,
      };
    }
    return {
      ...regional,
      hq_reason: 'HQ_INSUFFICIENT_STOCK' as HqWarehouseReason,
      hq_warehouse: view,
      hq_shortages: shortagesOf(lines),
    };
  }

  /**
   * 1-pog'ona — viloyat ombori (VkKDSNNn: `resolveSource` ning avvalgi
   * tanasi, xulq o'zgarmagan). Tekshiruv tartibi: MARKET_NOT_ALLOWED →
   * NO_ITEMS → NO_REGION → NO_WAREHOUSE → WAREHOUSE_PAUSED → PRODUCT_INVALID
   * → qoldiq (birinchi yetarli FAOL ombor yoki birinchisining
   * INSUFFICIENT_STOCK).
   */
  private async resolveRegional(
    input: {
      region_id?: unknown;
      district_id?: unknown;
      requester?: WarehouseActorInput | null;
    },
    items: OrderItem[],
    marketId: string | null,
  ) {
    const requester = input?.requester ?? null;
    const isMarketCreator =
      hasAnyRole(requester, [Roles.MARKET, Roles.MARKET_OPERATOR]) &&
      !hasAnyRole(requester, [
        Roles.SUPERADMIN,
        Roles.ADMIN,
        Roles.REGISTRATOR,
      ]);
    if (isMarketCreator) {
      const market: WarehouseMarketInfo | null = marketId
        ? await this.directory.getMarket(marketId)
        : null;
      if (!market?.can_order_from_warehouse) {
        return this.hqSource('MARKET_NOT_ALLOWED');
      }
    }
    if (!items.length) return this.hqSource('NO_ITEMS');

    const regionId = await this.resolveRegion(input);
    if (!regionId) return this.hqSource('NO_REGION');

    const candidates = await this.candidatesForRegion(regionId);
    if (!candidates.length) {
      return this.hqSource('NO_WAREHOUSE', { region_id: regionId });
    }
    const active = candidates.filter(
      (item) => item.warehouse.status === 'ACTIVE',
    );
    if (!active.length) {
      return this.hqSource('WAREHOUSE_PAUSED', {
        region_id: regionId,
        warehouse: this.candidateView(candidates[0]),
      });
    }

    const { products, invalid } = await this.validateProducts(items, marketId);
    if (invalid.length) {
      return this.hqSource('PRODUCT_INVALID', {
        region_id: regionId,
        invalid_product_ids: invalid,
      });
    }

    let first: ReturnType<WarehouseService['hqSource']> | null = null;
    for (const candidate of active) {
      const lines = await this.stockLines(
        candidate.warehouse.id,
        items,
        products,
      );
      if (lines.every((line) => line.enough)) {
        return {
          source: 'WAREHOUSE' as const,
          reason: 'OK' as const,
          region_id: regionId,
          warehouse: this.candidateView(candidate),
          items: lines,
          shortages: [] as SourceShortage[],
        };
      }
      first ??= this.hqSource('INSUFFICIENT_STOCK', {
        region_id: regionId,
        warehouse: this.candidateView(candidate),
        items: lines,
        shortages: shortagesOf(lines),
      });
    }
    return first!;
  }

  /**
   * Yaratish formasi uchun «Omborda: N»: hudud omboridagi (birinchi FAOL)
   * mavjud dona — market mahsulotlari (`market_id`) yoki `product_ids`.
   * Ombor to'xtatilgan bo'lsa `warehouse.status = PAUSED`, `items: []`.
   *
   * VkKDSNNn: kalit yoqilgan, hudud aniqlangan va Markaziy ombor FAOL bo'lsa
   * — qo'shimcha `hq_warehouse` va `hq_items` (shu shakl, shu filtrlar).
   * Aks holda bu maydonlar YO'Q (kalit o'chiq — javob o'zgarmagan).
   */
  async availability(input: {
    region_id?: unknown;
    district_id?: unknown;
    market_id?: unknown;
    product_ids?: unknown;
  }) {
    const marketId = toOptionalId(input?.market_id, 'market_id');
    const productIds = asList(input?.product_ids).map((value, index) =>
      toId(value, `product_ids[${index}]`),
    );
    if (!marketId && !productIds.length) {
      badRequest('market_id yoki product_ids majburiy');
    }
    if (productIds.length > 500) badRequest("product_ids — ko'pi bilan 500 ta");
    const regionId = await this.resolveRegion(input);
    if (!regionId) {
      return { region_id: null, warehouse: null, items: [] };
    }
    const regional = await this.availabilityRegional(
      regionId,
      marketId,
      productIds,
    );
    if (!this.hqTierEnabled()) return regional;
    const hq = await this.hqTierWarehouse();
    if (!hq || hq.warehouse.status !== 'ACTIVE') return regional;
    return {
      ...regional,
      hq_warehouse: this.candidateView(hq),
      hq_items: await this.availabilityItems(
        hq.warehouse.id,
        marketId,
        productIds,
      ),
    };
  }

  /**
   * Viloyat ombori bloki (VkKDSNNn: `availability` dan ajratildi, xulq
   * o'zgarmagan).
   */
  private async availabilityRegional(
    regionId: string,
    marketId: string | null,
    productIds: string[],
  ) {
    const candidates = await this.candidatesForRegion(regionId);
    const chosen =
      candidates.find((item) => item.warehouse.status === 'ACTIVE') ??
      candidates[0] ??
      null;
    if (!chosen) return { region_id: regionId, warehouse: null, items: [] };
    if (chosen.warehouse.status !== 'ACTIVE') {
      return {
        region_id: regionId,
        warehouse: this.candidateView(chosen),
        items: [],
      };
    }
    return {
      region_id: regionId,
      warehouse: this.candidateView(chosen),
      items: await this.availabilityItems(
        chosen.warehouse.id,
        marketId,
        productIds,
      ),
    };
  }

  /**
   * Bitta ombordagi mavjud dona (faqat qatori bor mahsulotlar), `market_id`
   * va/yoki `product_ids` filtri bilan. VkKDSNNn: viloyat va Markaziy ombor
   * uchun bitta so'rov.
   */
  private async availabilityItems(
    warehouseId: string,
    marketId: string | null,
    productIds: string[],
  ) {
    const params: unknown[] = [warehouseId];
    const where: string[] = [`"warehouse_id" = $1`];
    if (marketId) {
      params.push(marketId);
      where.push(`"market_id" = $${params.length}`);
    }
    if (productIds.length) {
      params.push(productIds);
      where.push(`"product_id" = ANY($${params.length}::bigint[])`);
    }
    const rows: Array<{
      product_id: string;
      on_hand: number;
      reserved: number;
    }> = await this.manager.query(
      `SELECT "product_id"::text AS product_id, "on_hand", "reserved"
           FROM ${this.t(WarehouseStock)} WHERE ${where.join(' AND ')}
          ORDER BY "product_id"`,
      params,
    );
    return rows.map((row) => ({
      product_id: row.product_id,
      on_hand: row.on_hand,
      reserved: row.reserved,
      available: Math.max(0, row.on_hand - row.reserved),
    }));
  }

  /** Bir nechta omborni id bo'yicha (ichki — order tafsiloti boyitishi). */
  async findByIds(ids: unknown) {
    const list = asList(ids)
      .filter((id) => /^\d+$/.test(id))
      .slice(0, 200);
    if (!list.length) return { data: [] };
    const warehouses = await this.warehouseRepo.find({
      where: { id: In(list) },
    });
    // Pa1KaXmj: `kind` — filial ma'lumotisiz, keshlangan HQ id bo'yicha.
    // Yagona chaqiruvchi — order-service ro'yxat/tafsilot boyitishi
    // (`loadWarehouseRefs`, timeout 3 s): HQ id ko'pi bilan
    // `HQ_ID_READ_WAIT_MS` kutiladi, branch-service sekin bo'lsa ham ro'yxat
    // kechikmaydi (`kind` zaxirasi — `REGIONAL`).
    const hqId = warehouses.length ? await this.hqBranchIdForRead() : null;
    return {
      data: warehouses.map((warehouse) => ({
        id: warehouse.id,
        name: warehouse.name,
        status: warehouse.status,
        kind: this.kindOf(warehouse.branch_id, null, hqId),
        branch_id: warehouse.branch_id,
      })),
    };
  }
}
