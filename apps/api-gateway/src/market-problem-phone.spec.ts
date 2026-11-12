import { BadRequestException } from '@nestjs/common';
import { lastValueFrom, Observable, of } from 'rxjs';
import { ApiGatewayController } from './api-gateway.controller';
import {
  marketContactsKey,
  ProblemContactsService,
} from './contacts/problem-contacts.service';

/**
 * (Dilshod 2026-11-12) Market «Qo'shimcha raqam» — chekdagi «Muammo bo'lsa»:
 *  - yoqiq market: `problem_contacts` = market raqami (`source: 'market'`),
 *    viloyat logisti / umumiy raqam o'rniga;
 *  - o'chiq / yo'q market yoki eski identity (`markets` yo'q) — avvalgidek;
 *  - market ham o'sha BITTA RPC'da (`market_ids`), kesh `m:<id>`;
 *  - `PATCH /admin/markets/:id` maydonlarni identity'ga uzatadi va market
 *    keshini tozalaydi.
 */
const LOGIST = {
  name: 'Andijon logisti',
  phone: '+998901112233',
  source: 'logist' as const,
};
const OWN = {
  name: 'TEST Market',
  phone: '+998935550011',
  source: 'market' as const,
};

const row = (over: Record<string, unknown> = {}) => ({
  id: '81',
  market_id: '37',
  customer_id: '29',
  region_id: '1',
  district_id: '10',
  ...over,
});

const replyWith = (markets?: Record<string, unknown[]>) => ({
  data: {
    regions: { '1': [LOGIST] },
    districts: { '10': [LOGIST] },
    fallback: [],
    ...(markets ? { markets } : {}),
  },
});

describe("Market «Qo'shimcha raqam» — gateway problem_contacts", () => {
  it('⭐ yoqiq market — market raqami; o`chiq market — viloyat logisti; bitta RPC', async () => {
    const identity = {
      send: jest.fn(() => of(replyWith({ '37': [OWN], '38': [] }))),
    };
    const service = new ProblemContactsService(identity as never);
    const rows = [row(), row({ id: '82', market_id: '38' })];
    await service.attach({ data: rows });

    expect(identity.send).toHaveBeenCalledTimes(1);
    expect(identity.send).toHaveBeenCalledWith(
      { cmd: 'identity.contacts.problem' },
      { region_ids: ['1'], district_ids: [], market_ids: ['37', '38'] },
    );
    expect((rows[0] as any).problem_contacts).toEqual([OWN]);
    expect((rows[1] as any).problem_contacts).toEqual([LOGIST]);
  });

  it('eski identity (`markets` yo`q) — avvalgidek viloyat logisti', async () => {
    const identity = { send: jest.fn(() => of(replyWith())) };
    const service = new ProblemContactsService(identity as never);
    const rows = [row()];
    await service.attach({ data: rows });
    expect((rows[0] as any).problem_contacts).toEqual([LOGIST]);
  });

  it('marketsiz qator (masalan eski pochta skani) — market so`ralmaydi', async () => {
    const identity = { send: jest.fn(() => of(replyWith())) };
    const service = new ProblemContactsService(identity as never);
    const rows = [{ id: '9', order_number: 'EL-1', region_id: '1' }];
    await service.attach({ data: { orders: rows } });
    expect(identity.send).toHaveBeenCalledWith(
      { cmd: 'identity.contacts.problem' },
      { region_ids: ['1'], district_ids: [] },
    );
    expect((rows[0] as any).problem_contacts).toEqual([LOGIST]);
  });

  it('pochta skani qisqa qatori `market_id` bilan — market raqami', async () => {
    const identity = { send: jest.fn(() => of(replyWith({ '37': [OWN] }))) };
    const service = new ProblemContactsService(identity as never);
    const rows = [
      { id: '9', order_number: 'EL-1', region_id: '1', market_id: '37' },
    ];
    await service.attach({ data: { orders: rows } });
    expect((rows[0] as any).problem_contacts).toEqual([OWN]);
  });

  it('⭐ kesh: market ham keshlanadi; forgetMarket — faqat shu market qayta so`raladi', async () => {
    const identity = {
      send: jest
        .fn()
        .mockReturnValueOnce(of(replyWith({ '37': [] })))
        .mockReturnValueOnce(of(replyWith({ '37': [OWN] }))),
    };
    const service = new ProblemContactsService(identity as never);
    const first = [row()];
    await service.attach({ data: first });
    expect((first[0] as any).problem_contacts).toEqual([LOGIST]);

    const cached = [row()];
    await service.attach({ data: cached });
    expect(identity.send).toHaveBeenCalledTimes(1);

    service.forgetMarket('37');
    const fresh = [row()];
    await service.attach({ data: fresh });
    expect(identity.send).toHaveBeenCalledTimes(2);
    expect(identity.send).toHaveBeenLastCalledWith(
      { cmd: 'identity.contacts.problem' },
      { region_ids: [], district_ids: [], market_ids: ['37'] },
    );
    expect((fresh[0] as any).problem_contacts).toEqual([OWN]);
  });

  it('resolveMany (printer qatorlari) — market_id bo`yicha override, tartib saqlanadi', async () => {
    const identity = {
      send: jest.fn(() => of(replyWith({ '37': [OWN], '40': [] }))),
    };
    const service = new ProblemContactsService(identity as never);
    const result = await service.resolveMany([
      { region_id: '1', market_id: '40' },
      { region_id: '1', market_id: '37' },
      { region_id: '1' },
    ]);
    expect(result).toEqual([[LOGIST], [OWN], [LOGIST]]);
  });

  it('market kaliti: market_id / marketId / market.id; noto`g`ri id — null', () => {
    expect(marketContactsKey({ market_id: '37' })).toBe('m:37');
    expect(marketContactsKey({ marketId: 38 })).toBe('m:38');
    expect(marketContactsKey({ market: { id: '39' } })).toBe('m:39');
    expect(marketContactsKey({ market_id: 'x' })).toBeNull();
    expect(marketContactsKey({})).toBeNull();
  });
});

describe("PATCH /admin/markets/:id — «Qo'shimcha raqam»", () => {
  type Send = jest.Mock<Observable<unknown>, [{ cmd: string }, unknown]>;
  const setup = () => {
    const identitySend: Send = jest.fn(() => of({ statusCode: 200, data: {} }));
    const forgetMarket = jest.fn();
    const controller = Object.create(
      ApiGatewayController.prototype,
    ) as ApiGatewayController & Record<string, unknown>;
    Object.assign(controller, {
      identityClient: { send: identitySend },
      problemContacts: { forgetMarket },
    });
    return { controller, identitySend, forgetMarket };
  };
  const req = { user: { sub: '2', roles: ['admin'] } } as any;

  it('⭐ maydonlar identity`ga uzatiladi va market keshi tozalanadi', async () => {
    const { controller, identitySend, forgetMarket } = setup();
    await lastValueFrom(
      controller.updateMarketExtraCost(
        '37',
        { problem_phone_enabled: true, problem_phone: '+998935550011' },
        req,
      ),
    );
    expect(identitySend).toHaveBeenCalledWith(
      { cmd: 'identity.market.update' },
      {
        id: '37',
        dto: { problem_phone_enabled: true, problem_phone: '+998935550011' },
        requester: expect.objectContaining({ id: '2' }),
      },
    );
    expect(forgetMarket).toHaveBeenCalledWith('37');
  });

  it('boshqa sozlama — kesh tegilmaydi; bo`sh tana — 400', async () => {
    const { controller, forgetMarket } = setup();
    await lastValueFrom(
      controller.updateMarketExtraCost(
        '37',
        { cashbox_debt_enabled: true },
        req,
      ),
    );
    expect(forgetMarket).not.toHaveBeenCalled();
    expect(() => controller.updateMarketExtraCost('37', {}, req)).toThrow(
      BadRequestException,
    );
  });

  it('problem_phone: null (o`chirish) ham uzatiladi', async () => {
    const { controller, identitySend } = setup();
    await lastValueFrom(
      controller.updateMarketExtraCost('37', { problem_phone: null }, req),
    );
    expect(identitySend).toHaveBeenCalledWith(
      { cmd: 'identity.market.update' },
      expect.objectContaining({ dto: { problem_phone: null } }),
    );
  });
});
