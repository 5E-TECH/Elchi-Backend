import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { ClientProxy, RpcException } from '@nestjs/microservices';
import { randomUUID } from 'node:crypto';
import {
  DataSource,
  EntityManager,
  In,
  LessThan,
  QueryFailedError,
} from 'typeorm';
import {
  ActivityLogService,
  CASHBOX_RECEIPT_DEFAULTS,
  CASHBOX_RECEIPT_DRAFT_TTL_HOURS,
  CASHBOX_RECEIPT_ERROR_CODES,
  CASHBOX_RECEIPT_MAX_BYTES,
  CASHBOX_RECEIPT_MESSAGES,
  CASHBOX_RECEIPT_SETTING_GROUPS,
  CASHBOX_RECEIPT_SETTING_KEYS,
  Roles,
  applyReceiptSettingsPatch,
  isCashboxReceiptKind,
  receiptSettingGroupOf,
  rmqSend,
  type CashboxReceiptErrorCode,
  type CashboxReceiptKind,
  type CashboxReceiptSettings,
  type CashboxReceiptSettingsPatch,
} from '@app/common';
import { CashboxReceipt } from '../entities/cashbox-receipt.entity';
import { FinanceSetting } from '../entities/finance-setting.entity';
import type {
  LinkedReceiptRef,
  ReceiptLinkRequest,
} from './cashbox-receipt.token';

const RC = CASHBOX_RECEIPT_ERROR_CODES;
const ALLOWED_MIME = new Set(['image/jpeg', 'image/png', 'image/webp']);
/** Bir yugurishda ko'pi bilan shuncha qoralama (qolgani keyingi soatda). */
const CLEANUP_BATCH = 200;

const text = (value: unknown): string =>
  typeof value === 'string' || typeof value === 'number'
    ? String(value).trim()
    : '';

const rolesOf = (value: unknown): string[] =>
  Array.isArray(value) ? value.map((role) => text(role).toLowerCase()) : [];

function successRes(data: unknown, statusCode = 200, message = 'success') {
  return { statusCode, message, data };
}

/** Kodli xato (`PUBLIC_ERROR_CODES` — kod FE'ga yetadi). */
export function receiptFail(
  statusCode: number,
  code: CashboxReceiptErrorCode,
  extra: Record<string, unknown> = {},
): never {
  throw new RpcException({
    statusCode,
    code,
    message: CASHBOX_RECEIPT_MESSAGES[code],
    ...extra,
  });
}

function forbidden(message: string): never {
  throw new RpcException({ statusCode: 403, message });
}

/** Boshqa xatolarni RPC shakliga (statusCode saqlanadi). */
export function receiptRpcError(error: unknown): never {
  if (error instanceof RpcException) throw error;
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

function parseBool(value: unknown, field: string): boolean | undefined {
  if (value === undefined || value === null) return undefined;
  if (value === true || value === false) return value;
  throw new BadRequestException(`${field} boolean bo'lishi kerak`);
}

function parseGroupPatch(value: unknown, group: string) {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new BadRequestException(`${group} obyekt bo'lishi kerak`);
  }
  const item = value as Record<string, unknown>;
  const photo = parseBool(item.photo_required, `${group}.photo_required`);
  const ai = parseBool(item.ai_enabled, `${group}.ai_enabled`);
  if (photo === undefined && ai === undefined) return undefined;
  return {
    ...(photo !== undefined ? { photo_required: photo } : {}),
    ...(ai !== undefined ? { ai_enabled: ai } : {}),
  };
}

/**
 * T3 (QlLf33Ma) — kassa cheki: sozlamalar, qoralama (rasm yuklanganda),
 * qoralamalarni tozalash. Bog'lash (T3-2) va AI natijasi (T3-3) — shu
 * servisda, pul tranzaksiyasi menejeri bilan.
 *
 * ⚠️ PUL INVARIANTI: kassa balanslarini HECH QACHON o'zgartirmaydi.
 * ⚠️ SAQLASH: `linked` chek va fayli o'chirilmaydi; tozalash faqat `draft`.
 * ⚠️ PII: rasm, karta raqami, ism logga yozilmaydi (faqat ID).
 */
@Injectable()
export class CashboxReceiptService {
  private readonly logger = new Logger(CashboxReceiptService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly activityLog: ActivityLogService,
    @Optional() @Inject('FILE') private readonly fileClient?: ClientProxy,
  ) {}

  // ───────────────────────── sozlamalar ─────────────────────────

  async loadSettings(manager?: EntityManager): Promise<
    CashboxReceiptSettings & {
      updated_at: Date | null;
      updated_by: string | null;
    }
  > {
    const keys = CASHBOX_RECEIPT_SETTING_GROUPS.flatMap((group) => [
      CASHBOX_RECEIPT_SETTING_KEYS[group].photo_required,
      CASHBOX_RECEIPT_SETTING_KEYS[group].ai_enabled,
    ]);
    const rows = await (manager ?? this.dataSource.manager)
      .getRepository(FinanceSetting)
      .find({ where: { key: In(keys), isDeleted: false } });
    const map = new Map(rows.map((row) => [row.key, row.value]));
    const pick = (key: string, fallback: boolean) => {
      const value = map.get(key);
      return typeof value === 'boolean' ? value : fallback;
    };
    const latest = rows.reduce<FinanceSetting | null>(
      (acc, row) =>
        !acc || new Date(row.updatedAt) > new Date(acc.updatedAt) ? row : acc,
      null,
    );
    const group = (name: (typeof CASHBOX_RECEIPT_SETTING_GROUPS)[number]) => {
      const photo = pick(
        CASHBOX_RECEIPT_SETTING_KEYS[name].photo_required,
        CASHBOX_RECEIPT_DEFAULTS.photo_required,
      );
      // Himoya: rasm o'chiq bo'lsa AI ham o'chiq (qo'lda yozilgan qator ham).
      const ai =
        photo &&
        pick(
          CASHBOX_RECEIPT_SETTING_KEYS[name].ai_enabled,
          CASHBOX_RECEIPT_DEFAULTS.ai_enabled,
        );
      return { photo_required: photo, ai_enabled: ai };
    };
    return {
      manual_expense: group('manual_expense'),
      hq_transfer: group('hq_transfer'),
      updated_at: latest ? new Date(latest.updatedAt) : null,
      updated_by: latest?.updated_by ? String(latest.updated_by) : null,
    };
  }

  async getSettings() {
    try {
      return successRes(await this.loadSettings(), 200, 'Receipt settings');
    } catch (error) {
      receiptRpcError(error);
    }
  }

  /** Faqat SUPERADMIN (gateway `@Roles` + bu yerda `requester_roles`). */
  async updateSettings(input: {
    requester_id?: unknown;
    requester_roles?: unknown;
    manual_expense?: unknown;
    hq_transfer?: unknown;
  }) {
    try {
      if (!rolesOf(input?.requester_roles).includes(Roles.SUPERADMIN)) {
        forbidden("Chek sozlamalarini faqat superadmin o'zgartiradi");
      }
      const requesterId = text(input?.requester_id) || null;
      const patch: CashboxReceiptSettingsPatch = {};
      for (const group of CASHBOX_RECEIPT_SETTING_GROUPS) {
        const item = parseGroupPatch(input?.[group], group);
        if (item) patch[group] = item;
      }
      if (!Object.keys(patch).length) {
        throw new BadRequestException("O'zgartiriladigan sozlama berilmadi");
      }
      const before = await this.loadSettings();
      const applied = applyReceiptSettingsPatch(before, patch);
      if (!applied.ok) {
        receiptFail(400, applied.code, { group: applied.group });
      }
      await this.dataSource.transaction(async (manager) => {
        for (const group of CASHBOX_RECEIPT_SETTING_GROUPS) {
          if (!patch[group]) continue;
          for (const field of ['photo_required', 'ai_enabled'] as const) {
            await manager
              .createQueryBuilder()
              .insert()
              .into(FinanceSetting)
              .values({
                key: CASHBOX_RECEIPT_SETTING_KEYS[group][field],
                value: applied.value[group][field] as never,
                updated_by: requesterId,
              })
              .orUpdate(['value', 'updated_by', 'updatedAt'], ['key'])
              .execute();
          }
        }
      });
      const after = await this.loadSettings();
      await this.activityLog.log({
        entity_type: 'FinanceSetting',
        entity_id: 'receipt',
        action: 'finance.receipt_settings_updated',
        old_value: {
          manual_expense: before.manual_expense,
          hq_transfer: before.hq_transfer,
        },
        new_value: {
          manual_expense: after.manual_expense,
          hq_transfer: after.hq_transfer,
        },
        user_id: requesterId,
      });
      return successRes(after, 200, 'Receipt settings updated');
    } catch (error) {
      receiptRpcError(error);
    }
  }

  // ───────────────────────── qoralama ─────────────────────────

  /**
   * Yuklashdan OLDIN (fayl hali yuborilmagan): rol va sozlama. Rasm o'chiq
   * → 400 `RECEIPT_DISABLED` — gateway faylni umuman yuklamaydi.
   */
  async assertCanUpload(input: {
    kind?: unknown;
    requester_roles?: unknown;
    branch_id?: unknown;
  }): Promise<{ kind: CashboxReceiptKind; branch_id: string | null }> {
    const kind = input?.kind;
    if (!isCashboxReceiptKind(kind)) {
      throw new BadRequestException(
        "kind faqat manual_expense, courier_to_hq yoki branch_to_hq bo'lishi mumkin",
      );
    }
    const roles = rolesOf(input?.requester_roles);
    const privileged =
      roles.includes(Roles.SUPERADMIN) || roles.includes(Roles.ADMIN);
    let branchId: string | null = null;
    if (!privileged) {
      if (!roles.includes(Roles.MANAGER) || kind !== 'manual_expense') {
        forbidden('Bu turdagi chekni yuklashga ruxsat yo‘q');
      }
      branchId = text(input?.branch_id);
      if (!/^\d+$/.test(branchId)) {
        forbidden('Menejerning filiali topilmadi');
      }
    }
    const settings = await this.loadSettings();
    if (!settings[receiptSettingGroupOf(kind)].photo_required) {
      receiptFail(400, RC.DISABLED);
    }
    return { kind, branch_id: branchId };
  }

  async uploadCheck(input: {
    kind?: unknown;
    requester_roles?: unknown;
    branch_id?: unknown;
  }) {
    try {
      const allowed = await this.assertCanUpload(input);
      return successRes(allowed, 200, 'Receipt upload allowed');
    } catch (error) {
      receiptRpcError(error);
    }
  }

  /** Fayl yuklandi (gateway) → `draft` qatori. */
  async createDraft(input: {
    kind?: unknown;
    file_key?: unknown;
    file_sha256?: unknown;
    mime?: unknown;
    size_bytes?: unknown;
    requester_id?: unknown;
    requester_roles?: unknown;
    branch_id?: unknown;
  }) {
    try {
      const allowed = await this.assertCanUpload(input);
      const requesterId = text(input?.requester_id);
      if (!/^\d+$/.test(requesterId)) {
        forbidden("So'rovchi aniqlanmadi");
      }
      const fileKey = text(input?.file_key);
      if (!fileKey.startsWith('cashbox-receipt-') || fileKey.length > 500) {
        throw new BadRequestException("file_key noto'g'ri");
      }
      const sha = text(input?.file_sha256).toLowerCase();
      if (!/^[0-9a-f]{64}$/.test(sha)) {
        throw new BadRequestException("file_sha256 noto'g'ri");
      }
      const mime = text(input?.mime).toLowerCase();
      if (!ALLOWED_MIME.has(mime)) {
        throw new BadRequestException("mime noto'g'ri");
      }
      const size = Number(input?.size_bytes);
      if (
        !Number.isInteger(size) ||
        size <= 0 ||
        size > CASHBOX_RECEIPT_MAX_BYTES
      ) {
        throw new BadRequestException("size_bytes noto'g'ri");
      }
      const settings = await this.loadSettings();
      const group = settings[receiptSettingGroupOf(allowed.kind)];
      const repo = this.dataSource.getRepository(CashboxReceipt);
      const saved = await repo.save(
        repo.create({
          kind: allowed.kind,
          state: 'draft',
          branch_id: allowed.branch_id,
          file_key: fileKey,
          file_sha256: sha,
          mime,
          size_bytes: size,
          uploaded_by: requesterId,
          uploaded_at: new Date(),
          photo_required_snap: group.photo_required,
          ai_enabled_snap: group.ai_enabled,
          ai_status: 'disabled',
        }),
      );
      await this.activityLog.log({
        entity_type: 'CashboxReceipt',
        entity_id: String(saved.id),
        action: 'finance.receipt_uploaded',
        new_value: {
          kind: saved.kind,
          state: saved.state,
          size_bytes: saved.size_bytes,
        },
        metadata: { branch_id: saved.branch_id },
        user_id: requesterId,
      });
      return successRes(
        {
          receipt_id: String(saved.id),
          kind: saved.kind,
          state: saved.state,
        },
        201,
        'Receipt uploaded',
      );
    } catch (error) {
      receiptRpcError(error);
    }
  }

  // ───────────────────────── bog'lash (T3-2) ─────────────────────────

  /**
   * Pul tranzaksiyasi ICHIDA (chaqiruvchining `manager`i, tarix qatorlari
   * saqlangandan keyin): chekni operatsiyaga bog'laydi. Xato → throw →
   * butun tranzaksiya (pul ham) rollback.
   *
   *  - `applicable:false` (naqd / click_to_market o'tkazma) + `receipt_id`
   *    → 400 `RECEIPT_NOT_APPLICABLE`; `receipt_id` siz — `null`;
   *  - rasm majburiy va `receipt_id` yo'q → 400 `RECEIPT_REQUIRED`; rasm
   *    o'chiq va yo'q → `null`;
   *  - chek qatori FOR UPDATE: yo'q → 400 `RECEIPT_NOT_FOUND`; boshqa
   *    xodimniki → 403; tur mos emas → 400; `linked` → 409;
   *  - bog'lash: `linked`, tarix ID'lari, operatsiya maydonlari, sozlama
   *    snapshot'i; `ai_status` = `pending` (yangi `ai_request_id`) yoki
   *    `disabled`.
   */
  async linkInTx(
    manager: EntityManager,
    request: ReceiptLinkRequest,
    ctx: {
      applicable: boolean;
      history_id: string;
      counter_history_id?: string | null;
      entered_amount: number;
      payment_method: string;
      card_id?: string | null;
      courier_id?: string | null;
      branch_id?: string | null;
    },
  ): Promise<LinkedReceiptRef | null> {
    const receiptId = text(request.receipt_id);
    if (!ctx.applicable) {
      if (receiptId) receiptFail(400, RC.NOT_APPLICABLE);
      return null;
    }
    const settings = await this.loadSettings(manager);
    const group = settings[receiptSettingGroupOf(request.kind)];
    if (!receiptId) {
      if (group.photo_required) receiptFail(400, RC.REQUIRED);
      return null;
    }
    if (!/^\d{1,18}$/.test(receiptId)) receiptFail(400, RC.NOT_FOUND);
    const repo = manager.getRepository(CashboxReceipt);
    const receipt = await repo.findOne({
      where: { id: receiptId, isDeleted: false },
      lock: { mode: 'pessimistic_write' },
    });
    if (!receipt) receiptFail(400, RC.NOT_FOUND);
    if (String(receipt.uploaded_by) !== text(request.requester_id)) {
      receiptFail(403, RC.NOT_OWNER);
    }
    if (receipt.kind !== request.kind) receiptFail(400, RC.KIND_MISMATCH);
    if (receipt.state === 'linked') receiptFail(409, RC.ALREADY_USED);

    const aiOn = group.photo_required && group.ai_enabled;
    const now = new Date();
    const aiRequestId = aiOn ? randomUUID() : null;
    try {
      await repo.update(
        { id: receipt.id },
        {
          state: 'linked',
          history_id: String(ctx.history_id),
          counter_history_id: ctx.counter_history_id
            ? String(ctx.counter_history_id)
            : null,
          entered_amount: Number(ctx.entered_amount),
          payment_method: ctx.payment_method,
          card_id: ctx.card_id ? String(ctx.card_id) : null,
          courier_id: ctx.courier_id ? String(ctx.courier_id) : null,
          branch_id: ctx.branch_id ? String(ctx.branch_id) : receipt.branch_id,
          linked_at: now,
          linked_by: text(request.requester_id) || null,
          photo_required_snap: group.photo_required,
          ai_enabled_snap: aiOn,
          ai_status: aiOn ? 'pending' : 'disabled',
          ai_request_id: aiRequestId,
          ai_requested_at: aiOn ? now : null,
        },
      );
    } catch (error) {
      // UNIQUE history_id — boshqa chek shu operatsiyaga bog'langan.
      if (
        error instanceof QueryFailedError &&
        (error.driverError as { code?: string })?.code === '23505'
      ) {
        receiptFail(409, RC.ALREADY_USED);
      }
      throw error;
    }
    return {
      id: String(receipt.id),
      kind: receipt.kind,
      ai_status: aiOn ? 'pending' : 'disabled',
      ai_request_id: aiRequestId,
    };
  }

  /** Idempotent takror: asl operatsiyaning cheki (bo'lmasa `null`). */
  async findForReplay(
    manager: EntityManager,
    where: { history_id?: string | null; counter_history_id?: string | null },
  ): Promise<LinkedReceiptRef | null> {
    const historyId = text(where.history_id);
    const counterId = text(where.counter_history_id);
    if (!historyId && !counterId) return null;
    const row = await manager.getRepository(CashboxReceipt).findOne({
      where: historyId
        ? { history_id: historyId, isDeleted: false }
        : { counter_history_id: counterId, isDeleted: false },
    });
    return row
      ? {
          id: String(row.id),
          kind: row.kind,
          ai_status: row.ai_status,
          // Takrorda AI qayta ishga tushirilmaydi.
          ai_request_id: null,
        }
      : null;
  }

  // ───────────────────────── tozalash ─────────────────────────

  /**
   * `draft` va `uploaded_at` > 24 soat → `file.delete` + soft-delete. Har
   * qator — alohida qisqa tranzaksiya, `FOR UPDATE SKIP LOCKED`: bog'lash
   * (o'sha qatorni FOR UPDATE qiladi) bilan poyga yo'q — qulf ostida holat
   * qayta tekshiriladi. `linked` qatorlar HECH QACHON tegilmaydi. Fayl
   * o'chmasa (file-service javob bermadi) qator qoladi — keyingi soatda.
   */
  async cleanupDrafts(now: Date = new Date()): Promise<{
    deleted: number;
    failed: number;
  }> {
    const cutoff = new Date(
      now.getTime() - CASHBOX_RECEIPT_DRAFT_TTL_HOURS * 3_600_000,
    );
    const candidates = await this.dataSource
      .getRepository(CashboxReceipt)
      .find({
        select: { id: true },
        where: {
          state: 'draft',
          isDeleted: false,
          uploaded_at: LessThan(cutoff),
        },
        order: { uploaded_at: 'ASC' },
        take: CLEANUP_BATCH,
      });
    let deleted = 0;
    let failed = 0;
    for (const { id } of candidates) {
      try {
        const done = await this.dataSource.transaction(async (manager) => {
          const row = await manager
            .getRepository(CashboxReceipt)
            .createQueryBuilder('r')
            .setLock('pessimistic_write')
            .setOnLocked('skip_locked')
            .where('r.id = :id', { id })
            .andWhere('r.state = :draft', { draft: 'draft' })
            .andWhere('r.is_deleted = false')
            .andWhere('r.uploaded_at < :cutoff', { cutoff })
            .getOne();
          if (!row) return false;
          await this.deleteFile(row.file_key);
          await manager.update(
            CashboxReceipt,
            { id: row.id },
            { isDeleted: true, deleted_at: now },
          );
          return true;
        });
        if (done) deleted += 1;
      } catch (error) {
        failed += 1;
        this.logger.warn(
          `chek qoralamasi tozalanmadi id=${String(id)}: ${
            error instanceof Error ? error.message : 'error'
          }`,
        );
      }
    }
    return { deleted, failed };
  }

  private async deleteFile(key: string): Promise<void> {
    if (!this.fileClient) {
      throw new Error('file-service sozlanmagan');
    }
    try {
      await rmqSend(
        this.fileClient,
        { cmd: 'file.delete' },
        { key },
        { timeoutMs: 10_000, retries: 1 },
      );
    } catch (error) {
      // Fayl allaqachon yo'q (404) — maqsadga erishilgan, qoralama o'chadi.
      const status = Number(
        (error as { statusCode?: unknown; error?: { statusCode?: unknown } })
          ?.statusCode ??
          (error as { error?: { statusCode?: unknown } })?.error?.statusCode,
      );
      if (status !== 404) throw error;
    }
  }
}
