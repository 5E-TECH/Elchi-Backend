import { map, of, throwError, timer, NEVER, type Observable } from 'rxjs';
import { RpcException } from '@nestjs/microservices';
import { ActivityAction, Roles, Status } from '@app/common';
import { UserServiceService } from './user-service.service';
import type { RequesterContext } from './contracts/user.payloads';

/**
 * fix3b BE-2 — identity deleteUser (CODE-07 identity qismi):
 *
 * o'chirilgan MENEJER/REGISTRATORning faol branch_users qatori ham olib
 * tashlanadi (`branch.user.remove`, so'rovchi bilan). Best-effort: xato yoki
 * timeout faqat WARN log, user baribir o'chiriladi. Olib tashlash user
 * saqlangandan KEYIN — saqlash yiqilsa faol, lekin filialsiz xodim qolmaydi.
 *
 * revMyIKg: KURYER ham — avval assertCourierCanBeDeleted (pul/buyurtma bo'lsa
 * 409, qator va user o'z holicha), keyin xuddi shu yo'l. Yopish deleteUser
 * byudjeti (13 s, gateway 15 s) ichida: tekshiruv cho'zilsa, qolgan vaqt bilan.
 */
const FIND_CMD = 'branch.user.find_by_user';
const REMOVE_CMD = 'branch.user.remove';
const CHECK_CMD = 'branch.user.courier_transfer_check';

type Row = Record<string, unknown> & { id: string; role: Roles };
type SendHandler = (
  pattern: { cmd: string },
  payload: unknown,
) => Observable<unknown>;

const staffRow = (
  role: Roles,
  overrides: Record<string, unknown> = {},
): Row => ({
  id: '77',
  role,
  name: 'Filial xodimi',
  phone_number: '+998900000777',
  username: 'xodim77',
  status: Status.ACTIVE,
  isDeleted: false,
  ...overrides,
});

function makeService(rows: Row[], branchSend: SendHandler) {
  const byId = new Map<string, Row>(rows.map((row) => [row.id, { ...row }]));
  const events: string[] = [];
  const repo = {
    findOne: jest.fn(({ where }: { where: Record<string, unknown> }) => {
      const row = byId.get(String(where.id));
      return Promise.resolve(row && row.isDeleted === false ? row : null);
    }),
    save: jest.fn((value: Record<string, unknown>) => {
      events.push('user:save');
      return Promise.resolve({ ...value });
    }),
  };
  const makeClient = (reply: unknown) => ({
    send: jest.fn(() => of(reply)),
    emit: jest.fn(),
  });
  const branchClient = {
    send: jest.fn((pattern: { cmd: string }, payload: unknown) => {
      events.push(`branch:${pattern.cmd}`);
      return branchSend(pattern, payload);
    }),
    emit: jest.fn(),
  };
  const activityLog = {
    log: jest.fn(() => {
      events.push('audit');
      return Promise.resolve(undefined);
    }),
    logChange: jest.fn().mockResolvedValue(undefined),
  };

  const service = new UserServiceService(
    repo as never,
    makeClient({ ok: true }) as never, // search
    makeClient({ statusCode: 200 }) as never, // catalog
    makeClient({ data: null }) as never, // order
    makeClient({ data: null }) as never, // logistics
    makeClient({ data: null }) as never, // finance
    branchClient as never, // branch
    { encrypt: jest.fn(), compare: jest.fn() } as never,
    { get: jest.fn() } as never,
    activityLog as never,
  );
  const warn = jest
    .spyOn(
      (service as unknown as { logger: { warn: () => void } }).logger,
      'warn',
    )
    .mockImplementation(() => undefined);

  return { service, repo, events, branchClient, activityLog, warn };
}

const superadmin: RequesterContext = { id: '1', roles: ['superadmin'] };
const admin: RequesterContext = { id: '2', roles: ['admin'] };

const sentCmds = (client: { send: jest.Mock }) =>
  client.send.mock.calls.map(([pattern]) => (pattern as { cmd: string }).cmd);

/** find_by_user → `branchId` (null — qator yo'q); remove → `removeReply`. */
const branchReplies =
  (
    branchId: string | null,
    removeReply: () => Observable<unknown> = () =>
      of({ statusCode: 200, data: {} }),
  ): SendHandler =>
  ({ cmd }) => {
    if (cmd === FIND_CMD) {
      return of({
        statusCode: 200,
        data: branchId ? { branch_id: branchId, role: 'MANAGER' } : null,
      });
    }
    if (cmd === REMOVE_CMD) {
      return removeReply();
    }
    return of({ data: null });
  };

describe('fix3b CODE-07 — deleteUser menejer/registrator filial qatorini olib tashlaydi', () => {
  afterEach(() => jest.useRealTimers());

  it.each([[Roles.MANAGER], [Roles.REGISTRATOR]])(
    '%s: find_by_user → branch.user.remove {requester, branch_id, user_id}; user o‘chiriladi',
    async (role) => {
      const h = makeService([staffRow(role)], branchReplies('21'));

      const res = await h.service.deleteUser('77', admin);

      expect(res).toEqual({
        statusCode: 200,
        message: 'User o‘chirildi',
        data: { id: '77' },
      });
      expect(sentCmds(h.branchClient)).toEqual([FIND_CMD, REMOVE_CMD]);
      expect(h.branchClient.send).toHaveBeenNthCalledWith(
        1,
        { cmd: FIND_CMD },
        { user_id: '77', requester: { id: '77', roles: ['superadmin'] } },
      );
      expect(h.branchClient.send).toHaveBeenNthCalledWith(
        2,
        { cmd: REMOVE_CMD },
        { requester: admin, branch_id: '21', user_id: '77' },
      );
      expect(h.repo.save).toHaveBeenCalledWith(
        expect.objectContaining({
          id: '77',
          isDeleted: true,
          status: Status.INACTIVE,
        }),
      );
      expect(h.activityLog.log).toHaveBeenCalledWith(
        expect.objectContaining({
          entity_id: '77',
          action: ActivityAction.DELETED,
        }),
      );
      expect(h.warn).not.toHaveBeenCalled();
    },
  );

  it('qator user SAQLANGANDAN KEYIN olib tashlanadi (saqlash yiqilsa filial qatori qoladi)', async () => {
    const h = makeService([staffRow(Roles.MANAGER)], branchReplies('21'));

    await h.service.deleteUser('77', superadmin);

    expect(h.events).toEqual([
      'user:save',
      `branch:${FIND_CMD}`,
      `branch:${REMOVE_CMD}`,
      'audit',
    ]);
  });

  it('user saqlanmasa — branch.user.remove chaqirilmaydi', async () => {
    const h = makeService([staffRow(Roles.MANAGER)], branchReplies('21'));
    h.repo.save.mockRejectedValueOnce(new Error('db down'));

    await expect(h.service.deleteUser('77', superadmin)).rejects.toThrow(
      'db down',
    );
    expect(sentCmds(h.branchClient)).toEqual([]);
  });

  it('faol qator yo‘q — remove chaqirilmaydi, user o‘chiriladi', async () => {
    const h = makeService([staffRow(Roles.REGISTRATOR)], branchReplies(null));

    const res = await h.service.deleteUser('77', superadmin);

    expect(res.statusCode).toBe(200);
    expect(sentCmds(h.branchClient)).toEqual([FIND_CMD]);
    expect(h.warn).not.toHaveBeenCalled();
  });

  it.each([
    ['409 rad', () => throwError(() => ({ statusCode: 409, message: 'x' }))],
    [
      '404 (qator allaqachon yo‘q)',
      () =>
        throwError(() => ({
          statusCode: 404,
          message: 'Foydalanuvchi bu filialga biriktirilmagan',
        })),
    ],
    ['ulanish xatosi', () => throwError(() => new Error('connection closed'))],
  ])(
    'remove xatosi (%s) — WARN log, user baribir o‘chiriladi (200)',
    async (_label, removeReply) => {
      const h = makeService(
        [staffRow(Roles.MANAGER)],
        branchReplies('21', removeReply),
      );

      const res = await h.service.deleteUser('77', superadmin);

      expect(res.statusCode).toBe(200);
      expect(h.repo.save).toHaveBeenCalledTimes(1);
      expect(h.activityLog.log).toHaveBeenCalledTimes(1);
      expect(h.warn).toHaveBeenCalledWith(
        expect.stringContaining(
          'branch_users row (branch 21, user 77) was NOT removed',
        ),
      );
    },
  );

  it('find_by_user xatosi — WARN log, remove yo‘q, user o‘chiriladi', async () => {
    const h = makeService([staffRow(Roles.MANAGER)], ({ cmd }) =>
      cmd === FIND_CMD
        ? throwError(() => ({ statusCode: 503, message: 'down' }))
        : of({ data: null }),
    );

    const res = await h.service.deleteUser('77', superadmin);

    expect(res.statusCode).toBe(200);
    expect(sentCmds(h.branchClient)).toEqual([FIND_CMD]);
    expect(h.warn).toHaveBeenCalledWith(
      expect.stringContaining('branch.user.find_by_user failed for user 77'),
    );
  });

  it('find_by_user javob bermasa: 3 s dan keyin remove’siz o‘chirish tugaydi', async () => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'queueMicrotask'] });
    const h = makeService([staffRow(Roles.MANAGER)], () => NEVER);
    let settled = false;
    const outcome = h.service.deleteUser('77', superadmin).then((res) => {
      settled = true;
      return res;
    });

    await jest.advanceTimersByTimeAsync(2_999);
    expect(settled).toBe(false);
    await jest.advanceTimersByTimeAsync(1);
    const res = await outcome;

    expect(res.statusCode).toBe(200);
    expect(sentCmds(h.branchClient)).toEqual([FIND_CMD]);
  });

  it('remove javob bermasa: 5 s dan keyin o‘chirish tugaydi (3 s + 5 s < gateway 15 s)', async () => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'queueMicrotask'] });
    const h = makeService([staffRow(Roles.MANAGER)], ({ cmd }) =>
      cmd === FIND_CMD
        ? of({ statusCode: 200, data: { branch_id: '21' } })
        : NEVER,
    );
    let settled = false;
    const outcome = h.service.deleteUser('77', superadmin).then((res) => {
      settled = true;
      return res;
    });

    await jest.advanceTimersByTimeAsync(4_999);
    expect(settled).toBe(false);
    await jest.advanceTimersByTimeAsync(1);
    const res = await outcome;

    expect(res.statusCode).toBe(200);
    // (revMyIKg) Timeout — rad emas: branch-service qatorni baribir yopishi
    // mumkin, shuning uchun «NOT removed» deyilmaydi.
    expect(h.warn).toHaveBeenCalledTimes(1);
    expect(h.warn).toHaveBeenCalledWith(
      expect.stringContaining(
        'branch.user.remove (branch 21, user 77) got no reply in 5000 ms — branch-service may still close the branch_users row',
      ),
    );
    expect(h.warn).not.toHaveBeenCalledWith(
      expect.stringContaining('was NOT removed'),
    );
  });

  it.each([[Roles.MARKET], [Roles.ADMIN]])(
    '%s — filial chaqiruvi yo‘q',
    async (role) => {
      const h = makeService([staffRow(role)], branchReplies('21'));

      const res = await h.service.deleteUser('77', superadmin);

      expect(res.statusCode).toBe(200);
      expect(h.branchClient.send).not.toHaveBeenCalled();
    },
  );
});

/** Kuryer: tekshiruv `checkReply` (sukut — toza), keyin find_by_user / remove. */
const courierReplies =
  (
    branchId: string | null,
    options: {
      checkReply?: () => Observable<unknown>;
      removeReply?: () => Observable<unknown>;
      findReply?: () => Observable<unknown>;
    } = {},
  ): SendHandler =>
  (pattern, payload) => {
    if (pattern.cmd === CHECK_CMD) {
      return options.checkReply
        ? options.checkReply()
        : of({ statusCode: 200, data: { reasons: [], can_transfer: true } });
    }
    if (pattern.cmd === FIND_CMD && options.findReply) {
      return options.findReply();
    }
    return branchReplies(branchId, options.removeReply)(pattern, payload);
  };

async function rpcErrorOf(
  promise: Promise<unknown>,
): Promise<{ statusCode?: number; message?: string }> {
  const error = await promise.then(
    () => {
      throw new Error('rad etilishi kutilgandi');
    },
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(RpcException);
  return (error as RpcException).getError() as {
    statusCode?: number;
    message?: string;
  };
}

describe('revMyIKg — deleteUser kuryerning filial qatorini ham yopadi', () => {
  afterEach(() => jest.useRealTimers());

  it.each([[superadmin], [admin]])(
    'toza kuryer: tekshiruv → saqlash → find_by_user → branch.user.remove {requester, branch_id, user_id}; 200',
    async (requester) => {
      const h = makeService([staffRow(Roles.COURIER)], courierReplies('7'));

      const res = await h.service.deleteUser('77', requester);

      expect(res).toEqual({
        statusCode: 200,
        message: 'User o‘chirildi',
        data: { id: '77' },
      });
      expect(h.events).toEqual([
        `branch:${CHECK_CMD}`,
        'user:save',
        `branch:${FIND_CMD}`,
        `branch:${REMOVE_CMD}`,
        'audit',
      ]);
      expect(h.branchClient.send).toHaveBeenNthCalledWith(
        1,
        { cmd: CHECK_CMD },
        { user_id: '77', requester },
      );
      expect(h.branchClient.send).toHaveBeenNthCalledWith(
        2,
        { cmd: FIND_CMD },
        { user_id: '77', requester: { id: '77', roles: ['superadmin'] } },
      );
      expect(h.branchClient.send).toHaveBeenNthCalledWith(
        3,
        { cmd: REMOVE_CMD },
        { requester, branch_id: '7', user_id: '77' },
      );
      expect(h.repo.save).toHaveBeenCalledWith(
        expect.objectContaining({
          id: '77',
          isDeleted: true,
          status: Status.INACTIVE,
        }),
      );
      expect(h.warn).not.toHaveBeenCalled();
    },
  );

  it('kuryerning faol qatori yo‘q — remove chaqirilmaydi, user o‘chiriladi', async () => {
    const h = makeService([staffRow(Roles.COURIER)], courierReplies(null));

    const res = await h.service.deleteUser('77', superadmin);

    expect(res.statusCode).toBe(200);
    expect(sentCmds(h.branchClient)).toEqual([CHECK_CMD, FIND_CMD]);
    expect(h.warn).not.toHaveBeenCalled();
  });

  it.each([
    [
      'branch qayta tekshiruvi 409 (oraliqda pul paydo bo‘lgan)',
      () =>
        throwError(() => ({
          statusCode: 409,
          message:
            "Kuryerni filialdan chiqarib bo'lmaydi: kuryer qo'lida 10 000 so'm pul bor",
        })),
    ],
    [
      'branch qayta tekshiruvi 503',
      () => throwError(() => ({ statusCode: 503, message: 'down' })),
    ],
    ['ulanish xatosi', () => throwError(() => new Error('connection closed'))],
  ])(
    'remove xatosi (%s) — WARN log (sabab bilan), user baribir o‘chiriladi (200)',
    async (_label, removeReply) => {
      const h = makeService(
        [staffRow(Roles.COURIER)],
        courierReplies('7', { removeReply }),
      );

      const res = await h.service.deleteUser('77', superadmin);

      expect(res.statusCode).toBe(200);
      expect(h.repo.save).toHaveBeenCalledTimes(1);
      expect(h.activityLog.log).toHaveBeenCalledTimes(1);
      expect(h.warn).toHaveBeenCalledTimes(1);
      expect(h.warn).toHaveBeenCalledWith(
        expect.stringContaining(
          'branch_users row (branch 7, user 77) was NOT removed',
        ),
      );
    },
  );

  it('remove 409 sababi WARN matnida', async () => {
    const h = makeService(
      [staffRow(Roles.COURIER)],
      courierReplies('7', {
        removeReply: () =>
          throwError(() => ({ statusCode: 409, message: 'pul bor' })),
      }),
    );

    await h.service.deleteUser('77', superadmin);

    expect(h.warn).toHaveBeenCalledWith(
      expect.stringContaining('(409 pul bor)'),
    );
  });

  it('pul/buyurtmasi bor kuryer → 409, user saqlanmaydi, find_by_user/remove YO‘Q', async () => {
    const reasons = [
      "kuryer qo'lida 150 000 so'm pul bor — avval uni 'Samarqand' filiali menejeri qabul qilib olsin.",
    ];
    const h = makeService(
      [staffRow(Roles.COURIER)],
      courierReplies('7', {
        checkReply: () =>
          of({ statusCode: 200, data: { reasons, can_transfer: false } }),
      }),
    );

    const err = await rpcErrorOf(h.service.deleteUser('77', superadmin));

    expect(err.statusCode).toBe(409);
    expect(err.message).toBe("Kuryerni o'chirib bo'lmaydi: " + reasons[0]);
    expect(sentCmds(h.branchClient)).toEqual([CHECK_CMD]);
    expect(h.repo.save).not.toHaveBeenCalled();
    expect(h.activityLog.log).not.toHaveBeenCalled();
  });

  it('tekshiruv bajarilmasa → 503, find_by_user/remove YO‘Q', async () => {
    const h = makeService(
      [staffRow(Roles.COURIER)],
      courierReplies('7', {
        checkReply: () => throwError(() => ({ statusCode: 503, message: 'x' })),
      }),
    );

    const err = await rpcErrorOf(h.service.deleteUser('77', superadmin));

    expect(err.statusCode).toBe(503);
    expect(sentCmds(h.branchClient)).toEqual([CHECK_CMD]);
    expect(h.repo.save).not.toHaveBeenCalled();
  });

  it('byudjet: tekshiruv 11 s olsa, find_by_user faqat qolgan 2 s kutiladi (jami 13 s < gateway 15 s)', async () => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'queueMicrotask'] });
    const h = makeService(
      [staffRow(Roles.COURIER)],
      courierReplies('7', {
        checkReply: () =>
          timer(11_000).pipe(
            map(() => ({
              statusCode: 200,
              data: { reasons: [], can_transfer: true },
            })),
          ),
        findReply: () => NEVER,
      }),
    );
    let settled = false;
    const outcome = h.service.deleteUser('77', superadmin).then((res) => {
      settled = true;
      return res;
    });

    await jest.advanceTimersByTimeAsync(12_999);
    expect(settled).toBe(false);
    await jest.advanceTimersByTimeAsync(1);
    const res = await outcome;

    expect(res.statusCode).toBe(200);
    expect(sentCmds(h.branchClient)).toEqual([CHECK_CMD, FIND_CMD]);
    expect(h.warn).toHaveBeenCalledWith(
      expect.stringContaining('branch.user.find_by_user failed for user 77'),
    );
  });

  it('byudjet: tekshiruv 11 s olsa, remove ham qolgan vaqt bilan (jami 13 s)', async () => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'queueMicrotask'] });
    const h = makeService(
      [staffRow(Roles.COURIER)],
      courierReplies('7', {
        checkReply: () =>
          timer(11_000).pipe(
            map(() => ({
              statusCode: 200,
              data: { reasons: [], can_transfer: true },
            })),
          ),
        removeReply: () => NEVER,
      }),
    );
    let settled = false;
    const outcome = h.service.deleteUser('77', superadmin).then((res) => {
      settled = true;
      return res;
    });

    await jest.advanceTimersByTimeAsync(12_999);
    expect(settled).toBe(false);
    await jest.advanceTimersByTimeAsync(1);
    const res = await outcome;

    expect(res.statusCode).toBe(200);
    expect(sentCmds(h.branchClient)).toEqual([CHECK_CMD, FIND_CMD, REMOVE_CMD]);
    // Qolgan vaqt: 13 s − 11 s = 2 s. Timeout — «NOT removed» emas: branch-service
    // qayta tekshiruvdan keyin qatorni baribir yopishi mumkin.
    expect(h.warn).toHaveBeenCalledTimes(1);
    expect(h.warn).toHaveBeenCalledWith(
      expect.stringContaining(
        'branch.user.remove (branch 7, user 77) got no reply in 2000 ms — branch-service may still close the branch_users row; check the branch staff list',
      ),
    );
    expect(h.warn).not.toHaveBeenCalledWith(
      expect.stringContaining('was NOT removed'),
    );
  });

  it('byudjet tugagan bo‘lsa (< 0,5 s) filial chaqiruvi yuborilmaydi — WARN, 200', async () => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'queueMicrotask'] });
    const h = makeService(
      [staffRow(Roles.COURIER)],
      courierReplies('7', {
        checkReply: () =>
          timer(11_900).pipe(
            map(() => ({
              statusCode: 200,
              data: { reasons: [], can_transfer: true },
            })),
          ),
      }),
    );
    // Sekin baza: saqlash 700 ms → 12,6 s o'tdi, 0,4 s qoldi.
    h.repo.save.mockImplementationOnce(
      (value: Record<string, unknown>) =>
        new Promise((resolve) => {
          h.events.push('user:save');
          setTimeout(() => resolve({ ...value }), 700);
        }),
    );
    const outcome = h.service.deleteUser('77', superadmin);

    await jest.advanceTimersByTimeAsync(12_600);
    const res = await outcome;

    expect(res.statusCode).toBe(200);
    expect(sentCmds(h.branchClient)).toEqual([CHECK_CMD]);
    expect(h.warn).toHaveBeenCalledWith(
      expect.stringContaining(
        'no time left for branch.user.find_by_user (user 77)',
      ),
    );
  });

  it('menejer: byudjet amalda ta’sir qilmaydi — find 3 s + remove 5 s to‘liq kutiladi', async () => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'queueMicrotask'] });
    let findCalls = 0;
    const h = makeService([staffRow(Roles.MANAGER)], ({ cmd }) => {
      if (cmd === FIND_CMD) {
        findCalls += 1;
        return timer(2_900).pipe(
          map(() => ({ statusCode: 200, data: { branch_id: '21' } })),
        );
      }
      return NEVER;
    });
    let settled = false;
    const outcome = h.service.deleteUser('77', superadmin).then((res) => {
      settled = true;
      return res;
    });

    await jest.advanceTimersByTimeAsync(7_899);
    expect(settled).toBe(false);
    await jest.advanceTimersByTimeAsync(1);
    const res = await outcome;

    expect(res.statusCode).toBe(200);
    expect(findCalls).toBe(1);
    expect(sentCmds(h.branchClient)).toEqual([FIND_CMD, REMOVE_CMD]);
  });
});
