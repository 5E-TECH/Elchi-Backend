import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import { Logger } from '@nestjs/common';
import type { ModuleRef } from '@nestjs/core';
import { of, throwError } from 'rxjs';
import {
  Cashbox_type,
  Operation_type,
  OutboxEvent,
  OutboxPublisher,
  OutboxService,
  PaymentMethod,
  Source_type,
  isKnownNotificationType,
} from '@app/common';
import { Cashbox } from '../entities/cashbox.entity';
import { CashboxHistory } from '../entities/cashbox-history.entity';
import { FinanceServiceService } from '../finance-service.service';
import {
  FINANCE_NOTIFICATION_TYPES,
  FinanceNotificationService,
  NOTIFICATION_DISPATCH_PATTERN,
  NOTIFICATION_OUTBOX_TARGET,
  buildBalanceTopupPayload,
  buildPaymentReceivedPayload,
  isBalanceTopup,
} from './finance-notification.service';

/**
 * ePpLHPX2 — finance hodisalari → bildirishnoma (outbox orqali, pul
 * tranzaksiyasi ichida, fail-open). Naqsh: order-service pilot (OA16fdSq).
 */
const SRC = join(__dirname, '..');

beforeEach(() => {
  jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());

describe('katalog (Eh8y21Ha TC12 analogi)', () => {
  it('finance yuboradigan barcha turlar notification-types katalogida', () => {
    expect(FINANCE_NOTIFICATION_TYPES).toEqual([
      'finance.payment_received',
      'finance.balance_topup',
    ]);
    FINANCE_NOTIFICATION_TYPES.forEach((type) =>
      expect(isKnownNotificationType(type)).toBe(true),
    );
  });
});

describe('buildPaymentReceivedPayload', () => {
  it('market to‘lovi — market qabul qiluvchi, category/link/group_key katalogdan', () => {
    expect(
      buildPaymentReceivedPayload({
        kind: 'market_payment',
        recipient_id: '5',
        payment_id: '701',
        amount: 1_500_000,
        payment_method: PaymentMethod.CASH,
      }),
    ).toEqual({
      type: 'finance.payment_received',
      category: 'finance',
      priority: 'normal',
      title: "To'lov qabul qilindi",
      body: "Sizga 1 500 000 so'm to'landi (to'lov #701).",
      data: {
        kind: 'market_payment',
        amount: 1_500_000,
        payment_id: '701',
        payment_method: PaymentMethod.CASH,
      },
      link: '/cash-box',
      recipient_ids: ['5'],
      group_key: 'finance:payment:701',
      channels: ['in_app', 'realtime'],
    });
  });

  it('kuryer to‘lovi — kuryer qabul qiluvchi (topshirgani qabul qilindi)', () => {
    const payload = buildPaymentReceivedPayload({
      kind: 'courier_payment',
      recipient_id: 44,
      payment_id: '9',
      amount: '250000',
    })!;
    expect(payload.recipient_ids).toEqual(['44']);
    expect(payload.body).toBe(
      "Siz topshirgan 250 000 so'm kassaga qabul qilindi (to'lov #9).",
    );
  });

  it('to‘lov raqami yo‘q — group_key UMUMAN berilmaydi (bo‘sh satr emas)', () => {
    const payload = buildPaymentReceivedPayload({
      kind: 'market_payment',
      recipient_id: '5',
      payment_id: null,
      amount: 100,
    })!;
    expect(payload).not.toHaveProperty('group_key');
    expect(payload.body).toBe("Sizga 100 so'm to'landi.");
  });

  it.each([
    [{ recipient_id: '0' }],
    [{ recipient_id: null }],
    [{ recipient_id: 'abc' }],
    [{ amount: 0 }],
    [{ amount: -5 }],
    [{ amount: 'x' }],
  ])('yaroqsiz kirish %j — payload yo‘q', (overrides) => {
    expect(
      buildPaymentReceivedPayload({
        kind: 'market_payment',
        recipient_id: '5',
        payment_id: '1',
        amount: 100,
        ...(overrides as object),
      }),
    ).toBeNull();
  });
});

describe('balance_topup — faqat market/kuryer kassasiga qo‘lda kirim', () => {
  const topup = (overrides: Record<string, unknown> = {}) => ({
    cashbox_type: Cashbox_type.FOR_MARKET,
    operation_type: Operation_type.INCOME,
    source_type: Source_type.MANUAL_INCOME,
    recipient_id: '5',
    history_id: '88',
    amount: 300_000,
    balance_after: 1_200_000,
    ...overrides,
  });

  it.each([
    [{}, true],
    [{ cashbox_type: Cashbox_type.FOR_COURIER }, true],
    [{ cashbox_type: Cashbox_type.MAIN }, false], // fillTheCashbox (HQ)
    [{ cashbox_type: Cashbox_type.BRANCH }, false], // fillTheCashbox (filial)
    [{ source_type: Source_type.SELL }, false], // sotuv oyog'i
    [{ source_type: Source_type.CORRECTION }, false],
    [{ operation_type: Operation_type.EXPENSE }, false],
  ])('%j → %s', (overrides, expected) => {
    expect(isBalanceTopup(topup(overrides) as never)).toBe(expected);
  });

  it('payload: summa + joriy balans, link /cash-box, group_key yo‘q (katalogda pattern null)', () => {
    const payload = buildBalanceTopupPayload(topup() as never)!;
    expect(payload).toEqual(
      expect.objectContaining({
        type: 'finance.balance_topup',
        category: 'finance',
        title: "Balans to'ldirildi",
        body: "Balansingiz 300 000 so'm ga to'ldirildi. Joriy balans: 1 200 000 so'm.",
        link: '/cash-box',
        recipient_ids: ['5'],
        channels: ['in_app', 'realtime'],
        data: {
          amount: 300_000,
          cashbox_type: Cashbox_type.FOR_MARKET,
          history_id: '88',
          balance_after: 1_200_000,
        },
      }),
    );
    expect(payload).not.toHaveProperty('group_key');
  });

  it('balans noma’lum bo‘lsa — matnda faqat summa', () => {
    expect(
      buildBalanceTopupPayload(topup({ balance_after: null }) as never)!.body,
    ).toBe("Balansingiz 300 000 so'm ga to'ldirildi.");
  });
});

// ---------------------------------------------------------------------------
// Integratsiya: haqiqiy FinanceServiceService + haqiqiy OutboxService +
// xotiradagi tranzaksiya (commit → committed, rollback → hech narsa).
// ---------------------------------------------------------------------------

type Row = Record<string, any>;

function makeEnv(
  options: {
    cashboxes?: Partial<Record<Cashbox_type, Row>>;
    duplicate?: boolean;
    commitError?: Error;
    outboxError?: (target: string) => Error | null;
  } = {},
) {
  const committed: Row[] = [];
  let pending: Row[] = [];
  let seq = 0;

  const outboxRepo = {
    create: jest.fn((value: Row) => ({ ...value })),
    save: jest.fn((value: Row) => {
      const error = options.outboxError?.(value.target);
      if (error) return Promise.reject(error);
      pending.push(value);
      return Promise.resolve({ id: String(pending.length), ...value });
    }),
  };
  const cashboxes: Partial<Record<Cashbox_type, Row>> = {
    [Cashbox_type.MAIN]: {
      id: '1',
      user_id: '0',
      cashbox_type: Cashbox_type.MAIN,
      balance: 10_000_000,
      balance_cash: 10_000_000,
      balance_card: 0,
    },
    [Cashbox_type.FOR_MARKET]: {
      id: '2',
      user_id: '5',
      cashbox_type: Cashbox_type.FOR_MARKET,
      balance: 2_000_000,
      balance_cash: 2_000_000,
      balance_card: 0,
    },
    [Cashbox_type.FOR_COURIER]: {
      id: '3',
      user_id: '44',
      cashbox_type: Cashbox_type.FOR_COURIER,
      balance: 900_000,
      balance_cash: 900_000,
      balance_card: 0,
    },
    ...options.cashboxes,
  };

  const queryRunner: Row = {
    isTransactionActive: false,
    connect: jest.fn().mockResolvedValue(undefined),
    startTransaction: jest.fn(() => {
      queryRunner.isTransactionActive = true;
      return Promise.resolve();
    }),
    commitTransaction: jest.fn(() => {
      if (options.commitError) return Promise.reject(options.commitError);
      committed.push(...pending);
      pending = [];
      queryRunner.isTransactionActive = false;
      return Promise.resolve();
    }),
    rollbackTransaction: jest.fn(() => {
      pending = [];
      queryRunner.isTransactionActive = false;
      return Promise.resolve();
    }),
    release: jest.fn().mockResolvedValue(undefined),
  };
  const manager: Row = {
    queryRunner,
    findOne: jest.fn((entity: unknown, opts: { where: Row }) => {
      if (entity === Cashbox) {
        return Promise.resolve(
          cashboxes[opts.where.cashbox_type as Cashbox_type] ?? null,
        );
      }
      if (entity === CashboxHistory) {
        return Promise.resolve(options.duplicate ? { id: 'old' } : null);
      }
      return Promise.resolve(null);
    }),
    save: jest.fn((entity: Row) =>
      Promise.resolve(
        'cashbox_type' in entity
          ? entity
          : { ...entity, id: entity.id ?? String(700 + ++seq) },
      ),
    ),
    create: jest.fn((_entity: unknown, dto: Row) => ({ ...dto })),
    getRepository: jest.fn((entity: unknown) => {
      if (entity === OutboxEvent) return outboxRepo;
      throw new Error('unexpected repository');
    }),
  };
  queryRunner.manager = manager;

  const defaultOutboxRepo = { create: jest.fn(), save: jest.fn() };
  const outbox = new OutboxService(defaultOutboxRepo as never);
  const notifier = new FinanceNotificationService(outbox);
  const anyClient = { send: jest.fn(() => of({ data: [] })) };
  const notificationClient = {
    send: jest.fn(() => {
      throw new Error('notification-service o‘chiq');
    }),
    emit: jest.fn(() => {
      throw new Error('notification-service o‘chiq');
    }),
  };
  const activityLog = {
    log: jest.fn().mockResolvedValue(undefined),
    logChange: jest.fn().mockResolvedValue(undefined),
  };

  const service = new FinanceServiceService(
    { findOne: jest.fn(), save: jest.fn() } as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    { createQueryRunner: jest.fn(() => queryRunner) } as never,
    activityLog as never,
    anyClient as never,
    anyClient as never,
    anyClient as never,
    outbox,
    notifier,
  );

  const notifications = () =>
    committed.filter((row) => row.target === NOTIFICATION_OUTBOX_TARGET);

  return {
    service,
    queryRunner,
    outboxRepo,
    defaultOutboxRepo,
    committed,
    notifications,
    notificationClient,
    cashboxes,
  };
}

describe('paymentsToMarket → finance.payment_received (outbox, pul tranzaksiyasi ichida)', () => {
  const pay = (env: ReturnType<typeof makeEnv>) =>
    env.service.paymentsToMarket({
      market_id: '5',
      amount: 1_500_000,
      payment_method: PaymentMethod.CASH,
      comment: 'Mijoz +998 90 123 45 67, Chilonzor 5-uy',
      created_by: '1',
      dedup_epoch: 'tok-1',
    });

  it('commit — outbox_events da target=NOTIFICATION, pattern=notification.dispatch qatori (market qabul qiluvchi) — settlement advance bilan BIRGA', async () => {
    const env = makeEnv();
    const res: Row = await pay(env);
    await env.service.onModuleDestroy();

    expect(res.statusCode).toBe(200);
    expect(env.queryRunner.commitTransaction).toHaveBeenCalledTimes(1);
    expect(env.committed.map((row) => [row.target, row.pattern])).toEqual([
      ['ORDER', 'order.settlement.advance'],
      [NOTIFICATION_OUTBOX_TARGET, NOTIFICATION_DISPATCH_PATTERN],
    ]);
    const [row] = env.notifications();
    expect(row).toEqual(
      expect.objectContaining({
        target: 'NOTIFICATION',
        pattern: 'notification.dispatch',
        status: 'pending',
        payload: expect.objectContaining({
          type: 'finance.payment_received',
          category: 'finance',
          recipient_ids: ['5'],
          link: '/cash-box',
          group_key: expect.stringMatching(/^finance:payment:7\d\d$/),
          request_id: expect.any(String),
        }),
      }),
    );
    // tranzaksiya menejeri orqali (default repo emas)
    expect(env.defaultOutboxRepo.save).not.toHaveBeenCalled();
  });

  it('PII: in_app body/title/data da to‘lov izohi (telefon, manzil) YO‘Q', async () => {
    const env = makeEnv();
    await pay(env);
    await env.service.onModuleDestroy();
    const { payload } = env.notifications()[0];
    for (const text of [
      payload.title,
      payload.body,
      JSON.stringify(payload.data),
    ]) {
      expect(text).not.toContain('Chilonzor');
      expect(text).not.toContain('123 45 67');
    }
    expect(payload.body).toMatch(
      /^Sizga 1 500 000 so'm to'landi \(to'lov #7\d\d\)\.$/,
    );
  });

  it('rollback (commit yiqildi) — outbox qatori HAM yo‘q (bildirishnoma ketmaydi)', async () => {
    const env = makeEnv({ commitError: new Error('serialization failure') });
    await expect(pay(env)).rejects.toBeDefined();
    expect(env.queryRunner.rollbackTransaction).toHaveBeenCalledTimes(1);
    expect(env.committed).toEqual([]);
  });

  it('ortiqcha to‘lov qo‘riqchisi — pul ko‘chmaydi, bildirishnoma ham yozilmaydi', async () => {
    const env = makeEnv();
    await expect(
      env.service.paymentsToMarket({
        market_id: '5',
        amount: 99_000_000,
        payment_method: PaymentMethod.CASH,
      }),
    ).rejects.toBeDefined();
    expect(env.outboxRepo.save).not.toHaveBeenCalled();
    expect(env.committed).toEqual([]);
  });

  it('takroriy (idempotent) so‘rov — ikkinchi bildirishnoma yo‘q', async () => {
    const env = makeEnv({ duplicate: true });
    const res: Row = await pay(env);
    expect(res.data).toEqual({ idempotent: true });
    expect(env.outboxRepo.save).not.toHaveBeenCalled();
  });

  it('tranzaksiya ichida outbox DB xatosi — chaqiruvchi rollback qiladi (order-service naqshi)', async () => {
    const env = makeEnv({
      outboxError: (target) =>
        target === NOTIFICATION_OUTBOX_TARGET
          ? new Error('current transaction is aborted')
          : null,
    });
    await expect(pay(env)).rejects.toBeDefined();
    expect(env.queryRunner.commitTransaction).not.toHaveBeenCalled();
    expect(env.queryRunner.rollbackTransaction).toHaveBeenCalledTimes(1);
    expect(env.committed).toEqual([]);
  });

  it('TC3 analogi: notification-service o‘chiq — to‘lov baribir o‘tadi, NOTIFICATION mijozi umuman chaqirilmaydi', async () => {
    const env = makeEnv();
    const res: Row = await pay(env);
    await env.service.onModuleDestroy();
    expect(res.statusCode).toBe(200);
    expect(env.notifications()).toHaveLength(1);
    expect(env.notificationClient.send).not.toHaveBeenCalled();
    expect(env.notificationClient.emit).not.toHaveBeenCalled();
  });
});

describe('paymentsFromCourier → finance.payment_received', () => {
  it('kuryer pul topshirdi — kuryer qabul qiluvchi (o‘sha tranzaksiyada)', async () => {
    const env = makeEnv();
    await env.service.paymentsFromCourier({
      courier_id: '44',
      amount: 400_000,
      payment_method: PaymentMethod.CASH,
      created_by: '1',
      dedup_epoch: 'tok-2',
    });
    await env.service.onModuleDestroy();
    const rows = env.notifications();
    expect(rows).toHaveLength(1);
    expect(rows[0].payload).toEqual(
      expect.objectContaining({
        type: 'finance.payment_received',
        recipient_ids: ['44'],
        data: expect.objectContaining({
          kind: 'courier_payment',
          amount: 400_000,
        }),
      }),
    );
  });

  it('click_to_market — kuryer (puli ketgan) VA market (puli kelgan) alohida', async () => {
    const env = makeEnv();
    await env.service.paymentsFromCourier({
      courier_id: '44',
      market_id: '5',
      amount: 400_000,
      payment_method: PaymentMethod.CLICK_TO_MARKET,
      created_by: '1',
      dedup_epoch: 'tok-3',
    });
    await env.service.onModuleDestroy();
    const rows = env.notifications();
    expect(rows.map((row) => row.payload.recipient_ids)).toEqual([
      ['44'],
      ['5'],
    ]);
    expect(rows.map((row) => row.payload.data.kind)).toEqual([
      'courier_payment',
      'market_payment',
    ]);
    // har biri o'z kassasi tarix qatori raqami bilan
    expect(rows[0].payload.group_key).not.toBe(rows[1].payload.group_key);
  });

  it('qoldiqdan oshgan summa — rad etiladi, bildirishnoma yo‘q', async () => {
    const env = makeEnv();
    await expect(
      env.service.paymentsFromCourier({
        courier_id: '44',
        amount: 5_000_000,
        payment_method: PaymentMethod.CASH,
      }),
    ).rejects.toBeDefined();
    expect(env.outboxRepo.save).not.toHaveBeenCalled();
  });
});

describe('updateBalance → finance.balance_topup', () => {
  it('market kassasiga qo‘lda kirim (MANUAL_INCOME) — kassa egasiga, joriy balans bilan', async () => {
    const env = makeEnv();
    const res: Row = await env.service.updateBalance({
      user_id: '5',
      cashbox_type: Cashbox_type.FOR_MARKET,
      amount: 300_000,
      operation_type: Operation_type.INCOME,
      source_type: Source_type.MANUAL_INCOME,
      created_by: '1',
    });
    expect(res.statusCode).toBe(200);
    const rows = env.notifications();
    expect(rows).toHaveLength(1);
    expect(rows[0].payload).toEqual(
      expect.objectContaining({
        type: 'finance.balance_topup',
        recipient_ids: ['5'],
        body: "Balansingiz 300 000 so'm ga to'ldirildi. Joriy balans: 2 300 000 so'm.",
      }),
    );
  });

  it.each([
    [
      'sotuv oyog‘i (order-service outbox)',
      {
        user_id: '5',
        cashbox_type: Cashbox_type.FOR_MARKET,
        source_type: Source_type.SELL,
        source_id: '81',
      },
    ],
    [
      'HQ kassasini to‘ldirish (fillTheCashbox)',
      {
        user_id: '0',
        cashbox_type: Cashbox_type.MAIN,
        source_type: Source_type.MANUAL_INCOME,
      },
    ],
  ])('%s — bildirishnoma yo‘q', async (_label, overrides) => {
    const env = makeEnv();
    await env.service.updateBalance({
      amount: 300_000,
      operation_type: Operation_type.INCOME,
      ...overrides,
    } as never);
    expect(env.queryRunner.commitTransaction).toHaveBeenCalledTimes(1);
    expect(env.notifications()).toEqual([]);
  });

  it('rollback — balans to‘ldirish bildirishnomasi ham yo‘q', async () => {
    const env = makeEnv({ commitError: new Error('deadlock') });
    await expect(
      env.service.updateBalance({
        user_id: '5',
        cashbox_type: Cashbox_type.FOR_MARKET,
        amount: 300_000,
        operation_type: Operation_type.INCOME,
        source_type: Source_type.MANUAL_INCOME,
      }),
    ).rejects.toBeDefined();
    expect(env.committed).toEqual([]);
  });
});

describe('fail-open (ePpLHPX2 TC3)', () => {
  it('payload qurishda kutilmagan xato — tranzaksiya ichida ham pul amali YIQILMAYDI', async () => {
    const outbox = { enqueue: jest.fn() };
    const notifier = new FinanceNotificationService(outbox as never);
    const manager = { queryRunner: { isTransactionActive: true } } as never;
    await expect(
      notifier.paymentReceived(
        {
          kind: 'market_payment',
          get recipient_id(): string {
            throw new Error('bug');
          },
          payment_id: '1',
          amount: 100,
        },
        manager,
      ),
    ).resolves.toBeUndefined();
    expect(outbox.enqueue).not.toHaveBeenCalled();
  });

  it('tranzaksiyasiz yo‘lda outbox xatosi — yutiladi (WARN)', async () => {
    const outbox = { enqueue: jest.fn().mockRejectedValue(new Error('db')) };
    const notifier = new FinanceNotificationService(outbox as never);
    await expect(
      notifier.paymentReceived({
        kind: 'market_payment',
        recipient_id: '5',
        payment_id: '1',
        amount: 100,
      }),
    ).resolves.toBeUndefined();
  });

  it('notifier ulanmagan (eski 13 argumentli konstruktor) — to‘lov avvalgidek, outbox faqat settlement advance', async () => {
    const env = makeEnv();
    const outboxOnly = { enqueue: jest.fn().mockResolvedValue(undefined) };
    const legacy = new FinanceServiceService(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      { createQueryRunner: jest.fn(() => env.queryRunner) } as never,
      { log: jest.fn().mockResolvedValue(undefined) } as never,
      { send: jest.fn(() => of({ data: [] })) } as never,
      { send: jest.fn(() => of({ data: [] })) } as never,
      {} as never,
      outboxOnly as never,
    );
    const res: Row = await legacy.paymentsToMarket({
      market_id: '5',
      amount: 100_000,
      payment_method: PaymentMethod.CASH,
    });
    await legacy.onModuleDestroy();
    expect(res.statusCode).toBe(200);
    expect(outboxOnly.enqueue).toHaveBeenCalledTimes(1);
    expect(outboxOnly.enqueue.mock.calls[0][1]).toBe(
      'order.settlement.advance',
    );
  });

  it('TC3: notification-service o‘chiq — OutboxPublisher bildirishnomani kutmaydi, settlement advance (pul) o‘sha tick’da ketadi', async () => {
    const events = [
      {
        id: '1',
        target: 'NOTIFICATION',
        pattern: 'notification.dispatch',
        payload: { request_id: 'n1' },
        status: 'pending',
        attempts: 0,
      },
      {
        id: '2',
        target: 'ORDER',
        pattern: 'order.settlement.advance',
        payload: { request_id: 'a1' },
        status: 'pending',
        attempts: 0,
      },
    ];
    const outbox = {
      getDuePending: jest.fn().mockResolvedValue(events),
      markPublished: jest.fn().mockResolvedValue(undefined),
      markFailed: jest.fn().mockResolvedValue(undefined),
    };
    const deadNotification = {
      send: jest.fn(() => throwError(() => new Error('no consumer'))),
      emit: jest.fn(() => throwError(() => new Error('broker down'))),
    };
    const order = { send: jest.fn(() => of({ ok: true })) };
    // finance-service.module.ts dagi sozlama bilan bir xil
    const publisher = new OutboxPublisher(
      {} as ModuleRef,
      outbox as never,
      ['ORDER', 'NOTIFICATION'],
      { fireAndForgetPatterns: ['notification.dispatch'] },
    );
    const internals = publisher as unknown as {
      clients: Map<string, unknown>;
      tick: () => Promise<void>;
    };
    internals.clients.set('NOTIFICATION', deadNotification);
    internals.clients.set('ORDER', order);

    await internals.tick();

    expect(deadNotification.send).not.toHaveBeenCalled();
    expect(deadNotification.emit).toHaveBeenCalledTimes(1);
    expect(outbox.markFailed).toHaveBeenCalledWith(
      '1',
      'broker down',
      expect.any(Number),
      expect.any(Number),
    );
    expect(order.send).toHaveBeenCalledTimes(1);
    expect(outbox.markPublished).toHaveBeenCalledWith('2');
  });
});

describe('modul ulanishi va TC5 analogi', () => {
  const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const full = join(dir, name);
      return statSync(full).isDirectory() ? walk(full) : [full];
    });
  const strip = (src: string) =>
    src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  it('finance-service.module.ts: NOTIFICATION mijozi, outbox targets va fireAndForgetPatterns', () => {
    const src = strip(
      readFileSync(join(SRC, 'finance-service.module.ts'), 'utf8'),
    );
    expect(src).toMatch(
      /RmqModule\.register\(\{\s*name:\s*'NOTIFICATION'\s*\}\)/,
    );
    expect(src).toMatch(/targets:\s*\[\s*'ORDER',\s*'NOTIFICATION'\s*\]/);
    expect(src).toMatch(
      /fireAndForgetPatterns:\s*\[\s*'notification\.dispatch'\s*\]/,
    );
    expect(src).toMatch(/FinanceNotificationService/);
  });

  it('grep bo‘sh: notification.dispatch faqat outbox orqali, NOTIFICATION mijozi inject qilinmaydi', () => {
    const offenders: string[] = [];
    for (const file of walk(SRC).filter(
      (f) => f.endsWith('.ts') && !f.endsWith('.spec.ts'),
    )) {
      const src = strip(readFileSync(file, 'utf8'));
      if (
        /rmqSend\([^;]*notification\.dispatch/s.test(src) ||
        /\.(send|emit)\(\s*\{\s*cmd:\s*['"]notification\./.test(src) ||
        /@Inject\(\s*['"]NOTIFICATION['"]\s*\)/.test(src)
      ) {
        offenders.push(file.replace(SRC, ''));
      }
    }
    expect(offenders).toEqual([]);
  });
});
