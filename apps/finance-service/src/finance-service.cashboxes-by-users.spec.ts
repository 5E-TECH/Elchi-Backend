/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return */
import { RpcException } from '@nestjs/microservices';
import { Cashbox_type } from '@app/common';
import { LOOKUP_LIST_MAX_LIMIT } from '@app/common/pagination/list-limit';
import { FinanceServiceService } from './finance-service.service';

/**
 * Qidiruv limitlari (2026-11-27): gateway `GET /markets` (SA/admin) va `GET /couriers` endi 100 dan ortiq qator
 * qaytaradi — har qatorga alohida `finance.cashbox.find_by_user` (N+1) o'rniga `finance.cashbox.find_by_users`:
 * bitta turdagi kassalar bir so'rovda, `In()` 1000 talik bo'laklarda.
 */
describe('finance.cashbox.find_by_users — kassalar bitta so‘rovda', () => {
  const make = (rows: Array<Record<string, unknown>>) => {
    const find = jest.fn(({ where }: any) => {
      const ids: string[] = where.user_id.value;
      return Promise.resolve(
        rows.filter(
          (row) =>
            ids.includes(String(row.user_id)) &&
            row.cashbox_type === where.cashbox_type &&
            where.isDeleted === false,
        ),
      );
    });
    const service = Object.create(FinanceServiceService.prototype);
    service.cashboxRepo = { find };
    return { service, find };
  };

  it('faqat so‘ralgan turdagi kassalar; kassasi yo‘q id ro‘yxatda yo‘q; takror/noto‘g‘ri id tashlanadi', async () => {
    const { service, find } = make([
      {
        id: '1',
        user_id: '5',
        cashbox_type: Cashbox_type.FOR_MARKET,
        balance: 100,
      },
      {
        id: '2',
        user_id: '7',
        cashbox_type: Cashbox_type.FOR_MARKET,
        balance: -40,
      },
      {
        id: '3',
        user_id: '7',
        cashbox_type: Cashbox_type.FOR_COURIER,
        balance: 9,
      },
    ]);

    const res = await service.findCashboxesByUsers({
      user_ids: ['5', '7', '7', '0009', 'abc', '', null],
      cashbox_type: Cashbox_type.FOR_MARKET,
    });

    expect(
      res.data.items.map((row: any) => [row.user_id, row.balance]),
    ).toEqual([
      ['5', 100],
      ['7', -40],
    ]);
    expect(find).toHaveBeenCalledTimes(1);
    expect(find.mock.calls[0][0].where.user_id.value).toEqual(['5', '7', '9']);
  });

  it('1000 dan ortiq id — 1000 talik bo‘laklarda', async () => {
    const { service, find } = make([]);
    const ids = Array.from({ length: 2500 }, (_, index) => String(index + 1));

    const res = await service.findCashboxesByUsers({
      user_ids: ids,
      cashbox_type: Cashbox_type.FOR_COURIER,
    });

    expect(res.data.items).toEqual([]);
    expect(
      find.mock.calls.map(([arg]: any) => arg.where.user_id.value.length),
    ).toEqual([1000, 1000, 500]);
  });

  it('bo‘sh ro‘yxat — so‘rovsiz bo‘sh javob', async () => {
    const { service, find } = make([]);
    const res = await service.findCashboxesByUsers({
      user_ids: [],
      cashbox_type: Cashbox_type.FOR_MARKET,
    });
    expect(res.data.items).toEqual([]);
    expect(find).not.toHaveBeenCalled();
  });

  it('noto‘g‘ri tur yoki juda uzun ro‘yxat — 400', async () => {
    const { service } = make([]);
    await expect(
      service.findCashboxesByUsers({ user_ids: ['1'], cashbox_type: 'boshqa' }),
    ).rejects.toBeInstanceOf(RpcException);
    await expect(
      service.findCashboxesByUsers({
        user_ids: Array.from({ length: LOOKUP_LIST_MAX_LIMIT + 1 }, (_, i) =>
          String(i + 1),
        ),
        cashbox_type: Cashbox_type.FOR_MARKET,
      }),
    ).rejects.toBeInstanceOf(RpcException);
  });
});
