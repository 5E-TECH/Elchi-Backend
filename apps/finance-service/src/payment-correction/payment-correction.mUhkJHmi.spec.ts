import { RpcException } from '@nestjs/microservices';
import { Observable, Subject, of, throwError } from 'rxjs';
import {
  Cashbox_type,
  Operation_type,
  PaymentMethod,
  Source_type,
} from '@app/common';
import { FinanceServiceService } from '../finance-service.service';
import { CashboxHistory } from '../entities/cashbox-history.entity';
import { PaymentCorrection } from '../entities/payment-correction.entity';
import type {
  CorrectableTransferView,
  HistoryWithCashbox,
} from './payment-correction.rules';

/**
 * mUhkJHmi (N2 «Qayerdan → Qayerga») — `GET /finance/history/:id` dagi
 * superadmin `correctable.transfer`: to'lov tomonlari (qabul qilgan kassa,
 * kuryer, market) aniq nomlari bilan. Nomlar — bitta identity + ko'pi bilan
 * bitta branch so'rovi, parallel, fail-open (xato / timeout — `null`).
 * DB va RMQ — mock (to'liq oqim: `payment-correction.pg.spec.ts`).
 */

type Pattern = { cmd: string };
type Reply = (payload: Record<string, unknown>) => Observable<unknown>;
type Where = { where?: Record<string, unknown> };
type Detail = {
  statusCode: number;
  data: Record<string, unknown> & {
    correctable?:
      | (Record<string, unknown> & {
          transfer: CorrectableTransferView | null;
        })
      | null;
  };
};
/** `deadline` — ISO satr (qiymati muddat testlarida). */
const ANY_DEADLINE: unknown = expect.any(String);

const RECENT = new Date(Date.now() - 60_000);
const OLD = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);

const box = (id: string, user_id: string, cashbox_type: Cashbox_type) => ({
  id,
  user_id,
  cashbox_type,
  isDeleted: false,
});
const COURIER_BOX = box('10', '301', Cashbox_type.FOR_COURIER);
const MAIN_BOX = box('20', '0', Cashbox_type.MAIN);
const BRANCH_BOX = box('30', '15', Cashbox_type.BRANCH);
const MARKET_BOX = box('40', '501', Cashbox_type.FOR_MARKET);

const leg = (
  id: string,
  cashbox: ReturnType<typeof box>,
  operation_type: Operation_type,
  source_type: Source_type,
  over: Record<string, unknown> = {},
) =>
  ({
    id,
    cashbox_id: cashbox.id,
    cashbox,
    transfer_id: 't1',
    amount: 500_000,
    operation_type,
    source_type,
    payment_method: PaymentMethod.CASH,
    source_user_id: null,
    created_by: '1',
    isDeleted: false,
    createdAt: RECENT,
    ...over,
  }) as unknown as HistoryWithCashbox;

const courierPayment = (
  receiver: ReturnType<typeof box>,
  over: Record<string, unknown> = {},
) => [
  leg(
    '1',
    COURIER_BOX,
    Operation_type.EXPENSE,
    Source_type.COURIER_PAYMENT,
    over,
  ),
  leg('2', receiver, Operation_type.INCOME, Source_type.COURIER_PAYMENT, over),
];

const clickToMarket = () => {
  const over = { payment_method: PaymentMethod.CLICK_TO_MARKET };
  return [
    ...courierPayment(MAIN_BOX, over),
    leg(
      '3',
      MAIN_BOX,
      Operation_type.EXPENSE,
      Source_type.MARKET_PAYMENT,
      over,
    ),
    leg(
      '4',
      MARKET_BOX,
      Operation_type.EXPENSE,
      Source_type.MARKET_PAYMENT,
      over,
    ),
  ];
};

const marketPayment = () => [
  leg('5', MAIN_BOX, Operation_type.EXPENSE, Source_type.MARKET_PAYMENT),
  leg('6', MARKET_BOX, Operation_type.EXPENSE, Source_type.MARKET_PAYMENT),
];

const USERS = [
  { id: '301', name: 'Ali Kuryer' },
  { id: '501', name: 'Mega Market' },
];

describe('mUhkJHmi — correctable.transfer (Qayerdan → Qayerga)', () => {
  let legs: HistoryWithCashbox[] = [];
  let corrected = false;
  let legsError: Error | null = null;
  let byIdsReply: Reply;
  let branchReply: Reply;
  // enrichHistoryWithUsers (eski yo'l) — bitta-bitta `find_by_id`.
  let findByIdReply: Reply = (payload) =>
    of({ data: { id: payload.id, name: 'Xodim', role: 'admin' } });
  const identityClient = {
    send: jest.fn((pattern: Pattern, payload: Record<string, unknown>) =>
      pattern.cmd === 'identity.user.find_by_ids'
        ? byIdsReply(payload)
        : findByIdReply(payload),
    ),
  };
  const branchClient = {
    send: jest.fn((_pattern: Pattern, payload: Record<string, unknown>) =>
      branchReply(payload),
    ),
  };
  const manager = {
    find: jest.fn((entity: unknown, options: Where) => {
      if (entity !== CashboxHistory) return Promise.resolve([]);
      if (legsError) return Promise.reject(legsError);
      return Promise.resolve(
        legs.filter((item) => item.transfer_id === options.where?.transfer_id),
      );
    }),
    findOne: jest.fn((entity: unknown, options: Where) =>
      Promise.resolve(
        entity === PaymentCorrection &&
          options.where?.original_transfer_id &&
          corrected
          ? { id: '9' }
          : null,
      ),
    ),
  };
  const historyRepo = { findOne: jest.fn() };

  const build = (branch: unknown) =>
    new FinanceServiceService(
      {} as never,
      historyRepo as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      { manager } as never,
      {} as never,
      { send: jest.fn() } as never,
      { send: jest.fn() } as never,
      identityClient as never,
      {} as never,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      branch as never,
    );

  const detail = async (
    history: HistoryWithCashbox,
    options: { include_correctable?: boolean; branch?: unknown } = {},
  ) => {
    historyRepo.findOne.mockResolvedValue(history);
    const service = build('branch' in options ? options.branch : branchClient);
    const res = (await service.findHistoryById(String(history.id), {
      include_correctable: options.include_correctable ?? true,
    })) as Detail;
    return res;
  };

  const callsOf = (cmd: string) =>
    (
      identityClient.send.mock.calls as unknown as Array<
        [Pattern, Record<string, unknown>]
      >
    ).filter(([pattern]) => pattern.cmd === cmd);

  beforeEach(() => {
    jest.clearAllMocks();
    legs = [];
    corrected = false;
    legsError = null;
    byIdsReply = () => of({ success: true, data: USERS });
    branchReply = (payload) =>
      of({
        statusCode: 200,
        data: { id: payload.id, name: 'Samarqand filiali' },
      });
  });

  it('⭐ naqd kuryer to`lovi, MAIN qabul qilgan — kuryer nomi, MAIN nomi null, branch so`ralmaydi', async () => {
    legs = courierPayment(MAIN_BOX);
    const res = await detail(legs[0]);
    expect(res.statusCode).toBe(200);
    expect(res.data.correctable).toEqual({
      allowed: true,
      deadline: ANY_DEADLINE,
      window_days: 30,
      root_history_id: '1',
      transfer: {
        kind: 'courier_payment',
        payment_method: 'cash',
        amount: 500_000,
        receiver: { cashbox_type: 'main', branch_id: null, name: null },
        courier: { id: '301', name: 'Ali Kuryer' },
        market: null,
      },
    });
    const byIds = callsOf('identity.user.find_by_ids');
    expect(byIds).toHaveLength(1);
    expect(byIds[0][1]).toMatchObject({ ids: ['301'] });
    expect(branchClient.send).not.toHaveBeenCalled();
  });

  it('click kuryer to`lovi (MAIN oyog`idan ochilgan) — o`sha transfer', async () => {
    legs = courierPayment(MAIN_BOX, { payment_method: PaymentMethod.CLICK });
    const res = await detail(legs[1]);
    expect(res.data.correctable?.transfer).toEqual({
      kind: 'courier_payment',
      payment_method: 'click',
      amount: 500_000,
      receiver: { cashbox_type: 'main', branch_id: null, name: null },
      courier: { id: '301', name: 'Ali Kuryer' },
      market: null,
    });
  });

  it('⭐ click_to_market (4 oyoq) — kuryer + market bitta identity so`rovida, receiver MAIN', async () => {
    legs = clickToMarket();
    const res = await detail(legs[0]);
    expect(res.data.correctable).toMatchObject({ allowed: true });
    expect(res.data.correctable?.transfer).toEqual({
      kind: 'courier_payment',
      payment_method: 'click_to_market',
      amount: 500_000,
      receiver: { cashbox_type: 'main', branch_id: null, name: null },
      courier: { id: '301', name: 'Ali Kuryer' },
      market: { id: '501', name: 'Mega Market' },
    });
    const byIds = callsOf('identity.user.find_by_ids');
    expect(byIds).toHaveLength(1);
    expect(byIds[0][1]).toMatchObject({ ids: ['301', '501'] });
    expect(branchClient.send).not.toHaveBeenCalled();
  });

  it('⭐ marketga to`lov — courier null, receiver MAIN, market bor', async () => {
    legs = marketPayment();
    const res = await detail(legs[1]);
    expect(res.data.correctable?.transfer).toEqual({
      kind: 'market_payment',
      payment_method: 'cash',
      amount: 500_000,
      receiver: { cashbox_type: 'main', branch_id: null, name: null },
      courier: null,
      market: { id: '501', name: 'Mega Market' },
    });
    expect(callsOf('identity.user.find_by_ids')[0][1]).toMatchObject({
      ids: ['501'],
    });
    expect(branchClient.send).not.toHaveBeenCalled();
  });

  it('⭐ filial (BRANCH) qabul qilgan — branch_id + filial nomi; bitta identity, bitta branch so`rovi (tizim requester)', async () => {
    legs = courierPayment(BRANCH_BOX);
    const res = await detail(legs[0]);
    expect(res.data.correctable?.transfer).toEqual({
      kind: 'courier_payment',
      payment_method: 'cash',
      amount: 500_000,
      receiver: {
        cashbox_type: 'branch',
        branch_id: '15',
        name: 'Samarqand filiali',
      },
      courier: { id: '301', name: 'Ali Kuryer' },
      market: null,
    });
    expect(callsOf('identity.user.find_by_ids')).toHaveLength(1);
    expect(branchClient.send).toHaveBeenCalledTimes(1);
    expect(branchClient.send).toHaveBeenCalledWith(
      { cmd: 'branch.find_by_id' },
      expect.objectContaining({
        id: '15',
        requester: { id: 'system', roles: ['superadmin'] },
      }),
    );
  });

  it('nomlar topilmadi (identity bo`sh, branch 404) — nom null, qolgan maydonlar joyida', async () => {
    legs = clickToMarket();
    byIdsReply = () => of({ success: true, data: [] });
    const res = await detail(legs[0]);
    expect(res.data.correctable?.transfer).toMatchObject({
      courier: { id: '301', name: null },
      market: { id: '501', name: null },
    });

    legs = courierPayment(BRANCH_BOX);
    branchReply = () =>
      throwError(
        () => new RpcException({ statusCode: 404, message: 'topilmadi' }),
      );
    const branch = await detail(legs[0]);
    expect(branch.statusCode).toBe(200);
    expect(branch.data.correctable).toMatchObject({
      allowed: true,
      root_history_id: '1',
      transfer: {
        receiver: { cashbox_type: 'branch', branch_id: '15', name: null },
        courier: { id: '301', name: null },
      },
    });
  });

  it('⭐ identity va branch xatosi — fail-open: 200, nomlar null, blok null EMAS', async () => {
    legs = courierPayment(BRANCH_BOX);
    byIdsReply = () => throwError(() => new Error('identity down'));
    branchReply = () => throwError(() => new Error('branch down'));
    const res = await detail(legs[0]);
    expect(res.statusCode).toBe(200);
    expect(res.data.correctable).toEqual({
      allowed: true,
      deadline: ANY_DEADLINE,
      window_days: 30,
      root_history_id: '1',
      transfer: {
        kind: 'courier_payment',
        payment_method: 'cash',
        amount: 500_000,
        receiver: { cashbox_type: 'branch', branch_id: '15', name: null },
        courier: { id: '301', name: null },
        market: null,
      },
    });
    // N+1 yo'q: bitta identity, bitta branch so'rovi (qayta urinish yo'qligi — timeout testida).
    expect(callsOf('identity.user.find_by_ids')).toHaveLength(1);
    expect(branchClient.send).toHaveBeenCalledTimes(1);
  });

  it('⭐ timeout — ikkala so`rov parallel, ≤1500 ms, qayta urinishsiz; nomlar null', async () => {
    legs = courierPayment(BRANCH_BOX);
    // Har so'rov obunasi vaqti — parallellik CI yukidan qat'i nazar aniq
    // tekshiriladi (umumiy vaqtning yuqori chegarasi emas).
    const subscribedAt: number[] = [];
    const hang = () =>
      new Observable<never>(() => {
        subscribedAt.push(Date.now());
      });
    byIdsReply = hang;
    branchReply = hang;
    const started = Date.now();
    const res = await detail(legs[0]);
    const elapsed = Date.now() - started;
    expect(res.statusCode).toBe(200);
    expect(res.data.correctable?.transfer).toMatchObject({
      receiver: { branch_id: '15', name: null },
      courier: { id: '301', name: null },
    });
    // Timeout 1500 ms dan oldin tugamaydi; ikkala so'rov bir vaqtda
    // boshlangan (ketma-ket bo'lsa oraliq ≥ 1500 ms bo'lardi), har biri
    // bir martadan (qayta urinish yo'q).
    expect(elapsed).toBeGreaterThanOrEqual(1400);
    expect(subscribedAt).toHaveLength(2);
    expect(Math.abs(subscribedAt[1] - subscribedAt[0])).toBeLessThan(1000);
    expect(callsOf('identity.user.find_by_ids')).toHaveLength(1);
    expect(branchClient.send).toHaveBeenCalledTimes(1);
  }, 10_000);

  it('⭐ correctable enrichment bilan PARALLEL — nom so‘rovlari enrichment tugashini kutmaydi', async () => {
    legs = courierPayment(BRANCH_BOX);
    const enrichment = new Subject<unknown>();
    findByIdReply = () => enrichment.asObservable();
    try {
      const pending = detail(legs[0]);
      // Enrichment (`find_by_id`) hali javob bermagan — correctable nom
      // so'rovlari allaqachon yuborilgan bo'lishi shart.
      for (
        let i = 0;
        i < 20 && !callsOf('identity.user.find_by_ids').length;
        i += 1
      ) {
        await new Promise((resolve) => setImmediate(resolve));
      }
      expect(callsOf('identity.user.find_by_ids')).toHaveLength(1);
      expect(branchClient.send).toHaveBeenCalledTimes(1);

      enrichment.next({ data: { id: '1', name: 'Xodim', role: 'admin' } });
      enrichment.complete();
      const res = await pending;
      expect(res.statusCode).toBe(200);
      expect(res.data.correctable?.transfer?.receiver).toEqual({
        cashbox_type: 'branch',
        branch_id: '15',
        name: 'Samarqand filiali',
      });
    } finally {
      findByIdReply = (payload) =>
        of({ data: { id: payload.id, name: 'Xodim', role: 'admin' } });
    }
  });

  it('branch client ulanmagan (eski spec`lar) — filial nomi null, branch_id bor', async () => {
    legs = courierPayment(BRANCH_BOX);
    const res = await detail(legs[0], { branch: undefined });
    expect(res.data.correctable?.transfer?.receiver).toEqual({
      cashbox_type: 'branch',
      branch_id: '15',
      name: null,
    });
    expect(branchClient.send).not.toHaveBeenCalled();
  });

  it.each([
    [
      'LEGACY_UNLINKED',
      () => {
        legs = courierPayment(MAIN_BOX);
        return leg(
          '1',
          COURIER_BOX,
          Operation_type.EXPENSE,
          Source_type.COURIER_PAYMENT,
          { transfer_id: null },
        );
      },
      { allowed: false, code: 'LEGACY_UNLINKED' },
    ],
    [
      'unsupported_type (shaklga tushmaydi)',
      () => {
        legs = [courierPayment(MAIN_BOX)[0]];
        return legs[0];
      },
      { code: 'NOT_CORRECTABLE', reason: 'unsupported_type' },
    ],
    [
      'reversal_row',
      () =>
        leg(
          '7',
          MAIN_BOX,
          Operation_type.EXPENSE,
          Source_type.PAYMENT_REVERSAL,
          {
            transfer_id: null,
            reverses_history_id: '2',
          },
        ),
      { code: 'NOT_CORRECTABLE', reason: 'reversal_row' },
    ],
  ])('%s — transfer null, nom so`ralmaydi', async (_name, make, verdict) => {
    const res = await detail(make());
    expect(res.data.correctable).toMatchObject({ ...verdict, transfer: null });
    expect(callsOf('identity.user.find_by_ids')).toHaveLength(0);
    expect(branchClient.send).not.toHaveBeenCalled();
  });

  it('⭐ ALREADY_CORRECTED — transfer saqlanadi', async () => {
    legs = courierPayment(BRANCH_BOX);
    corrected = true;
    const res = await detail(legs[0]);
    expect(res.data.correctable).toMatchObject({
      allowed: false,
      code: 'ALREADY_CORRECTED',
      transfer: {
        kind: 'courier_payment',
        receiver: { branch_id: '15', name: 'Samarqand filiali' },
        courier: { id: '301', name: 'Ali Kuryer' },
      },
    });
  });

  it('⭐ WINDOW_EXPIRED — transfer saqlanadi', async () => {
    legs = marketPayment().map((item) =>
      Object.assign(item, { createdAt: OLD }),
    );
    const res = await detail(legs[0]);
    expect(res.data.correctable).toMatchObject({
      allowed: false,
      code: 'WINDOW_EXPIRED',
      transfer: {
        kind: 'market_payment',
        market: { id: '501', name: 'Mega Market' },
      },
    });
  });

  it('include_correctable false (admin) — correctable kaliti yo`q, nom so`ralmaydi', async () => {
    legs = courierPayment(BRANCH_BOX);
    const res = await detail(legs[0], { include_correctable: false });
    expect(res.data).not.toHaveProperty('correctable');
    expect(callsOf('identity.user.find_by_ids')).toHaveLength(0);
    expect(branchClient.send).not.toHaveBeenCalled();
  });

  it('blok hisobida DB xatosi — avvalgidek correctable null (javob 200)', async () => {
    legs = courierPayment(MAIN_BOX);
    legsError = new Error('db down');
    const res = await detail(legs[0]);
    expect(res.statusCode).toBe(200);
    expect(res.data).toHaveProperty('correctable', null);
  });
});
