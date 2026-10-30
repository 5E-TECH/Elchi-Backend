import { PUBLIC_ERROR_CODES, publicErrorFields } from '@app/common';
import { Cashbox_type, Operation_type, Source_type } from '@app/common';
import {
  attachCorrectionViews,
  evaluateCorrectable,
  type HistoryWithCashbox,
} from './payment-correction.rules';

/**
 * iPlY5yop (T6-BE-2) — karta 4–6-bandlari, sof qism: gateway javobiga chiqadigan
 * maydonlar, `NOT_CORRECTABLE` sababi, `correction.related` (N+1 siz).
 * To'liq oqim — `payment-correction.pg.spec.ts` (haqiqiy Postgres).
 */
describe('iPlY5yop — xato maydonlari (PUBLIC_ERROR_CODES)', () => {
  it.each([
    ['INSUFFICIENT_BALANCE', { required: 500_000 }],
    ['NOT_CORRECTABLE', { reason: 'reversal_row' }],
    [
      'WINDOW_EXPIRED',
      { deadline: '2026-10-30T00:00:00.000Z', window_days: 7 },
    ],
    ['AMOUNT_EXCEEDS', { max: 500_000 }],
  ])('%s maydonlari javobga chiqadi', (code, fields) => {
    expect(publicErrorFields({ code, ...fields, secret: 'x' })).toEqual({
      code,
      ...fields,
    });
  });

  it('ro`yxat yopiq: boshqa kodlarga yangi maydon qo`shilmagan', () => {
    expect(PUBLIC_ERROR_CODES.ALREADY_CORRECTED).toEqual([]);
    expect(PUBLIC_ERROR_CODES.LEGACY_UNLINKED).toEqual([]);
  });
});

const leg = (over: Partial<HistoryWithCashbox>) =>
  ({
    id: '1',
    cashbox_id: '10',
    amount: 1000,
    operation_type: Operation_type.EXPENSE,
    source_type: Source_type.COURIER_PAYMENT,
    payment_method: 'cash',
    createdAt: new Date('2026-10-30T10:00:00.000Z'),
    cashbox: {
      id: '10',
      user_id: '301',
      cashbox_type: Cashbox_type.FOR_COURIER,
      isDeleted: false,
    },
    ...over,
  }) as unknown as HistoryWithCashbox;

describe('iPlY5yop — NOT_CORRECTABLE sababi', () => {
  const evaluate = (history: HistoryWithCashbox, legs: unknown[] = []) =>
    evaluateCorrectable(
      {
        find: jest.fn().mockResolvedValue(legs),
        findOne: jest.fn().mockResolvedValue(null),
      } as never,
      history,
      { windowDays: 30 },
    );

  it('teskari qator → reversal_row', async () => {
    await expect(
      evaluate(
        leg({
          source_type: Source_type.PAYMENT_REVERSAL,
          reverses_history_id: '7',
        }),
      ),
    ).resolves.toMatchObject({
      allowed: false,
      code: 'NOT_CORRECTABLE',
      reason: 'reversal_row',
    });
  });

  it('qamrovdan tashqari tur → unsupported_type', async () => {
    await expect(
      evaluate(leg({ source_type: Source_type.MANUAL_EXPENSE })),
    ).resolves.toMatchObject({
      code: 'NOT_CORRECTABLE',
      reason: 'unsupported_type',
    });
  });

  it('oyoqlar to`lov shakliga tushmaydi → unsupported_type', async () => {
    const lone = leg({ transfer_id: 't1' });
    await expect(evaluate(lone, [lone])).resolves.toMatchObject({
      code: 'NOT_CORRECTABLE',
      reason: 'unsupported_type',
    });
  });

  it('kontragent kassasi o`chirilgan → cashbox_deleted', async () => {
    const courier = leg({
      id: '1',
      transfer_id: 't1',
      cashbox: {
        id: '10',
        user_id: '301',
        cashbox_type: Cashbox_type.FOR_COURIER,
        isDeleted: true,
      } as never,
    });
    const main = leg({
      id: '2',
      transfer_id: 't1',
      cashbox_id: '20',
      operation_type: Operation_type.INCOME,
      cashbox: {
        id: '20',
        user_id: '0',
        cashbox_type: Cashbox_type.MAIN,
        isDeleted: false,
      } as never,
    });
    await expect(evaluate(courier, [courier, main])).resolves.toMatchObject({
      code: 'NOT_CORRECTABLE',
      reason: 'cashbox_deleted',
    });
  });
});

describe('iPlY5yop — correction.related', () => {
  const at = new Date('2026-10-30T10:00:00.000Z');
  const base = {
    id: '50',
    action: 'edit',
    payment_kind: 'courier_payment',
    original_transfer_id: 'orig',
    reversal_transfer_id: 'rev',
    replacement_transfer_id: 'repl',
    root_transfer_id: 'orig',
    original_amount: 500_000,
    new_amount: 50_000,
    reason: 'Summa xato',
    created_by: '1',
    createdAt: at,
  };
  const row = (over: Record<string, unknown>) => ({
    cashbox_id: '20',
    source_type: Source_type.COURIER_PAYMENT,
    operation_type: Operation_type.INCOME,
    amount: 500_000,
    createdAt: at,
    ...over,
  });
  const original = row({ id: '1', transfer_id: 'orig' });
  const reversal = row({
    id: '3',
    transfer_id: 'rev',
    source_type: Source_type.PAYMENT_REVERSAL,
    operation_type: Operation_type.EXPENSE,
    reverses_history_id: '1',
  });
  const replacement = row({ id: '5', transfer_id: 'repl', amount: 50_000 });
  // click_to_market: o'sha MAIN kassada ikkinchi oyoq — adashmasligi kerak.
  const replacementMarket = row({
    id: '6',
    transfer_id: 'repl',
    amount: 50_000,
    source_type: Source_type.MARKET_PAYMENT,
    operation_type: Operation_type.EXPENSE,
  });
  const otherBox = row({ id: '7', transfer_id: 'repl', cashbox_id: '30' });

  const run = async (rows: Array<Record<string, any>>, correction = base) => {
    const find = jest.fn((entity: { name: string }, options: any) =>
      Promise.resolve(
        entity.name === 'PaymentCorrection'
          ? [correction]
          : JSON.stringify(options.where).length
            ? [original, reversal, replacement, replacementMarket, otherBox]
            : [],
      ),
    );
    const views = await attachCorrectionViews(
      { find } as never,
      rows as never,
      () => Promise.resolve(new Map()),
    );
    return { views: views as any[], find };
  };

  it('asl oyoq (tahrir) → yangi oyoq, tur/amal/kassa bo`yicha', async () => {
    const { views } = await run([original]);
    expect(views[0].correction).toMatchObject({
      role: 'original',
      payment_kind: 'courier_payment',
      related_history_id: '3',
      related: {
        id: '5',
        source_type: Source_type.COURIER_PAYMENT,
        role: 'replacement',
        operation_type: Operation_type.INCOME,
        amount: 50_000,
        created_at: at,
      },
    });
  });

  it('asl oyoq (qaytarish) → teskari qator', async () => {
    const { views } = await run([original], {
      ...base,
      action: 'reverse',
      replacement_transfer_id: null as never,
      new_amount: null as never,
    });
    expect(views[0].correction.related).toMatchObject({
      id: '3',
      role: 'reversal',
      source_type: Source_type.PAYMENT_REVERSAL,
      operation_type: Operation_type.EXPENSE,
    });
  });

  it('teskari va yangi qator → asl oyoq', async () => {
    const { views } = await run([reversal, replacement]);
    expect(views[0].correction.related).toMatchObject({
      id: '1',
      role: 'original',
    });
    expect(views[1].correction.related).toMatchObject({
      id: '1',
      role: 'original',
    });
  });

  it('N+1 yo`q: 100 qatorga ham ikki so`rov (jurnal + bog`liq oyoqlar)', async () => {
    const rows = Array.from({ length: 100 }, (_, index) =>
      row({ id: String(1000 + index), transfer_id: 'orig' }),
    );
    const { find } = await run(rows);
    expect(find).toHaveBeenCalledTimes(2);
  });
});
