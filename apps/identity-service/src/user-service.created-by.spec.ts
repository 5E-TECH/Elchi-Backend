import { UserServiceService } from './user-service.service';
import type { RequesterContext } from './contracts/user.payloads';

/**
 * `users.created_by` — bigint (b64f0aa, manager egaligi uchun).
 *
 * MUAMMO. Integration partner market provisioning so'rovchini
 * `{ id: 'partner:2', roles: ['superadmin'] }` bilan yuboradi. Uni bigint
 * ustunga yozish Postgres xatosi bilan butun yaratishni yiqitardi →
 * POST /partner/markets prodda doim 502 ("Market yaratib bo'lmadi"),
 * ya'ni yangi sotuvchini ulab bo'lmasdi (zfPNDCCr testida topildi).
 */
function makeService() {
  const repo = {
    findOne: jest.fn().mockResolvedValue(null),
    create: jest.fn((value) => ({ ...value })),
    save: jest.fn((value) => Promise.resolve({ id: '41', ...value })),
  };
  const noopClient = { send: jest.fn(), emit: jest.fn() };
  const activityLog = {
    log: jest.fn().mockResolvedValue(undefined),
    logChange: jest.fn().mockResolvedValue(undefined),
  };
  const service = new UserServiceService(
    repo as any,
    noopClient as any, // search
    noopClient as any, // catalog
    noopClient as any, // order
    noopClient as any, // logistics
    noopClient as any, // finance
    noopClient as any, // branch
    { encrypt: jest.fn().mockResolvedValue('hash'), compare: jest.fn() } as any,
    { get: jest.fn() } as any,
    activityLog as any,
  );
  // Tashqi saga qadamlari bu test mavzusi emas.
  Object.assign(service as any, {
    ensurePhoneUnique: jest.fn().mockResolvedValue(undefined),
    ensureUsernameUnique: jest.fn().mockResolvedValue(undefined),
    ensureCreatedUserCashboxOrCompensate: jest
      .fn()
      .mockResolvedValue(undefined),
    syncUserToSearch: jest.fn().mockResolvedValue(undefined),
  });
  return { service, repo };
}

const dto = {
  name: 'TEST Partner Market',
  phone_number: '+998887009110',
  username: 'p2_seller_1',
  password: 'secret',
  tariff_home: 0,
  tariff_center: 0,
  default_tariff: 'center',
} as never;

describe('createMarket — created_by faqat raqamli so`rovchi id', () => {
  it("⭐ partner so'rovchisi ('partner:2') — market yaratiladi, created_by = null", async () => {
    const { service, repo } = makeService();
    const requester: RequesterContext = {
      id: 'partner:2',
      roles: ['superadmin'],
    };

    const res: any = await service.createMarket(dto, requester);

    expect(res.statusCode).toBe(201);
    expect(res.data.id).toBe('41');
    expect(repo.create).toHaveBeenCalledWith(
      expect.objectContaining({ created_by: null }),
    );
  });

  it('raqamli so`rovchi (manager 25) — egalik saqlanadi', async () => {
    const { service, repo } = makeService();

    await service.createMarket(dto, { id: '25', roles: ['superadmin'] });

    expect(repo.create).toHaveBeenCalledWith(
      expect.objectContaining({ created_by: '25' }),
    );
  });

  it("so'rovchisiz (ichki chaqiruv) — created_by = null", async () => {
    const { service, repo } = makeService();
    await service
      .createMarket(dto, { roles: ['superadmin'] } as RequesterContext)
      .catch(() => undefined);
    const call = repo.create.mock.calls[0]?.[0];
    if (call) expect(call.created_by).toBeNull();
  });
});
