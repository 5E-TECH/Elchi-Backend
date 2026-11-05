import { Logger } from '@nestjs/common';
import { RpcException } from '@nestjs/microservices';
import { of } from 'rxjs';
import {
  findNotificationType,
  NotificationCategory,
  NotificationChannel,
  NotificationPriority,
  Order_status,
} from '@app/common';
import {
  buildExtraCostDecisionNotice,
  formatExtraCostWaitPeriod,
} from '../notification/extra-cost-notifications';
import {
  ExtraCostExecutionOptions,
  ExtraCostRequestClosedError,
  OrderLifecycleService,
} from './order-lifecycle.service';
import {
  extraCostApprovalTable,
  extraCostDataSource,
  extraCostManager,
  extraCostTransaction,
} from '../testing/extra-cost-kit-spec';

/**
 * GykuOz8f — so'rov yozgan kuryer / menejerga qaror xabari va tasdiqsiz
 * yozilgan xarajat qatori.
 *
 * Xabar (in-app + realtime + Telegram DM) — tasdiqlandi (qo'lda yoki
 * avtomatik), rad etildi va HAR BIR yopilish (`void`) yo'lida, qaror bilan
 * BITTA tranzaksiyada (`outbox.enqueue(…, { manager })`). `reversed` va
 * tasdiqsiz (`immediate`) qator uchun xabar yo'q.
 *
 * Tasdiqsiz yozilgan xarajat — `approved` + `immediate` qatori sotuv
 * tranzaksiyasida; qayta ijroda (tasdiqlangan so'rovning o'zi bor) —
 * qo'shimcha qator yo'q; orqaga qaytarishda `reversed`.
 */
type Row = Record<string, unknown>;
type Requester = { id: string; roles?: string[]; branch_id?: string | null };

const request = (overrides: Row = {}): Row => ({
  id: '7',
  order_id: '7001',
  market_id: '501',
  requested_by_user_id: '289',
  requested_by_role: 'courier',
  requester_branch_id: '77',
  action: 'sell',
  amount: 10000,
  proof_file_keys: [],
  operation_payload: { extraCost: 10000 },
  status: 'pending',
  createdAt: new Date('2026-11-05T08:00:00Z'),
  ...overrides,
});

type Helpers = {
  applyExtraCostApprovalsOnExecution: (
    tx: unknown,
    orderId: string,
    requester: Requester,
    options?: ExtraCostExecutionOptions,
    immediate?: {
      action: string;
      amount: number;
      marketId: string | null | undefined;
      proofFiles: string[];
      payload: Row;
    },
  ) => Promise<void>;
  closeExtraCostApprovalsOnRollback: (
    tx: unknown,
    orderId: string,
    requester: { id: string },
  ) => Promise<void>;
  mergePartialChildrenBack: (
    tx: unknown,
    order: Row,
    requester: { id: string },
  ) => Promise<number>;
  settleFailedExtraCostReplay: (
    approval: Row,
    error: unknown,
    actorId: string | null,
  ) => Promise<never>;
  requestExtraCostApprovalIfNeeded: (params: Row) => Promise<unknown>;
};

const OLD_ENV = { ...process.env };

beforeEach(() => {
  delete process.env.EXTRA_COST_AUTO_APPROVE_MINUTES;
  jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
});
afterEach(() => {
  process.env = { ...OLD_ENV };
  jest.restoreAllMocks();
});

function setup(rows: Row[], changedTo: string | null = null) {
  const table = extraCostApprovalTable(rows);
  const manager = extraCostManager({ table, changedTo });
  const svc = Object.create(OrderLifecycleService.prototype) as Helpers &
    OrderLifecycleService &
    Record<string, unknown>;
  const outbox = { enqueue: jest.fn().mockResolvedValue(undefined) };
  const logger = { warn: jest.fn(), log: jest.fn(), error: jest.fn() };
  Object.assign(svc, {
    logger,
    outbox,
    extraCostApprovalRepo: table,
    dataSource: {
      manager,
      transaction: extraCostTransaction(manager, table),
    },
    identityClient: { send: jest.fn(() => of({ data: [] })) },
    activityLog: { log: jest.fn().mockResolvedValue(undefined) },
  });
  return { svc, table, manager, outbox, logger };
}

/** `outbox.enqueue` chaqiruvlari: [payload, options]. */
const notices = (outbox: { enqueue: jest.Mock }) =>
  (outbox.enqueue.mock.calls as unknown[][]).map((args) => {
    expect(args[0]).toBe('NOTIFICATION');
    expect(args[1]).toBe('notification.dispatch');
    return { payload: args[2] as Row, options: args[3] as Row | undefined };
  });

const replay = (
  id: string,
  patch: Partial<{
    auto_approved: boolean;
    decided_by_user_id: string | null;
  }> = {},
): ExtraCostExecutionOptions => ({
  extraCostApproval: {
    id,
    patch: {
      decided_by_user_id: '501',
      decided_at: new Date('2026-11-05T09:00:00Z'),
      decision_comment: null,
      auto_approved: false,
      ...patch,
    },
  },
});

describe('GykuOz8f — xabar matni va turlar ro‘yxati', () => {
  const approval = request();

  it('⭐ tasdiqlandi: qo‘lda; avtomatik — muddat soatda yoki daqiqada', () => {
    expect(
      buildExtraCostDecisionNotice({ kind: 'approved', approval }),
    ).toEqual({
      type: 'order.extra_cost_approved',
      title: "✅ EL-107001: qo'shimcha xarajat tasdiqlandi",
      body: "10 000 so'm qo'shimcha xarajat tasdiqlandi.",
      link: '/extra-costs?tab=approved',
      status: 'approved',
    });
    expect(
      buildExtraCostDecisionNotice({
        kind: 'approved',
        approval,
        autoApproved: true,
        autoApproveMinutes: 1440,
      }).body,
    ).toBe(
      "10 000 so'm qo'shimcha xarajat tasdiqlandi. Market 24 soat ichida javob bermadi — avtomatik tasdiqlandi.",
    );
    expect(
      buildExtraCostDecisionNotice({
        kind: 'approved',
        approval,
        autoApproved: true,
        autoApproveMinutes: 90,
      }).body,
    ).toContain('Market 90 daqiqa ichida javob bermadi');
    expect(formatExtraCostWaitPeriod(60)).toBe('1 soat');
    expect(formatExtraCostWaitPeriod(1440)).toBe('24 soat');
    expect(formatExtraCostWaitPeriod(90)).toBe('90 daqiqa');
  });

  it('⭐ rad etildi: sabab yorlig‘i[: izoh] va «qayta soting yoki bekor qiling»', () => {
    const rejected = (rejectLabel: string | null, comment: string | null) =>
      buildExtraCostDecisionNotice({
        kind: 'rejected',
        approval,
        rejectLabel,
        comment,
      });
    expect(rejected('Summa juda katta', 'Juda qimmat')).toEqual({
      type: 'order.extra_cost_rejected',
      title: "❌ EL-107001: qo'shimcha xarajat rad etildi",
      body:
        "10 000 so'm qo'shimcha xarajat rad etildi — Summa juda katta: Juda qimmat. " +
        'Buyurtma kutilmoqda holatida qoldi: qayta soting yoki bekor qiling.',
      link: '/extra-costs?tab=cancelled',
      status: 'rejected',
    });
    expect(rejected('Summa juda katta', null).body).toContain(
      'rad etildi — Summa juda katta. Buyurtma',
    );
    expect(rejected(null, 'Juda qimmat').body).toContain(
      'rad etildi — Juda qimmat. Buyurtma',
    );
    expect(rejected(null, null).body).toContain('rad etildi. Buyurtma');
  });

  it('⭐ yopildi (void): summa — yopilish sababi', () => {
    expect(
      buildExtraCostDecisionNotice({
        kind: 'voided',
        approval: { ...approval, closed_reason: 'Buyurtma orqaga qaytarildi' },
      }),
    ).toEqual({
      type: 'order.extra_cost_voided',
      title: "⚪ EL-107001: qo'shimcha xarajat so'rovi yopildi",
      body: "10 000 so'm — Buyurtma orqaga qaytarildi",
      link: '/extra-costs?tab=cancelled',
      status: 'void',
    });
  });

  it.each([
    ['order.extra_cost_approved'],
    ['order.extra_cost_rejected'],
    ['order.extra_cost_voided'],
  ])(
    '%s — ro‘yxatda: ORDER, in_app + realtime + telegram, kuryer / menejer',
    (key) => {
      expect(findNotificationType(key)).toMatchObject({
        key,
        category: NotificationCategory.ORDER,
        group_key_pattern: 'extra_cost:{{approval_id}}',
        default_audience: ['courier', 'manager'],
        user_can_mute: true,
        default_channels: [
          NotificationChannel.IN_APP,
          NotificationChannel.REALTIME,
          NotificationChannel.TELEGRAM,
        ],
      });
    },
  );
});

describe('GykuOz8f — tasdiqlandi xabari (sotuv tranzaksiyasida)', () => {
  it('⭐ qo‘lda tasdiq: yozgan kuryerga «tasdiqlandi», boshqa ochiq so‘rov egasiga «yopildi» — ikkalasi { manager } bilan', async () => {
    const { svc, manager, outbox } = setup([
      request({ id: '7' }),
      // Eski kod qoldirgan ikkinchi ochiq so'rov (boshqa kuryer).
      request({
        id: '6',
        requested_by_user_id: '290',
        amount: 5000,
        createdAt: new Date('2026-11-05T07:00:00Z'),
      }),
    ]);

    await svc.applyExtraCostApprovalsOnExecution(
      manager,
      '7001',
      { id: '289', roles: ['courier'] },
      replay('7'),
    );

    const sent = notices(outbox);
    expect(sent).toHaveLength(2);
    expect(sent[0].options).toEqual({ manager });
    expect(sent[0].payload).toEqual({
      type: 'order.extra_cost_approved',
      category: NotificationCategory.ORDER,
      priority: NotificationPriority.HIGH,
      title: "✅ EL-107001: qo'shimcha xarajat tasdiqlandi",
      body: "10 000 so'm qo'shimcha xarajat tasdiqlandi.",
      recipient_id: '289',
      link: '/extra-costs?tab=approved',
      channels: ['in_app', 'realtime', 'telegram'],
      group_key: 'extra_cost:7',
      data: {
        approval_id: '7',
        order_id: '7001',
        order_number: 'EL-107001',
        action: 'sell',
        amount: 10000,
        status: 'approved',
        telegram_cabinet_link: true,
      },
    });
    expect(sent[1].options).toEqual({ manager });
    expect(sent[1].payload).toMatchObject({
      type: 'order.extra_cost_voided',
      recipient_id: '290',
      group_key: 'extra_cost:6',
      body: "5 000 so'm — Buyurtma boshqa so'rov bilan yakunlandi — eski so'rov yopildi",
      data: expect.objectContaining({ status: 'void', amount: 5000 }),
    });
  });

  it('⭐ avtomatik tasdiq: «Market 24 soat ichida javob bermadi»; muddat 90 daqiqa — «90 daqiqa»', async () => {
    for (const [minutes, text] of [
      [
        undefined,
        'Market 24 soat ichida javob bermadi — avtomatik tasdiqlandi.',
      ],
      ['90', 'Market 90 daqiqa ichida javob bermadi — avtomatik tasdiqlandi.'],
    ] as const) {
      if (minutes) process.env.EXTRA_COST_AUTO_APPROVE_MINUTES = minutes;
      const { svc, manager, outbox } = setup([request()]);

      await svc.applyExtraCostApprovalsOnExecution(
        manager,
        '7001',
        { id: '289', roles: ['courier'] },
        replay('7', { auto_approved: true, decided_by_user_id: null }),
      );

      const [notice] = notices(outbox);
      expect(notice.payload).toMatchObject({
        type: 'order.extra_cost_approved',
        recipient_id: '289',
        body: `10 000 so'm qo'shimcha xarajat tasdiqlandi. ${text}`,
      });
      expect(notice.options).toEqual({ manager });
    }
  });

  it('⭐ approveExtraCostApproval (avtomatik) — xabar sotuv tranzaksiyasida; sotuv yiqilsa, tasdiq ham, xabar ham qaytadi', async () => {
    const { svc, table, manager, outbox } = setup([request()]);
    Object.assign(svc, {
      orderRepo: {
        findOne: jest.fn().mockResolvedValue({
          id: '7001',
          status: Order_status.WAITING,
          isDeleted: false,
        }),
      },
    });
    // Sotuv tranzaksiyasi: claim + xabar shu yerda; pul yozuvi yiqilsa —
    // hammasi qaytadi (kit jadvali + outbox chaqiruvlari tozalanadi).
    let failMoney = true;
    jest.spyOn(svc, 'sellOrder').mockImplementation(
      (actor, orderId, _dto, _req, execution) =>
        table.transaction(async () => {
          const before = outbox.enqueue.mock.calls.length;
          try {
            await svc.applyExtraCostApprovalsOnExecution(
              manager,
              orderId,
              actor,
              execution,
            );
            if (failMoney) throw new Error('kassa yozuvi yiqildi');
          } catch (error) {
            outbox.enqueue.mock.calls.splice(before);
            throw error;
          }
          return { statusCode: 200, data: {} };
        }) as never,
    );

    await expect(
      svc.approveExtraCostApproval(null, '7', undefined, { auto: true }),
    ).rejects.toThrow('kassa yozuvi yiqildi');
    expect(table.row('7')!.status).toBe('pending');
    expect(outbox.enqueue).not.toHaveBeenCalled();

    failMoney = false;
    await svc.approveExtraCostApproval(null, '7', undefined, { auto: true });
    expect(table.row('7')).toMatchObject({
      status: 'approved',
      auto_approved: true,
      decided_by_user_id: null,
    });
    const [notice] = notices(outbox);
    expect(notice.payload).toMatchObject({
      type: 'order.extra_cost_approved',
      recipient_id: '289',
      body: expect.stringContaining('Market 24 soat ichida javob bermadi'),
    });
  });

  it('claim o‘tmadi (parallel qaror) — xabar yo‘q', async () => {
    const { svc, manager, outbox } = setup([request({ status: 'rejected' })]);

    await expect(
      svc.applyExtraCostApprovalsOnExecution(
        manager,
        '7001',
        { id: '289' },
        replay('7'),
      ),
    ).rejects.toBeInstanceOf(ExtraCostRequestClosedError);
    expect(outbox.enqueue).not.toHaveBeenCalled();
  });
});

describe('GykuOz8f — rad etildi xabari (qaror bilan bitta tranzaksiyada)', () => {
  const MARKET = { id: '501', roles: ['market'] };

  it('⭐ sabab yorlig‘i va izoh bilan; tranzaksiya menejeri bilan', async () => {
    const { svc, table, manager, outbox } = setup([request()]);

    await svc.rejectExtraCostApproval(MARKET, '7', {
      reason: 'TOO_EXPENSIVE',
      comment: '  Juda qimmat ',
    });

    expect(
      (svc as unknown as { dataSource: { transaction: jest.Mock } }).dataSource
        .transaction,
    ).toHaveBeenCalledTimes(1);
    expect(table.row('7')).toMatchObject({
      status: 'rejected',
      reject_reason: 'TOO_EXPENSIVE',
      decision_comment: 'Summa juda katta — Juda qimmat',
    });
    const sent = notices(outbox);
    expect(sent).toHaveLength(1);
    expect(sent[0].options).toEqual({ manager });
    expect(sent[0].payload).toMatchObject({
      type: 'order.extra_cost_rejected',
      recipient_id: '289',
      title: "❌ EL-107001: qo'shimcha xarajat rad etildi",
      body:
        "10 000 so'm qo'shimcha xarajat rad etildi — Summa juda katta: Juda qimmat. " +
        'Buyurtma kutilmoqda holatida qoldi: qayta soting yoki bekor qiling.',
      link: '/extra-costs?tab=cancelled',
      data: expect.objectContaining({ status: 'rejected' }),
    });
  });

  it('⭐ xabarni navbatga qo‘yib bo‘lmadi — rad etish ham qaytadi (so‘rov pending)', async () => {
    const { svc, table, outbox } = setup([request()]);
    outbox.enqueue.mockRejectedValue(new Error('outbox yozilmadi'));

    await expect(
      svc.rejectExtraCostApproval(MARKET, '7', { reason: 'NO_PROOF' }),
    ).rejects.toThrow('outbox yozilmadi');
    expect(table.row('7')!.status).toBe('pending');
  });

  it('parallel qaror (claim o‘tmadi) — 409, xabar yo‘q', async () => {
    const { svc, table, outbox } = setup([request({ status: 'approved' })]);
    // Tezkor o'qish hali `pending` ko'rgan — haqiqiy holat UPDATE'da.
    Object.assign(svc, {
      extraCostApprovalRepo: {
        ...table,
        findOne: jest.fn().mockResolvedValue(request()),
      },
    });

    await expect(
      svc.rejectExtraCostApproval(MARKET, '7', {}),
    ).rejects.toBeInstanceOf(ExtraCostRequestClosedError);
    expect(outbox.enqueue).not.toHaveBeenCalled();
    expect(table.row('7')!.status).toBe('approved');
  });
});

describe('GykuOz8f — har bir yopilish (void) yo‘lida xabar', () => {
  it('⭐ orqaga qaytarish: pending → void (xabar); approved va tasdiqsiz → reversed (xabar YO‘Q)', async () => {
    const { svc, table, manager, outbox } = setup([
      request({ id: '7' }),
      request({ id: '9', status: 'approved' }),
      request({ id: '10', status: 'approved', immediate: true }),
    ]);

    await svc.closeExtraCostApprovalsOnRollback(manager, '7001', { id: '1' });

    expect(table.row('9')!.status).toBe('reversed');
    expect(table.row('10')!.status).toBe('reversed');
    const sent = notices(outbox);
    expect(sent).toHaveLength(1);
    expect(sent[0].options).toEqual({ manager });
    expect(sent[0].payload).toMatchObject({
      type: 'order.extra_cost_voided',
      recipient_id: '289',
      group_key: 'extra_cost:7',
      body: "10 000 so'm — Buyurtma orqaga qaytarildi",
    });
  });

  it('qo‘shiladigan qisman sotuv qoldig‘idagi ochiq so‘rov — void + xabar', async () => {
    const { svc, table, outbox } = setup([
      request({ id: '7', order_id: '7101', requested_by_user_id: '302' }),
    ]);
    const orderRepo = {
      findOne: jest.fn().mockResolvedValue({ id: '7001', total_price: 100000 }),
      find: jest
        .fn()
        .mockResolvedValue([
          { id: '7101', total_price: 50000, product_quantity: 1 },
        ]),
      save: jest.fn((row: Row) => Promise.resolve(row)),
    };
    const itemRepo = {
      find: jest.fn().mockResolvedValue([]),
      save: jest.fn(),
      create: jest.fn(),
    };
    const manager = extraCostManager({ table, orderRepo });
    const base = manager.getRepository.getMockImplementation()!;
    manager.getRepository.mockImplementation((entity: unknown) =>
      (entity as { name?: string })?.name === 'OrderItem'
        ? itemRepo
        : base(entity),
    );
    Object.assign(svc, {
      removeOrderFromSearch: jest.fn().mockResolvedValue(undefined),
      syncOrderToSearch: jest.fn().mockResolvedValue(undefined),
    });

    await svc.mergePartialChildrenBack(manager, { id: '7001' }, { id: '1' });

    expect(table.row('7')!.status).toBe('void');
    const [notice] = notices(outbox);
    expect(notice.options).toEqual({ manager });
    expect(notice.payload).toMatchObject({
      type: 'order.extra_cost_voided',
      recipient_id: '302',
      data: expect.objectContaining({ order_id: '7101' }),
    });
  });

  it('⭐ yangi so‘rov bilan almashtirildi — eski so‘rov egasiga void xabari (o‘z amali bo‘lsa ham)', async () => {
    const { svc, table, outbox } = setup([request({ amount: 12000 })]);
    const manager = extraCostManager({ table });
    const dataSource = extraCostDataSource(manager, table);
    Object.assign(svc, {
      dataSource,
      lockWaitingOrder: jest.fn().mockResolvedValue(undefined),
      notifyExtraCostRequested: jest.fn().mockResolvedValue(undefined),
    });

    const res = (await svc.requestExtraCostApprovalIfNeeded({
      order: { id: '7001', market_id: '501' },
      requester: { id: '289', roles: ['courier'], branch_id: '77' },
      action: 'cancel',
      extraCost: 15000,
      proofFiles: [],
      dto: { extraCost: 15000 },
      market: { extra_cost_requires_approval: true },
    })) as { statusCode: number };

    expect(res.statusCode).toBe(202);
    expect(table.row('7')!.status).toBe('void');
    const sent = notices(outbox);
    expect(sent).toHaveLength(1);
    expect(sent[0].options).toEqual({ manager });
    expect(sent[0].payload).toMatchObject({
      type: 'order.extra_cost_voided',
      recipient_id: '289',
      body: "12 000 so'm — Yangi so'rov bilan almashtirildi (cancel, 15000 so'm) — eski sell so'rovi yopildi",
    });
  });

  it('⭐ qayta ijro xatosi / darvoza — void + xabar o‘z tranzaksiyasida; infra (503) — xabar yo‘q', async () => {
    const { svc, table, manager, outbox } = setup([request()]);

    await expect(
      svc.settleFailedExtraCostReplay(
        request(),
        new RpcException({ statusCode: 503, message: 'Xizmat javob bermadi' }),
        '501',
      ),
    ).rejects.toBeInstanceOf(RpcException);
    expect(outbox.enqueue).not.toHaveBeenCalled();

    await expect(
      svc.settleFailedExtraCostReplay(
        request(),
        new RpcException({ statusCode: 403, message: 'Ruxsat yo‘q' }),
        '501',
      ),
    ).rejects.toBeInstanceOf(ExtraCostRequestClosedError);
    expect(table.row('7')!.status).toBe('void');
    const [notice] = notices(outbox);
    expect(notice.options).toEqual({ manager });
    expect(notice.payload).toMatchObject({
      type: 'order.extra_cost_voided',
      recipient_id: '289',
      body: "10 000 so'm — amalni bajarib bo'lmadi: Ruxsat yo‘q",
    });
  });

  it('tasdiq darvozasi (buyurtma endi «kutilmoqda» emas) — void + xabar', async () => {
    const { svc, table, outbox } = setup([request()]);
    Object.assign(svc, {
      orderRepo: {
        findOne: jest.fn().mockResolvedValue({
          id: '7001',
          status: Order_status.SOLD,
          isDeleted: false,
        }),
      },
    });

    await expect(
      svc.approveExtraCostApproval({ id: '501', roles: ['market'] }, '7'),
    ).rejects.toBeInstanceOf(ExtraCostRequestClosedError);
    expect(table.row('7')!.status).toBe('void');
    const [notice] = notices(outbox);
    expect(notice.payload).toMatchObject({
      type: 'order.extra_cost_voided',
      body: expect.stringContaining('buyurtma endi «kutilmoqda» holatida emas'),
    });
  });

  it('⭐ xabarni navbatga qo‘yib bo‘lmadi — yopilish ham qaytadi (xato yutilmaydi)', async () => {
    const { svc, table, outbox } = setup([request()]);
    outbox.enqueue.mockRejectedValue(new Error('outbox yozilmadi'));

    await expect(
      svc.settleFailedExtraCostReplay(
        request(),
        new RpcException({ statusCode: 400, message: 'Biznes xatosi' }),
        '501',
      ),
    ).rejects.toThrow('outbox yozilmadi');
    expect(table.row('7')!.status).toBe('pending');
  });

  it('so‘rov yozuvchisi raqam emas (eski / hamkor qatori) — void bo‘ladi, xabar yo‘q', async () => {
    const { svc, table, manager, outbox } = setup([
      request({ requested_by_user_id: null }),
    ]);

    await svc.applyExtraCostApprovalsOnExecution(manager, '7001', {
      id: '289',
    });

    expect(table.row('7')!.status).toBe('void');
    expect(outbox.enqueue).not.toHaveBeenCalled();
  });
});

describe('GykuOz8f — tasdiqsiz yozilgan xarajat qatori (`immediate`)', () => {
  const immediate = (overrides: Row = {}) => ({
    action: 'sell',
    amount: 10000,
    marketId: '501',
    proofFiles: ['proof/a.jpg'],
    payload: { extraCost: 10000, comment: 'Yo‘l xarajati' },
    ...overrides,
  });

  it('⭐ qayta ijro emas — `approved` + `immediate` qatori, qaror maydonlari bo‘sh, xabar yo‘q', async () => {
    const { svc, table, manager, outbox } = setup([]);

    await svc.applyExtraCostApprovalsOnExecution(
      manager,
      '7001',
      { id: '301', roles: ['courier'], branch_id: '77' },
      undefined,
      immediate(),
    );

    expect(table.rows).toHaveLength(1);
    expect(table.rows[0]).toMatchObject({
      order_id: '7001',
      market_id: '501',
      requested_by_user_id: '301',
      requested_by_role: 'courier',
      requester_branch_id: '77',
      action: 'sell',
      amount: 10000,
      proof_file_keys: ['proof/a.jpg'],
      operation_payload: { extraCost: 10000, comment: 'Yo‘l xarajati' },
      status: 'approved',
      immediate: true,
      auto_approved: false,
      decided_by_user_id: null,
      decided_at: expect.any(Date),
    });
    expect(outbox.enqueue).not.toHaveBeenCalled();
  });

  it('menejer — rol manager, filialsiz — requester_branch_id null; bekor / qisman sotuv amali', async () => {
    const { svc, table, manager } = setup([]);

    await svc.applyExtraCostApprovalsOnExecution(
      manager,
      '7001',
      { id: '201', roles: ['manager'], branch_id: null },
      undefined,
      immediate({ action: 'cancel', proofFiles: [], payload: {} }),
    );
    await svc.applyExtraCostApprovalsOnExecution(
      manager,
      '7002',
      { id: '301', roles: ['courier'] },
      undefined,
      immediate({ action: 'partly_sell', amount: 4999.7 }),
    );

    expect(table.rows[0]).toMatchObject({
      requested_by_role: 'manager',
      requester_branch_id: null,
      action: 'cancel',
      proof_file_keys: [],
      operation_payload: {},
    });
    expect(table.rows[1]).toMatchObject({
      order_id: '7002',
      action: 'partly_sell',
      amount: 4999,
    });
  });

  it('⭐ qayta ijro (tasdiqlangan so‘rovning o‘zi bor) — qo‘shimcha qator YO‘Q', async () => {
    const { svc, table, manager } = setup([request()]);

    await svc.applyExtraCostApprovalsOnExecution(
      manager,
      '7001',
      { id: '289', roles: ['courier'] },
      replay('7'),
      immediate(),
    );

    expect(table.rows).toHaveLength(1);
    expect(table.row('7')).toMatchObject({ status: 'approved' });
    expect(table.row('7')!.immediate).toBeUndefined();
  });

  it('hamkor / tizim amali yoki marketsiz buyurtma — qator yozilmaydi (ogohlantirish); xarajat 0 — jim', async () => {
    const { svc, table, manager, logger } = setup([]);

    await svc.applyExtraCostApprovalsOnExecution(
      manager,
      '7001',
      { id: 'partner:4' },
      undefined,
      immediate(),
    );
    await svc.applyExtraCostApprovalsOnExecution(
      manager,
      '7001',
      { id: '301', roles: ['courier'] },
      undefined,
      immediate({ marketId: null }),
    );
    expect(logger.warn).toHaveBeenCalledTimes(2);

    await svc.applyExtraCostApprovalsOnExecution(
      manager,
      '7001',
      { id: '301', roles: ['courier'] },
      undefined,
      immediate({ amount: 0 }),
    );
    expect(table.rows).toHaveLength(0);
    expect(logger.warn).toHaveBeenCalledTimes(2);
  });

  it('⭐ orqaga qaytarishda tasdiqsiz qator `reversed`, xabar yo‘q', async () => {
    const { svc, table, manager, outbox } = setup([]);
    await svc.applyExtraCostApprovalsOnExecution(
      manager,
      '7001',
      { id: '301', roles: ['courier'] },
      undefined,
      immediate(),
    );

    await svc.closeExtraCostApprovalsOnRollback(manager, '7001', { id: '1' });

    expect(table.rows[0]).toMatchObject({
      status: 'reversed',
      immediate: true,
      closed_reason:
        'Buyurtma orqaga qaytarildi — tasdiqlangan xarajat teskari yozildi',
    });
    expect(outbox.enqueue).not.toHaveBeenCalled();
  });
});
