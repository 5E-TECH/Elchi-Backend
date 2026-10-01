import { RpcException } from '@nestjs/microservices';
import { Observable, of, throwError } from 'rxjs';
import { Cashbox_type } from '@app/common';
import { UserServiceService } from './user-service.service';
import type { RequesterContext } from './contracts/user.payloads';

/**
 * C8 — HQ (bosh ofis) ga menejer biriktirilmaydi.
 *
 * POST /managers identity createManager'ga keladi. Tekshiruv user
 * yaratilishidan OLDIN turishi shart: aks holda branch-service'ning rad
 * javobi saga orqali HTTP 500 bo'lib qaytadi, user esa yarim yaratilib,
 * soxta (mangled) telefon bilan o'chirilgan holda qolardi.
 */
const HQ_MANAGER_MESSAGE =
  "HQ (bosh ofis) ga menejer biriktirib bo'lmaydi. HQ ishlarini superadmin, admin va registratorlar bajaradi.";

type SendHandler = (
  pattern: { cmd: string },
  payload: unknown,
) => Observable<unknown>;

function makeService(branchSend: SendHandler) {
  const repo = {
    findOne: jest.fn().mockResolvedValue(null),
    create: jest.fn((value: Record<string, unknown>) => ({ ...value })),
    save: jest.fn((value: Record<string, unknown>) =>
      Promise.resolve({ id: 'new-manager', ...value }),
    ),
  };
  const noopClient = { send: jest.fn(), emit: jest.fn() };
  const branchClient = { send: jest.fn(branchSend), emit: jest.fn() };
  const financeClient = {
    send: jest.fn(() => of({ statusCode: 201, data: { id: 'cb-1' } })),
    emit: jest.fn(),
  };
  const bcrypt = {
    encrypt: jest.fn().mockResolvedValue('hashed'),
    compare: jest.fn(),
  };
  const activityLog = {
    log: jest.fn().mockResolvedValue(undefined),
    logChange: jest.fn().mockResolvedValue(undefined),
  };

  const service = new UserServiceService(
    repo as never,
    noopClient as never, // search
    noopClient as never, // catalog
    noopClient as never, // order
    noopClient as never, // logistics
    financeClient as never, // finance
    branchClient as never, // branch
    bcrypt as never,
    { get: jest.fn() } as never,
    activityLog as never,
  );
  return { service, repo, branchClient, financeClient, bcrypt };
}

/** branch.find_hq HQ id'sini, branch.user.assign — muvaffaqiyatni qaytaradi. */
const branchServiceWithHq =
  (hqId: string): SendHandler =>
  ({ cmd }) => {
    if (cmd === 'branch.find_hq') {
      return of({ statusCode: 200, data: { id: hqId, type: 'HQ' } });
    }
    if (cmd === 'branch.user.assign') {
      return of({ statusCode: 201, data: { id: 'bu-1' } });
    }
    return of({ data: null });
  };

const superadmin: RequesterContext = { id: '1', roles: ['superadmin'] };

const managerDto = (branchId: string) =>
  ({
    name: 'Yangi menejer',
    phone_number: '+998901112233',
    password: 'secret123',
    branch_id: branchId,
  }) as never;

async function rpcErrorOf(
  promise: Promise<unknown>,
): Promise<{ statusCode?: number; message?: string }> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(RpcException);
    return (error as RpcException).getError() as {
      statusCode?: number;
      message?: string;
    };
  }
  throw new Error('createManager rad etilishi kutilgandi');
}

const sentCmds = (client: { send: jest.Mock }) =>
  client.send.mock.calls.map(([pattern]) => (pattern as { cmd: string }).cmd);

describe('UserServiceService.createManager — HQ ga menejer yo‘q', () => {
  it("branch_id = HQ → 400 o'zbekcha xabar; user yozilmaydi, parol hashlanmaydi", async () => {
    const { service, repo, branchClient, financeClient, bcrypt } = makeService(
      branchServiceWithHq('1'),
    );

    const err = await rpcErrorOf(
      service.createManager(managerDto('1'), superadmin),
    );

    expect(err).toEqual(
      expect.objectContaining({ statusCode: 400, message: HQ_MANAGER_MESSAGE }),
    );
    // Tekshiruv ensurePhoneUnique va users.save'dan OLDIN.
    expect(repo.findOne).not.toHaveBeenCalled();
    expect(repo.save).not.toHaveBeenCalled();
    expect(bcrypt.encrypt).not.toHaveBeenCalled();
    expect(sentCmds(branchClient)).toEqual(['branch.find_hq']);
    expect(financeClient.send).not.toHaveBeenCalled();
  });

  it("boshqa filial → user saqlanadi, 'MANAGER' bilan biriktiriladi va filial kassasi yaratiladi", async () => {
    const { service, repo, branchClient, financeClient } = makeService(
      branchServiceWithHq('1'),
    );

    const res = await service.createManager(managerDto('15'), superadmin);

    expect(res.statusCode).toBe(201);
    expect(repo.save).toHaveBeenCalledTimes(1);
    expect(branchClient.send).toHaveBeenCalledWith(
      { cmd: 'branch.user.assign' },
      expect.objectContaining({
        dto: { branch_id: '15', user_id: 'new-manager', role: 'MANAGER' },
      }),
    );
    expect(financeClient.send).toHaveBeenCalledWith(
      { cmd: 'finance.cashbox.create' },
      expect.objectContaining({
        user_id: '15',
        cashbox_type: Cashbox_type.BRANCH,
      }),
    );
  });

  /**
   * Postgres '+1', ' 1 ', '0x1' kabi satrlarni ham bigint 1 ga (HQ'ga)
   * aylantiradi — satr taqqoslashi esa ularni HQ'dan farqli deb o'tkazib
   * yuborardi. Endi: faqat raqamlar, aks holda 400 "branch_id noto'g'ri",
   * branch-service'ga umuman murojaat qilinmaydi.
   */
  it.each([
    ['+1'],
    [' 1 '],
    [' 1'],
    ['1 '],
    ['0x1'],
    ['1e0'],
    ['-1'],
    ['1_0'],
    ['abc'],
  ])(
    'branch_id %p → 400 "branch_id noto\'g\'ri"; find_hq chaqirilmaydi, user yozilmaydi',
    async (branchId) => {
      const { service, repo, branchClient, financeClient, bcrypt } =
        makeService(branchServiceWithHq('1'));

      const err = await rpcErrorOf(
        service.createManager(managerDto(branchId), superadmin),
      );

      expect(err).toEqual(
        expect.objectContaining({
          statusCode: 400,
          message: "branch_id noto'g'ri",
        }),
      );
      expect(branchClient.send).not.toHaveBeenCalled();
      expect(repo.findOne).not.toHaveBeenCalled();
      expect(repo.save).not.toHaveBeenCalled();
      expect(bcrypt.encrypt).not.toHaveBeenCalled();
      expect(financeClient.send).not.toHaveBeenCalled();
    },
  );

  it.each([['01'], ['001'], ['0000000001']])(
    'branch_id %p kanonik ko‘rinishda HQ (1) ga teng → 400 HQ xabari',
    async (branchId) => {
      const { service, repo } = makeService(branchServiceWithHq('1'));

      const err = await rpcErrorOf(
        service.createManager(managerDto(branchId), superadmin),
      );

      expect(err).toEqual(
        expect.objectContaining({
          statusCode: 400,
          message: HQ_MANAGER_MESSAGE,
        }),
      );
      expect(repo.save).not.toHaveBeenCalled();
    },
  );

  it("HQ id'si branch-service'dan son (yoki nol bilan) kelsa ham kanonik solishtiriladi", async () => {
    const numericHq = makeService(({ cmd }) =>
      cmd === 'branch.find_hq'
        ? of({ statusCode: 200, data: { id: 1, type: 'HQ' } })
        : of({ data: null }),
    );
    const paddedHq = makeService(branchServiceWithHq('001'));

    const numericErr = await rpcErrorOf(
      numericHq.service.createManager(managerDto('1'), superadmin),
    );
    const paddedErr = await rpcErrorOf(
      paddedHq.service.createManager(managerDto('01'), superadmin),
    );

    expect(numericErr.message).toBe(HQ_MANAGER_MESSAGE);
    expect(paddedErr.message).toBe(HQ_MANAGER_MESSAGE);
    expect(numericHq.repo.save).not.toHaveBeenCalled();
    expect(paddedHq.repo.save).not.toHaveBeenCalled();
  });

  it("HQ bilan boshi o'xshash boshqa filial ('10', '100') ruxsat etiladi", async () => {
    for (const branchId of ['10', '100']) {
      const { service, repo } = makeService(branchServiceWithHq('1'));

      const res = await service.createManager(managerDto(branchId), superadmin);

      expect(res.statusCode).toBe(201);
      expect(repo.save).toHaveBeenCalledTimes(1);
    }
  });

  it("branch.find_hq raqamli bo'lmagan id qaytarsa → 502 (fail-closed), user yozilmaydi", async () => {
    const { service, repo } = makeService(branchServiceWithHq('hq'));

    const err = await rpcErrorOf(
      service.createManager(managerDto('15'), superadmin),
    );

    expect(err).toEqual(
      expect.objectContaining({
        statusCode: 502,
        message: 'Filial xizmati javob bermadi',
      }),
    );
    expect(repo.save).not.toHaveBeenCalled();
  });

  it("branch_id berilmasa tekshiruv o'tkazib yuboriladi (filialsiz menejer, find_hq yo'q)", async () => {
    const { service, repo, branchClient } = makeService(
      branchServiceWithHq('1'),
    );

    const res = await service.createManager(
      {
        name: 'Filialsiz menejer',
        phone_number: '+998901112244',
        password: 'secret123',
      } as never,
      superadmin,
    );

    expect(res.statusCode).toBe(201);
    expect(repo.save).toHaveBeenCalledTimes(1);
    expect(branchClient.send).not.toHaveBeenCalled();
  });

  it('branch.find_hq xato bersa → 502 "Filial xizmati javob bermadi", user yozilmaydi', async () => {
    const { service, repo } = makeService(({ cmd }) =>
      cmd === 'branch.find_hq'
        ? throwError(() => new Error('branch-service down'))
        : of({ data: null }),
    );

    const err = await rpcErrorOf(
      service.createManager(managerDto('15'), superadmin),
    );

    expect(err).toEqual(
      expect.objectContaining({
        statusCode: 502,
        message: 'Filial xizmati javob bermadi',
      }),
    );
    expect(repo.findOne).not.toHaveBeenCalled();
    expect(repo.save).not.toHaveBeenCalled();
  });
});
