import { RpcException } from '@nestjs/microservices';
import { of } from 'rxjs';
import { Roles, Status } from '@app/common';
import { User } from './entities/user.entity';
import {
  MARKET_TG_TOKEN_AUDIT_ACTION,
  MARKET_TG_TOKEN_ROTATE_ALL_ENTITY_ID,
  UserServiceService,
} from './user-service.service';
import { MARKET_TG_TOKEN_ROTATE_ALL_CONFIRM } from './contracts/market.payloads';

/**
 * (GvL6ZFAd) market_tg_token — bearer sir. Umumiy javoblarda YO'Q (sanitize),
 * ko'rish/rotatsiya — faqat SUPERADMIN RPC'lari:
 *  - identity.market.get_tg_token      → getMarketTelegramToken
 *  - identity.market.rotate_tg_token   → rotateMarketTelegramToken
 *  - identity.market.rotate_all_tg_tokens → rotateAllMarketTelegramTokens
 * Jurnalga faqat amal yoziladi — token qiymati hech qachon.
 */
const TOKEN = 'group_token-0123456789abcdef0123456789abcdef';
const TOKEN_RE = /^group_token-[a-f0-9]{32}$/;

type Row = Record<string, unknown> & { id: string; role: Roles };

const seedRows = (): Row[] => [
  {
    id: '3',
    role: Roles.MARKET,
    name: 'Yandex',
    status: Status.ACTIVE,
    isDeleted: false,
    password: '$2b$10$x',
    refresh_token: 'a'.repeat(64),
    market_tg_token: TOKEN,
  },
  {
    // INACTIVE market tokeni ham find_by_tg_token'da ishlaydi — rotate-all
    // uni ham almashtiradi.
    id: '4',
    role: Roles.MARKET,
    name: 'Nofaol market',
    status: Status.INACTIVE,
    isDeleted: false,
    market_tg_token: 'group_token-11111111111111111111111111111111',
  },
  {
    id: '6',
    role: Roles.MARKET,
    name: "O'chirilgan market",
    status: Status.INACTIVE,
    isDeleted: true,
    market_tg_token: 'group_token-22222222222222222222222222222222',
  },
  {
    id: '9',
    role: Roles.COURIER,
    name: 'Kuryer',
    status: Status.ACTIVE,
    isDeleted: false,
    market_tg_token: 'group_token-33333333333333333333333333333333',
  },
];

function rowMatches(row: Row, where: Record<string, unknown>): boolean {
  return Object.entries(where).every(
    ([key, value]) => value === undefined || row[key] === value,
  );
}

function makeService() {
  const rows = seedRows();

  const repo = {
    findOne: jest.fn(({ where }: { where: Record<string, unknown> }) =>
      Promise.resolve(
        rows.find((row) => rowMatches(row, where))
          ? { ...rows.find((row) => rowMatches(row, where)) }
          : null,
      ),
    ),
    update: jest.fn(
      (where: Record<string, unknown>, patch: Record<string, unknown>) => {
        const targets = rows.filter((row) => rowMatches(row, where));
        targets.forEach((row) => Object.assign(row, patch));
        return Promise.resolve({ affected: targets.length });
      },
    ),
    manager: {
      transaction: jest.fn(),
    },
  };

  // Tranzaksiya: yozuvlar avval nusxaga tushadi, callback muvaffaqiyatli
  // tugasagina asl qatorlarga ko'chiriladi (rollback'ni taqlid qiladi).
  const txRepo = {
    find: jest.fn(),
    update: jest.fn(),
  };
  const getRepository = jest.fn();
  repo.manager.transaction.mockImplementation(
    async (
      cb: (manager: { getRepository: typeof getRepository }) => unknown,
    ) => {
      const staged = rows.map((row) => ({ ...row }));
      txRepo.find.mockImplementation(
        ({ where }: { where: Record<string, unknown> }) =>
          Promise.resolve(
            staged
              .filter((row) => rowMatches(row, where))
              .map((row) => ({ id: row.id })),
          ),
      );
      txRepo.update.mockImplementation(
        (where: Record<string, unknown>, patch: Record<string, unknown>) => {
          const targets = staged.filter((row) => rowMatches(row, where));
          targets.forEach((row) => Object.assign(row, patch));
          return Promise.resolve({ affected: targets.length });
        },
      );
      getRepository.mockReturnValue(txRepo);
      const result = await cb({ getRepository });
      staged.forEach((row, index) => Object.assign(rows[index], row));
      return result;
    },
  );

  const client = { send: jest.fn(() => of({ data: {} })), emit: jest.fn() };
  const activityLog = {
    log: jest.fn().mockResolvedValue(undefined),
    logChange: jest.fn().mockResolvedValue(undefined),
  };

  const service = new UserServiceService(
    repo as never,
    client as never, // search
    client as never, // catalog
    client as never, // order
    client as never, // logistics
    client as never, // finance
    client as never, // branch
    { encrypt: jest.fn(), compare: jest.fn() } as never,
    { get: jest.fn() } as never,
    activityLog as never,
  );

  return { service, repo, rows, txRepo, getRepository, activityLog };
}

const superadmin = { id: '1', roles: ['superadmin'] };
const nonSuperadmins: Array<
  [string, { id: string; roles: string[] } | undefined]
> = [
  ['admin', { id: '2', roles: ['admin'] }],
  ['manager', { id: '19', roles: ['manager'] }],
  ['registrator', { id: '20', roles: ['registrator'] }],
  ['market (o‘zi ham)', { id: '3', roles: ['market'] }],
  ["requester yo'q (ichki chaqiruv)", undefined],
  ["id'siz superadmin", { id: '', roles: ['superadmin'] }],
];

async function rpcError(promise: Promise<unknown>) {
  const error: unknown = await promise.then(
    () => null,
    (err: unknown) => err,
  );
  expect(error).toBeInstanceOf(RpcException);
  return (error as RpcException).getError() as {
    statusCode?: number;
    message?: string;
  };
}

/** Jurnal chaqiruvlarida hech qanday token qiymati yo'q. */
function expectNoTokenInLogs(activityLog: { log: jest.Mock }) {
  expect(JSON.stringify(activityLog.log.mock.calls)).not.toContain(
    'group_token-',
  );
}

describe('sanitize — password, refresh_token, market_tg_token uchalasi olib tashlanadi (GvL6ZFAd)', () => {
  it('market qatori: uchala maxfiy kalit yo‘q, qolgan maydonlar joyida, asl obyekt o‘zgarmaydi', () => {
    const { service } = makeService();
    const row = {
      ...seedRows()[0],
      phone_number: '+998900000001',
    } as unknown as User;
    const sanitize = (
      service as unknown as {
        sanitize: (user: User) => Record<string, unknown>;
      }
    ).sanitize.bind(service);

    const safe = sanitize(row);

    expect(safe).not.toHaveProperty('password');
    expect(safe).not.toHaveProperty('refresh_token');
    expect(safe).not.toHaveProperty('market_tg_token');
    expect(safe).toEqual(
      expect.objectContaining({
        id: '3',
        name: 'Yandex',
        phone_number: '+998900000001',
      }),
    );
    expect(row.market_tg_token).toBe(TOKEN);
    expect(row.password).toBe('$2b$10$x');
  });

  it("eski sanitizeWithTgToken yo'li olib tashlangan", () => {
    const { service } = makeService();

    expect(
      (service as unknown as Record<string, unknown>).sanitizeWithTgToken,
    ).toBeUndefined();
  });
});

describe('getMarketTelegramToken — identity.market.get_tg_token (GvL6ZFAd)', () => {
  it('SUPERADMIN: { id, market_tg_token } qaytadi, ko‘rish jurnalga yoziladi (token qiymatisiz)', async () => {
    const { service, activityLog } = makeService();

    const res = await service.getMarketTelegramToken('3', superadmin);

    expect(res.statusCode).toBe(200);
    expect(res.data).toEqual({ id: '3', market_tg_token: TOKEN });
    expect(activityLog.log).toHaveBeenCalledTimes(1);
    expect(activityLog.log).toHaveBeenCalledWith(
      expect.objectContaining({
        entity_type: 'User',
        entity_id: '3',
        action: MARKET_TG_TOKEN_AUDIT_ACTION.VIEWED,
        user_id: '1',
        user_role: 'superadmin',
        metadata: { market_id: '3', has_token: true },
      }),
    );
    expectNoTokenInLogs(activityLog);
  });

  it("rol katta harfda ('SUPERADMIN') ham qabul qilinadi", async () => {
    const { service } = makeService();

    const res = await service.getMarketTelegramToken('3', {
      id: '1',
      roles: ['SUPERADMIN'],
    });

    expect(res.data.market_tg_token).toBe(TOKEN);
  });

  it.each(nonSuperadmins)(
    '%s → 403, DB o‘qilmaydi, jurnal yozilmaydi',
    async (_label, requester) => {
      const { service, repo, activityLog } = makeService();

      const error = await rpcError(
        service.getMarketTelegramToken('3', requester),
      );

      expect(error.statusCode).toBe(403);
      expect(repo.findOne).not.toHaveBeenCalled();
      expect(activityLog.log).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["mavjud bo'lmagan id", '999'],
    ["o'chirilgan market (is_deleted = true)", '6'],
    ['market emas (kuryer qatori)', '9'],
    ['raqam emas', 'abc'],
  ])('%s → 404', async (_label, id) => {
    const { service, activityLog } = makeService();

    const error = await rpcError(
      service.getMarketTelegramToken(id, superadmin),
    );

    expect(error.statusCode).toBe(404);
    expect(activityLog.log).not.toHaveBeenCalled();
  });

  it("tokeni yo'q market: market_tg_token null, has_token false", async () => {
    const { service, rows, activityLog } = makeService();
    rows[0].market_tg_token = null;

    const res = await service.getMarketTelegramToken('3', superadmin);

    expect(res.data).toEqual({ id: '3', market_tg_token: null });
    expect(activityLog.log).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: { market_id: '3', has_token: false },
      }),
    );
  });
});

describe('rotateMarketTelegramToken — identity.market.rotate_tg_token (GvL6ZFAd)', () => {
  it('SUPERADMIN: yangi token yoziladi (nuqtali UPDATE) va qaytadi; eski token endi topilmaydi', async () => {
    const { service, repo, rows, activityLog } = makeService();

    const res = await service.rotateMarketTelegramToken('3', superadmin);

    expect(res.statusCode).toBe(200);
    expect(res.data.id).toBe('3');
    expect(res.data.market_tg_token).toMatch(TOKEN_RE);
    expect(res.data.market_tg_token).not.toBe(TOKEN);
    expect(repo.update).toHaveBeenCalledWith(
      { id: '3', role: Roles.MARKET, isDeleted: false },
      { market_tg_token: res.data.market_tg_token },
    );
    expect(rows[0].market_tg_token).toBe(res.data.market_tg_token);

    const oldLookup = await rpcError(service.findMarketByTelegramToken(TOKEN));
    expect(oldLookup.statusCode).toBe(404);

    expect(activityLog.log).toHaveBeenCalledTimes(1);
    expect(activityLog.log).toHaveBeenCalledWith(
      expect.objectContaining({
        entity_type: 'User',
        entity_id: '3',
        action: MARKET_TG_TOKEN_AUDIT_ACTION.ROTATED,
        user_id: '1',
        metadata: { market_id: '3', rotated: true },
      }),
    );
    expectNoTokenInLogs(activityLog);
  });

  it.each(nonSuperadmins)(
    '%s → 403, hech narsa yozilmaydi',
    async (_label, requester) => {
      const { service, repo, rows, activityLog } = makeService();

      const error = await rpcError(
        service.rotateMarketTelegramToken('3', requester),
      );

      expect(error.statusCode).toBe(403);
      expect(repo.update).not.toHaveBeenCalled();
      expect(rows[0].market_tg_token).toBe(TOKEN);
      expect(activityLog.log).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["o'chirilgan market", '6'],
    ['kuryer qatori', '9'],
    ["mavjud bo'lmagan id", '999'],
  ])('%s → 404, UPDATE yo‘q', async (_label, id) => {
    const { service, repo } = makeService();

    const error = await rpcError(
      service.rotateMarketTelegramToken(id, superadmin),
    );

    expect(error.statusCode).toBe(404);
    expect(repo.update).not.toHaveBeenCalled();
  });

  it("o'qish va yozish orasida o'chirilgan (affected 0) → 404, jurnal yo'q", async () => {
    const { service, repo, activityLog } = makeService();
    repo.update.mockResolvedValueOnce({ affected: 0 });

    const error = await rpcError(
      service.rotateMarketTelegramToken('3', superadmin),
    );

    expect(error.statusCode).toBe(404);
    expect(activityLog.log).not.toHaveBeenCalled();
  });

  it('DB xatosi → 503 RpcException (navbatga qayta qo‘yilmaydi), jurnal yo‘q', async () => {
    const { service, repo, activityLog } = makeService();
    repo.update.mockRejectedValueOnce(new Error('connection reset'));

    const error = await rpcError(
      service.rotateMarketTelegramToken('3', superadmin),
    );

    expect(error.statusCode).toBe(503);
    expect(activityLog.log).not.toHaveBeenCalled();
  });
});

describe('rotateAllMarketTelegramTokens — identity.market.rotate_all_tg_tokens (GvL6ZFAd)', () => {
  it("contract: tasdiq qiymati 'ROTATE_ALL'", () => {
    expect(MARKET_TG_TOKEN_ROTATE_ALL_CONFIRM).toBe('ROTATE_ALL');
  });

  it.each([
    ["confirm yo'q", undefined],
    ['kichik harf', 'rotate_all'],
    ['boshqa satr', 'YES'],
    ['boolean', true],
    ["bo'shliq bilan", ' ROTATE_ALL'],
  ])(
    'SUPERADMIN, %s → 400, tranzaksiya ochilmaydi',
    async (_label, confirm) => {
      const { service, repo, activityLog } = makeService();

      const error = await rpcError(
        service.rotateAllMarketTelegramTokens(confirm, superadmin),
      );

      expect(error.statusCode).toBe(400);
      expect(repo.manager.transaction).not.toHaveBeenCalled();
      expect(activityLog.log).not.toHaveBeenCalled();
    },
  );

  it.each(nonSuperadmins)(
    "%s (to'g'ri confirm bilan ham) → 403",
    async (_label, requester) => {
      const { service, repo } = makeService();

      const error = await rpcError(
        service.rotateAllMarketTelegramTokens(
          MARKET_TG_TOKEN_ROTATE_ALL_CONFIRM,
          requester,
        ),
      );

      expect(error.statusCode).toBe(403);
      expect(repo.manager.transaction).not.toHaveBeenCalled();
    },
  );

  it("SUPERADMIN + confirm: barcha faol marketlar (INACTIVE ham) bitta tranzaksiyada, javobda faqat son; o'chirilgan market va xodim qatori tegilmaydi", async () => {
    const { service, repo, rows, txRepo, getRepository, activityLog } =
      makeService();
    const before = rows.map((row) => row.market_tg_token);

    const res = await service.rotateAllMarketTelegramTokens(
      MARKET_TG_TOKEN_ROTATE_ALL_CONFIRM,
      superadmin,
    );

    expect(res.statusCode).toBe(200);
    expect(res.data).toEqual({ rotated_count: 2 });
    expect(JSON.stringify(res)).not.toContain('group_token-');

    expect(repo.manager.transaction).toHaveBeenCalledTimes(1);
    expect(getRepository).toHaveBeenCalledWith(User);
    expect(txRepo.find).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { role: Roles.MARKET, isDeleted: false },
      }),
    );
    // Asosiy repo orqali (tranzaksiyadan tashqarida) hech narsa yozilmaydi.
    expect(repo.update).not.toHaveBeenCalled();

    const [market3, market4, deletedMarket, courier] = rows;
    expect(market3.market_tg_token).toMatch(TOKEN_RE);
    expect(market4.market_tg_token).toMatch(TOKEN_RE);
    expect(market3.market_tg_token).not.toBe(before[0]);
    expect(market4.market_tg_token).not.toBe(before[1]);
    expect(market3.market_tg_token).not.toBe(market4.market_tg_token);
    expect(deletedMarket.market_tg_token).toBe(before[2]);
    expect(courier.market_tg_token).toBe(before[3]);

    expect(activityLog.log).toHaveBeenCalledTimes(1);
    expect(activityLog.log).toHaveBeenCalledWith(
      expect.objectContaining({
        entity_type: 'User',
        entity_id: MARKET_TG_TOKEN_ROTATE_ALL_ENTITY_ID,
        action: MARKET_TG_TOKEN_AUDIT_ACTION.ROTATED_ALL,
        user_id: '1',
        metadata: { rotated_count: 2 },
      }),
    );
    expectNoTokenInLogs(activityLog);
  });

  it("tranzaksiya o'rtasida xato → 503, hech bir token o'zgarmaydi (rollback), jurnal yo'q", async () => {
    const { service, rows, txRepo, repo, activityLog } = makeService();
    const before = rows.map((row) => row.market_tg_token);
    const original = repo.manager.transaction.getMockImplementation()!;
    repo.manager.transaction.mockImplementationOnce((cb: never) => {
      const pending = original(cb);
      // Birinchi UPDATE nusxaga yoziladi, ikkinchisi yiqiladi.
      const stagedUpdate = txRepo.update.getMockImplementation()!;
      txRepo.update
        .mockImplementationOnce(stagedUpdate)
        .mockImplementationOnce(() => Promise.reject(new Error('deadlock')));
      return pending;
    });

    const error = await rpcError(
      service.rotateAllMarketTelegramTokens(
        MARKET_TG_TOKEN_ROTATE_ALL_CONFIRM,
        superadmin,
      ),
    );

    expect(error.statusCode).toBe(503);
    expect(rows.map((row) => row.market_tg_token)).toEqual(before);
    expect(activityLog.log).not.toHaveBeenCalled();
  });
});
