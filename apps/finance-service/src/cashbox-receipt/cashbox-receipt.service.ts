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
  MoreThanOrEqual,
  Not,
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
  Cashbox_type,
  RECEIPT_REANALYZE_STATUS,
  Roles,
  applyReceiptSettingsPatch,
  isCashboxReceiptKind,
  receiptReanalyzeBlock,
  receiptSettingGroupOf,
  rmqSend,
  tashkentDayRange,
  type CashboxReceiptErrorCode,
  type CashboxReceiptKind,
  type CashboxReceiptSettings,
  type CashboxReceiptSettingsPatch,
} from '@app/common';
import { Cashbox } from '../entities/cashbox.entity';
import { CashboxCard } from '../entities/cashbox-card.entity';
import { CashboxHistory } from '../entities/cashbox-history.entity';
import { CashboxReceipt } from '../entities/cashbox-receipt.entity';
import { FinanceRealtimeService } from '../realtime/finance-realtime.service';
import {
  RECEIPT_DUPLICATE_REFERENCE_DAYS,
  deriveReceiptFlags,
  deriveReceiptOutcome,
} from './receipt.rules';
import { FinanceSetting } from '../entities/finance-setting.entity';
import {
  isReceiptSummaryKind,
  loadReceiptChecksSummary,
} from './cashbox-receipt.summary';
import { isReceiptFilterStatus } from './cashbox-receipt.views';
import type {
  LinkedReceiptRef,
  ReceiptLinkRequest,
} from './cashbox-receipt.token';

const RC = CASHBOX_RECEIPT_ERROR_CODES;
const ALLOWED_MIME = new Set(['image/jpeg', 'image/png', 'image/webp']);
/** Bir yugurishda ko'pi bilan shuncha qoralama (qolgani keyingi soatda). */
const CLEANUP_BATCH = 200;
/** Xulosa davri (kun) — AI yordamchi bilan bir xil. */
export const RECEIPT_SUMMARY_MAX_DAYS = 366;

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

const optionalText = (value: unknown): string | undefined => {
  const v = text(value);
  return v === '' ? undefined : v;
};

/** Aniq `YYYY-MM-DD` (haqiqiy sana) yoki undefined; boshqasi — 400. */
function parseYmd(value: unknown, field: string): string | undefined {
  const v = optionalText(value);
  if (v === undefined) return undefined;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  const date = match ? new Date(`${v}T00:00:00Z`) : null;
  if (
    !date ||
    Number.isNaN(date.getTime()) ||
    date.toISOString().slice(0, 10) !== v
  ) {
    throw new BadRequestException(
      `${field} YYYY-MM-DD formatida bo'lishi kerak`,
    );
  }
  return v;
}

export function parseSummaryPeriod(
  fromRaw: unknown,
  toRaw: unknown,
  now: Date = new Date(),
): { from: string; to: string } {
  const today = new Date(now.getTime() + 5 * 3_600_000)
    .toISOString()
    .slice(0, 10);
  const to = parseYmd(toRaw, 'to') ?? today;
  const from = parseYmd(fromRaw, 'from') ?? `${to.slice(0, 8)}01`;
  if (from > to) throw new BadRequestException("from to dan keyin bo'lmasin");
  const days =
    (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) /
    86_400_000;
  if (days > RECEIPT_SUMMARY_MAX_DAYS) {
    throw new BadRequestException(
      `Davr ${RECEIPT_SUMMARY_MAX_DAYS} kundan oshmasin`,
    );
  }
  return { from, to };
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
    @Optional() private readonly realtime?: FinanceRealtimeService,
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
      ...(aiOn ? { file_key: receipt.file_key, mime: receipt.mime } : {}),
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

  // ───────────────────────── AI (T3-3) ─────────────────────────

  /**
   * Gateway AI natijasi (`finance.receipt.ai_result`). `ai_request_id`
   * joriy so'rovniki bo'lmasa (qayta tahlil boshlangan / eski javob) —
   * e'tiborsiz (`ignored:true`). Holat — `deriveReceiptOutcome`, bayroqlar —
   * `deriveReceiptFlags`; `ai_attempts + 1`; realtime `finance.receipt.
   * checked` (outbox, AYNI tranzaksiyada) va jurnal. Rasm / karta raqami /
   * ism logga YOZILMAYDI.
   */
  async applyAiResult(input: {
    receipt_id?: unknown;
    ai_request_id?: unknown;
    result?: unknown;
  }) {
    try {
      const receiptId = text(input?.receipt_id);
      const requestId = text(input?.ai_request_id);
      if (!/^\d{1,18}$/.test(receiptId) || !requestId) {
        throw new BadRequestException("receipt_id / ai_request_id noto'g'ri");
      }
      const result = (
        input?.result && typeof input.result === 'object' ? input.result : {}
      ) as Record<string, unknown>;
      const outcome = await this.dataSource.transaction(async (manager) => {
        const repo = manager.getRepository(CashboxReceipt);
        const row = await repo.findOne({
          where: { id: receiptId, isDeleted: false },
          lock: { mode: 'pessimistic_write' },
        });
        if (
          !row ||
          row.ai_request_id !== requestId ||
          row.ai_status !== 'pending'
        ) {
          return null;
        }
        const derived = deriveReceiptOutcome(
          result,
          row.entered_amount === null ? null : Number(row.entered_amount),
        );
        const ok = result.ok === true;
        const str = (value: unknown, max: number) =>
          typeof value === 'string' && value.trim()
            ? value.trim().slice(0, max)
            : null;
        const last4 = (value: unknown) =>
          typeof value === 'string' && /^\d{4}$/.test(value) ? value : null;
        const reference = ok ? str(result.reference, 120) : null;
        const isTransfer = row.kind !== 'manual_expense';
        const flags = deriveReceiptFlags({
          duplicate_photo: await this.hasDuplicatePhoto(manager, row),
          duplicate_reference: reference
            ? await this.hasDuplicateReference(manager, row, reference)
            : false,
          receipt_date: ok ? result.date : null,
          operation_at: row.linked_at ?? row.uploaded_at,
          expected_last4: await this.expectedCardLast4(manager, row),
          detected_last4: ok
            ? last4(
                isTransfer
                  ? result.recipient_card_last4
                  : result.payer_card_last4,
              )
            : null,
        });
        const amount =
          ok &&
          typeof result.amount === 'number' &&
          Number.isFinite(result.amount)
            ? Math.round(result.amount * 100) / 100
            : null;
        const confidence =
          ok &&
          typeof result.confidence === 'number' &&
          Number.isFinite(result.confidence)
            ? Math.min(1, Math.max(0, result.confidence))
            : null;
        const now = new Date();
        await repo.update(
          { id: row.id },
          {
            ai_status: derived.status,
            ai_attempts: Number(row.ai_attempts ?? 0) + 1,
            ai_error_reason: derived.error_reason,
            ai_amount: amount,
            ai_difference: derived.difference,
            ai_currency: ok ? str(result.currency, 8) : null,
            ai_date: ok ? str(result.date, 40) : null,
            ai_recipient: ok ? str(result.recipient_name, 120) : null,
            ai_recipient_last4: ok ? last4(result.recipient_card_last4) : null,
            ai_payer: ok ? str(result.payer_name, 120) : null,
            ai_payer_last4: ok ? last4(result.payer_card_last4) : null,
            ai_bank: ok ? str(result.bank, 80) : null,
            ai_reference: reference,
            ai_confidence: confidence,
            ai_flags: flags,
            ai_model: ok ? str(result.model, 80) : null,
            ai_checked_at: now,
          },
        );
        await this.realtime?.receiptChecked(
          {
            receipt_id: String(row.id),
            history_id: row.history_id,
            kind: row.kind,
            ai_status: derived.status,
            branch_id: row.branch_id,
            uploaded_by: row.uploaded_by,
            at: now,
          },
          manager,
        );
        return { row, status: derived.status, flags };
      });
      if (!outcome) {
        return successRes({ ignored: true }, 200, 'Stale AI result ignored');
      }
      await this.activityLog.log({
        entity_type: 'CashboxReceipt',
        entity_id: String(outcome.row.id),
        action: 'finance.receipt_ai_checked',
        new_value: { ai_status: outcome.status, flags: outcome.flags },
        metadata: {
          kind: outcome.row.kind,
          history_id: outcome.row.history_id,
          attempt: Number(outcome.row.ai_attempts ?? 0) + 1,
        },
        user_id: null,
      });
      return successRes(
        { receipt_id: String(outcome.row.id), ai_status: outcome.status },
        200,
        'Receipt AI result applied',
      );
    } catch (error) {
      receiptRpcError(error);
    }
  }

  /**
   * `POST /finance/receipts/:id/reanalyze` (faqat SA/admin): ruxsat —
   * `receiptReanalyzeBlock` (T3-2 `can_reanalyze` bilan bitta qoida). Yangi
   * `ai_request_id` → `pending` (eski kechikkan javob yozilmaydi). Gateway
   * AI'ni fonda boshlaydi.
   */
  async requestReanalyze(input: {
    receipt_id?: unknown;
    requester_id?: unknown;
    requester_roles?: unknown;
  }) {
    try {
      const roles = rolesOf(input?.requester_roles);
      if (!roles.includes(Roles.SUPERADMIN) && !roles.includes(Roles.ADMIN)) {
        forbidden('Qayta tahlil faqat superadmin/admin uchun');
      }
      const receiptId = text(input?.receipt_id);
      if (!/^\d{1,18}$/.test(receiptId)) {
        throw new NotFoundException('Chek topilmadi');
      }
      const settings = await this.loadSettings();
      const result = await this.dataSource.transaction(async (manager) => {
        const repo = manager.getRepository(CashboxReceipt);
        const row = await repo.findOne({
          where: { id: receiptId, isDeleted: false, state: 'linked' },
          lock: { mode: 'pessimistic_write' },
        });
        if (!row) throw new NotFoundException('Chek topilmadi');
        const group = settings[receiptSettingGroupOf(row.kind)];
        const block = receiptReanalyzeBlock(
          row,
          group.photo_required && group.ai_enabled,
        );
        if (block) {
          receiptFail(RECEIPT_REANALYZE_STATUS[block] ?? 409, block);
        }
        const aiRequestId = randomUUID();
        await repo.update(
          { id: row.id },
          {
            ai_status: 'pending',
            ai_request_id: aiRequestId,
            ai_requested_at: new Date(),
          },
        );
        return { row, aiRequestId };
      });
      await this.activityLog.log({
        entity_type: 'CashboxReceipt',
        entity_id: String(result.row.id),
        action: 'finance.receipt_reanalyze_requested',
        old_value: { ai_status: result.row.ai_status },
        new_value: { ai_status: 'pending' },
        metadata: { attempts: Number(result.row.ai_attempts ?? 0) },
        user_id: text(input?.requester_id) || null,
      });
      return successRes(
        {
          receipt_id: String(result.row.id),
          ai_status: 'pending',
          ai_request_id: result.aiRequestId,
          file_key: result.row.file_key,
          mime: result.row.mime,
        },
        202,
        'Receipt reanalyze requested',
      );
    } catch (error) {
      receiptRpcError(error);
    }
  }

  /**
   * T3-4 — chek tekshiruvi xulosasi (SA/admin; gateway `@Roles` + bu yerda).
   * Davr — Toshkent sanalari (kiradi), sukut: joriy oy boshidan bugungacha,
   * ≤ 366 kun. `none` — tarixdagi «Chek yo'q» filtri bilan AYNI shart.
   */
  async summary(input: {
    requester_roles?: unknown;
    from?: unknown;
    to?: unknown;
    kind?: unknown;
    ai_status?: unknown;
  }) {
    try {
      const roles = rolesOf(input?.requester_roles);
      if (!roles.includes(Roles.SUPERADMIN) && !roles.includes(Roles.ADMIN)) {
        forbidden('Chek xulosasi faqat superadmin/admin uchun');
      }
      const period = parseSummaryPeriod(input?.from, input?.to);
      const kind = optionalText(input?.kind);
      if (kind !== undefined && !isReceiptSummaryKind(kind)) {
        throw new BadRequestException("kind noto'g'ri");
      }
      const aiStatus = optionalText(input?.ai_status);
      if (aiStatus !== undefined && !isReceiptFilterStatus(aiStatus)) {
        throw new BadRequestException("ai_status noto'g'ri");
      }
      const range = tashkentDayRange(period.from, period.to);
      const data = await loadReceiptChecksSummary(
        this.dataSource.manager,
        {
          receipts: this.dataSource.getMetadata(CashboxReceipt).tablePath,
          history: this.dataSource.getMetadata(CashboxHistory).tablePath,
          cashbox: this.dataSource.getMetadata(Cashbox).tablePath,
        },
        { start: range.start!, end: range.end!, kind, ai_status: aiStatus },
      );
      return successRes(
        { period: { from: period.from, to: period.to }, ...data },
        200,
        'Receipt checks summary',
      );
    } catch (error) {
      receiptRpcError(error);
    }
  }

  private async hasDuplicatePhoto(
    manager: EntityManager,
    row: CashboxReceipt,
  ): Promise<boolean> {
    return (
      (await manager.getRepository(CashboxReceipt).count({
        where: {
          file_sha256: row.file_sha256,
          isDeleted: false,
          id: Not(row.id),
        },
      })) > 0
    );
  }

  private async hasDuplicateReference(
    manager: EntityManager,
    row: CashboxReceipt,
    reference: string,
  ): Promise<boolean> {
    const since = new Date(
      Date.now() - RECEIPT_DUPLICATE_REFERENCE_DAYS * 86_400_000,
    );
    return (
      (await manager.getRepository(CashboxReceipt).count({
        where: {
          ai_reference: reference,
          isDeleted: false,
          id: Not(row.id),
          uploaded_at: MoreThanOrEqual(since),
        },
      })) > 0
    );
  }

  /**
   * `card_mismatch` uchun kutilgan last4: o'tkazmada — HQ (MAIN) kassa
   * kartalari; chiqimda — to'lov qilingan karta (click). Topilmasa — [].
   */
  private async expectedCardLast4(
    manager: EntityManager,
    row: CashboxReceipt,
  ): Promise<string[]> {
    try {
      if (row.kind === 'manual_expense') {
        if (!row.card_id || row.payment_method !== 'click') return [];
        const card = await manager.findOne(CashboxCard, {
          where: { id: String(row.card_id) },
        });
        return card?.last4 ? [String(card.last4)] : [];
      }
      const main = await manager.findOne(Cashbox, {
        where: {
          user_id: '0',
          cashbox_type: Cashbox_type.MAIN,
          isDeleted: false,
        },
      });
      if (!main) return [];
      const cards = await manager.find(CashboxCard, {
        where: { cashbox_id: String(main.id), isDeleted: false },
      });
      return cards
        .map((card) => (card.last4 ? String(card.last4) : ''))
        .filter(Boolean);
    } catch {
      return [];
    }
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
