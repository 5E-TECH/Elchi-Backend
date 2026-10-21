import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { RpcException } from '@nestjs/microservices';
import { DataSource, EntityManager } from 'typeorm';
import { ActivityLogService, Operation_type, Source_type } from '@app/common';
import { CashboxExpenseCategory } from '../entities/cashbox-expense-category.entity';

/**
 * Elchi Pochta №1 — kassa xarajatlari kategoriyalari.
 *
 *   • ro'yxat — kassadan chiqim qila oladigan hamma (superadmin, admin,
 *     menejer): faqat o'chirilmaganlar, `sort_order` bo'yicha;
 *   • qo'shish / tahrirlash / o'chirish — faqat superadmin (gateway @Roles).
 *     O'chirish SOFT: tarix qatorlari nomni snapshot sifatida saqlaydi
 *     (`cashbox_history.expense_category_name`), o'chirilgan nom yangi
 *     kategoriyaga qayta berilishi mumkin.
 *
 * Qulf tartibi: tahrirlash / o'chirish qatorni FOR UPDATE bilan oladi, qo'lda
 * chiqim (`resolveSpendExpenseCategory`) esa FOR SHARE — o'chirish jarayondagi
 * chiqim commit bo'lishini kutadi, o'chirilgandan keyin kelgan chiqim esa
 * yangilangan qatorni ko'rib 400 oladi.
 */
const NAME_MAX_LENGTH = 100;
const DESCRIPTION_MAX_LENGTH = 500;
const SORT_ORDER_MAX = 1_000_000;
const ID_RE = /^\d+$/;

function conflict(message: string): never {
  throw new RpcException({ statusCode: 409, message });
}

function toRpcError(error: unknown): never {
  if (error instanceof RpcException) {
    throw error;
  }
  if (error instanceof NotFoundException) {
    throw new RpcException({ statusCode: 404, message: error.message });
  }
  if (error instanceof BadRequestException) {
    throw new RpcException({ statusCode: 400, message: error.message });
  }
  throw new RpcException({
    statusCode: 500,
    message: error instanceof Error ? error.message : 'Internal server error',
  });
}

function successRes(data: unknown, statusCode = 200, message = 'success') {
  return { statusCode, message, data };
}

/** Skalyar qiymat matni (obyekt / massiv — bo'sh satr: RMQ payload ishonchsiz). */
function scalarText(value: unknown): string {
  if (
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'bigint'
  ) {
    return String(value).trim();
  }
  return '';
}

function assertId(value: unknown, field: string): string {
  const text = scalarText(value);
  if (!ID_RE.test(text)) {
    throw new BadRequestException(`${field} raqamli ID bo'lishi kerak`);
  }
  return text;
}

/** Amal bajaruvchi (JWT `sub`) — raqam bo'lmasa NULL (bigint ustun). */
function actorId(value: unknown): string | null {
  const text = scalarText(value);
  return ID_RE.test(text) ? text : null;
}

function normalizeName(value: unknown): string {
  const name = scalarText(value).replace(/\s+/g, ' ');
  if (!name) {
    throw new BadRequestException('Kategoriya nomi majburiy');
  }
  if (name.length > NAME_MAX_LENGTH) {
    throw new BadRequestException(
      `Kategoriya nomi ${NAME_MAX_LENGTH} belgidan oshmasin`,
    );
  }
  return name;
}

/** "Nimalar kiradi" — bo'sh / null — tavsifsiz. */
function normalizeDescription(value: unknown): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== 'string') {
    throw new BadRequestException("Kategoriya tavsifi matn bo'lishi kerak");
  }
  const description = value.trim();
  if (description.length > DESCRIPTION_MAX_LENGTH) {
    throw new BadRequestException(
      `Kategoriya tavsifi ${DESCRIPTION_MAX_LENGTH} belgidan oshmasin`,
    );
  }
  return description || null;
}

function normalizeSortOrder(value: unknown): number {
  const sortOrder =
    typeof value === 'number' || (typeof value === 'string' && value.trim())
      ? Number(value)
      : NaN;
  if (
    !Number.isInteger(sortOrder) ||
    sortOrder < 0 ||
    sortOrder > SORT_ORDER_MAX
  ) {
    throw new BadRequestException(
      `sort_order 0 dan ${SORT_ORDER_MAX} gacha butun son bo'lishi kerak`,
    );
  }
  return sortOrder;
}

/** Postgres unique_violation — parallel so'rov bir xil nomni yozib ulgurdi. */
function isUniqueViolation(error: unknown): boolean {
  return (error as { code?: string } | null)?.code === '23505';
}

const duplicateNameMessage = (name: string) =>
  `"${name}" nomli kategoriya allaqachon bor`;

/**
 * Elchi Pochta №1 — qo'lda chiqimga (`PATCH /finance/cashbox/spend`)
 * tanlangan kassa xarajati kategoriyasi. `updateBalance` tranzaksiyasi
 * ICHIDA, kassa qatori qulflangandan keyin chaqiriladi:
 *
 *   • `expense_category_id` yo'q — `null` (avvalgi xatti-harakat,
 *     kategoriyasiz chiqim);
 *   • faqat qo'lda chiqim (EXPENSE + MANUAL_EXPENSE) — boshqa oyoqlarda 400;
 *   • kategoriya mavjud va o'chirilmagan bo'lishi shart — aks holda 400
 *     (tanlov ro'yxatidan eskirgan qiymat kelgan).
 *
 * Qaytaradi: tarix qatoriga yoziladigan `{ id, name }` (nom — snapshot).
 */
export async function resolveSpendExpenseCategory(
  manager: EntityManager,
  input: {
    expense_category_id?: unknown;
    operation_type: Operation_type;
    source_type: Source_type;
  },
): Promise<{ id: string; name: string } | null> {
  const raw = input.expense_category_id;
  if (raw === undefined || raw === null || raw === '') {
    return null;
  }
  const id = assertId(raw, 'expense_category_id');
  if (
    input.operation_type !== Operation_type.EXPENSE ||
    input.source_type !== Source_type.MANUAL_EXPENSE
  ) {
    throw new BadRequestException(
      "expense_category_id faqat kassadan qo'lda chiqimda (xarajat) beriladi",
    );
  }
  const category = await manager.findOne(CashboxExpenseCategory, {
    where: { id, isDeleted: false },
    lock: { mode: 'pessimistic_read' },
  });
  if (!category) {
    throw new BadRequestException(
      "Xarajat kategoriyasi topilmadi yoki o'chirilgan — ro'yxatdan faol kategoriya tanlang",
    );
  }
  return { id: String(category.id), name: category.name };
}

export type ExpenseCategoryView = {
  id: string;
  name: string;
  description: string | null;
  sort_order: number;
  is_deleted: boolean;
  created_by: string | null;
  updated_by: string | null;
  created_at: Date;
  updated_at: Date;
};

type EditableFields = Pick<
  CashboxExpenseCategory,
  'name' | 'description' | 'sort_order'
>;

const EDITABLE_FIELDS: ReadonlyArray<keyof EditableFields> = [
  'name',
  'description',
  'sort_order',
];

@Injectable()
export class ExpenseCategoryService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly activityLog: ActivityLogService,
  ) {}

  private view(category: CashboxExpenseCategory): ExpenseCategoryView {
    return {
      id: String(category.id),
      name: category.name,
      description: category.description ?? null,
      sort_order: Number(category.sort_order ?? 0),
      is_deleted: category.isDeleted === true,
      created_by: category.created_by ?? null,
      updated_by: category.updated_by ?? null,
      created_at: category.createdAt,
      updated_at: category.updatedAt,
    };
  }

  private async hasDuplicateName(
    manager: EntityManager,
    name: string,
    exceptId?: string,
  ): Promise<boolean> {
    const qb = manager
      .createQueryBuilder(CashboxExpenseCategory, 'c')
      .where('c.isDeleted = false')
      .andWhere('lower(c.name) = lower(:name)', { name });
    if (exceptId) {
      qb.andWhere('c.id <> :exceptId', { exceptId });
    }
    return (await qb.getCount()) > 0;
  }

  /** `sort_order` berilmasa — ro'yxat oxiriga (MAX + 1). */
  private async nextSortOrder(manager: EntityManager): Promise<number> {
    const raw = await manager
      .createQueryBuilder(CashboxExpenseCategory, 'c')
      .select('COALESCE(MAX(c.sort_order), 0)', 'max')
      .where('c.isDeleted = false')
      .getRawOne<{ max: string | number | null }>();
    return Math.min(SORT_ORDER_MAX, Number(raw?.max ?? 0) + 1);
  }

  // ───────────────────────── o'qish ─────────────────────────

  /**
   * GET /finance/cashbox/expense-categories — tanlov ro'yxati
   * (`sort_order`, keyin `id` bo'yicha). `include_deleted` — o'chirilganlar
   * ham (oxirida); gateway uni faqat superadminga o'tkazadi.
   */
  async list(input?: { include_deleted?: boolean | string }) {
    try {
      const includeDeleted =
        input?.include_deleted === true || input?.include_deleted === 'true';
      const rows = await this.dataSource.manager.find(CashboxExpenseCategory, {
        where: includeDeleted ? {} : { isDeleted: false },
        order: { isDeleted: 'ASC', sort_order: 'ASC', id: 'ASC' },
      });
      return successRes(
        { items: rows.map((row) => this.view(row)) },
        200,
        'Xarajat kategoriyalari',
      );
    } catch (error) {
      toRpcError(error);
    }
  }

  // ───────────────────────── o'zgartirish (superadmin) ─────────────────────────

  async create(input: {
    name: string;
    description?: string | null;
    sort_order?: number | string | null;
    created_by?: string | null;
  }) {
    try {
      const name = normalizeName(input?.name);
      const description = normalizeDescription(input?.description);
      const manager = this.dataSource.manager;
      const sortOrder =
        input?.sort_order === undefined || input?.sort_order === null
          ? await this.nextSortOrder(manager)
          : normalizeSortOrder(input.sort_order);
      if (await this.hasDuplicateName(manager, name)) {
        conflict(duplicateNameMessage(name));
      }
      const createdBy = actorId(input?.created_by);
      let category: CashboxExpenseCategory;
      try {
        category = await manager.save(
          CashboxExpenseCategory,
          manager.create(CashboxExpenseCategory, {
            name,
            description,
            sort_order: sortOrder,
            created_by: createdBy,
            updated_by: null,
          }),
        );
      } catch (error) {
        if (isUniqueViolation(error)) {
          conflict(duplicateNameMessage(name));
        }
        throw error;
      }
      await this.activityLog.log({
        entity_type: 'CashboxExpenseCategory',
        entity_id: String(category.id),
        action: 'finance.expense_category_created',
        new_value: { name, description, sort_order: sortOrder },
        user_id: createdBy,
        description: `"${name}" xarajat kategoriyasi qo'shildi`,
      });
      return successRes(
        { category: this.view(category) },
        201,
        "Kategoriya qo'shildi",
      );
    } catch (error) {
      toRpcError(error);
    }
  }

  async update(input: {
    id: string;
    name?: string;
    description?: string | null;
    sort_order?: number | string | null;
    updated_by?: string | null;
  }) {
    try {
      const id = assertId(input?.id, 'id');
      const patch: Partial<EditableFields> = {};
      if (input?.name !== undefined) {
        patch.name = normalizeName(input.name);
      }
      // `description: null` (yoki '') — tavsifni tozalash.
      if (input?.description !== undefined) {
        patch.description = normalizeDescription(input.description);
      }
      if (input?.sort_order !== undefined && input?.sort_order !== null) {
        patch.sort_order = normalizeSortOrder(input.sort_order);
      }
      if (!Object.keys(patch).length) {
        throw new BadRequestException(
          "O'zgartirish uchun name, description yoki sort_order bering",
        );
      }
      const updatedBy = actorId(input?.updated_by);

      let outcome: {
        category: CashboxExpenseCategory;
        before: EditableFields;
      };
      try {
        outcome = await this.dataSource.transaction(async (manager) => {
          const category = await manager.findOne(CashboxExpenseCategory, {
            where: { id, isDeleted: false },
            lock: { mode: 'pessimistic_write' },
          });
          if (!category) {
            throw new NotFoundException('Kategoriya topilmadi');
          }
          if (
            patch.name !== undefined &&
            (await this.hasDuplicateName(manager, patch.name, id))
          ) {
            conflict(duplicateNameMessage(patch.name));
          }
          const before: EditableFields = {
            name: category.name,
            description: category.description ?? null,
            sort_order: Number(category.sort_order ?? 0),
          };
          Object.assign(category, patch, { updated_by: updatedBy });
          return {
            category: await manager.save(CashboxExpenseCategory, category),
            before,
          };
        });
      } catch (error) {
        if (isUniqueViolation(error) && patch.name !== undefined) {
          conflict(duplicateNameMessage(patch.name));
        }
        throw error;
      }

      const { category, before } = outcome;
      const changed = EDITABLE_FIELDS.filter(
        (field) => field in patch && before[field] !== category[field],
      );
      if (changed.length) {
        const pick = (source: Partial<EditableFields>) =>
          Object.fromEntries(changed.map((field) => [field, source[field]]));
        await this.activityLog.log({
          entity_type: 'CashboxExpenseCategory',
          entity_id: id,
          action: 'finance.expense_category_updated',
          old_value: pick(before),
          new_value: pick(category),
          user_id: updatedBy,
          description: changed.includes('name')
            ? `Xarajat kategoriyasi nomi: "${before.name}" → "${category.name}"`
            : `"${category.name}" xarajat kategoriyasi tahrirlandi`,
        });
      }
      return successRes(
        { category: this.view(category) },
        200,
        'Kategoriya yangilandi',
      );
    } catch (error) {
      toRpcError(error);
    }
  }

  /**
   * DELETE /finance/cashbox/expense-categories/:id — SOFT o'chirish.
   * Tanlov ro'yxatidan yo'qoladi, yangi chiqimga berilsa 400; mavjud tarix
   * qatorlari nomni (snapshot) ko'rsatishda davom etadi.
   */
  async remove(input: { id: string; deleted_by?: string | null }) {
    try {
      const id = assertId(input?.id, 'id');
      const deletedBy = actorId(input?.deleted_by);
      const category = await this.dataSource.transaction(async (manager) => {
        const row = await manager.findOne(CashboxExpenseCategory, {
          where: { id, isDeleted: false },
          lock: { mode: 'pessimistic_write' },
        });
        if (!row) {
          throw new NotFoundException('Kategoriya topilmadi');
        }
        row.isDeleted = true;
        row.updated_by = deletedBy;
        return manager.save(CashboxExpenseCategory, row);
      });
      await this.activityLog.log({
        entity_type: 'CashboxExpenseCategory',
        entity_id: id,
        action: 'finance.expense_category_deleted',
        old_value: { name: category.name, is_deleted: false },
        new_value: { is_deleted: true },
        user_id: deletedBy,
        description: `"${category.name}" xarajat kategoriyasi o'chirildi`,
      });
      return successRes(
        { category: this.view(category) },
        200,
        "Kategoriya o'chirildi",
      );
    } catch (error) {
      toRpcError(error);
    }
  }
}
