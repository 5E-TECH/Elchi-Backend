import { randomUUID } from 'node:crypto';
import { of } from 'rxjs';
import { DataSource } from 'typeorm';
import {
  Cashbox_type,
  Operation_type,
  PaymentMethod,
  Source_type,
} from '@app/common';
import { FinanceServiceService } from '../finance-service.service';
import { Cashbox } from '../entities/cashbox.entity';
import { CashboxCard } from '../entities/cashbox-card.entity';
import { CashboxHistory } from '../entities/cashbox-history.entity';
import { CourierPaymentAck } from '../entities/courier-payment-ack.entity';
import { FinanceSetting } from '../entities/finance-setting.entity';
import { FinancialBalanceHistory } from '../entities/financial-balance-history.entity';
import { PaymentCorrection } from '../entities/payment-correction.entity';
import { Shift, ShiftStatus } from '../entities/shift.entity';
import { CourierPaymentAckService } from '../courier-payment/courier-payment-ack.service';
import { FinanceNotificationService } from '../notification/finance-notification.service';
import { FinanceRealtimeService } from '../realtime/finance-realtime.service';
import { PaymentCorrectionService } from './payment-correction.service';
import { ShiftReportService } from '../shift-report/shift-report.service';

/**
 * T6-BE-2 — to'lovni qaytarish / summasini tuzatish, HAQIQIY Postgres
 * (FINANCE_OPERATOR_PG_TEST_URI bo'lmasa skip; o'z per-run sxemasida).
 * Kartaning backend qabul mezonlari (1–14).
 */
const pgUri = process.env.FINANCE_OPERATOR_PG_TEST_URI;
const describePg = pgUri ? describe : describe.skip;

const SA = { requester_id: '1', requester_roles: ['superadmin'] };

describePg('T6 payment correction — haqiqiy Postgres', () => {
  const schema = `spec_t6pc_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
  let admin: DataSource;
  let db: DataSource;
  let finance: FinanceServiceService;
  let corrections: PaymentCorrectionService;
  let acks: CourierPaymentAckService;
  const outbox = { enqueue: jest.fn().mockResolvedValue(undefined) };
  const activityLog = { log: jest.fn().mockResolvedValue(undefined) };
  const languages = new Map<string, string>();
  const orderCalls: Array<{ cmd: string; payload: any }> = [];
  // Hamkor xabari (`emitSettlementPaymentSafely`) shu client orqali ketadi.
  const integrationClient = { send: jest.fn(() => of({})) };
  const partnerCalls = () =>
    (integrationClient.send.mock.calls as unknown as Array<[{ cmd: string }]>)
      .map(([pattern]) => pattern.cmd)
      .filter((cmd) => cmd === 'integration.partner.settlement.enqueue');
  let marketOrders: Array<Record<string, unknown>> = [];
  const syncs: Promise<void>[] = [];

  beforeAll(async () => {
    process.env.RABBITMQ_GATEWAY_QUEUE = 'gateway_queue';
    admin = new DataSource({ type: 'postgres', url: pgUri });
    await admin.initialize();
    await admin.query(`CREATE SCHEMA "${schema}"`);
    db = new DataSource({
      type: 'postgres',
      url: pgUri,
      schema,
      entities: [
        Cashbox,
        CashboxHistory,
        CashboxCard,
        FinancialBalanceHistory,
        FinanceSetting,
        PaymentCorrection,
        Shift,
        CourierPaymentAck,
      ],
      synchronize: true,
    });
    await db.initialize();
    const identityClient = {
      send: jest.fn((pattern: { cmd: string }, payload: any) => {
        if (pattern.cmd === 'identity.audience.resolve') {
          return of({
            data: {
              items: (payload.user_ids as string[]).map((id) => ({
                id,
                language: languages.get(id) ?? 'uz',
              })),
            },
          });
        }
        return of({ data: { id: payload?.id, name: 'Bosh admin' } });
      }),
    };
    const orderClient = {
      send: jest.fn((pattern: { cmd: string }, payload: any) => {
        orderCalls.push({ cmd: pattern.cmd, payload });
        if (pattern.cmd === 'order.find_all') {
          return of({ data: payload?.query?.page === 1 ? marketOrders : [] });
        }
        return of({ statusCode: 200, data: {} });
      }),
    };
    const notifications = new FinanceNotificationService(outbox as never);
    const realtime = new FinanceRealtimeService(outbox as never);
    finance = new FinanceServiceService(
      db.getRepository(Cashbox),
      db.getRepository(CashboxHistory),
      db.getRepository(Shift),
      {} as never,
      {} as never,
      {} as never,
      db.getRepository(FinancialBalanceHistory),
      db,
      activityLog as never,
      orderClient as never,
      integrationClient as never,
      identityClient as never,
      outbox as never,
      notifications,
      undefined,
      undefined,
      realtime,
    );
    // Oddiy to'lovning fon ishlari (market sinxroni) bu testda kerak emas.
    jest
      .spyOn(finance as never, 'scheduleMarketPaymentFollowUp')
      .mockResolvedValue(undefined as never);
    const original = finance.scheduleMarketPaymentCorrectionSync.bind(finance);
    jest
      .spyOn(finance, 'scheduleMarketPaymentCorrectionSync')
      .mockImplementation((input) => {
        const promise = original(input);
        syncs.push(promise);
        return promise;
      });
    corrections = new PaymentCorrectionService(
      db,
      finance,
      activityLog as never,
      outbox as never,
      identityClient as never,
      notifications,
      realtime,
    );
    acks = new CourierPaymentAckService(
      db.getRepository(CourierPaymentAck),
      db,
      activityLog as never,
      notifications,
    );
  }, 30_000);

  afterAll(async () => {
    delete process.env.RABBITMQ_GATEWAY_QUEUE;
    delete process.env.FINANCE_REQUIRE_OPEN_SHIFT;
    if (db?.isInitialized) await db.destroy();
    if (admin?.isInitialized) {
      await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await admin.destroy();
    }
  });

  beforeEach(async () => {
    outbox.enqueue.mockClear();
    activityLog.log.mockClear();
    integrationClient.send.mockClear();
    orderCalls.length = 0;
    syncs.length = 0;
    marketOrders = [];
    languages.clear();
    delete process.env.FINANCE_REQUIRE_OPEN_SHIFT;
    await db.query(
      `TRUNCATE TABLE "${schema}".cashbox_history, "${schema}".cashboxes,
        "${schema}".payment_corrections, "${schema}".finance_settings,
        "${schema}".cashbox_cards, "${schema}".shifts,
        "${schema}".courier_payment_acks RESTART IDENTITY CASCADE`,
    );
  });

  // ───────────────────────── yordamchilar ─────────────────────────

  const seed = (
    user_id: string,
    cashbox_type: Cashbox_type,
    cash = 0,
    card = 0,
  ) =>
    db.getRepository(Cashbox).save(
      db.getRepository(Cashbox).create({
        user_id,
        cashbox_type,
        balance: cash + card,
        balance_cash: cash,
        balance_card: card,
      }),
    );

  const box = async (user_id: string, cashbox_type: Cashbox_type) => {
    const cb = await db
      .getRepository(Cashbox)
      .findOneByOrFail({ user_id, cashbox_type });
    return {
      balance: Number(cb.balance),
      cash: Number(cb.balance_cash),
      card: Number(cb.balance_card),
    };
  };

  /** Sotuv oyog'i (order-service outbox shakli) — kuryer / market qarzi. */
  const sale = (user_id: string, cashbox_type: Cashbox_type, amount: number) =>
    finance.updateBalance({
      user_id,
      cashbox_type,
      amount,
      operation_type: Operation_type.INCOME,
      source_type: Source_type.SELL,
      source_id: String(Math.floor(Math.random() * 1e9)),
    });

  const payCourier = async (
    amount: number,
    extra: Record<string, unknown> = {},
  ) => {
    const res = (await finance.paymentsFromCourier({
      courier_id: '301',
      amount,
      payment_method: PaymentMethod.CASH,
      created_by: '5',
      dedup_epoch: `pay-${randomUUID()}`,
      ...extra,
    })) as { data: { transfer_id: string } };
    return res.data.transfer_id;
  };

  const legOf = async (
    transferId: string,
    cashbox_type: Cashbox_type,
    operation_type?: Operation_type,
  ) => {
    const rows = await db.getRepository(CashboxHistory).find({
      where: { transfer_id: transferId },
      relations: ['cashbox'],
    });
    const leg = rows.find(
      (row) =>
        row.cashbox.cashbox_type === cashbox_type &&
        (!operation_type || row.operation_type === operation_type),
    );
    if (!leg) throw new Error(`leg ${cashbox_type} topilmadi`);
    return leg;
  };

  const enqueued = (pattern: string) =>
    outbox.enqueue.mock.calls
      .filter((call: unknown[]) => call[1] === pattern)
      .map((call: unknown[]) => call[2] as Record<string, any>);

  const reverse = (history_id: string, key = randomUUID(), extra = {}) =>
    corrections.reverse({
      history_id,
      reason: "Xato kiritilgan to'lov",
      idempotency_key: key,
      ...SA,
      ...extra,
    }) as Promise<any>;

  const correct = (
    history_id: string,
    new_amount: number,
    key = randomUUID(),
    extra = {},
  ) =>
    corrections.correctAmount({
      history_id,
      new_amount,
      reason: 'Summa noto`g`ri yozilgan',
      idempotency_key: key,
      ...SA,
      ...extra,
    }) as Promise<any>;

  const assertInvariant = async () => {
    for (const cb of await db.getRepository(Cashbox).find()) {
      expect(Number(cb.balance)).toBeCloseTo(
        Number(cb.balance_cash) + Number(cb.balance_card),
        2,
      );
    }
  };

  // ───────────────────────── mezonlar ─────────────────────────

  it('⭐ 1/2: HQ kuryeri naqd 500 000 → qaytarish; teskari qatorlar, audit, retreat, ru xabar', async () => {
    await seed('0', Cashbox_type.MAIN);
    await seed('301', Cashbox_type.FOR_COURIER);
    await sale('301', Cashbox_type.FOR_COURIER, 500_000);
    const tid = await payCourier(500_000);
    expect(await box('301', Cashbox_type.FOR_COURIER)).toMatchObject({
      balance: 0,
    });
    expect(await box('0', Cashbox_type.MAIN)).toMatchObject({ cash: 500_000 });
    const courierLeg = await legOf(tid, Cashbox_type.FOR_COURIER);
    languages.set('301', 'ru');
    outbox.enqueue.mockClear();

    const res = await reverse(String(courierLeg.id));

    expect(res.statusCode).toBe(201);
    expect(res.data.idempotent).toBe(false);
    expect(res.data.correction).toMatchObject({
      action: 'reverse',
      payment_kind: 'courier_payment',
      original_amount: 500_000,
      new_amount: null,
      created_by: '1',
    });
    expect(await box('301', Cashbox_type.FOR_COURIER)).toMatchObject({
      balance: 500_000,
    });
    expect(await box('0', Cashbox_type.MAIN)).toMatchObject({ cash: 0 });
    expect(res.data.cashboxes).toHaveLength(2);

    const reversals = await db.getRepository(CashboxHistory).find({
      where: { source_type: Source_type.PAYMENT_REVERSAL },
      order: { id: 'ASC' },
    });
    expect(reversals).toHaveLength(2);
    for (const row of reversals) {
      expect(row.comment).toBe("Xato kiritilgan to'lov");
      expect(row.reverses_history_id).not.toBeNull();
      expect(row.payment_method).toBe(PaymentMethod.CASH);
      expect(row.source_user_id).toBe('301');
    }
    // Asl qatorlar o'zgarmagan.
    const originals = await db
      .getRepository(CashboxHistory)
      .find({ where: { transfer_id: tid } });
    expect(originals).toHaveLength(2);

    expect(enqueued('order.settlement.retreat')).toEqual([
      expect.objectContaining({
        level: 'courier_to_branch',
        match_value: '301',
        amount: 500_000,
        request_id: `pc:${res.data.correction.id}:courier_to_branch`,
      }),
    ]);
    expect(enqueued('order.settlement.advance')).toHaveLength(0);
    const notes = enqueued('notification.dispatch');
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({
      type: 'finance.payment_corrected',
      recipient_ids: ['301'],
      title: 'Платёж отменён',
      priority: 'high',
    });
    expect(notes[0].body).toContain('500 000 сум');
    expect(notes[0].body).toContain('0 сум → 500 000 сум');
    expect(notes[0].body).not.toContain('Xato');
    expect(notes[0].channels).toEqual(['in_app', 'realtime', 'telegram']);
    const rt = enqueued('realtime.notify');
    expect(rt[0]).toMatchObject({
      event: 'finance.payment.corrected',
      targets: expect.arrayContaining([
        { role: 'superadmin' },
        { user_id: '301' },
      ]),
    });
    expect(JSON.stringify(rt[0].payload)).not.toContain('500000');
    expect(activityLog.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'finance.payment_reversed',
        metadata: expect.objectContaining({
          original_amount: 500_000,
          reason: "Xato kiritilgan to'lov",
          partner_notified: false,
        }),
      }),
    );
    await assertInvariant();
  });

  it('⭐ 3: tahrir 500 000 → 50 000: kuryer sof +450 000, MAIN sof −450 000; correction maydonlari', async () => {
    await seed('0', Cashbox_type.MAIN);
    await seed('301', Cashbox_type.FOR_COURIER);
    await sale('301', Cashbox_type.FOR_COURIER, 500_000);
    const tid = await payCourier(500_000);
    const mainLeg = await legOf(tid, Cashbox_type.MAIN);
    outbox.enqueue.mockClear();

    const res = await correct(String(mainLeg.id), 50_000);

    expect(res.statusCode).toBe(201);
    expect(await box('301', Cashbox_type.FOR_COURIER)).toMatchObject({
      balance: 450_000,
    });
    expect(await box('0', Cashbox_type.MAIN)).toMatchObject({ cash: 50_000 });
    // Daftar: avval orqaga, keyin yangi summa bilan oldinga.
    const patterns = outbox.enqueue.mock.calls
      .map((call: unknown[]) => call[1])
      .filter((p: unknown) => String(p).startsWith('order.settlement'));
    expect(patterns).toEqual([
      'order.settlement.retreat',
      'order.settlement.advance',
    ]);
    expect(enqueued('order.settlement.advance')[0]).toMatchObject({
      amount: 50_000,
      request_id: `pc:${res.data.correction.id}`,
    });
    // `finance.payment_received` YO'Q, faqat tuzatish xabari.
    const notes = enqueued('notification.dispatch');
    expect(notes.map((n) => n.type)).toEqual(['finance.payment_corrected']);
    expect(notes[0].title).toBe("To'lov summasi tuzatildi");
    expect(notes[0].body).toContain("500 000 so'm → 50 000 so'm");

    const list = (await finance.findAllHistory({
      cashbox_type: Cashbox_type.FOR_COURIER,
      page: 1,
      limit: 50,
    })) as any;
    const items = list.data.items as any[];
    const roles = items
      .filter((row) => row.source_type !== Source_type.SELL)
      .map((row) => row.correction?.role)
      .sort();
    expect(roles).toEqual(['original', 'replacement', 'reversal']);
    const reversalRow = items.find(
      (row) => row.correction?.role === 'reversal',
    );
    expect(reversalRow.correction).toMatchObject({
      action: 'edit',
      original_amount: 500_000,
      new_amount: 50_000,
      created_by_name: 'Bosh admin',
      related_history_id: String(
        (await legOf(tid, Cashbox_type.FOR_COURIER)).id,
      ),
    });
    // Teskari qator kontragenti — asl oyoqniki (frontda ism).
    expect(reversalRow.source_user).toMatchObject({ id: '301' });
    expect(reversalRow.reverses_history_id).toBe(
      reversalRow.correction.related_history_id,
    );
    expect(
      items.find((r) => r.source_type === Source_type.SELL).correction,
    ).toBeNull();
    await assertInvariant();
  });

  it('4: BRANCH — filial kassasi −X; kuryer va filial boshlig`i xabar oladi', async () => {
    await seed('15', Cashbox_type.BRANCH, 0, 0);
    await seed('301', Cashbox_type.FOR_COURIER);
    await sale('301', Cashbox_type.FOR_COURIER, 200_000);
    const tid = await payCourier(200_000, {
      receiver_user_id: '15',
      receiver_cashbox_type: Cashbox_type.BRANCH,
      payment_method: PaymentMethod.CLICK,
    });
    expect(await box('15', Cashbox_type.BRANCH)).toMatchObject({
      card: 200_000,
    });
    const leg = await legOf(tid, Cashbox_type.FOR_COURIER);
    outbox.enqueue.mockClear();

    const res = await reverse(String(leg.id), randomUUID(), {
      notify_user_ids: ['77'],
    });

    expect(res.statusCode).toBe(201);
    expect(await box('15', Cashbox_type.BRANCH)).toMatchObject({ card: 0 });
    expect(enqueued('order.settlement.retreat')).toEqual([
      expect.objectContaining({
        level: 'courier_to_branch',
        receiver_cashbox_type: 'branch',
        receiver_branch_id: '15',
      }),
    ]);
    expect(await box('301', Cashbox_type.FOR_COURIER)).toMatchObject({
      balance: 200_000,
    });
    const recipients = enqueued('notification.dispatch').map(
      (n) => n.recipient_ids[0],
    );
    expect(recipients.sort()).toEqual(['301', '77']);
    expect(enqueued('realtime.notify')[0].targets).toEqual(
      expect.arrayContaining([{ role: 'manager', branch_id: '15' }]),
    );
  });

  it('⭐ 5: click_to_market — kuryer +X, market +X, MAIN sof 0; market xabar oladi', async () => {
    await seed('0', Cashbox_type.MAIN);
    await seed('301', Cashbox_type.FOR_COURIER);
    await seed('501', Cashbox_type.FOR_MARKET);
    await sale('301', Cashbox_type.FOR_COURIER, 300_000);
    await sale('501', Cashbox_type.FOR_MARKET, 300_000);
    const tid = await payCourier(120_000, {
      payment_method: PaymentMethod.CLICK_TO_MARKET,
      market_id: '501',
    });
    const before = await box('0', Cashbox_type.MAIN);
    const leg = await legOf(tid, Cashbox_type.FOR_MARKET);
    outbox.enqueue.mockClear();

    const res = await reverse(String(leg.id));

    expect(res.statusCode).toBe(201);
    expect(await box('301', Cashbox_type.FOR_COURIER)).toMatchObject({
      balance: 300_000,
    });
    expect(await box('501', Cashbox_type.FOR_MARKET)).toMatchObject({
      balance: 300_000,
    });
    expect(await box('0', Cashbox_type.MAIN)).toEqual(before);
    expect(
      await db
        .getRepository(CashboxHistory)
        .count({ where: { source_type: Source_type.PAYMENT_REVERSAL } }),
    ).toBe(4);
    // Tartib: avval market bo'g'ini, keyin kuryer (outbox ketma-ket).
    expect(enqueued('order.settlement.retreat')).toEqual([
      expect.objectContaining({
        level: 'hq_to_market',
        match_value: '501',
        receiver_cashbox_type: 'main',
        receiver_branch_id: null,
      }),
      expect.objectContaining({
        level: 'courier_to_branch',
        match_value: '301',
        receiver_cashbox_type: 'main',
        receiver_branch_id: null,
      }),
    ]);
    expect(
      enqueued('notification.dispatch')
        .map((n) => n.recipient_ids[0])
        .sort(),
    ).toEqual(['301', '501']);
    expect(syncs).toHaveLength(1);
    await assertInvariant();
  });

  it('⭐ 6: marketga to`lov → MAIN +X, market +X; oxirgi PAID buyurtmalar PARTLY_PAID/SOLD', async () => {
    await seed('0', Cashbox_type.MAIN, 1_000_000);
    await seed('501', Cashbox_type.FOR_MARKET);
    await sale('501', Cashbox_type.FOR_MARKET, 700_000);
    const res0 = (await finance.paymentsToMarket({
      market_id: '501',
      amount: 300_000,
      payment_method: PaymentMethod.CASH,
      created_by: '5',
      dedup_epoch: 'mp-1',
    })) as any;
    const tid = res0.data.transfer_id as string;
    const leg = await legOf(tid, Cashbox_type.MAIN);
    marketOrders = [
      // eng yangisi birinchi (sort_dir: desc)
      {
        id: '903',
        status: 'paid',
        to_be_paid: 120_000,
        paid_amount: 120_000,
        extra_cost: 20_000,
      },
      {
        id: '902',
        status: 'paid',
        to_be_paid: 150_000,
        paid_amount: 150_000,
        extra_cost: 0,
      },
      {
        id: '901',
        status: 'paid',
        to_be_paid: 200_000,
        paid_amount: 200_000,
        extra_cost: 0,
      },
    ];

    const res = await reverse(String(leg.id));
    await Promise.all(syncs);

    expect(res.statusCode).toBe(201);
    expect(await box('0', Cashbox_type.MAIN)).toMatchObject({
      cash: 1_000_000,
    });
    expect(await box('501', Cashbox_type.FOR_MARKET)).toMatchObject({
      balance: 700_000,
    });
    const findAll = orderCalls.find((c) => c.cmd === 'order.find_all');
    expect(findAll?.payload.query).toMatchObject({
      market_id: '501',
      status: ['paid', 'partly_paid'],
      sort_dir: 'desc',
    });
    expect(
      orderCalls
        .filter((c) => c.cmd === 'order.payment_reversal.apply')
        .map((c) => c.payload),
    ).toEqual([
      expect.objectContaining({
        order_id: '903',
        paid_amount: 0,
        status: 'sold',
      }),
      expect.objectContaining({
        order_id: '902',
        paid_amount: 0,
        status: 'sold',
      }),
      expect.objectContaining({
        order_id: '901',
        paid_amount: 150_000,
        status: 'partly_paid',
      }),
    ]);
    expect(partnerCalls()).toEqual([]);
    expect(enqueued('order.settlement.retreat')[0]).toMatchObject({
      level: 'hq_to_market',
      match_value: '501',
    });
  });

  it('⭐ 7/13: muddat 7 kun, to`lov 8 kunlik → correctable false, 409 WINDOW_EXPIRED + deadline; sozlama', async () => {
    expect(((await corrections.getSettings()) as any).data.window_days).toBe(
      30,
    );
    await expect(
      corrections.updateSettings({ window_days: 0, ...SA }),
    ).rejects.toMatchObject({ error: { statusCode: 400 } });
    await expect(
      corrections.updateSettings({ window_days: 400, ...SA }),
    ).rejects.toMatchObject({ error: { statusCode: 400 } });
    await expect(
      corrections.updateSettings({ window_days: 7.5, ...SA }),
    ).rejects.toMatchObject({ error: { statusCode: 400 } });
    await expect(
      corrections.updateSettings({
        window_days: 10,
        requester_id: '2',
        requester_roles: ['admin'],
      }),
    ).rejects.toMatchObject({ error: { statusCode: 403 } });
    await corrections.updateSettings({ window_days: 10, ...SA });
    expect((await corrections.getSettings()) as any).toMatchObject({
      data: { window_days: 10, updated_by: '1' },
    });
    expect(activityLog.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'finance.payment_correction_settings_updated',
      }),
    );
    await corrections.updateSettings({ window_days: 7, ...SA });

    await seed('0', Cashbox_type.MAIN);
    await seed('301', Cashbox_type.FOR_COURIER);
    await sale('301', Cashbox_type.FOR_COURIER, 100_000);
    const tid = await payCourier(100_000);
    await db.query(
      `UPDATE "${schema}".cashbox_history SET "createdAt" = now() - interval '8 days' WHERE transfer_id = $1`,
      [tid],
    );
    const leg = await legOf(tid, Cashbox_type.FOR_COURIER);
    const detail = (await finance.findHistoryById(String(leg.id), {
      include_correctable: true,
    })) as any;
    expect(detail.data.correctable).toMatchObject({
      allowed: false,
      code: 'WINDOW_EXPIRED',
      window_days: 7,
    });
    const err = await reverse(String(leg.id)).catch((e) => e.getError());
    expect(err).toMatchObject({
      statusCode: 409,
      code: 'WINDOW_EXPIRED',
      deadline: detail.data.correctable.deadline,
    });
    expect(await box('301', Cashbox_type.FOR_COURIER)).toMatchObject({
      balance: 0,
    });
    // Muddat kengaysa — darhol ruxsat.
    await corrections.updateSettings({ window_days: 30, ...SA });
    const ok = (await finance.findHistoryById(String(leg.id), {
      include_correctable: true,
    })) as any;
    expect(ok.data.correctable).toMatchObject({ allowed: true });
    expect(ok.data.correctable.code).toBeUndefined();
  });

  it('⭐ 8: takror → 409 ALREADY_CORRECTED; o`sha kalit → 200 idempotent, pul bir marta; boshqa so`rov → 409; admin → 403', async () => {
    await seed('0', Cashbox_type.MAIN);
    await seed('301', Cashbox_type.FOR_COURIER);
    await sale('301', Cashbox_type.FOR_COURIER, 500_000);
    const tid = await payCourier(500_000);
    const leg = await legOf(tid, Cashbox_type.FOR_COURIER);
    const key = randomUUID();

    await expect(
      corrections.reverse({
        history_id: String(leg.id),
        reason: 'Xato kiritildi',
        idempotency_key: key,
        requester_id: '2',
        requester_roles: ['admin'],
      }),
    ).rejects.toMatchObject({ error: { statusCode: 403 } });

    // Parallel: ikki superadmin, ikki xil kalit — bittasi o'tadi.
    const [a, b] = await Promise.allSettled([
      reverse(String(leg.id), key),
      reverse(String(leg.id)),
    ]);
    const ok = [a, b].filter((r) => r.status === 'fulfilled');
    const bad = [a, b].filter(
      (r): r is PromiseRejectedResult => r.status === 'rejected',
    );
    expect(ok).toHaveLength(1);
    expect(bad).toHaveLength(1);
    expect(bad[0].reason.getError()).toMatchObject({
      statusCode: 409,
      code: 'ALREADY_CORRECTED',
    });
    expect(await box('301', Cashbox_type.FOR_COURIER)).toMatchObject({
      balance: 500_000,
    });
    // O'sha kalit bilan qayta (agar birinchisi `key` bilan o'tgan bo'lsa).
    const winnerKey =
      a.status === 'fulfilled'
        ? key
        : (
            await db
              .getRepository(PaymentCorrection)
              .findOneByOrFail({ original_transfer_id: tid })
          ).idempotency_key;
    const replay = await reverse(String(leg.id), winnerKey);
    expect(replay.statusCode).toBe(200);
    expect(replay.data.idempotent).toBe(true);
    expect(await box('301', Cashbox_type.FOR_COURIER)).toMatchObject({
      balance: 500_000,
    });
    // O'sha kalit, boshqa sabab — 409.
    const reused = await reverse(String(leg.id), winnerKey, {
      reason: 'Boshqa sabab matni',
    }).catch((e) => e.getError());
    expect(reused).toMatchObject({
      statusCode: 409,
      code: 'IDEMPOTENCY_KEY_REUSED',
    });
    // Teskari qatorning o'zi — NOT_CORRECTABLE.
    const reversal = await db.getRepository(CashboxHistory).findOneByOrFail({
      source_type: Source_type.PAYMENT_REVERSAL,
      cashbox_id: leg.cashbox_id,
    });
    expect(
      await reverse(String(reversal.id)).catch((e) => e.getError()),
    ).toMatchObject({ statusCode: 409, code: 'NOT_CORRECTABLE' });
  });

  it('⭐ 9: smena yopiq → 400 SHIFT_REQUIRED; MAIN naqdi yetmaydi → 409, balans o`zgarmagan; tahrir > max → AMOUNT_EXCEEDS', async () => {
    await seed('0', Cashbox_type.MAIN);
    await seed('301', Cashbox_type.FOR_COURIER);
    await sale('301', Cashbox_type.FOR_COURIER, 500_000);
    const tid = await payCourier(500_000);
    const leg = await legOf(tid, Cashbox_type.FOR_COURIER);

    process.env.FINANCE_REQUIRE_OPEN_SHIFT = 'main';
    expect(
      await reverse(String(leg.id)).catch((e) => e.getError()),
    ).toMatchObject({
      statusCode: 400,
      code: 'SHIFT_REQUIRED',
    });
    await db.getRepository(Shift).save(
      db.getRepository(Shift).create({
        cashbox_user_id: '0',
        opened_by: '1',
        opened_at: new Date(),
        status: ShiftStatus.OPEN,
      } as never),
    );

    // Pul HQ'dan chiqib ketgan (qo'lda chiqim) — qaytarishga yetmaydi.
    await db.query(
      `UPDATE "${schema}".cashboxes SET balance_cash = 100000, balance = 100000 WHERE user_id = '0'`,
    );
    expect(
      await reverse(String(leg.id)).catch((e) => e.getError()),
    ).toMatchObject({
      statusCode: 409,
      code: 'INSUFFICIENT_BALANCE',
    });
    expect(await box('0', Cashbox_type.MAIN)).toMatchObject({ cash: 100_000 });
    expect(await box('301', Cashbox_type.FOR_COURIER)).toMatchObject({
      balance: 0,
    });
    expect(await db.getRepository(PaymentCorrection).count()).toBe(0);
    await db.query(
      `UPDATE "${schema}".cashboxes SET balance_cash = 500000, balance = 500000 WHERE user_id = '0'`,
    );

    expect(
      await correct(String(leg.id), 500_000).catch((e) => e.getError()),
    ).toMatchObject({ statusCode: 409, code: 'SAME_AMOUNT' });
    // max = kuryer qoldig'i (0) + 500 000.
    expect(
      await correct(String(leg.id), 600_000).catch((e) => e.getError()),
    ).toMatchObject({ statusCode: 409, code: 'AMOUNT_EXCEEDS', max: 500_000 });
    // 10: sabab < 5 belgi.
    await expect(
      reverse(String(leg.id), randomUUID(), { reason: 'abc' }),
    ).rejects.toMatchObject({ error: { statusCode: 400 } });
    await expect(reverse(String(leg.id), '')).rejects.toMatchObject({
      error: { statusCode: 400, code: 'IDEMPOTENCY_KEY_REQUIRED' },
    });
  });

  it('karta: nomli kartaga tushgan CLICK — qaytarishda karta qoldig`i kamayadi; arxivda → CARD_ARCHIVED; yetmasa → INSUFFICIENT_BALANCE', async () => {
    const main = await seed('0', Cashbox_type.MAIN);
    await seed('301', Cashbox_type.FOR_COURIER);
    await sale('301', Cashbox_type.FOR_COURIER, 300_000);
    const card = await db.getRepository(CashboxCard).save(
      db.getRepository(CashboxCard).create({
        cashbox_id: String(main.id),
        name: 'Uzcard 1',
        balance: 0,
        is_default: false,
        is_active: true,
        sort_order: 1,
      }),
    );
    const t1 = await payCourier(100_000, {
      payment_method: PaymentMethod.CLICK,
      card_id: String(card.id),
    });
    const t2 = await payCourier(100_000, {
      payment_method: PaymentMethod.CLICK,
      card_id: String(card.id),
    });
    const cardBalance = async () =>
      Number(
        (await db.getRepository(CashboxCard).findOneByOrFail({ id: card.id }))
          .balance,
      );
    expect(await cardBalance()).toBe(200_000);

    await reverse(String((await legOf(t1, Cashbox_type.MAIN)).id));
    expect(await cardBalance()).toBe(100_000);
    expect(await box('0', Cashbox_type.MAIN)).toMatchObject({ card: 100_000 });

    await db
      .getRepository(CashboxCard)
      .update({ id: card.id }, { is_active: false });
    const leg2 = await legOf(t2, Cashbox_type.MAIN);
    expect(
      await reverse(String(leg2.id)).catch((e) => e.getError()),
    ).toMatchObject({
      statusCode: 409,
      code: 'CARD_ARCHIVED',
    });
    await db
      .getRepository(CashboxCard)
      .update({ id: card.id }, { is_active: true, balance: 40_000 });
    expect(
      await reverse(String(leg2.id)).catch((e) => e.getError()),
    ).toMatchObject({
      statusCode: 409,
      code: 'INSUFFICIENT_BALANCE',
    });
    expect(await box('0', Cashbox_type.MAIN)).toMatchObject({ card: 100_000 });
  });

  it('smena hisoboti: qaytarilgan kuryer topshirig`i jamidan ayiriladi, market to`lovi «qaytarildi» qatori', async () => {
    await seed('0', Cashbox_type.MAIN, 1_000_000);
    await seed('301', Cashbox_type.FOR_COURIER);
    await seed('501', Cashbox_type.FOR_MARKET);
    await sale('301', Cashbox_type.FOR_COURIER, 700_000);
    await sale('501', Cashbox_type.FOR_MARKET, 900_000);
    const shift = await db.getRepository(Shift).save(
      db.getRepository(Shift).create({
        cashbox_user_id: '0',
        opened_by: '1',
        opened_at: new Date(Date.now() - 60_000),
        status: ShiftStatus.OPEN,
      } as never),
    );
    const t1 = await payCourier(500_000);
    await payCourier(200_000);
    const mp = (await finance.paymentsToMarket({
      market_id: '501',
      amount: 300_000,
      payment_method: PaymentMethod.CASH,
      created_by: '5',
      dedup_epoch: 'mp-shift',
    })) as any;
    await reverse(String((await legOf(t1, Cashbox_type.FOR_COURIER)).id));
    await reverse(
      String((await legOf(mp.data.transfer_id, Cashbox_type.MAIN)).id),
    );
    shift.closed_at = new Date(Date.now() + 1_000);
    const reports = new ShiftReportService(
      db,
      activityLog as never,
      { listForShift: jest.fn().mockResolvedValue([]) } as never,
      {} as never,
      { send: jest.fn(() => of({ data: [] })) } as never,
    );
    const snapshot = await reports.buildSnapshot(shift, 1);
    expect(snapshot.couriers).toEqual([
      expect.objectContaining({
        courier_id: '301',
        // Qaytarilgani sanalmaydi; yalpi 700 000, qaytarilgan 500 000, sof 200 000.
        count: 1,
        received: 700_000,
        total: 200_000,
        reversed: 500_000,
      }),
    ]);
    expect(snapshot.markets[0].total).toBe(0);
    expect(
      snapshot.markets[0].payments.map((p) => [p.amount, !!p.reversed]),
    ).toEqual([
      [300_000, false],
      [-300_000, true],
    ]);
  });

  it('smena hisoboti: S1 dagi to`lov S2 da qaytarilsa — S1 qayta yuborilganda count 1, total yalpi', async () => {
    await seed('0', Cashbox_type.MAIN);
    await seed('301', Cashbox_type.FOR_COURIER);
    await sale('301', Cashbox_type.FOR_COURIER, 500_000);
    const s1 = await db.getRepository(Shift).save(
      db.getRepository(Shift).create({
        cashbox_user_id: '0',
        opened_by: '1',
        opened_at: new Date(Date.now() - 60_000),
        status: ShiftStatus.OPEN,
      } as never),
    );
    const tid = await payCourier(500_000);
    s1.closed_at = new Date();
    await new Promise((resolve) => setTimeout(resolve, 20));
    await reverse(String((await legOf(tid, Cashbox_type.FOR_COURIER)).id));
    const reports = new ShiftReportService(
      db,
      activityLog as never,
      { listForShift: jest.fn().mockResolvedValue([]) } as never,
      {} as never,
      { send: jest.fn(() => of({ data: [] })) } as never,
    );
    const snapshot = await reports.buildSnapshot(s1, 2);
    expect(snapshot.couriers).toEqual([
      expect.objectContaining({ courier_id: '301', count: 1, total: 500_000 }),
    ]);
    expect(snapshot.couriers[0].reversed).toBeUndefined();
  });

  it('G: marketga to`lov TAHRIRI — buyurtma sinxroni hamkorga holat yubormaydi (suppress_external_sync)', async () => {
    await seed('0', Cashbox_type.MAIN, 1_000_000);
    await seed('501', Cashbox_type.FOR_MARKET);
    await sale('501', Cashbox_type.FOR_MARKET, 700_000);
    const res0 = (await finance.paymentsToMarket({
      market_id: '501',
      amount: 300_000,
      payment_method: PaymentMethod.CASH,
      created_by: '5',
      dedup_epoch: 'mp-g',
    })) as { data: { transfer_id: string } };
    marketOrders = [
      {
        id: '911',
        status: 'paid',
        to_be_paid: 300_000,
        paid_amount: 300_000,
        extra_cost: 0,
      },
    ];
    const leg = await legOf(res0.data.transfer_id, Cashbox_type.MAIN);
    await correct(String(leg.id), 200_000);
    await Promise.all(syncs);
    const writes = orderCalls.filter(
      (c) => c.cmd === 'order.update_normalized',
    );
    expect(writes.length).toBeGreaterThan(0);
    for (const call of writes) {
      expect(call.payload).toMatchObject({ suppress_external_sync: true });
    }
    expect(partnerCalls()).toEqual([]);
    // Ijobiy nazorat: hamkor xabari haqiqatan shu client orqali ketadi.
    await (
      finance as unknown as {
        emitSettlementPaymentSafely: (
          i: Record<string, unknown>,
        ) => Promise<void>;
      }
    ).emitSettlementPaymentSafely({ market_id: '501', amount: 1 });
    expect(partnerCalls()).toHaveLength(1);
    expect(await box('0', Cashbox_type.MAIN)).toMatchObject({ cash: 800_000 });
  });

  it('⭐ 11: qaytarilgan to`lov kvitansiyasida «Tasdiqlayman» → 409 PAYMENT_CORRECTED', async () => {
    await seed('0', Cashbox_type.MAIN);
    await seed('301', Cashbox_type.FOR_COURIER);
    await sale('301', Cashbox_type.FOR_COURIER, 90_000);
    const tid = await payCourier(90_000);
    const leg = await legOf(tid, Cashbox_type.FOR_COURIER);
    await reverse(String(leg.id));
    await expect(
      acks.ack({
        payment_id: String(leg.id),
        courier_id: '301',
        ack: 'confirmed',
      }),
    ).rejects.toMatchObject({
      error: { statusCode: 409, code: 'PAYMENT_CORRECTED' },
    });
  });

  it('14: transfer_id NULL → 409 LEGACY_UNLINKED; zanjir: tahrirdan keyingi to`lov yana tuzatiladi (muddat birinchisidan)', async () => {
    await seed('0', Cashbox_type.MAIN);
    await seed('301', Cashbox_type.FOR_COURIER);
    await sale('301', Cashbox_type.FOR_COURIER, 400_000);
    const tid = await payCourier(400_000);
    const leg = await legOf(tid, Cashbox_type.FOR_COURIER);
    const edited = await correct(String(leg.id), 300_000);
    const replacement = await db
      .getRepository(PaymentCorrection)
      .findOneByOrFail({
        id: edited.data.correction.id,
      });
    const newLeg = await legOf(
      String(replacement.replacement_transfer_id),
      Cashbox_type.FOR_COURIER,
    );
    const again = await correct(String(newLeg.id), 250_000);
    expect(again.statusCode).toBe(201);
    const second = await db.getRepository(PaymentCorrection).findOneByOrFail({
      id: again.data.correction.id,
    });
    expect(second.root_transfer_id).toBe(tid);
    expect(new Date(second.root_created_at).getTime()).toBe(
      new Date(replacement.root_created_at).getTime(),
    );
    expect(await box('301', Cashbox_type.FOR_COURIER)).toMatchObject({
      balance: 150_000,
    });
    expect(await box('0', Cashbox_type.MAIN)).toMatchObject({ cash: 250_000 });

    await db.query(
      `UPDATE "${schema}".cashbox_history SET transfer_id = NULL WHERE transfer_id = $1`,
      [String(second.replacement_transfer_id)],
    );
    const last = await db.getRepository(CashboxHistory).findOneOrFail({
      where: {
        source_type: Source_type.COURIER_PAYMENT,
        cashbox_id: leg.cashbox_id,
      },
      order: { id: 'DESC' },
    });
    expect(
      await reverse(String(last.id)).catch((e) => e.getError()),
    ).toMatchObject({
      statusCode: 409,
      code: 'LEGACY_UNLINKED',
    });
    expect(await reverse('999999').catch((e) => e.getError())).toMatchObject({
      statusCode: 404,
      code: 'NOT_FOUND',
    });
    await assertInvariant();
  });

  // ───────────────── iPlY5yop: karta 4–6-bandlari ─────────────────

  const detailOf = async (id: unknown) =>
    (
      (await finance.findHistoryById(String(id), {
        include_correctable: true,
      })) as any
    ).data;

  it('iPlY5yop #4: INSUFFICIENT_BALANCE + required (kassa, nomli karta); NOT_CORRECTABLE + reason; WINDOW_EXPIRED + window_days', async () => {
    const main = await seed('0', Cashbox_type.MAIN);
    await seed('301', Cashbox_type.FOR_COURIER);
    await sale('301', Cashbox_type.FOR_COURIER, 700_000);
    const tid = await payCourier(500_000);
    const leg = await legOf(tid, Cashbox_type.FOR_COURIER);

    await db.query(
      `UPDATE "${schema}".cashboxes SET balance_cash = 100000, balance = 100000 WHERE user_id = '0'`,
    );
    expect(
      await reverse(String(leg.id)).catch((e) => e.getError()),
    ).toMatchObject({ code: 'INSUFFICIENT_BALANCE', required: 500_000 });
    // Tahrirda ham: avval X chiqadi, keyin yangi summa kiradi.
    expect(
      await correct(String(leg.id), 300_000).catch((e) => e.getError()),
    ).toMatchObject({ code: 'INSUFFICIENT_BALANCE', required: 500_000 });
    await db.query(
      `UPDATE "${schema}".cashboxes SET balance_cash = 500000, balance = 500000 WHERE user_id = '0'`,
    );

    // Nomli karta qoldig'i yetmaydi.
    const card = await db.getRepository(CashboxCard).save(
      db.getRepository(CashboxCard).create({
        cashbox_id: String(main.id),
        name: 'Uzcard 1',
        balance: 0,
        is_default: false,
        is_active: true,
        sort_order: 1,
      }),
    );
    const onCard = await payCourier(100_000, {
      payment_method: PaymentMethod.CLICK,
      card_id: String(card.id),
    });
    await db
      .getRepository(CashboxCard)
      .update({ id: card.id }, { balance: 40_000 });
    expect(
      await reverse(String((await legOf(onCard, Cashbox_type.MAIN)).id)).catch(
        (e) => e.getError(),
      ),
    ).toMatchObject({ code: 'INSUFFICIENT_BALANCE', required: 100_000 });

    // Sabab: tur qamrovda emas / teskari qator / kassa o'chirilgan.
    const sell = await db.getRepository(CashboxHistory).findOneByOrFail({
      source_type: Source_type.SELL,
    });
    expect(
      await reverse(String(sell.id)).catch((e) => e.getError()),
    ).toMatchObject({ code: 'NOT_CORRECTABLE', reason: 'unsupported_type' });

    await reverse(String(leg.id));
    const reversalRow = await db.getRepository(CashboxHistory).findOneByOrFail({
      reverses_history_id: String(leg.id),
    });
    expect(
      await reverse(String(reversalRow.id)).catch((e) => e.getError()),
    ).toMatchObject({ code: 'NOT_CORRECTABLE', reason: 'reversal_row' });

    const third = await payCourier(50_000);
    await db.query(
      `UPDATE "${schema}".cashboxes SET is_deleted = true WHERE user_id = '301'`,
    );
    const moved = await legOf(third, Cashbox_type.MAIN);
    expect(
      await reverse(String(moved.id)).catch((e) => e.getError()),
    ).toMatchObject({ code: 'NOT_CORRECTABLE', reason: 'cashbox_deleted' });
    await db.query(
      `UPDATE "${schema}".cashboxes SET is_deleted = false WHERE user_id = '301'`,
    );

    await corrections.updateSettings({ window_days: 7, ...SA });
    await db.query(
      `UPDATE "${schema}".cashbox_history SET "createdAt" = now() - interval '8 days' WHERE transfer_id = $1`,
      [third],
    );
    expect(
      await reverse(String(moved.id)).catch((e) => e.getError()),
    ).toMatchObject({
      code: 'WINDOW_EXPIRED',
      window_days: 7,
      deadline: expect.any(String),
    });
  });

  it('iPlY5yop #5: correction — payment_kind va related (asl → yangi/teskari; teskari/yangi → asl)', async () => {
    await seed('0', Cashbox_type.MAIN);
    await seed('301', Cashbox_type.FOR_COURIER);
    await sale('301', Cashbox_type.FOR_COURIER, 500_000);
    const tid = await payCourier(500_000);
    const original = await legOf(tid, Cashbox_type.MAIN);
    const edited = await correct(String(original.id), 200_000);
    const journal = await db.getRepository(PaymentCorrection).findOneByOrFail({
      id: edited.data.correction.id,
    });
    const replacement = await legOf(
      String(journal.replacement_transfer_id),
      Cashbox_type.MAIN,
    );
    const reversal = await db.getRepository(CashboxHistory).findOneByOrFail({
      reverses_history_id: String(original.id),
    });

    expect((await detailOf(original.id)).correction).toMatchObject({
      role: 'original',
      payment_kind: 'courier_payment',
      related_history_id: String(reversal.id),
      related: {
        id: String(replacement.id),
        role: 'replacement',
        source_type: Source_type.COURIER_PAYMENT,
        operation_type: Operation_type.INCOME,
        amount: 200_000,
        created_at: expect.anything(),
      },
    });
    expect((await detailOf(reversal.id)).correction.related).toMatchObject({
      id: String(original.id),
      role: 'original',
      operation_type: Operation_type.INCOME,
      amount: 500_000,
    });
    expect((await detailOf(replacement.id)).correction.related).toMatchObject({
      id: String(original.id),
      role: 'original',
    });

    // Sof qaytarish: asl → teskari qator.
    await sale('301', Cashbox_type.FOR_COURIER, 100_000);
    const second = await payCourier(100_000);
    const secondLeg = await legOf(second, Cashbox_type.FOR_COURIER);
    await reverse(String(secondLeg.id));
    const secondReversal = await db
      .getRepository(CashboxHistory)
      .findOneByOrFail({ reverses_history_id: String(secondLeg.id) });
    expect((await detailOf(secondLeg.id)).correction.related).toMatchObject({
      id: String(secondReversal.id),
      role: 'reversal',
      source_type: Source_type.PAYMENT_REVERSAL,
      operation_type: Operation_type.INCOME,
    });
  });

  it('iPlY5yop #5: click_to_market — MAIN dagi ikki oyoq o`z juftini oladi', async () => {
    await seed('0', Cashbox_type.MAIN);
    await seed('301', Cashbox_type.FOR_COURIER);
    await seed('401', Cashbox_type.FOR_MARKET);
    await sale('301', Cashbox_type.FOR_COURIER, 300_000);
    await sale('401', Cashbox_type.FOR_MARKET, 300_000);
    const tid = await payCourier(300_000, {
      payment_method: PaymentMethod.CLICK_TO_MARKET,
      market_id: '401',
    });
    const income = await legOf(tid, Cashbox_type.MAIN, Operation_type.INCOME);
    const expense = await legOf(tid, Cashbox_type.MAIN, Operation_type.EXPENSE);
    await correct(String(income.id), 100_000);
    expect((await detailOf(income.id)).correction.related).toMatchObject({
      role: 'replacement',
      source_type: Source_type.COURIER_PAYMENT,
      operation_type: Operation_type.INCOME,
    });
    expect((await detailOf(expense.id)).correction.related).toMatchObject({
      role: 'replacement',
      source_type: Source_type.MARKET_PAYMENT,
      operation_type: Operation_type.EXPENSE,
    });
  });

  it('iPlY5yop #6: correctable — reason, root_history_id; qamrovdan tashqari tur → null', async () => {
    await seed('0', Cashbox_type.MAIN);
    await seed('301', Cashbox_type.FOR_COURIER);
    await sale('301', Cashbox_type.FOR_COURIER, 500_000);
    const tid = await payCourier(400_000);
    const leg = await legOf(tid, Cashbox_type.FOR_COURIER);

    expect((await detailOf(leg.id)).correctable).toMatchObject({
      allowed: true,
      root_history_id: String(leg.id),
    });

    // Zanjir: yangi oyoqda root — birinchi to'lovning shu kassadagi oyog'i.
    const edited = await correct(String(leg.id), 300_000);
    const journal = await db.getRepository(PaymentCorrection).findOneByOrFail({
      id: edited.data.correction.id,
    });
    const next = await legOf(
      String(journal.replacement_transfer_id),
      Cashbox_type.FOR_COURIER,
    );
    expect((await detailOf(next.id)).correctable).toMatchObject({
      allowed: true,
      root_history_id: String(leg.id),
    });
    expect((await detailOf(leg.id)).correctable).toMatchObject({
      allowed: false,
      code: 'ALREADY_CORRECTED',
      root_history_id: String(leg.id),
    });

    const reversal = await db.getRepository(CashboxHistory).findOneByOrFail({
      reverses_history_id: String(leg.id),
    });
    const reversalBlock = (await detailOf(reversal.id)).correctable;
    expect(reversalBlock).toMatchObject({
      allowed: false,
      code: 'NOT_CORRECTABLE',
      reason: 'reversal_row',
      root_history_id: String(leg.id),
    });

    // Qamrovdan tashqari tur — kalit bor, qiymat null.
    const sell = await db.getRepository(CashboxHistory).findOneByOrFail({
      source_type: Source_type.SELL,
    });
    const detail = await detailOf(sell.id);
    expect(detail).toHaveProperty('correctable', null);

    // Eski yozuv: zanjir yo'q.
    await db.query(
      `UPDATE "${schema}".cashbox_history SET transfer_id = NULL WHERE id = $1`,
      [String(next.id)],
    );
    expect((await detailOf(next.id)).correctable).toMatchObject({
      allowed: false,
      code: 'LEGACY_UNLINKED',
      root_history_id: null,
    });
  });
});
