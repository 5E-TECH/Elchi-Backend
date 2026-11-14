import { of } from 'rxjs';
import {
  Cashbox_type,
  Operation_type,
  PaymentMethod,
  Source_type,
} from '@app/common';
import { FinanceServiceService } from './finance-service.service';

/**
 * (2026-11-14, Dilshod) `GET /finance/history/:id` — «Qayerdan» va karta:
 * `branch_to_main` kirimida pulni topshirgan FILIAL (`source_branch`), o'tkazma
 * manbasi (`transfer_source_user`) va CLICK pul tushgan karta (`card`).
 * Ilgari tafsilot ularni bermas, oyna yozuvni kiritgan xodimni ko'rsatardi.
 */
describe('history detail — source_branch, transfer_source_user, card', () => {
  const users: Record<string, Record<string, unknown>> = {
    '1': { id: '1', name: 'Super Admin', role: 'superadmin', salary: 1 },
    '25': {
      id: '25',
      name: 'TEST Menejer',
      role: 'manager',
      phone_number: '+998900000025',
      salary: 5_000_000,
    },
  };
  const cards: Record<string, Record<string, unknown>> = {
    '7': {
      id: '7',
      cashbox_id: '1',
      name: 'Humo biznes',
      is_default: false,
      kind: 'plastic_card',
      bank_name: 'Kapitalbank',
      card_network: 'Humo',
      last4: '4821',
      holder_name: 'Elchi MCHJ',
      balance: 9_000_000,
      require_photo_on_shift_close: true,
    },
    default: {
      id: '3',
      cashbox_id: '1',
      name: 'Asosiy karta',
      is_default: true,
      kind: null,
      bank_name: null,
      card_network: null,
      last4: null,
      holder_name: null,
      balance: 0,
    },
  };

  const MAIN = { id: '1', user_id: '0', cashbox_type: Cashbox_type.MAIN };

  const make = (
    history: Record<string, unknown>,
    options: {
      cards?: Record<string, unknown> | null;
      branchFails?: boolean;
    } = {},
  ) => {
    const self = Object.create(FinanceServiceService.prototype) as Record<
      string,
      unknown
    >;
    self.historyRepo = {
      findOne: jest.fn().mockResolvedValue(history),
      query: jest.fn().mockResolvedValue([]),
    };
    self.identityClient = {
      send: jest.fn((_pattern: unknown, payload: { id: string }) =>
        of({ statusCode: 200, data: users[String(payload.id)] ?? null }),
      ),
    };
    self.branchClient = {
      send: jest.fn((_pattern: unknown, payload: { id: string }) => {
        if (options.branchFails) throw new Error('branch-service down');
        return of({
          statusCode: 200,
          data: { id: payload.id, name: 'Samarqand filiali' },
        });
      }),
    };
    const findOne = jest.fn(
      (_entity: unknown, query: { where: { id?: string } }) => {
        const source = options.cards === undefined ? cards : options.cards;
        if (!source) return Promise.resolve(null);
        const key = query.where.id ?? 'default';
        return Promise.resolve(source[key] ?? null);
      },
    );
    self.dataSource = { manager: { findOne } };
    self.logger = { warn: jest.fn() };
    self.courierAcks = { flags: jest.fn().mockResolvedValue(new Map()) };
    return { service: self as unknown as FinanceServiceService, findOne };
  };

  type Detail = { data: Record<string, any> };

  const branchIncome = (extra: Record<string, unknown> = {}) => ({
    id: '293',
    cashbox_id: '1',
    cashbox: MAIN,
    source_type: Source_type.BRANCH_TO_MAIN,
    operation_type: Operation_type.INCOME,
    source_user_id: '15',
    created_by: '1',
    amount: 5_000_000,
    payment_method: PaymentMethod.CASH,
    card_id: null,
    transfer_source_user_id: null,
    ...extra,
  });

  it('⭐ naqd filial → HQ kirimi: source_branch — filial, karta va o`tkazma manbasi yo`q', async () => {
    const { service, findOne } = make(branchIncome());

    const res = (await service.findHistoryById('293')) as unknown as Detail;

    expect(res.data.source_branch).toEqual({
      id: '15',
      name: 'Samarqand filiali',
    });
    expect(res.data.card).toBeNull();
    expect(res.data.transfer_source_user).toBeNull();
    // Kiritgan xodim avvalgidek — `created_by_user`.
    expect(res.data.created_by_user).toMatchObject({ id: '1' });
    expect(findOne).not.toHaveBeenCalled();
  });

  it('⭐ CLICK nomli kartaga: card — faqat ko`rsatish maydonlari; o`tkazma manbasi — minimal foydalanuvchi', async () => {
    const { service } = make(
      branchIncome({
        payment_method: PaymentMethod.CLICK,
        card_id: '7',
        transfer_source_user_id: '25',
      }),
    );

    const res = (await service.findHistoryById('293')) as unknown as Detail;

    expect(res.data.card).toEqual({
      id: '7',
      name: 'Humo biznes',
      is_default: false,
      kind: 'plastic_card',
      bank_name: 'Kapitalbank',
      card_network: 'Humo',
      last4: '4821',
      holder_name: 'Elchi MCHJ',
    });
    expect(res.data.transfer_source_user).toEqual({
      id: '25',
      name: 'TEST Menejer',
      role: 'manager',
      phone_number: '+998900000025',
    });
  });

  it('CLICK, card_id = null — kassaning Asosiy kartasi; yozuvi yo`q bo`lsa nomi bilan (id: null)', async () => {
    const withDefault = make(
      branchIncome({ payment_method: PaymentMethod.CLICK }),
    );
    const res = (await withDefault.service.findHistoryById(
      '293',
    )) as unknown as Detail;
    expect(res.data.card).toMatchObject({
      id: '3',
      name: 'Asosiy karta',
      is_default: true,
    });
    expect(withDefault.findOne.mock.calls[0][1]).toEqual({
      where: { cashbox_id: '1', is_default: true, isDeleted: false },
    });

    const noRecord = make(
      branchIncome({ payment_method: PaymentMethod.CLICK }),
      {
        cards: null,
      },
    );
    const res2 = (await noRecord.service.findHistoryById(
      '293',
    )) as unknown as Detail;
    expect(res2.data.card).toMatchObject({
      id: null,
      name: 'Asosiy karta',
      is_default: true,
    });
  });

  it('kuryer / market kassasidagi CLICK qatori — karta yo`q (kartalar faqat MAIN / BRANCH da)', async () => {
    const { service, findOne } = make({
      id: '400',
      cashbox_id: '9',
      cashbox: {
        id: '9',
        user_id: '37',
        cashbox_type: Cashbox_type.FOR_MARKET,
      },
      source_type: Source_type.MARKET_PAYMENT,
      operation_type: Operation_type.INCOME,
      source_user_id: '37',
      payment_method: PaymentMethod.CLICK,
      card_id: null,
      amount: 100_000,
    });

    const res = (await service.findHistoryById('400')) as unknown as Detail;

    expect(res.data.card).toBeNull();
    expect(res.data.source_branch).toBeNull();
    expect(findOne).not.toHaveBeenCalled();
  });

  it('fail-open: filial nomi olinmasa — id qoladi, name null; tafsilot baribir chiqadi', async () => {
    const { service } = make(branchIncome(), { branchFails: true });

    const res = (await service.findHistoryById('293')) as unknown as Detail;

    expect(res.statusCode ?? 200).toBe(200);
    expect(res.data.source_branch).toEqual({ id: '15', name: null });
  });
});
