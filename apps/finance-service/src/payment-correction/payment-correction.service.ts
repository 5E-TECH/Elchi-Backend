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
import { DataSource, EntityManager, In, QueryFailedError } from 'typeorm';
import {
  ActivityLogService,
  Cashbox_type,
  Operation_type,
  OutboxService,
  PAYMENT_CORRECTION_ERROR_CODES,
  PAYMENT_CORRECTION_MAX_WINDOW_DAYS,
  PAYMENT_CORRECTION_MIN_WINDOW_DAYS,
  PAYMENT_CORRECTION_REASON_MAX,
  PAYMENT_CORRECTION_REASON_MIN,
  PAYMENT_CORRECTION_WINDOW_KEY,
  PaymentMethod,
  Roles,
  Source_type,
  rmqSend,
  type PaymentCorrectionErrorCode,
} from '@app/common';
import { FinanceServiceService } from '../finance-service.service';
import { Cashbox } from '../entities/cashbox.entity';
import { CashboxCard } from '../entities/cashbox-card.entity';
import { CashboxHistory } from '../entities/cashbox-history.entity';
import { FinanceSetting } from '../entities/finance-setting.entity';
import {
  PaymentCorrection,
  type PaymentCorrectionAction,
} from '../entities/payment-correction.entity';
import {
  applyCashboxCardSelection,
  sumNamedCardBalances,
} from '../cashbox-card/cashbox-card.service';
import { FinanceNotificationService } from '../notification/finance-notification.service';
import { FinanceRealtimeService } from '../realtime/finance-realtime.service';
import {
  evaluateCorrectable,
  readWindowSetting,
  type HistoryWithCashbox,
  type TransferShape,
} from './payment-correction.rules';

const C = PAYMENT_CORRECTION_ERROR_CODES;
const MAIN_CASHBOX_USER_ID = '0';
const PG_UNIQUE_VIOLATION = '23505';

/** Kirish (gateway → `finance.payment_correction.{reverse,correct_amount}`). */
export interface PaymentCorrectionInput {
  history_id?: unknown;
  reason?: unknown;
  new_amount?: unknown;
  idempotency_key?: unknown;
  requester_id?: unknown;
  requester_roles?: unknown;
  /** Gateway aniqlagan filial boshlig'i(lar)i (BRANCH qabul qiluvchi). */
  notify_user_ids?: unknown;
}

interface ValidatedInput {
  action: PaymentCorrectionAction;
  historyId: string;
  reason: string;
  newAmount: number | null;
  key: string;
  requesterId: string;
  managerIds: string[];
}

const text = (value: unknown): string =>
  typeof value === 'string' || typeof value === 'number'
    ? String(value).trim()
    : '';

const round2 = (value: number) => Math.round(value * 100) / 100;

function fail(
  statusCode: number,
  code: PaymentCorrectionErrorCode,
  message: string,
  extra: Record<string, unknown> = {},
): never {
  throw new RpcException({ statusCode, code, message, ...extra });
}

const MESSAGES: Record<PaymentCorrectionErrorCode, string> = {
  NOT_FOUND: 'Kassa yozuvi topilmadi',
  NOT_CORRECTABLE:
    "Bu yozuvni qaytarib / tuzatib bo'lmaydi (faqat kuryerdan qabul va marketga to'lov)",
  LEGACY_UNLINKED:
    "Eski yozuv: to'lov oyoqlari bog'lanmagan — qaytarib bo'lmaydi",
  ALREADY_CORRECTED: "To'lov allaqachon qaytarilgan yoki tuzatilgan",
  WINDOW_EXPIRED: "Tuzatish muddati o'tgan",
  SHIFT_REQUIRED: 'Asosiy kassada smena ochilmagan',
  BRANCH_SHIFT_REQUIRED: 'Filial kassasida smena ochilmagan',
  INSUFFICIENT_BALANCE:
    "Kassada yetarli mablag' yo'q — pul allaqachon boshqa joyga o'tkazilgan",
  CARD_ARCHIVED: "To'lov kartasi arxivlangan — avval kartani faollashtiring",
  SAME_AMOUNT: 'Yangi summa eskisiga teng',
  AMOUNT_EXCEEDS: 'Yangi summa ruxsat etilganidan katta',
  IDEMPOTENCY_KEY_REUSED: "Bu Idempotency-Key boshqa so'rov uchun ishlatilgan",
  IDEMPOTENCY_KEY_REQUIRED: 'Idempotency-Key sarlavhasi majburiy',
  PAYMENT_CORRECTED: "To'lov qaytarilgan yoki tuzatilgan",
};

function failCode(
  statusCode: number,
  code: PaymentCorrectionErrorCode,
  extra: Record<string, unknown> = {},
): never {
  fail(statusCode, code, MESSAGES[code], extra);
}

/** Teskari amal. */
const opposite = (op: Operation_type) =>
  op === Operation_type.INCOME ? Operation_type.EXPENSE : Operation_type.INCOME;

const isCardMethod = (method: PaymentMethod) =>
  method === PaymentMethod.CLICK || method === PaymentMethod.CLICK_TO_MARKET;

/**
 * T6-BE-2 — SUPERADMIN to'lovni (kuryerdan qabul / marketga to'lov) TO'LIQ
 * QAYTARADI yoki SUMMASINI TUZATADI.
 *
 * Hech narsa o'chirilmaydi: har asl oyoqqa TESKARI qator
 * (`payment_reversal`, `reverses_history_id`, summa / usul / karta /
 * kontragent asldan, `comment` = sabab), asl qatorlar o'zgarmaydi. Tahrir =
 * qaytarish + yangi summali to'lov (`applyCourierPaymentInTx` /
 * `applyMarketPaymentInTx`, `dedup_epoch = pc:<id>`) — BITTA tranzaksiyada.
 *
 * Pul — muqaddas: qulf tartibi kuryer → MAIN/BRANCH → market (oddiy to'lov
 * bilan bir xil — deadlock yo'q), har tekshiruv qulf ostida, xatoda HECH
 * NARSA o'zgarmaydi. Idempotentlik: `Idempotency-Key` (UNIQUE) — o'sha
 * so'rov 200 `idempotent: true`, boshqa so'rov 409; bir to'lov bir marta
 * (`original_transfer_id` UNIQUE + `reverses_history_id` UNIQUE).
 *
 * Shu tranzaksiyada outbox: `order.settlement.retreat` (daftar orqaga),
 * tahrirda keyin `order.settlement.advance`; `finance.payment_corrected`
 * bildirishnomasi (har oluvchiga o'z tilida); realtime
 * `finance.payment.corrected`. Commit'dan keyin: audit, market buyurtmalari
 * sinxroni (fonda).
 */
@Injectable()
export class PaymentCorrectionService {
  private readonly logger = new Logger(PaymentCorrectionService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly finance: FinanceServiceService,
    private readonly activityLog: ActivityLogService,
    private readonly outbox: OutboxService,
    @Inject('IDENTITY') private readonly identityClient: ClientProxy,
    @Optional() private readonly notifications?: FinanceNotificationService,
    @Optional() private readonly realtime?: FinanceRealtimeService,
  ) {}

  // ───────────────────────── sozlama ─────────────────────────

  async getSettings() {
    try {
      const setting = await readWindowSetting(this.dataSource.manager);
      return { statusCode: 200, message: 'success', data: setting };
    } catch (error) {
      this.rethrow(error);
    }
  }

  async updateSettings(input: {
    window_days?: unknown;
    requester_id?: unknown;
    requester_roles?: unknown;
  }) {
    try {
      this.assertSuperadmin(input.requester_roles);
      const requesterId = text(input.requester_id);
      const days = Number(input.window_days);
      if (
        typeof input.window_days === 'boolean' ||
        !Number.isInteger(days) ||
        days < PAYMENT_CORRECTION_MIN_WINDOW_DAYS ||
        days > PAYMENT_CORRECTION_MAX_WINDOW_DAYS
      ) {
        throw new BadRequestException(
          `window_days ${PAYMENT_CORRECTION_MIN_WINDOW_DAYS}…${PAYMENT_CORRECTION_MAX_WINDOW_DAYS} oralig'idagi butun son bo'lishi kerak`,
        );
      }
      const before = await readWindowSetting(this.dataSource.manager);
      await this.dataSource
        .createQueryBuilder()
        .insert()
        .into(FinanceSetting)
        .values({
          key: PAYMENT_CORRECTION_WINDOW_KEY,
          value: days as never,
          updated_by: /^\d+$/.test(requesterId) ? requesterId : null,
        })
        .orUpdate(['value', 'updated_by', 'updatedAt'], ['key'])
        .execute();
      const after = await readWindowSetting(this.dataSource.manager);
      await this.activityLog
        .log({
          entity_type: 'FinanceSetting',
          entity_id: 'payment_correction',
          action: 'finance.payment_correction_settings_updated',
          old_value: { window_days: before.window_days },
          new_value: { window_days: after.window_days },
          user_id: /^\d+$/.test(requesterId) ? requesterId : null,
          user_role: Roles.SUPERADMIN,
          metadata: { key: PAYMENT_CORRECTION_WINDOW_KEY },
        })
        .catch((error: unknown) =>
          this.logger.warn(
            `payment correction settings audit: ${(error as Error)?.message ?? error}`,
          ),
        );
      return {
        statusCode: 200,
        message: 'Payment correction settings updated',
        data: after,
      };
    } catch (error) {
      this.rethrow(error);
    }
  }

  // ─────────────────────── gateway konteksti ───────────────────────

  /**
   * Gateway uchun: to'lovni qaysi kassa qabul qilgan (BRANCH bo'lsa —
   * filial boshlig'ini bildirishnomaga qo'shish uchun). Pul o'zgarmaydi.
   */
  async context(input: { history_id?: unknown }) {
    try {
      const history = await this.loadHistory(text(input.history_id));
      const shape = history.transfer_id
        ? (
            await evaluateCorrectable(this.dataSource.manager, history, {
              windowDays: 1,
            })
          ).shape
        : undefined;
      return {
        statusCode: 200,
        message: 'success',
        data: shape
          ? {
              payment_kind: shape.kind,
              receiver_cashbox_type: shape.receiverCashbox.cashbox_type,
              receiver_branch_id:
                shape.receiverCashbox.cashbox_type === Cashbox_type.BRANCH
                  ? String(shape.receiverCashbox.user_id)
                  : null,
              courier_id: shape.courierLeg
                ? String(shape.courierLeg.cashbox.user_id)
                : null,
            }
          : {
              payment_kind: null,
              receiver_cashbox_type: null,
              receiver_branch_id: null,
              courier_id: null,
            },
      };
    } catch (error) {
      this.rethrow(error);
    }
  }

  // ───────────────────────── amallar ─────────────────────────

  reverse(input: PaymentCorrectionInput) {
    return this.execute('reverse', input);
  }

  correctAmount(input: PaymentCorrectionInput) {
    return this.execute('edit', input);
  }

  private async execute(
    action: PaymentCorrectionAction,
    raw: PaymentCorrectionInput,
  ) {
    try {
      const input = this.validate(action, raw);
      // Tranzaksiyadan OLDIN (qulfsiz): mavjudlik, takroriy kalit, turi —
      // erta va aniq xato; hammasi qulf ostida QAYTA tekshiriladi.
      const history = await this.loadHistory(input.historyId);
      const replay = await this.findReplay(
        this.dataSource.manager,
        input,
        history,
      );
      if (replay) return replay;

      const { window_days: windowDays } = await readWindowSetting(
        this.dataSource.manager,
      );
      const pre = await evaluateCorrectable(this.dataSource.manager, history, {
        windowDays,
      });
      if (!pre.allowed || !pre.shape) {
        this.failVerdict(pre.code ?? C.NOT_CORRECTABLE, pre.deadline);
      }
      const languages = await this.resolveLanguages(
        this.recipientIds(pre.shape, input.managerIds),
      );
      return await this.run(input, history, windowDays, languages);
    } catch (error) {
      this.rethrow(error);
    }
  }

  private async run(
    input: ValidatedInput,
    history: HistoryWithCashbox,
    windowDays: number,
    languages: Map<string, string>,
  ) {
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();
    let committed: {
      correction: PaymentCorrection;
      shape: TransferShape;
      cashboxes: Cashbox[];
    } | null = null;
    try {
      const tx = queryRunner.manager;
      const verdictBefore = await evaluateCorrectable(tx, history, {
        windowDays,
      });
      const shapeBefore = verdictBefore.shape;
      if (!shapeBefore) {
        this.failVerdict(verdictBefore.code ?? C.NOT_CORRECTABLE, null);
      }

      // Qulf: kuryer → MAIN/BRANCH → market (oddiy to'lov tartibi).
      const lockOrder = [
        shapeBefore.courierLeg?.cashbox_id,
        shapeBefore.receiverCashbox.id,
        shapeBefore.marketLeg?.cashbox_id,
      ].filter((id): id is string => Boolean(id));
      const locked = new Map<string, Cashbox>();
      for (const id of [...new Set(lockOrder.map(String))]) {
        const cashbox = await tx.findOne(Cashbox, {
          where: { id },
          lock: { mode: 'pessimistic_write' },
        });
        if (!cashbox || cashbox.isDeleted) {
          failCode(409, C.NOT_CORRECTABLE);
        }
        locked.set(id, cashbox);
      }

      // Qulf ostida: takroriy kalit (parallel o'sha so'rov) va holat qaytadan.
      const replay = await this.findReplay(tx, input, history);
      if (replay) {
        await queryRunner.commitTransaction();
        return replay;
      }
      const verdict = await evaluateCorrectable(tx, history, { windowDays });
      if (!verdict.allowed || !verdict.shape || !verdict.root) {
        this.failVerdict(verdict.code ?? C.NOT_CORRECTABLE, verdict.deadline);
      }
      const shape = verdict.shape;
      const box = (id: string | undefined | null) =>
        id ? (locked.get(String(id)) ?? null) : null;
      const courierBox = box(shape.courierLeg?.cashbox_id);
      const receiverBox = box(shape.receiverCashbox.id) as Cashbox;
      const marketBox = box(shape.marketLeg?.cashbox_id);
      const X = shape.amount;

      // Smena — qabul qiluvchi kassada (kod bilan).
      await this.requireShift(tx, receiverBox);

      // Tahrir chegaralari.
      if (input.action === 'edit') {
        const next = input.newAmount as number;
        if (round2(next) === round2(X)) failCode(409, C.SAME_AMOUNT);
        const caps: number[] = [];
        if (courierBox) caps.push(round2(Number(courierBox.balance) + X));
        if (marketBox) caps.push(round2(Number(marketBox.balance) + X));
        const max = caps.length ? Math.min(...caps) : Number.POSITIVE_INFINITY;
        if (next > max) failCode(409, C.AMOUNT_EXCEEDS, { max });
      }
      await this.assertFunds(tx, shape, receiverBox, input.newAmount);

      // Jurnal qatori (id → dedup_epoch). UNIQUE — ikki superadmin bir vaqtda.
      const reversalTransferId = randomUUID();
      const replacementTransferId =
        input.action === 'edit' ? randomUUID() : null;
      const correction = await tx.save(
        tx.create(PaymentCorrection, {
          action: input.action,
          payment_kind: shape.kind,
          original_transfer_id: String(history.transfer_id),
          root_transfer_id: verdict.root.root_transfer_id,
          reversal_transfer_id: reversalTransferId,
          replacement_transfer_id: replacementTransferId,
          original_amount: X,
          new_amount: input.action === 'edit' ? input.newAmount : null,
          payment_method: shape.payment_method,
          counterparty_user_id: shape.counterpartyUserId,
          receiver_cashbox_id: String(receiverBox.id),
          reason: input.reason,
          created_by: input.requesterId,
          idempotency_key: input.key,
          root_created_at: verdict.root.root_created_at,
        }),
      );
      const epoch = `pc:${String(correction.id)}`;

      // Qoldiqlar (bildirishnoma uchun: oldin → keyin).
      const balanceBefore = new Map(
        [...locked.values()].map((cb) => [String(cb.id), Number(cb.balance)]),
      );

      // Teskari qatorlar — kassa hech qachon oraliqda manfiyga tushmaydigan
      // tartibda (click_to_market: MAIN avval +X, keyin −X).
      const order: Array<HistoryWithCashbox | null> =
        shape.kind === 'market_payment'
          ? [shape.mainMarketLeg, shape.marketLeg]
          : [
              shape.courierLeg,
              shape.marketLeg,
              shape.mainMarketLeg,
              shape.receiverLeg,
            ];
      for (const leg of order) {
        if (!leg) continue;
        await this.writeReversal(tx, leg, box(leg.cashbox_id) as Cashbox, {
          reversalTransferId,
          epoch,
          reason: input.reason,
          requesterId: input.requesterId,
        });
      }

      // Daftar orqaga (finance → order, doimiy pattern). TARTIB muhim
      // (outbox ketma-ket yetkazadi): click_to_market da AVVAL market
      // bo'g'ini (MARKET_SETTLED → BRANCH_SETTLED), keyin kuryer bo'g'ini —
      // aks holda kuryer retreat'i market yopgan qatorlarni ko'rmaydi.
      // Qabul qiluvchi (MAIN / filial) — qaysi qatorlar qayta ochilishi
      // shundan (kuryer boshqa filialga o'tgan bo'lsa ham asl qabul qiluvchi).
      const receiver = {
        receiver_cashbox_type: receiverBox.cashbox_type,
        receiver_branch_id:
          receiverBox.cashbox_type === Cashbox_type.BRANCH
            ? String(receiverBox.user_id)
            : null,
      };
      if (shape.marketLeg) {
        await this.enqueueRetreat(
          tx,
          'hq_to_market',
          String(shape.marketLeg.cashbox.user_id),
          X,
          epoch,
          input.requesterId,
          receiver,
        );
      }
      if (shape.courierLeg) {
        await this.enqueueRetreat(
          tx,
          'courier_to_branch',
          shape.counterpartyUserId,
          X,
          epoch,
          input.requesterId,
          receiver,
        );
      }

      // Tahrir — yangi summali to'lov (bildirishnomasiz, auditsiz).
      if (input.action === 'edit') {
        await this.writeReplacement(tx, shape, receiverBox, {
          amount: input.newAmount as number,
          transferId: replacementTransferId as string,
          epoch,
          requesterId: input.requesterId,
        });
      }

      const cashboxes = await tx.find(Cashbox, {
        where: { id: In([...locked.keys()]) },
        order: { id: 'ASC' },
      });
      await this.notifyParties(tx, {
        correction,
        shape,
        input,
        languages,
        balanceBefore,
        balanceAfter: new Map(
          cashboxes.map((cb) => [String(cb.id), Number(cb.balance)]),
        ),
      });

      await queryRunner.commitTransaction();
      committed = { correction, shape, cashboxes };
    } catch (error) {
      if (queryRunner.isTransactionActive) {
        await queryRunner.rollbackTransaction();
      }
      if (this.isUniqueViolation(error)) {
        // Parallel: o'sha kalit (idempotent javob) yoki o'sha to'lov.
        const replay = await this.findReplay(
          this.dataSource.manager,
          input,
          history,
        );
        if (replay) return replay;
        failCode(409, C.ALREADY_CORRECTED);
      }
      throw this.mapMoneyError(error);
    } finally {
      await queryRunner.release();
    }

    if (!committed) {
      throw new Error('payment correction: commit holati yo`q');
    }
    await this.afterCommit(committed.correction, committed.shape, input);
    return {
      statusCode: 201,
      message:
        input.action === 'edit'
          ? "To'lov summasi tuzatildi"
          : "To'lov qaytarildi",
      data: {
        correction: this.correctionView(committed.correction),
        cashboxes: committed.cashboxes.map((cb) => this.cashboxView(cb)),
        idempotent: false,
      },
    };
  }

  // ───────────────────────── pul qadamlari ─────────────────────────

  private async writeReversal(
    tx: EntityManager,
    leg: HistoryWithCashbox,
    cashbox: Cashbox,
    ctx: {
      reversalTransferId: string;
      epoch: string;
      reason: string;
      requesterId: string;
    },
  ) {
    const amount = Number(leg.amount);
    const operation = opposite(leg.operation_type);
    this.finance.updateBalancesByMethod(
      cashbox,
      amount,
      operation,
      leg.payment_method,
    );
    // Karta — asl oyoqniki (faqat MAIN/BRANCH, click, nomli karta).
    const cardId =
      leg.card_id && leg.payment_method === PaymentMethod.CLICK
        ? await applyCashboxCardSelection(tx, cashbox, {
            card_id: leg.card_id,
            operation,
            amount,
            payment_method: leg.payment_method,
          })
        : (leg.card_id ?? null);
    await tx.save(cashbox);
    await tx.save(
      tx.create(CashboxHistory, {
        operation_type: operation,
        cashbox_id: cashbox.id,
        card_id: cardId,
        source_type: Source_type.PAYMENT_REVERSAL,
        source_id: String(leg.id),
        dedup_epoch: ctx.epoch,
        transfer_id: ctx.reversalTransferId,
        reverses_history_id: String(leg.id),
        source_user_id: leg.source_user_id ?? null,
        transfer_source_user_id: leg.transfer_source_user_id ?? null,
        amount,
        balance_after: cashbox.balance,
        balance_cash_after: cashbox.balance_cash,
        balance_card_after: cashbox.balance_card,
        payment_method: leg.payment_method,
        comment: ctx.reason,
        created_by: ctx.requesterId,
        payment_date: null,
      }),
    );
  }

  private async writeReplacement(
    tx: EntityManager,
    shape: TransferShape,
    receiverBox: Cashbox,
    ctx: {
      amount: number;
      transferId: string;
      epoch: string;
      requesterId: string;
    },
  ) {
    const iso = (value: Date | null | undefined) =>
      value ? new Date(value).toISOString() : undefined;
    if (shape.kind === 'courier_payment' && shape.courierLeg) {
      const original = shape.courierLeg;
      const result = await this.finance.applyCourierPaymentInTx(
        tx,
        {
          courier_id: shape.counterpartyUserId,
          amount: ctx.amount,
          payment_method: shape.payment_method,
          payment_date: iso(original.payment_date),
          comment: original.comment ?? undefined,
          market_id: shape.marketLeg
            ? String(shape.marketLeg.cashbox.user_id)
            : undefined,
          created_by: ctx.requesterId,
          receiver_user_id: String(receiverBox.user_id),
          receiver_cashbox_type: receiverBox.cashbox_type,
          dedup_epoch: ctx.epoch,
          card_id: shape.receiverLeg?.card_id ?? undefined,
        },
        { notify: false, transferId: ctx.transferId, skipShiftGate: true },
      );
      if (result.idempotent) {
        failCode(409, C.ALREADY_CORRECTED);
      }
      return;
    }
    const original = shape.mainMarketLeg as HistoryWithCashbox;
    const result = await this.finance.applyMarketPaymentInTx(
      tx,
      {
        market_id: shape.counterpartyUserId,
        amount: ctx.amount,
        payment_method: shape.payment_method,
        payment_date: iso(original.payment_date),
        comment: original.comment ?? undefined,
        created_by: ctx.requesterId,
        dedup_epoch: ctx.epoch,
        transfer_source_user_id: original.transfer_source_user_id ?? undefined,
        card_id: original.card_id ?? undefined,
      },
      { notify: false, transferId: ctx.transferId, skipShiftGate: true },
    );
    if (result.idempotent) {
      failCode(409, C.ALREADY_CORRECTED);
    }
  }

  private async enqueueRetreat(
    tx: EntityManager,
    level: 'courier_to_branch' | 'hq_to_market',
    matchValue: string,
    amount: number,
    epoch: string,
    requesterId: string,
    receiver: {
      receiver_cashbox_type: Cashbox_type;
      receiver_branch_id: string | null;
    },
  ) {
    const requestId = `${epoch}:${level}`;
    await this.outbox.enqueue(
      'ORDER',
      'order.settlement.retreat',
      {
        level,
        match_value: String(matchValue),
        amount: Number(amount),
        requester_id: requesterId,
        request_id: requestId,
        ...receiver,
      },
      { manager: tx, requestId },
    );
  }

  /**
   * Qulf ostida — pul yetadimi (xatoda hech narsa yozilmagan bo'lsin):
   *  • kuryer to'lovi (click_to_market emas): qabul qiluvchi kassadan X
   *    chiqadi — usul cho'ntagi va karta (nomli — o'z qoldig'i, Asosiy —
   *    hosila qoldiq) yetishi shart; click_to_market da MAIN sof 0;
   *  • marketga to'lov tahriri: MAIN ga X qaytadi, keyin yangi summa chiqadi;
   *  • to'lov kartasi arxivda — CARD_ARCHIVED.
   */
  private async assertFunds(
    tx: EntityManager,
    shape: TransferShape,
    receiverBox: Cashbox,
    newAmount: number | null,
  ) {
    const X = shape.amount;
    const receiverLeg =
      shape.kind === 'market_payment' ? shape.mainMarketLeg : shape.receiverLeg;
    const method = shape.payment_method;
    const card =
      receiverLeg?.card_id && method === PaymentMethod.CLICK
        ? await tx.findOne(CashboxCard, {
            where: { id: String(receiverLeg.card_id), isDeleted: false },
            lock: { mode: 'pessimistic_write' },
          })
        : null;
    if (receiverLeg?.card_id && method === PaymentMethod.CLICK) {
      if (!card || String(card.cashbox_id) !== String(receiverBox.id)) {
        failCode(409, C.NOT_CORRECTABLE);
      }
      if (!card.is_active && !card.is_default) {
        failCode(409, C.CARD_ARCHIVED);
      }
    }
    // Qabul qiluvchidan chiqadigan sof summa (oxirgi holat bo'yicha).
    let outflow = 0;
    if (shape.kind === 'courier_payment' && !shape.clickToMarket) {
      outflow = X - (newAmount ?? 0);
    } else if (shape.kind === 'market_payment' && newAmount !== null) {
      outflow = newAmount - X;
    }
    // Oraliq holat ham: kuryer to'lovida avval X chiqadi (keyin yangi summa kiradi).
    const peak =
      shape.kind === 'courier_payment' && !shape.clickToMarket ? X : outflow;
    if (!(peak > 0)) return;
    const bucket = isCardMethod(method)
      ? Number(receiverBox.balance_card)
      : Number(receiverBox.balance_cash);
    if (round2(bucket - peak) < 0) failCode(409, C.INSUFFICIENT_BALANCE);
    if (method !== PaymentMethod.CLICK) return;
    if (card && !card.is_default) {
      if (round2(Number(card.balance) - peak) < 0) {
        failCode(409, C.INSUFFICIENT_BALANCE);
      }
      return;
    }
    const named = await sumNamedCardBalances(tx, String(receiverBox.id));
    if (round2(Number(receiverBox.balance_card) - named - peak) < 0) {
      failCode(409, C.INSUFFICIENT_BALANCE);
    }
  }

  private async requireShift(tx: EntityManager, receiver: Cashbox) {
    try {
      await this.finance.requireOpenShift(tx, {
        user_id: String(receiver.user_id ?? MAIN_CASHBOX_USER_ID),
        cashbox_type: receiver.cashbox_type,
      });
    } catch (error) {
      if (error instanceof BadRequestException) {
        failCode(
          400,
          receiver.cashbox_type === Cashbox_type.BRANCH
            ? C.BRANCH_SHIFT_REQUIRED
            : C.SHIFT_REQUIRED,
        );
      }
      throw error;
    }
  }

  // ───────────────────── bildirishnoma / realtime ─────────────────────

  private recipientIds(shape: TransferShape, managerIds: string[]) {
    const ids = new Set<string>();
    if (shape.courierLeg) ids.add(String(shape.courierLeg.cashbox.user_id));
    if (shape.marketLeg) ids.add(String(shape.marketLeg.cashbox.user_id));
    if (shape.receiverCashbox.cashbox_type === Cashbox_type.BRANCH) {
      for (const id of managerIds) ids.add(id);
    }
    return [...ids];
  }

  /** Oluvchilar tili — `identity.audience.resolve` (qisqa, fail-open → uz). */
  private async resolveLanguages(ids: string[]): Promise<Map<string, string>> {
    const map = new Map<string, string>();
    if (!ids.length) return map;
    try {
      const res = await rmqSend<{
        data?: { items?: Array<{ id?: unknown; language?: unknown }> };
      }>(
        this.identityClient,
        { cmd: 'identity.audience.resolve' },
        { user_ids: ids, fields: 'minimal', limit: 100, with_total: false },
        { timeoutMs: 1500, retries: 0 },
      );
      for (const item of res?.data?.items ?? []) {
        if (typeof item?.language === 'string') {
          map.set(text(item.id), item.language);
        }
      }
    } catch (error) {
      this.logger.warn(
        `payment correction: oluvchilar tili olinmadi (uz): ${(error as Error)?.message ?? error}`,
      );
    }
    return map;
  }

  private async notifyParties(
    tx: EntityManager,
    ctx: {
      correction: PaymentCorrection;
      shape: TransferShape;
      input: ValidatedInput;
      languages: Map<string, string>;
      balanceBefore: Map<string, number>;
      balanceAfter: Map<string, number>;
    },
  ) {
    const { correction, shape, input } = ctx;
    const parties: Array<{ userId: string; leg: HistoryWithCashbox }> = [];
    if (shape.courierLeg) {
      parties.push({
        userId: String(shape.courierLeg.cashbox.user_id),
        leg: shape.courierLeg,
      });
    }
    if (
      shape.receiverLeg &&
      shape.receiverCashbox.cashbox_type === Cashbox_type.BRANCH
    ) {
      for (const managerId of input.managerIds) {
        parties.push({ userId: managerId, leg: shape.receiverLeg });
      }
    }
    if (shape.marketLeg) {
      parties.push({
        userId: String(shape.marketLeg.cashbox.user_id),
        leg: shape.marketLeg,
      });
    }
    const seen = new Set<string>();
    for (const party of parties) {
      if (seen.has(party.userId)) continue;
      seen.add(party.userId);
      const cashboxId = String(party.leg.cashbox_id);
      await this.notifications?.paymentCorrected(
        {
          correction_id: correction.id,
          action: correction.action,
          recipient_id: party.userId,
          language: ctx.languages.get(party.userId) ?? null,
          payment_id: party.leg.id,
          amount: shape.amount,
          new_amount: correction.new_amount,
          payment_date: party.leg.payment_date ?? party.leg.createdAt,
          balance_before: ctx.balanceBefore.get(cashboxId) ?? null,
          balance_after: ctx.balanceAfter.get(cashboxId) ?? null,
        },
        tx,
      );
    }
    await this.realtime?.paymentCorrected(
      {
        correction_id: correction.id,
        action: correction.action,
        payment_kind: shape.kind,
        receiver_cashbox_type:
          shape.receiverCashbox.cashbox_type === Cashbox_type.BRANCH
            ? 'branch'
            : 'main',
        branch_id:
          shape.receiverCashbox.cashbox_type === Cashbox_type.BRANCH
            ? String(shape.receiverCashbox.user_id)
            : null,
        user_ids: [
          shape.courierLeg ? String(shape.courierLeg.cashbox.user_id) : null,
          shape.marketLeg ? String(shape.marketLeg.cashbox.user_id) : null,
        ],
        cashbox_ids: [...ctx.balanceAfter.keys()],
      },
      tx,
    );
  }

  private async afterCommit(
    correction: PaymentCorrection,
    shape: TransferShape,
    input: ValidatedInput,
  ) {
    if (shape.marketLeg) {
      void this.finance.scheduleMarketPaymentCorrectionSync({
        market_id: String(shape.marketLeg.cashbox.user_id),
        reverted: shape.amount,
        applied: correction.new_amount,
      });
    }
    const isEdit = correction.action === 'edit';
    await this.activityLog
      .log({
        entity_type: 'PaymentCorrection',
        entity_id: String(correction.id),
        action: isEdit
          ? 'finance.payment_amount_corrected'
          : 'finance.payment_reversed',
        user_id: input.requesterId,
        user_role: Roles.SUPERADMIN,
        old_value: { amount: shape.amount },
        new_value: { amount: isEdit ? correction.new_amount : 0 },
        metadata: {
          correction_id: String(correction.id),
          payment_kind: shape.kind,
          payment_method: shape.payment_method,
          original_amount: shape.amount,
          new_amount: correction.new_amount,
          reason: correction.reason,
          history_id: input.historyId,
          original_transfer_id: correction.original_transfer_id,
          reversal_transfer_id: correction.reversal_transfer_id,
          replacement_transfer_id: correction.replacement_transfer_id,
          counterparty_user_id: correction.counterparty_user_id,
          receiver_cashbox_id: correction.receiver_cashbox_id,
          // Ega qarori: hamkor marketiga xabar yuborilmaydi.
          partner_notified: false,
        },
        description: isEdit
          ? `To'lov summasi tuzatildi: ${shape.amount} → ${correction.new_amount} so'm (tuzatish #${String(correction.id)})`
          : `To'lov qaytarildi: ${shape.amount} so'm (tuzatish #${String(correction.id)})`,
      })
      .catch((error: unknown) =>
        this.logger.warn(
          `payment correction audit (#${String(correction.id)}): ${(error as Error)?.message ?? error}`,
        ),
      );
  }

  // ───────────────────────── yordamchilar ─────────────────────────

  private validate(
    action: PaymentCorrectionAction,
    raw: PaymentCorrectionInput,
  ): ValidatedInput {
    this.assertSuperadmin(raw?.requester_roles);
    const requesterId = text(raw?.requester_id);
    if (!/^\d+$/.test(requesterId)) {
      throw new BadRequestException("requester_id noto'g'ri");
    }
    const key = text(raw?.idempotency_key);
    if (!key) {
      failCode(400, C.IDEMPOTENCY_KEY_REQUIRED);
    }
    if (key.length > 255) {
      throw new BadRequestException(
        'Idempotency-Key 255 belgidan oshmasligi kerak',
      );
    }
    const historyId = text(raw?.history_id);
    if (!/^\d{1,19}$/.test(historyId)) {
      throw new BadRequestException("Kassa yozuvi id si noto'g'ri");
    }
    const reason = typeof raw?.reason === 'string' ? raw.reason.trim() : '';
    if (
      reason.length < PAYMENT_CORRECTION_REASON_MIN ||
      reason.length > PAYMENT_CORRECTION_REASON_MAX
    ) {
      throw new BadRequestException(
        `Sabab ${PAYMENT_CORRECTION_REASON_MIN}…${PAYMENT_CORRECTION_REASON_MAX} belgi bo'lishi kerak`,
      );
    }
    let newAmount: number | null = null;
    if (action === 'edit') {
      const value = Number(raw?.new_amount);
      if (
        typeof raw?.new_amount === 'boolean' ||
        !Number.isFinite(value) ||
        !(value > 0) ||
        round2(value) !== value
      ) {
        throw new BadRequestException(
          "new_amount 0 dan katta (ko'pi bilan 2 kasr xonali) son bo'lishi kerak",
        );
      }
      newAmount = value;
    }
    const managerIds = Array.isArray(raw?.notify_user_ids)
      ? [
          ...new Set(
            raw.notify_user_ids
              .map(text)
              .filter((id) => /^\d{1,19}$/.test(id) && !/^0+$/.test(id)),
          ),
        ]
      : [];
    return {
      action,
      historyId,
      reason,
      newAmount,
      key,
      requesterId,
      managerIds,
    };
  }

  private assertSuperadmin(roles: unknown) {
    const list = Array.isArray(roles)
      ? roles.map((role) => text(role).toLowerCase())
      : [];
    if (!list.includes(Roles.SUPERADMIN)) {
      throw new RpcException({
        statusCode: 403,
        message: 'Bu amal faqat superadmin uchun',
      });
    }
  }

  private async loadHistory(id: string): Promise<HistoryWithCashbox> {
    if (!/^\d{1,19}$/.test(id)) {
      throw new BadRequestException("Kassa yozuvi id si noto'g'ri");
    }
    const history = await this.dataSource.manager.findOne(CashboxHistory, {
      where: { id, isDeleted: false },
      relations: ['cashbox'],
    });
    if (!history) failCode(404, C.NOT_FOUND);
    return history;
  }

  /**
   * O'sha `Idempotency-Key` — o'sha so'rov bo'lsa 200 `idempotent: true`
   * (pul qayta ko'chmaydi), boshqa so'rov bo'lsa 409.
   */
  private async findReplay(
    manager: EntityManager,
    input: ValidatedInput,
    history: HistoryWithCashbox,
  ) {
    const existing = await manager.findOne(PaymentCorrection, {
      where: { idempotency_key: input.key },
    });
    if (!existing) return null;
    const sameRequest =
      existing.action === input.action &&
      existing.original_transfer_id === history.transfer_id &&
      String(existing.created_by) === input.requesterId &&
      existing.reason === input.reason &&
      (existing.new_amount === null || existing.new_amount === undefined
        ? input.newAmount === null
        : round2(Number(existing.new_amount)) === input.newAmount);
    if (!sameRequest) {
      failCode(409, C.IDEMPOTENCY_KEY_REUSED);
    }
    const legs = await manager.find(CashboxHistory, {
      where: [
        { transfer_id: existing.original_transfer_id },
        { transfer_id: existing.reversal_transfer_id },
      ],
      select: ['id', 'cashbox_id'],
    });
    const cashboxes = legs.length
      ? await manager.find(Cashbox, {
          where: { id: In([...new Set(legs.map((leg) => leg.cashbox_id))]) },
          order: { id: 'ASC' },
        })
      : [];
    return {
      statusCode: 200,
      message: "Tuzatish allaqachon bajarilgan (takroriy so'rov)",
      data: {
        correction: this.correctionView(existing),
        cashboxes: cashboxes.map((cb) => this.cashboxView(cb)),
        idempotent: true,
      },
    };
  }

  private failVerdict(
    code: PaymentCorrectionErrorCode,
    deadline: string | null,
  ): never {
    if (code === C.WINDOW_EXPIRED) {
      failCode(409, code, { deadline });
    }
    failCode(code === C.NOT_FOUND ? 404 : 409, code);
  }

  private correctionView(correction: PaymentCorrection) {
    return {
      id: String(correction.id),
      action: correction.action,
      payment_kind: correction.payment_kind,
      original_amount: Number(correction.original_amount),
      new_amount:
        correction.new_amount === null || correction.new_amount === undefined
          ? null
          : Number(correction.new_amount),
      reason: correction.reason,
      created_by: String(correction.created_by),
      created_at: correction.createdAt,
    };
  }

  private cashboxView(cashbox: Cashbox) {
    return {
      id: String(cashbox.id),
      user_id: String(cashbox.user_id),
      cashbox_type: cashbox.cashbox_type,
      balance: Number(cashbox.balance),
      balance_cash: Number(cashbox.balance_cash),
      balance_card: Number(cashbox.balance_card),
    };
  }

  private isUniqueViolation(error: unknown): boolean {
    const code =
      (error as { code?: string })?.code ??
      (error as { driverError?: { code?: string } })?.driverError?.code;
    return error instanceof QueryFailedError && code === PG_UNIQUE_VIOLATION;
  }

  /**
   * Pul funksiyalarining kodsiz xatolari (qo'riqchilar oldindan tekshirgan,
   * lekin himoya qatlami) — aniq kodga.
   */
  private mapMoneyError(error: unknown): unknown {
    if (!(error instanceof BadRequestException)) return error;
    const message = error.message ?? '';
    if (/arxivlangan/i.test(message)) {
      return new RpcException({
        statusCode: 409,
        code: C.CARD_ARCHIVED,
        message: MESSAGES.CARD_ARCHIVED,
      });
    }
    if (/insufficient|yetarli mablag/i.test(message)) {
      return new RpcException({
        statusCode: 409,
        code: C.INSUFFICIENT_BALANCE,
        message: MESSAGES.INSUFFICIENT_BALANCE,
      });
    }
    if (/oshib ketdi/i.test(message)) {
      return new RpcException({
        statusCode: 409,
        code: C.AMOUNT_EXCEEDS,
        message: MESSAGES.AMOUNT_EXCEEDS,
      });
    }
    return error;
  }

  private rethrow(error: unknown): never {
    if (error instanceof RpcException) throw error;
    if (error instanceof NotFoundException) {
      throw new RpcException({ statusCode: 404, message: error.message });
    }
    if (error instanceof BadRequestException) {
      throw new RpcException({ statusCode: 400, message: error.message });
    }
    this.logger.error(
      `payment correction failed: ${(error as Error)?.message ?? error}`,
    );
    throw new RpcException({
      statusCode: 500,
      message: error instanceof Error ? error.message : 'Internal server error',
    });
  }
}
