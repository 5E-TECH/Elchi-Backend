import { Logger } from '@nestjs/common';
import { RpcException } from '@nestjs/microservices';
import { FindOperator } from 'typeorm';
import { NotificationServiceService } from './notification-service.service';
import {
  TELEGRAM_TOKEN_ENC_PREFIX,
  TelegramTokenCipher,
} from './telegram-token.cipher';

/**
 * n0kLbx3d #3 — `telegram_markets.token` DB'da shifrlangan saqlanadi:
 *  - repo'ga (save/update) faqat `enc:v1:…` ketadi, ochiq token HECH QACHON;
 *  - Telegram'ga yuborishda shifrdan ochilgan qiymat ishlatiladi;
 *  - prefikssiz (eski) qiymat — ochiq matn sifatida ishlaydi;
 *  - noto'g'ri kalit / buzilgan shifr — aniq xato, token matni chiqmaydi,
 *    platforma (env) botiga jimgina o'tilmaydi;
 *  - start'dagi backfill idempotent;
 *  - API javoblarida hamon faqat `has_token`.
 */
const KEY = '5e'.repeat(32);
const OTHER_KEY = '9f'.repeat(32);
const BOT_TOKEN = '7012345678:AAH9sQwErTyUiOpAsDfGhJkLzXcVbNm1234';
const PLAIN = '123456:SECRET_BOT_TOKEN_VALUE';

const sealWith = (key: string, plain: string) =>
  TelegramTokenCipher.fromEnv((k) =>
    k === 'TELEGRAM_TOKEN_ENC_KEY' ? key : undefined,
  ).encrypt(plain);

const openWith = (key: string, stored: string) =>
  TelegramTokenCipher.fromEnv((k) =>
    k === 'TELEGRAM_TOKEN_ENC_KEY' ? key : undefined,
  ).decrypt(stored);

describe('NotificationServiceService — bot tokeni DB’da shifrlangan (n0kLbx3d #3)', () => {
  let repo: any;
  let env: Record<string, string | undefined>;
  let fetchMock: jest.Mock;
  let warnSpy: jest.SpyInstance;
  let errorSpy: jest.SpyInstance;

  const row = (overrides: Record<string, unknown> = {}) => ({
    id: '10',
    createdAt: new Date(0),
    updatedAt: new Date(0),
    isDeleted: false,
    market_id: '5',
    group_id: '-100555',
    group_type: 'create',
    token: sealWith(KEY, PLAIN),
    is_active: true,
    ...overrides,
  });

  const makeService = () =>
    new NotificationServiceService(
      repo,
      { get: jest.fn((key: string) => env[key]) } as any,
      {} as any,
      {
        log: jest.fn().mockResolvedValue(undefined),
        logChange: jest.fn().mockResolvedValue(undefined),
      } as any,
    );

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
    warnSpy = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    errorSpy = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    env = { TELEGRAM_BOT_TOKEN: 'ENV_TOKEN', TELEGRAM_TOKEN_ENC_KEY: KEY };
    repo = {
      findOne: jest.fn(),
      find: jest.fn().mockResolvedValue([]),
      findAndCount: jest.fn(),
      save: jest.fn((entity: any) => Promise.resolve({ id: '11', ...entity })),
      create: jest.fn((value: any) => ({ ...value })),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
    };
    fetchMock = jest.fn();
    (global as any).fetch = fetchMock;
  });

  afterEach(() => jest.restoreAllMocks());

  describe('yozish: DB’ga ochiq matn tushmaydi', () => {
    it('POST /notifications — repo.save’ga enc:v1: ketadi, javobda faqat has_token', async () => {
      const service = makeService();
      repo.findOne.mockResolvedValueOnce(null);
      const res = await service.createTelegramMarket({
        market_id: '5',
        group_id: '-100555',
        group_type: 'create',
        token: PLAIN,
      } as any);

      const persisted = repo.save.mock.calls[0][0].token as string;
      expect(persisted.startsWith(TELEGRAM_TOKEN_ENC_PREFIX)).toBe(true);
      expect(JSON.stringify(repo.save.mock.calls)).not.toContain(PLAIN);
      expect(JSON.stringify(repo.create.mock.calls)).not.toContain(PLAIN);
      expect(openWith(KEY, persisted)).toBe(PLAIN);

      expect(res?.data).not.toHaveProperty('token');
      expect((res?.data as any).has_token).toBe(true);
      expect(JSON.stringify(res)).not.toContain(PLAIN);
      expect(JSON.stringify(res)).not.toContain(TELEGRAM_TOKEN_ENC_PREFIX);
    });

    it('POST tokensiz — token null', async () => {
      const service = makeService();
      repo.findOne.mockResolvedValueOnce(null);
      const res = await service.createTelegramMarket({
        market_id: '5',
        group_id: '-100555',
        group_type: 'create',
      } as any);
      expect(repo.save.mock.calls[0][0].token).toBeNull();
      expect((res?.data as any).has_token).toBe(false);
    });

    it('PATCH token — yangi enc:v1:; bo‘sh token → null; token berilmasa saqlangan shifr o‘zgarmaydi', async () => {
      const service = makeService();
      const stored = sealWith(KEY, 'OLD:TOKEN');

      repo.findOne
        .mockResolvedValueOnce(row({ token: stored }))
        .mockResolvedValueOnce(null);
      const updated = await service.updateTelegramMarket({
        id: '10',
        token: PLAIN,
      } as any);
      const persisted = repo.save.mock.calls[0][0].token as string;
      expect(persisted.startsWith(TELEGRAM_TOKEN_ENC_PREFIX)).toBe(true);
      expect(persisted).not.toBe(stored);
      expect(JSON.stringify(repo.save.mock.calls)).not.toContain(PLAIN);
      expect(openWith(KEY, persisted)).toBe(PLAIN);
      expect(updated?.data).not.toHaveProperty('token');

      repo.findOne
        .mockResolvedValueOnce(row({ token: stored }))
        .mockResolvedValueOnce(null);
      await service.updateTelegramMarket({ id: '10', token: '' } as any);
      expect(repo.save.mock.calls[1][0].token).toBeNull();

      repo.findOne
        .mockResolvedValueOnce(row({ token: stored }))
        .mockResolvedValueOnce(null);
      await service.updateTelegramMarket({ id: '10', is_active: false } as any);
      expect(repo.save.mock.calls[2][0].token).toBe(stored);
    });

    it('kalit umuman yo‘q — token saqlanmaydi (400, aniq xabar), ochiq matn yozilmaydi', async () => {
      env = { TELEGRAM_BOT_TOKEN: 'ENV_TOKEN' };
      const service = makeService();
      repo.findOne.mockResolvedValueOnce(null);
      const err = await errorOf(
        service.createTelegramMarket({
          market_id: '5',
          group_id: '-100555',
          group_type: 'create',
          token: PLAIN,
        } as any),
      );
      expect(err).toEqual(
        expect.objectContaining({
          statusCode: 400,
          message: expect.stringContaining('TELEGRAM_TOKEN_ENC_KEY'),
        }),
      );
      expect(err.message).not.toContain(PLAIN);
      expect(repo.save).not.toHaveBeenCalled();
    });

    it('TELEGRAM_TOKEN_ENC_KEY yo‘q, SMS_CREDENTIAL_SECRET bor — hosil qilingan kalit bilan shifrlanadi', async () => {
      env = {
        TELEGRAM_BOT_TOKEN: 'ENV_TOKEN',
        SMS_CREDENTIAL_SECRET: 'c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2',
      };
      const service = makeService();
      repo.findOne.mockResolvedValueOnce(null);
      await service.createTelegramMarket({
        market_id: '5',
        group_id: '-100555',
        group_type: 'create',
        token: PLAIN,
      } as any);
      const persisted = repo.save.mock.calls[0][0].token as string;
      expect(persisted.startsWith(TELEGRAM_TOKEN_ENC_PREFIX)).toBe(true);
      expect(
        TelegramTokenCipher.fromEnv((k) => env[k]).decrypt(persisted),
      ).toBe(PLAIN);
    });
  });

  describe('o‘qish: yuborishda shifrdan ochilgan token', () => {
    it('market_id → DB’dagi shifr ochiladi, Telegram’ga ochiq token', async () => {
      const service = makeService();
      repo.find.mockResolvedValue([row()]);
      telegramOk();
      const res = await service.sendNotification({
        market_id: '5',
        message: 'hi',
      } as any);
      expect(res?.data.success).toBe(1);
      expect(usedTokens()).toEqual([PLAIN]);
    });

    it('registrator + ulangan group_id → shifr ochiladi', async () => {
      const service = makeService();
      repo.find.mockResolvedValue([row()]);
      telegramOk();
      await service.sendNotification({
        group_id: '-100555',
        message: 'hi',
        requester: { id: '7', roles: ['registrator'] },
      } as any);
      expect(usedTokens()).toEqual([PLAIN]);
    });

    it('eski ochiq matnli qator (prefikssiz) — shundayligicha ishlaydi', async () => {
      const service = makeService();
      repo.find.mockResolvedValue([row({ token: PLAIN })]);
      telegramOk();
      await service.sendNotification({ market_id: '5', message: 'hi' } as any);
      expect(usedTokens()).toEqual([PLAIN]);
    });

    it('shifrlangan market tokeni (group_token-…) — bot tokeni emas: env bot, has_token=false', async () => {
      const service = makeService();
      const stored = sealWith(KEY, 'group_token-0123456789abcdef');
      repo.find.mockResolvedValue([row({ token: stored })]);
      telegramOk();
      await service.sendNotification({ market_id: '5', message: 'hi' } as any);
      expect(usedTokens()).toEqual(['ENV_TOKEN']);

      repo.findOne.mockResolvedValueOnce(row({ token: stored }));
      const one = await service.findTelegramMarketById('10');
      expect((one?.data as any).has_token).toBe(false);
    });

    it('noto‘g‘ri kalit — aniq xato, token chiqmaydi, env botiga jimgina o‘tilmaydi', async () => {
      const service = makeService();
      const foreign = sealWith(OTHER_KEY, PLAIN);
      repo.find.mockResolvedValue([row({ token: foreign })]);
      telegramOk();
      const res = await service.sendNotification({
        market_id: '5',
        message: 'hi',
      } as any);

      expect(fetchMock).not.toHaveBeenCalled();
      expect(res?.data).toEqual(
        expect.objectContaining({ success: 0, failed: 1 }),
      );
      const error = res?.data.results[0].error as string;
      expect(error).toMatch(/ochib bo'lmadi/);
      expect(error).toMatch(/TELEGRAM_TOKEN_ENC_KEY/);
      const dump = JSON.stringify(res) + JSON.stringify(errorSpy.mock.calls);
      expect(dump).not.toContain(PLAIN);
      expect(dump).not.toContain(foreign);
      expect(dump).not.toContain(TELEGRAM_TOKEN_ENC_PREFIX);
    });

    it('buzilgan shifr — aniq xato (token chiqmaydi)', async () => {
      const service = makeService();
      const parts = sealWith(KEY, PLAIN).split(':');
      const data = Buffer.from(parts[4], 'base64url');
      data[0] ^= 0xff; // ciphertext'ning bir bayti buzildi
      parts[4] = data.toString('base64url');
      const tampered = parts.join(':');
      repo.find.mockResolvedValue([row({ token: tampered })]);
      const res = await service.sendNotification({
        market_id: '5',
        message: 'hi',
      } as any);
      expect(fetchMock).not.toHaveBeenCalled();
      expect(res?.data.results[0]).toEqual(
        expect.objectContaining({
          ok: false,
          error: expect.stringMatching(/ochib bo'lmadi/),
        }),
      );
      expect(JSON.stringify(res)).not.toContain(PLAIN);
    });

    it('ochilmaydigan qator ro‘yxatni yiqitmaydi: GET /notifications → has_token=true, token yo‘q', async () => {
      const service = makeService();
      repo.findAndCount.mockResolvedValue([
        [
          row(),
          row({ id: '12', token: sealWith(OTHER_KEY, PLAIN) }),
          row({ id: '13', token: null }),
        ],
        3,
      ]);
      const res = await service.findAllTelegramMarkets({});
      const items = res?.data.items as Array<Record<string, unknown>>;
      expect(items.map((item) => item.has_token)).toEqual([true, true, false]);
      for (const item of items) {
        expect(item).not.toHaveProperty('token');
        expect(item).not.toHaveProperty('isDeleted');
      }
      expect(JSON.stringify(res)).not.toContain(TELEGRAM_TOKEN_ENC_PREFIX);
      expect(JSON.stringify(res)).not.toContain(PLAIN);
    });
  });

  describe('backfill (start’da) — idempotent', () => {
    /** Haqiqiy DB'ga o'xshash xotiradagi jadval: find/update holatni ko'radi. */
    const useTable = (rows: Array<{ id: string; token: string | null }>) => {
      const table = rows.map((item) => ({ ...item }));
      repo.find = jest.fn(() =>
        Promise.resolve(
          table
            .filter((item) => item.token !== null)
            .map((item) => ({ ...item })),
        ),
      );
      repo.update = jest.fn(
        (criteria: { id: string; token: string }, patch: { token: string }) => {
          const target = table.find(
            (item) => item.id === criteria.id && item.token === criteria.token,
          );
          if (!target) return Promise.resolve({ affected: 0 });
          target.token = patch.token;
          return Promise.resolve({ affected: 1 });
        },
      );
      return table;
    };

    it('ochiq qatorlar shifrlanadi, joriy shifrga tegilmaydi; ikkinchi ishga tushirish — 0 o‘zgarish', async () => {
      const current = sealWith(KEY, 'CURRENT:TOKEN');
      const table = useTable([
        { id: '1', token: PLAIN },
        { id: '2', token: current },
        { id: '3', token: 'group_token-0123456789abcdef' },
        { id: '4', token: null },
      ]);
      const service = makeService();

      const first = await service.encryptStoredTelegramTokens();
      expect(first).toEqual({
        skipped: false,
        encrypted: 2,
        reencrypted: 0,
        unreadable: 0,
      });
      expect(repo.find).toHaveBeenCalledWith({
        select: { id: true, token: true },
        where: { token: expect.any(FindOperator) },
      });
      // DB'da ochiq token qolmadi.
      for (const item of table) {
        if (item.token === null) continue;
        expect(item.token.startsWith(TELEGRAM_TOKEN_ENC_PREFIX)).toBe(true);
      }
      expect(JSON.stringify(table)).not.toContain(PLAIN);
      expect(openWith(KEY, table[0].token as string)).toBe(PLAIN);
      expect(table[1].token).toBe(current);
      expect(openWith(KEY, table[2].token as string)).toBe(
        'group_token-0123456789abcdef',
      );
      expect(table[3].token).toBeNull();

      // Shartli yangilash: id + eski qiymat; updatedAt o'zgartirilmaydi.
      const [criteria, patch] = repo.update.mock.calls[0];
      expect(criteria).toEqual({ id: '1', token: PLAIN });
      expect(typeof patch.updatedAt).toBe('function');
      expect(patch.updatedAt()).toBe('"updatedAt"');

      const snapshot = JSON.stringify(table);
      repo.update.mockClear();
      const second = await service.encryptStoredTelegramTokens();
      expect(second).toEqual({
        skipped: false,
        encrypted: 0,
        reencrypted: 0,
        unreadable: 0,
      });
      expect(repo.update).not.toHaveBeenCalled();
      expect(JSON.stringify(table)).toBe(snapshot);
    });

    it('hosil qilingan (fallback) kalitdagi shifr aniq kalitga qayta shifrlanadi; ochilmaydigani ustidan yozilmaydi', async () => {
      const derivedOnly = TelegramTokenCipher.fromEnv((k) =>
        k === 'TELEGRAM_BOT_TOKEN' ? BOT_TOKEN : undefined,
      ).encrypt(PLAIN);
      const foreign = sealWith(OTHER_KEY, PLAIN);
      const table = useTable([
        { id: '1', token: derivedOnly },
        { id: '2', token: foreign },
      ]);
      env = { TELEGRAM_BOT_TOKEN: BOT_TOKEN, TELEGRAM_TOKEN_ENC_KEY: KEY };
      const service = makeService();

      const res = await service.encryptStoredTelegramTokens();
      expect(res).toEqual({
        skipped: false,
        encrypted: 0,
        reencrypted: 1,
        unreadable: 1,
      });
      expect(openWith(KEY, table[0].token as string)).toBe(PLAIN);
      expect(table[1].token).toBe(foreign);
      expect(JSON.stringify(warnSpy.mock.calls)).not.toContain(PLAIN);
    });

    it('parallel yozuv (shartli update 0 qator) — hisoblanmaydi, xato emas', async () => {
      repo.find.mockResolvedValue([{ id: '1', token: PLAIN }]);
      repo.update.mockResolvedValue({ affected: 0 });
      const res = await makeService().encryptStoredTelegramTokens();
      expect(res.encrypted).toBe(0);
      expect(repo.update).toHaveBeenCalledTimes(1);
    });

    it('kalit yo‘q — backfill o‘tkazib yuboriladi (DB’ga tegilmaydi)', async () => {
      env = { TELEGRAM_BOT_TOKEN: 'ENV_TOKEN' };
      const res = await makeService().encryptStoredTelegramTokens();
      expect(res.skipped).toBe(true);
      expect(repo.find).not.toHaveBeenCalled();
      expect(repo.update).not.toHaveBeenCalled();
    });
  });

  describe('onModuleInit — kalit tanlash va start xulqi', () => {
    it('aniq kalit — WARN yo‘q, backfill ishlaydi', async () => {
      repo.find.mockResolvedValue([{ id: '1', token: PLAIN }]);
      await makeService().onModuleInit();
      expect(warnSpy).not.toHaveBeenCalled();
      expect(repo.update).toHaveBeenCalledTimes(1);
    });

    it('TELEGRAM_TOKEN_ENC_KEY yo‘q — hosil qilingan kalit + WARN (servis yiqilmaydi)', async () => {
      env = { TELEGRAM_BOT_TOKEN: BOT_TOKEN };
      await expect(makeService().onModuleInit()).resolves.toBeUndefined();
      const warned = JSON.stringify(warnSpy.mock.calls);
      expect(warned).toContain('TELEGRAM_TOKEN_ENC_KEY berilmagan');
      expect(warned).toContain('TELEGRAM_BOT_TOKEN');
      expect(warned).not.toContain(BOT_TOKEN);
      expect(repo.find).toHaveBeenCalled();
    });

    it('hech qanday kalit yo‘q — WARN, yiqilmaydi, backfill yo‘q', async () => {
      env = {};
      await expect(makeService().onModuleInit()).resolves.toBeUndefined();
      expect(JSON.stringify(warnSpy.mock.calls)).toContain('shifrlanmaydi');
      expect(repo.find).not.toHaveBeenCalled();
    });

    it('noto‘g‘ri formatdagi TELEGRAM_TOKEN_ENC_KEY — start xatosi (fail-fast)', async () => {
      env = { TELEGRAM_TOKEN_ENC_KEY: 'not-a-32-byte-key' };
      await expect(makeService().onModuleInit()).rejects.toThrow(
        /TELEGRAM_TOKEN_ENC_KEY noto'g'ri/,
      );
    });

    it('backfill DB xatosi servisni yiqitmaydi (ERROR log)', async () => {
      repo.find.mockRejectedValue(new Error('db down'));
      await expect(makeService().onModuleInit()).resolves.toBeUndefined();
      expect(JSON.stringify(errorSpy.mock.calls)).toContain('db down');
    });
  });
});
