import { Logger } from '@nestjs/common';
import { RpcException } from '@nestjs/microservices';
import {
  NotificationServiceService,
  toPublicTelegramMarket,
} from './notification-service.service';

/**
 * n0kLbx3d — ochiq Telegram relay yopildi:
 *  - REGISTRATOR faqat Elchi'da ulangan (telegram_markets) guruhlarga — begona
 *    `group_id` → 403;
 *  - payload `token` HECH QACHON ishlatilmaydi (faqat DB yoki env);
 *  - GET/POST/PATCH /notifications javoblarida bot tokeni yo'q (`has_token`),
 *    `isDeleted` ham yo'q.
 */
describe('NotificationServiceService — Telegram relay xavfsizligi (n0kLbx3d)', () => {
  let service: NotificationServiceService;
  let repo: any;
  let fetchMock: jest.Mock;

  const row = (overrides: Record<string, unknown> = {}) => ({
    id: '10',
    createdAt: new Date(0),
    updatedAt: new Date(0),
    isDeleted: false,
    market_id: '5',
    group_id: '-100555',
    group_type: 'create',
    token: '123456:SECRET_BOT_TOKEN',
    is_active: true,
    ...overrides,
  });

  const telegramOk = () =>
    fetchMock.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ ok: true, result: { message_id: 1 } }),
    });

  const usedTokens = () =>
    fetchMock.mock.calls.map((call: [string]) =>
      String(call[0])
        .replace(/^https:\/\/api\.telegram\.org\/bot/, '')
        .replace(/\/sendMessage$/, ''),
    );

  const errorOf = (promise: Promise<unknown>) =>
    promise.then(
      () => null,
      (err: unknown) => (err as RpcException).getError() as any,
    );

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    repo = {
      findOne: jest.fn(),
      find: jest.fn().mockResolvedValue([]),
      findAndCount: jest.fn(),
      save: jest.fn((entity: any) => Promise.resolve({ id: '11', ...entity })),
      create: jest.fn((value: any) => ({ ...value })),
    };
    service = new NotificationServiceService(
      repo,
      {
        // #3: bot tokeni DB'ga shifrlab yoziladi — kalit kerak.
        get: jest.fn(
          (key: string) =>
            ({
              TELEGRAM_BOT_TOKEN: 'ENV_TOKEN',
              TELEGRAM_TOKEN_ENC_KEY: 'cd'.repeat(32),
            })[key],
        ),
      } as any,
      {} as any,
      {
        log: jest.fn().mockResolvedValue(undefined),
        logChange: jest.fn().mockResolvedValue(undefined),
      } as any,
    );
    fetchMock = jest.fn();
    (global as any).fetch = fetchMock;
  });

  afterEach(() => jest.restoreAllMocks());

  describe('TC1: /notifications/send — registrator doirasi', () => {
    const registrator = { id: '77', roles: ['registrator'] };

    it('registrator + begona (ulanmagan) group_id → 403, Telegram’ga so‘rov KETMAYDI', async () => {
      repo.find.mockResolvedValue([]);
      const err = await errorOf(
        service.sendNotification({
          group_id: '-1001234567890',
          message: 'audit probe',
          requester: registrator,
        } as any),
      );
      expect(err).toEqual(
        expect.objectContaining({
          statusCode: 403,
          message: expect.stringContaining('ulanmagan'),
        }),
      );
      expect(fetchMock).not.toHaveBeenCalled();
      expect(repo.find).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            group_id: '-1001234567890',
            isDeleted: false,
            is_active: true,
          },
        }),
      );
    });

    it('registrator + ulangan market guruhi → yuboriladi (DB tokeni bilan), bir guruh bir marta', async () => {
      repo.find.mockResolvedValue([
        row(),
        row({ id: '12', group_type: 'cancel' }),
      ]);
      telegramOk();
      const res = await service.sendNotification({
        group_id: '-100555',
        message: 'ok',
        requester: registrator,
      } as any);
      expect(res?.data.success).toBe(1);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(usedTokens()).toEqual(['123456:SECRET_BOT_TOKEN']);
    });

    it('registrator + market_id → faqat o‘sha marketning ulangan guruhlari', async () => {
      repo.find.mockResolvedValue([row()]);
      telegramOk();
      await service.sendNotification({
        market_id: '5',
        message: 'ok',
        requester: registrator,
      } as any);
      expect(repo.find.mock.calls[0][0].where).toEqual(
        expect.objectContaining({ market_id: '5', is_active: true }),
      );
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it.each([
      ['superadmin', { id: '1', roles: ['superadmin'] }],
      ['admin', { id: '2', roles: ['ADMIN'] }],
      ['ichki RMQ (requester yo‘q)', undefined],
    ])(
      '%s — ixtiyoriy group_id cheklanmaydi (env bot)',
      async (_label, requester) => {
        telegramOk();
        const res = await service.sendNotification({
          group_id: '-100999',
          message: 'hi',
          requester,
        } as any);
        expect(res?.data.success).toBe(1);
        expect(repo.find).not.toHaveBeenCalled();
        expect(usedTokens()).toEqual(['ENV_TOKEN']);
      },
    );

    it('rolsiz requester — cheklangan (xavfsiz sukut)', async () => {
      const err = await errorOf(
        service.sendNotification({
          group_id: '-100999',
          message: 'hi',
          requester: { id: '3', roles: [] },
        } as any),
      );
      expect(err.statusCode).toBe(403);
    });
  });

  describe('payload `token` e’tiborsiz (n0kLbx3d #2)', () => {
    it('group_id + token → env bot ishlatiladi, payload tokeni HECH QACHON', async () => {
      telegramOk();
      await service.sendNotification({
        group_id: '-100999',
        message: 'hi',
        token: 'EVIL:TOKEN',
      } as any);
      expect(usedTokens()).toEqual(['ENV_TOKEN']);
    });

    it('market_id + token → DB tokeni, payload tokeni emas', async () => {
      repo.find.mockResolvedValue([row()]);
      telegramOk();
      await service.sendNotification({
        market_id: '5',
        message: 'hi',
        token: 'EVIL:TOKEN',
      } as any);
      expect(usedTokens()).toEqual(['123456:SECRET_BOT_TOKEN']);
    });
  });

  describe('TC3: javoblarda bot tokeni yo‘q (`has_token`), isDeleted yo‘q', () => {
    const assertPublic = (item: Record<string, unknown>, hasToken: boolean) => {
      expect(item).not.toHaveProperty('token');
      expect(item).not.toHaveProperty('isDeleted');
      expect(item.has_token).toBe(hasToken);
      expect(JSON.stringify(item)).not.toContain('SECRET_BOT_TOKEN');
    };

    it('GET /notifications (find_all) — har elementda token o‘rniga has_token; token faqat ataylab tanlanadi', async () => {
      repo.findAndCount.mockResolvedValue([
        [
          row(),
          row({ id: '11', token: null }),
          row({ id: '12', token: 'group_token-abcdef0123456789' }),
        ],
        3,
      ]);
      const res = await service.findAllTelegramMarkets({});
      const items = res?.data.items as Array<Record<string, unknown>>;
      assertPublic(items[0], true);
      assertPublic(items[1], false);
      // group_token-… — market tokeni, bot tokeni emas → has_token=false
      assertPublic(items[2], false);
      expect(Object.keys(items[0]).sort()).toEqual(
        [
          'createdAt',
          'group_id',
          'group_type',
          'has_token',
          'id',
          'is_active',
          'market_id',
          'updatedAt',
        ].sort(),
      );
      expect(repo.findAndCount.mock.calls[0][0].select).toEqual(
        expect.objectContaining({ token: true }),
      );
    });

    it('GET /notifications/:id, POST va PATCH javoblari ham tokensiz', async () => {
      repo.findOne.mockResolvedValueOnce(row());
      assertPublic(
        (await service.findTelegramMarketById('10'))?.data as any,
        true,
      );

      repo.findOne.mockResolvedValueOnce(null);
      const created = await service.createTelegramMarket({
        market_id: '5',
        group_id: '-100555',
        group_type: 'create',
        token: '123456:SECRET_BOT_TOKEN',
      } as any);
      assertPublic(created?.data as any, true);

      repo.findOne
        .mockResolvedValueOnce(row()) // resolveTelegramMarketTarget
        .mockResolvedValueOnce(null); // duplicate tekshiruvi
      const updated = await service.updateTelegramMarket({
        id: '10',
        is_active: false,
      } as any);
      assertPublic(updated?.data as any, true);
    });

    it('toPublicTelegramMarket — sof funksiya', () => {
      expect(toPublicTelegramMarket(row() as any)).toEqual({
        id: '10',
        createdAt: new Date(0),
        updatedAt: new Date(0),
        market_id: '5',
        group_id: '-100555',
        group_type: 'create',
        has_token: true,
        is_active: true,
      });
    });
  });
});
