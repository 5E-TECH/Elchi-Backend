import 'reflect-metadata';
import { ForbiddenException } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { of } from 'rxjs';
import { FinanceGatewayController } from './finance-gateway.controller';
import {
  FindCashboxByUserQueryDto,
  FindHistoryQueryDto,
  HistoryDailyQueryDto,
} from './dto/finance.swagger.dto';

/**
 * KRN902pg — gateway: `payment_method` / `card_id` tarix filtrlari.
 *  • DTO (`forbidNonWhitelisted` ostida): ruxsat etilgan qiymatlar o'tadi,
 *    takrorlangan parametr vergulga qo'shiladi, noma'lum qiymat → 400;
 *  • faqat SA/admin/menejer/registrator — kuryer va market → 403
 *    (63HO6cBU: kuryer filial oyog'i qatorida usulni ko'rmaydi);
 *  • `history`, `history/daily`, `cashbox/user/:id` — filtr finance'ga boradi.
 */
const DTOS = [
  ['FindHistoryQueryDto', FindHistoryQueryDto],
  ['HistoryDailyQueryDto', HistoryDailyQueryDto],
  ['FindCashboxByUserQueryDto', FindCashboxByUserQueryDto],
] as const;

const errorsOf = async (
  dto: new () => object,
  plain: Record<string, unknown>,
) =>
  (
    await validate(plainToInstance(dto, plain), {
      whitelist: true,
      forbidNonWhitelisted: true,
    })
  ).map((error) => error.property);

describe('KRN902pg — DTO', () => {
  it.each(DTOS)('%s: ruxsat etilgan qiymatlar', async (_name, dto) => {
    for (const plain of [
      { payment_method: 'cash' },
      { payment_method: 'cash,click,click_to_market,none' },
      { card_id: '3' },
      { card_id: '3,12,none' },
      { card_id: 'none', payment_method: 'click' },
    ]) {
      expect(await errorsOf(dto, plain)).toEqual([]);
    }
  });

  it.each(DTOS)(
    '%s: takrorlangan parametr — vergul bilan',
    async (_name, dto) => {
      const instance = plainToInstance(dto, {
        payment_method: ['cash', 'click'],
        card_id: ['3', 'none'],
      }) as { payment_method?: string; card_id?: string };
      expect(instance.payment_method).toBe('cash,click');
      expect(instance.card_id).toBe('3,none');
      expect(await validate(instance as object)).toEqual([]);
    },
  );

  it.each(DTOS)('%s: noma`lum qiymat → xato (400)', async (_name, dto) => {
    for (const payment_method of ['card', 'cash,', 'CASH', 'cash;click']) {
      expect(await errorsOf(dto, { payment_method })).toEqual([
        'payment_method',
      ]);
    }
    for (const card_id of ['abc', '3,x', '-1', '1'.repeat(19)]) {
      expect(await errorsOf(dto, { card_id })).toEqual(['card_id']);
    }
  });
});

describe('KRN902pg — gateway yo`llari', () => {
  const make = (
    financeReply: unknown = { statusCode: 200, data: { items: [] } },
  ) => {
    const finance = { send: jest.fn(() => of(financeReply)) };
    const controller = new FinanceGatewayController(
      finance as never,
      { send: jest.fn(() => of({ data: {} })) } as never,
      {
        send: jest.fn(() => of({ statusCode: 200, data: { id: '13' } })),
      } as never,
      { send: jest.fn(() => of({})) } as never,
    );
    return { controller, finance };
  };
  const user = (roles: string[], extra: Record<string, unknown> = {}) =>
    ({ user: { sub: '9', roles, ...extra } }) as never as { user: never };
  const lastPayload = (finance: { send: jest.Mock }) =>
    (finance.send.mock.calls.at(-1) as unknown as [unknown, any])[1];

  it.each([[['courier']], [['market']]])(
    '%j: history, history/daily, cashbox/user — filtr bilan 403 (finance`ga bormaydi)',
    async (roles) => {
      const { controller, finance } = make();
      for (const query of [{ payment_method: 'cash' }, { card_id: 'none' }]) {
        await expect(
          controller.findHistory(query as never, user(roles)),
        ).rejects.toBeInstanceOf(ForbiddenException);
        await expect(
          controller.historyDaily(query as never, user(roles)),
        ).rejects.toBeInstanceOf(ForbiddenException);
        await expect(
          controller.findCashboxByUser('9', query as never, user(roles)),
        ).rejects.toBeInstanceOf(ForbiddenException);
      }
      expect(finance.send).not.toHaveBeenCalled();
    },
  );

  it('kuryer: filtrsiz tarix avvalgidek', async () => {
    const { controller, finance } = make();
    await controller.findHistory({}, user(['courier']));
    expect(lastPayload(finance)).toMatchObject({
      user_id: '9',
      cashbox_type: 'couriers',
    });
  });

  it.each([[['superadmin']], [['admin']]])(
    '%j: history — filtr finance`ga boradi',
    async (roles) => {
      const { controller, finance } = make();
      await controller.findHistory(
        {
          cashbox_type: 'main',
          payment_method: 'cash,click',
          card_id: '3,none',
        } as never,
        user(roles),
      );
      expect(lastPayload(finance)).toMatchObject({
        cashbox_type: 'main',
        payment_method: 'cash,click',
        card_id: '3,none',
      });
    },
  );

  it('menejer: o`z filiali tarixi + filtr', async () => {
    const { controller, finance } = make();
    await controller.findHistory(
      { payment_method: 'cash' },
      user(['manager'], { branch_id: '13' }),
    );
    expect(lastPayload(finance)).toMatchObject({
      user_id: '13',
      cashbox_type: 'branch',
      payment_method: 'cash',
    });
  });

  it('history/daily — filtr finance`ga boradi', async () => {
    const { controller, finance } = make({ statusCode: 200, data: {} });
    await controller.historyDaily(
      { cashbox_type: 'main', payment_method: 'click', card_id: '7' } as never,
      user(['admin']),
    );
    expect(lastPayload(finance)).toMatchObject({
      cashbox_type: 'main',
      payment_method: 'click',
      card_id: '7',
    });
  });

  it('cashbox/user/:id (kuryer kassasi) — filtr finance`ga boradi', async () => {
    const { controller, finance } = make({
      statusCode: 200,
      data: { cashbox: { id: '5', balance: 0 }, history: [] },
    });
    await controller.findCashboxByUser(
      '301',
      {
        cashbox_type: 'couriers',
        payment_method: 'cash',
        card_id: 'none',
      } as never,
      user(['superadmin']),
    );
    const call = finance.send.mock.calls.find(
      (args) =>
        (args as unknown as [{ cmd: string }])[0]?.cmd ===
        'finance.cashbox.find_by_user',
    ) as unknown as [unknown, any];
    expect(call[1]).toMatchObject({
      user_id: '301',
      cashbox_type: 'couriers',
      payment_method: 'cash',
      card_id: 'none',
    });
  });
});
