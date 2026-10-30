import { Logger } from '@nestjs/common';
import { RpcException } from '@nestjs/microservices';
import {
  NotificationServiceService,
  toPublicTelegramMarket,
} from './notification-service.service';
import {
  ENV_BOT_TOKEN,
  makeFetch,
  makeOutbox,
  usedTokens,
  type FetchMock,
} from './bot/testing/bot-kit-spec';

/**
 * n0kLbx3d + bOMYoOtV — ochiq Telegram relay yopildi:
 *  - REGISTRATOR faqat Elchi'da ulangan (telegram_markets) guruhlarga — begona
 *    `group_id` → 403 (gateway'da esa REGISTRATOR umuman 403, bOMYoOtV #3);
 *  - bot tokeni FAQAT env'dan: payload tokeni ham, DB'dagi eski `token` ham
 *    HECH QACHON ishlatilmaydi (bOMYoOtV #1);
 *  - GET/POST/PATCH /notifications javoblarida token yo'q (`has_token` ham
 *    olib tashlandi — `bot_slug`), `isDeleted` ham yo'q.
 * Transport HAQIQIY (BotTransportService + outbox), faqat fetch soxta.
 */
describe('NotificationServiceService — Telegram relay xavfsizligi (n0kLbx3d / bOMYoOtV)', () => {
  let service: NotificationServiceService;
  let repo: any;
  let fetchMock: FetchMock;

  const row = (overrides: Record<string, unknown> = {}) => ({
    id: '10',
    createdAt: new Date(0),
    updatedAt: new Date(0),
    isDeleted: false,
    market_id: '5',
    group_id: '-100555',
    group_type: 'create',
    // Eski qatorda qolgan DB tokeni — endi HECH QACHON o'qilmaydi.
    token: '123456:SECRET_BOT_TOKEN',
    bot_slug: null,
    is_active: true,
    ...overrides,
  });

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
    fetchMock = makeFetch();
    service = new NotificationServiceService(
      repo,
      {} as any,
      {
        log: jest.fn().mockResolvedValue(undefined),
        logChange: jest.fn().mockResolvedValue(undefined),
      } as any,
      makeOutbox(fetchMock).outbox,
      {} as never,
    );
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

    it('registrator + ulangan market guruhi → yuboriladi (env bot bilan), bir guruh bir marta', async () => {
      repo.find.mockResolvedValue([
        row(),
        row({ id: '12', group_type: 'cancel' }),
      ]);
      const res = await service.sendNotification({
        group_id: '-100555',
        message: 'ok',
        requester: registrator,
      } as any);
      expect((res?.data as { success?: number }).success).toBe(1);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(usedTokens(fetchMock)).toEqual([ENV_BOT_TOKEN]);
    });

    it('registrator + market_id → faqat o‘sha marketning ulangan guruhlari', async () => {
      repo.find.mockResolvedValue([row()]);
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
        const res = await service.sendNotification({
          group_id: '-100999',
          message: 'hi',
          requester,
        } as any);
        expect((res?.data as { success?: number }).success).toBe(1);
        expect(repo.find).not.toHaveBeenCalled();
        expect(usedTokens(fetchMock)).toEqual([ENV_BOT_TOKEN]);
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

  describe('bot tokeni FAQAT env (bOMYoOtV #1)', () => {
    it('group_id + payload token → env bot, payload tokeni HECH QACHON', async () => {
      await service.sendNotification({
        group_id: '-100999',
        message: 'hi',
        token: 'EVIL:TOKEN',
      } as any);
      expect(usedTokens(fetchMock)).toEqual([ENV_BOT_TOKEN]);
    });

    it('market_id → DB qatoridagi eski `token` ham emas, env bot (404 chiqmaydi)', async () => {
      repo.find.mockResolvedValue([
        row(),
        row({
          id: '13',
          group_id: '-100777',
          token: 'group_token-abcdef0123456789',
        }),
      ]);
      const res = await service.sendNotification({
        market_id: '5',
        message: 'hi',
        token: 'EVIL:TOKEN',
      } as any);
      expect(res?.statusCode).toBe(200);
      expect(usedTokens(fetchMock)).toEqual([ENV_BOT_TOKEN, ENV_BOT_TOKEN]);
      // O'qishda `token` ustuni umuman tanlanmaydi.
      expect(repo.find.mock.calls[0][0].select).not.toHaveProperty('token');
    });

    it('env tokeni yo‘q — tashqi so‘rov YO‘Q, 502', async () => {
      const noToken = makeFetch();
      const bare = new NotificationServiceService(
        repo,
        {} as any,
        { log: jest.fn(), logChange: jest.fn() } as any,
        makeOutbox(noToken, { env: {} }).outbox,
        {} as never,
      );
      const res = await bare.sendNotification({
        group_id: '-100999',
        message: 'hi',
      } as any);
      expect(noToken).not.toHaveBeenCalled();
      expect(res?.statusCode).toBe(502);
    });
  });

  describe('TC3: javoblarda bot tokeni yo‘q, isDeleted yo‘q', () => {
    const assertPublic = (item: Record<string, unknown>) => {
      expect(item).not.toHaveProperty('token');
      expect(item).not.toHaveProperty('has_token');
      expect(item).not.toHaveProperty('connect_token_hash');
      expect(item).not.toHaveProperty('isDeleted');
      expect(JSON.stringify(item)).not.toContain('SECRET_BOT_TOKEN');
    };

    it('GET /notifications (find_all) — token ustuni tanlanmaydi, javobda yo‘q', async () => {
      repo.findAndCount.mockResolvedValue([[row(), row({ id: '11' })], 2]);
      const res = await service.findAllTelegramMarkets({});
      const items = (res?.data as { items: unknown }).items as Array<
        Record<string, unknown>
      >;
      items.forEach(assertPublic);
      expect(Object.keys(items[0]).sort()).toEqual(
        [
          'bot_slug',
          'createdAt',
          'group_id',
          'group_type',
          'id',
          'inactive_at',
          'linked_by',
          'inactive_reason',
          'is_active',
          'market_id',
          'updatedAt',
        ].sort(),
      );
      const select = repo.findAndCount.mock.calls[0][0].select;
      expect(select).not.toHaveProperty('token');
      expect(select).not.toHaveProperty('connect_token_hash');
    });

    it('GET /notifications/:id, POST va PATCH javoblari ham tokensiz; POST token SAQLAMAYDI', async () => {
      repo.findOne.mockResolvedValueOnce(row());
      assertPublic((await service.findTelegramMarketById('10'))?.data as any);

      repo.findOne.mockResolvedValueOnce(null);
      const created = await service.createTelegramMarket({
        market_id: '5',
        group_id: '-100555',
        group_type: 'create',
        token: '123456:SECRET_BOT_TOKEN',
      } as any);
      assertPublic(created?.data as any);
      expect(repo.create.mock.calls[0][0]).not.toHaveProperty('token');

      repo.findOne
        .mockResolvedValueOnce(row()) // resolveTelegramMarketTarget
        .mockResolvedValueOnce(null); // duplicate tekshiruvi
      const updated = await service.updateTelegramMarket({
        id: '10',
        is_active: false,
        token: 'NEW:TOKEN',
      } as any);
      assertPublic(updated?.data as any);
    });

    it('toPublicTelegramMarket — sof funksiya', () => {
      expect(toPublicTelegramMarket(row() as any)).toEqual({
        id: '10',
        createdAt: new Date(0),
        updatedAt: new Date(0),
        market_id: '5',
        group_id: '-100555',
        group_type: 'create',
        bot_slug: null,
        is_active: true,
        inactive_reason: null,
        inactive_at: null,
        linked_by: null,
      });
    });
  });
});
