import { Logger } from '@nestjs/common';
import { RpcException } from '@nestjs/microservices';
import { of, throwError } from 'rxjs';
import {
  NOTIFICATION_SMS_DELIVERY_STATUS_PATTERN,
  NOTIFICATION_SMS_TEMP_PASSWORD_PATTERN,
  OLD_PASSWORD_INVALID,
  OLD_PASSWORD_REQUIRED,
  PASSWORD_SMS_COOLDOWN,
  PASSWORD_SMS_DAILY_LIMIT,
  Roles,
  Status,
} from '@app/common';
import { RequesterContext } from './contracts/user.payloads';
import { TempPasswordService } from './temp-password/temp-password.service';
import { UserServiceService } from './user-service.service';

/**
 * (aidsxJ2H) Foydalanuvchi yaratishda tasodifiy parol + SMS:
 *  - `generate_sms` (sukut): parol tizimniki, DB'da faqat hash, javobda /
 *    logda / faoliyat jurnalida YO'Q; SMS faqat notification orqali
 *    (`notification.sms.send_temp_password`, qayta urinishsiz);
 *  - SMS xatosi yaratishni buzmaydi — `password_sms.status: failed` + sabab;
 *  - qayta yuborish: huquq, 60 s / kuniga 5 (429), yangi parol + sessiyalar;
 *  - resend'da SMS navbatga tushmasa eski parol va sessiyalar saqlanadi;
 *  - o'z parolini almashtirish (US:1548): `old_password` doim tekshiriladi,
 *    majburiyligi — `PASSWORD_CHANGE_REQUIRE_OLD` (sukut o'chiq, hozirgi FE
 *    `{ password }` yuboradi); bayroqlar tushadi.
 */
type Row = Record<string, unknown>;

const HASH = '$2b$12$opaque-test-hash';

function makeHarness(
  options: {
    existing?: Row | null;
    notify?: (pattern: { cmd: string }, payload: Row) => unknown;
    lastSend?: Row | null;
    resendsToday?: number;
    config?: Record<string, string>;
  } = {},
) {
  const saves: Row[] = [];
  const repo = {
    findOne: jest.fn(() =>
      Promise.resolve(options.existing ? { ...options.existing } : null),
    ),
    find: jest.fn(() => Promise.resolve([])),
    count: jest.fn(() => Promise.resolve(0)),
    create: jest.fn((value: Row) => ({ ...value })),
    save: jest.fn((value: Row) => {
      saves.push({ ...value });
      return Promise.resolve({ id: '700', ...value });
    }),
    update: jest.fn(() => Promise.resolve({ affected: 1 })),
    manager: {
      transaction: jest.fn((work: (manager: unknown) => unknown) =>
        work(txManager),
      ),
    },
  };
  const sendRows: Row[] = [];
  const sendsRepo = {
    find: jest.fn(() =>
      Promise.resolve(options.lastSend ? [{ ...options.lastSend }] : []),
    ),
    count: jest.fn(() => Promise.resolve(options.resendsToday ?? 0)),
    create: jest.fn((value: Row) => ({ ...value })),
    save: jest.fn((value: Row) => {
      const row = {
        id: String(sendRows.length + 1),
        created_at: new Date(),
        ...value,
      };
      sendRows.push(row);
      return Promise.resolve(row);
    }),
    update: jest.fn(() => Promise.resolve({ affected: 1 })),
  };
  const txManager = {
    query: jest.fn(() => Promise.resolve([])),
    getRepository: jest.fn(() => sendsRepo),
  };
  const notifyCalls: Array<{ pattern: { cmd: string }; payload: Row }> = [];
  const notification = {
    send: jest.fn((pattern: { cmd: string }, payload: Row) => {
      notifyCalls.push({ pattern, payload });
      const result = options.notify
        ? options.notify(pattern, payload)
        : {
            client_message_id: payload.client_message_id,
            status: 'pending',
            failure_reason: null,
          };
      return result instanceof Error ? throwError(() => result) : of(result);
    }),
    emit: jest.fn(),
  };
  const ok = {
    send: jest.fn(() => of({ statusCode: 200, data: { id: '3' } })),
    emit: jest.fn(),
  };
  const encrypt = jest.fn(() => Promise.resolve(HASH));
  const compare = jest.fn((plain: string, hash: string) =>
    Promise.resolve(hash === `hash-of:${plain}`),
  );
  const activityLog = {
    log: jest.fn().mockResolvedValue(undefined),
    logChange: jest.fn().mockResolvedValue(undefined),
  };
  const tempPasswords = new TempPasswordService(
    sendsRepo as never,
    notification as never,
    activityLog as never,
  );
  const authSessions = {
    afterPasswordChange: jest.fn(() =>
      Promise.resolve({ session_ids: ['s-1'], kept_session_id: null }),
    ),
    revokeStaleEpoch: jest.fn(() => Promise.resolve()),
  };
  const service = new UserServiceService(
    repo as never,
    ok as never, // search
    ok as never, // catalog
    ok as never, // order
    ok as never, // logistics
    ok as never, // finance
    ok as never, // branch
    { encrypt, compare } as never,
    { get: jest.fn((key: string) => options.config?.[key]) } as never,
    activityLog as never,
    authSessions as never,
    undefined, // contacts (QPq2C1co)
    tempPasswords,
  );
  return {
    service,
    saves,
    repo,
    sendsRepo,
    sendRows,
    notifyCalls,
    encrypt,
    compare,
    activityLog,
    authSessions,
    txManager,
  };
}

const superadmin: RequesterContext = { id: '1', roles: ['superadmin'] };
const courierDto = {
  name: 'TEST Claude Kuryer SMS',
  phone_number: '+998935557711',
  tariff_home: 1,
  tariff_center: 1,
  region_id: '1',
};

async function rpcErrorOf(promise: Promise<unknown>) {
  const error: unknown = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(RpcException);
  return (error as RpcException).getError() as Record<string, unknown>;
}

/** Barcha logger chaqiruvlari (parol oqmasligini tekshirish uchun). */
function spyLogger() {
  const calls: unknown[][] = [];
  const methods = ['log', 'warn', 'error', 'debug', 'verbose'] as const;
  const spies = methods.map((method) =>
    jest
      .spyOn(Logger.prototype, method)
      .mockImplementation((...args: unknown[]) => {
        calls.push(args);
      }),
  );
  return {
    calls,
    restore: () => spies.forEach((spy) => spy.mockRestore()),
  };
}

describe('aidsxJ2H — yaratishda tasodifiy parol + SMS', () => {
  it('generate_sms (sukut): parol faqat notification xabarida — DB, javob, log, faoliyat jurnalida YO‘Q', async () => {
    const logger = spyLogger();
    const t = makeHarness();
    const response = (await t.service.createCourier(
      { ...courierDto },
      superadmin,
    )) as { data: Row };
    logger.restore();

    // 1) SMS — notification orqali, aniq pattern, qayta urinishsiz (bitta).
    expect(t.notifyCalls).toHaveLength(1);
    expect(t.notifyCalls[0].pattern).toEqual({
      cmd: NOTIFICATION_SMS_TEMP_PASSWORD_PATTERN,
    });
    const password = String(t.notifyCalls[0].payload.password);
    expect(password).toMatch(/^[A-Za-z2-9]{12}$/);
    expect(t.notifyCalls[0].payload).toMatchObject({
      phone: '+998935557711',
      client_message_id: expect.stringMatching(/^tmppw-/),
    });

    // 2) DB'da faqat hash; bayroqlar yoqilgan.
    expect(t.encrypt).toHaveBeenCalledWith(password);
    expect(t.saves[0]).toMatchObject({
      password: HASH,
      must_change_password: true,
      password_change_forced: true,
    });
    for (const row of [...t.saves, ...t.sendRows]) {
      expect(JSON.stringify(row)).not.toContain(password);
    }

    // 3) Javobda parol yo'q, holat bor.
    expect(JSON.stringify(response)).not.toContain(password);
    expect(response.data).toMatchObject({
      password_mode: 'generate_sms',
      must_change_password: true,
      password_sms: {
        status: 'pending',
        failure_reason: null,
        failure_message: null,
        resends_left_today: 5,
      },
    });
    expect(response.data).not.toHaveProperty('password');

    // 4) Log va faoliyat jurnalida yo'q.
    expect(JSON.stringify(logger.calls)).not.toContain(password);
    expect(JSON.stringify(t.activityLog.log.mock.calls)).not.toContain(
      password,
    );
    expect(t.activityLog.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'auth.temp_password_sms',
        metadata: expect.objectContaining({
          reason: 'create',
          sms_status: 'pending',
        }),
      }),
    );
    expect(t.sendRows[0]).toMatchObject({
      reason: 'create',
      requested_by: '1',
      status: 'pending',
    });
  });

  it('SMS xatosi (notification javob bermadi) yaratishni BUZMAYDI — status failed + sabab', async () => {
    const t = makeHarness({ notify: () => new Error('Timeout has occurred') });
    const response = (await t.service.createManager(
      {
        name: 'TEST Claude Menejer SMS',
        phone_number: '+998935557712',
      } as never,
      superadmin,
    )) as { statusCode: number; data: Row };
    expect(response.statusCode).toBe(201);
    expect(t.saves).toHaveLength(1);
    expect(response.data.password_sms).toMatchObject({
      status: 'failed',
      failure_reason: 'notification_unavailable',
      failure_message: 'SMS xizmati javob bermadi',
    });
    expect(t.sendRows[0]).toBeDefined();
    expect(t.sendsRepo.update).toHaveBeenCalledWith(
      { id: t.sendRows[0].id },
      { status: 'failed', failure_reason: 'notification_unavailable' },
    );
  });

  it('SMS rad etildi (raqam noto‘g‘ri / balans) — foydalanuvchi yaratiladi, sabab qaytadi', async () => {
    const t = makeHarness({
      notify: (_pattern, payload) => ({
        client_message_id: payload.client_message_id,
        status: 'failed',
        failure_reason: 'invalid_phone',
      }),
    });
    const response = await t.service.createAdmin(
      {
        name: 'TEST Claude Admin SMS',
        phone_number: '+998935557713',
        salary: 0,
      } as never,
      superadmin,
    );
    expect(response.statusCode).toBe(201);
    expect(response.message).toBe(
      "Admin yaratildi, lekin SMS yuborilmadi: Telefon raqami noto'g'ri — SMS yuborilmadi",
    );
    expect(response.data.password_sms).toMatchObject({
      status: 'failed',
      failure_reason: 'invalid_phone',
      failure_message: "Telefon raqami noto'g'ri — SMS yuborilmadi",
    });
  });

  it('eski so‘rov (faqat password) — manual: SMS yo‘q, bayroqlar false, password_sms: null', async () => {
    const t = makeHarness();
    const response = (await t.service.createCourier(
      { ...courierDto, password: 'Kuchli-Parol-2026' },
      superadmin,
    )) as { data: Row };
    expect(t.notifyCalls).toHaveLength(0);
    expect(t.encrypt).toHaveBeenCalledWith('Kuchli-Parol-2026');
    expect(t.saves[0]).toMatchObject({
      must_change_password: false,
      password_change_forced: false,
    });
    expect(response.data).toMatchObject({
      password_mode: 'manual',
      password_sms: null,
    });
  });

  it('manual + must_change_password: true — bayroqlar yoqiladi, SMS yo‘q', async () => {
    const t = makeHarness();
    await t.service.createLogist(
      {
        name: 'TEST Claude Logist',
        phone_number: '+998935557714',
        password: 'Kuchli-Parol-2026',
        password_mode: 'manual',
        must_change_password: true,
        salary: 0,
      } as never,
      superadmin,
    );
    expect(t.notifyCalls).toHaveLength(0);
    expect(t.saves[0]).toMatchObject({
      must_change_password: true,
      password_change_forced: true,
    });
  });

  it('generate_sms + password — 400, hech narsa yozilmaydi va SMS ketmaydi', async () => {
    const t = makeHarness();
    const error = await rpcErrorOf(
      t.service.createMarket(
        {
          name: 'TEST Claude Market',
          phone_number: '+998935557715',
          username: 'test_claude_mkt',
          password: 'Kuchli-Parol-2026',
          password_mode: 'generate_sms',
          tariff_home: 1,
          tariff_center: 1,
        } as never,
        superadmin,
      ),
    );
    expect(error.statusCode).toBe(400);
    expect(t.saves).toEqual([]);
    expect(t.notifyCalls).toHaveLength(0);
  });
});

describe('aidsxJ2H — POST /users/:id/password/resend-sms', () => {
  const courier: Row = {
    id: '26',
    name: 'TEST Claude Kuryer',
    role: Roles.COURIER,
    phone_number: '+998935557711',
    password: 'old-hash',
    status: Status.ACTIVE,
    isDeleted: false,
    session_epoch: 3,
    must_change_password: false,
    password_change_forced: false,
    created_by: '25',
    language: 'uz',
  };

  it('yangi parol: hash, bayroqlar, barcha sessiyalar yopiladi, SMS — parol javobda yo‘q', async () => {
    const logger = spyLogger();
    const t = makeHarness({ existing: courier });
    const response = (await t.service.resendTempPasswordSms(
      '26',
      superadmin,
    )) as Row & { data: Row };
    logger.restore();

    const password = String(t.notifyCalls[0].payload.password);
    expect(password).toMatch(/^[A-Za-z2-9]{12}$/);
    expect(t.txManager.query).toHaveBeenCalledWith(
      'SELECT pg_advisory_xact_lock(hashtext($1))',
      ['identity.temp_password:26'],
    );
    expect(t.saves[0]).toMatchObject({
      password: HASH,
      must_change_password: true,
      password_change_forced: true,
      session_epoch: 4,
    });
    expect(t.authSessions.afterPasswordChange).toHaveBeenCalledWith(
      expect.objectContaining({ keepSessionId: null }),
    );
    expect(response).toMatchObject({
      statusCode: 200,
      sessions_revoked: 1,
      data: {
        user_id: '26',
        must_change_password: true,
        password_sms: { status: 'pending' },
      },
    });
    expect(t.sendRows[0]).toMatchObject({ reason: 'resend', user_id: '26' });
    expect(JSON.stringify(response)).not.toContain(password);
    expect(JSON.stringify(logger.calls)).not.toContain(password);
    expect(JSON.stringify(t.activityLog.log.mock.calls)).not.toContain(
      password,
    );
  });

  it('⭐ SMS navbatga tushmadi — parol, bayroqlar, sessiyalar O‘ZGARMAYDI, sabab javobda (qulflanmaydi)', async () => {
    const t = makeHarness({
      existing: courier,
      notify: (_pattern, payload) => ({
        client_message_id: payload.client_message_id,
        status: 'failed',
        failure_reason: 'daily_cap_exceeded',
      }),
    });
    const response = (await t.service.resendTempPasswordSms(
      '26',
      superadmin,
    )) as Row & { data: Row };

    expect(t.saves).toEqual([]);
    expect(t.authSessions.afterPasswordChange).not.toHaveBeenCalled();
    expect(response).toMatchObject({
      statusCode: 200,
      message: "SMS yuborilmadi: Bugungi SMS limiti tugagan. Parol o'zgarmadi",
      data: {
        user_id: '26',
        must_change_password: false,
        password_sms: {
          status: 'failed',
          failure_reason: 'daily_cap_exceeded',
          failure_message: 'Bugungi SMS limiti tugagan',
        },
      },
    });
    expect(response.sessions_revoked).toBeUndefined();
  });

  it('notification javob bermadi — eski parol qoladi', async () => {
    const t = makeHarness({
      existing: courier,
      notify: () => new Error('timeout'),
    });
    const response = (await t.service.resendTempPasswordSms(
      '26',
      superadmin,
    )) as { data: { password_sms: Row } };
    expect(t.saves).toEqual([]);
    expect(response.data.password_sms).toMatchObject({
      status: 'failed',
      failure_reason: 'notification_unavailable',
    });
  });

  it('60 s ichida qayta — 429 PASSWORD_SMS_COOLDOWN, parol o‘zgarmaydi', async () => {
    const t = makeHarness({
      existing: courier,
      lastSend: { id: '9', created_at: new Date(Date.now() - 20_000) },
    });
    const error = await rpcErrorOf(
      t.service.resendTempPasswordSms('26', superadmin),
    );
    expect(error).toMatchObject({
      statusCode: 429,
      code: PASSWORD_SMS_COOLDOWN,
    });
    expect(Number(error.retry_after_seconds)).toBeGreaterThan(30);
    expect(Number(error.retry_after_seconds)).toBeLessThanOrEqual(60);
    expect(t.saves).toEqual([]);
    expect(t.notifyCalls).toHaveLength(0);
  });

  it('kuniga 5 marta — 6-chisi 429 PASSWORD_SMS_DAILY_LIMIT', async () => {
    const t = makeHarness({
      existing: courier,
      lastSend: { id: '9', created_at: new Date(Date.now() - 120_000) },
      resendsToday: 5,
    });
    const error = await rpcErrorOf(
      t.service.resendTempPasswordSms('26', superadmin),
    );
    expect(error).toMatchObject({
      statusCode: 429,
      code: PASSWORD_SMS_DAILY_LIMIT,
    });
    expect(t.saves).toEqual([]);
  });

  it('huquq: menejer — faqat o‘z kuryeri; begona kuryer / admin / o‘zi — 403; mijoz roli — 400', async () => {
    const own = makeHarness({ existing: courier });
    await expect(
      own.service.resendTempPasswordSms('26', {
        id: '25',
        roles: ['manager'],
      }),
    ).resolves.toMatchObject({ statusCode: 200 });

    const foreign = makeHarness({ existing: courier });
    expect(
      await rpcErrorOf(
        foreign.service.resendTempPasswordSms('26', {
          id: '99',
          roles: ['manager'],
        }),
      ),
    ).toMatchObject({ statusCode: 403 });

    const adminTarget = makeHarness({
      existing: { ...courier, id: '30', role: Roles.ADMIN },
    });
    expect(
      await rpcErrorOf(
        adminTarget.service.resendTempPasswordSms('30', {
          id: '2',
          roles: ['admin'],
        }),
      ),
    ).toMatchObject({ statusCode: 403 });

    const self = makeHarness({ existing: courier });
    expect(
      await rpcErrorOf(
        self.service.resendTempPasswordSms('26', {
          id: '26',
          roles: ['superadmin'],
        }),
      ),
    ).toMatchObject({ statusCode: 403 });

    const customer = makeHarness({
      existing: { ...courier, role: Roles.CUSTOMER },
    });
    expect(
      await rpcErrorOf(
        customer.service.resendTempPasswordSms('26', superadmin),
      ),
    ).toMatchObject({ statusCode: 400 });
  });

  it('GET sms-status — jonli holat notification’dan (delivered), keshlanadi', async () => {
    const t = makeHarness({
      existing: { ...courier, must_change_password: true },
      lastSend: {
        id: '9',
        client_message_id: 'tmppw-11111111-2222',
        status: 'pending',
        failure_reason: null,
        created_at: new Date('2026-10-26T09:00:00.000Z'),
      },
      notify: (pattern) =>
        pattern.cmd === NOTIFICATION_SMS_DELIVERY_STATUS_PATTERN
          ? [
              {
                client_message_id: 'tmppw-11111111-2222',
                status: 'delivered',
                failure_reason: null,
                sent_at: '2026-10-26T09:00:05.000Z',
                delivered_at: '2026-10-26T09:00:07.000Z',
              },
            ]
          : null,
    });
    const response = (await t.service.tempPasswordSmsStatus(
      '26',
      superadmin,
    )) as { data: Row };
    expect(response.data).toMatchObject({
      user_id: '26',
      must_change_password: true,
      password_sms: {
        status: 'delivered',
        requested_at: '2026-10-26T09:00:00.000Z',
        sent_at: '2026-10-26T09:00:05.000Z',
        delivered_at: '2026-10-26T09:00:07.000Z',
        resend_available_at: '2026-10-26T09:01:00.000Z',
      },
    });
    expect(t.sendsRepo.update).toHaveBeenCalledWith(
      { id: '9' },
      { status: 'delivered', failure_reason: null },
    );
  });
});

describe('aidsxJ2H — o‘z parolini almashtirish: eski parol (US:1548)', () => {
  const manager: Row = {
    id: '25',
    role: Roles.MANAGER,
    phone_number: '+998935557711',
    password: 'hash-of:Vaqtinchalik7K',
    status: Status.ACTIVE,
    isDeleted: false,
    session_epoch: 0,
    must_change_password: true,
    password_change_forced: true,
  };
  const self: RequesterContext = { id: '25', roles: ['manager'] };

  it('⭐ hozirgi FE: `{ password }` (old_password yo‘q) — kalit o‘chiq, avvalgidek saqlanadi', async () => {
    const t = makeHarness({ existing: manager });
    await t.service.updateUser('25', { password: 'Yangi-Parol-2026' }, self);
    expect(t.saves[0]).toMatchObject({
      password: HASH,
      must_change_password: false,
      password_change_forced: false,
    });
  });

  it('PASSWORD_CHANGE_REQUIRE_OLD=on: old_password yo‘q — 400 OLD_PASSWORD_REQUIRED (401 emas), saqlanmaydi', async () => {
    const t = makeHarness({
      existing: manager,
      config: { PASSWORD_CHANGE_REQUIRE_OLD: 'on' },
    });
    const error = await rpcErrorOf(
      t.service.updateUser('25', { password: 'Yangi-Parol-2026' }, self),
    );
    expect(error).toMatchObject({
      statusCode: 400,
      code: OLD_PASSWORD_REQUIRED,
    });
    expect(t.saves).toEqual([]);
  });

  it('kalit o‘chiq, lekin vaqtinchalik parolni o‘ziga «almashtirib» bayroqni tushirib bo‘lmaydi', async () => {
    const t = makeHarness({ existing: manager });
    const error = await rpcErrorOf(
      t.service.updateUser('25', { password: 'Vaqtinchalik7K' }, self),
    );
    expect(error).toMatchObject({
      statusCode: 400,
      message: 'Yangi parol joriy paroldan farq qilishi kerak',
    });
    expect(t.saves).toEqual([]);
  });

  it('old_password noto‘g‘ri — 400 OLD_PASSWORD_INVALID', async () => {
    const t = makeHarness({ existing: manager });
    const error = await rpcErrorOf(
      t.service.updateUser(
        '25',
        { password: 'Yangi-Parol-2026', old_password: 'xato' },
        self,
      ),
    );
    expect(error).toMatchObject({
      statusCode: 400,
      code: OLD_PASSWORD_INVALID,
      message: "Joriy parol noto'g'ri",
    });
    expect(t.saves).toEqual([]);
  });

  it('yangi parol joriysi bilan bir xil — 400', async () => {
    const t = makeHarness({
      existing: { ...manager, password: 'hash-of:Yangi-Parol-2026' },
    });
    const error = await rpcErrorOf(
      t.service.updateUser(
        '25',
        {
          password: 'Yangi-Parol-2026',
          old_password: 'Yangi-Parol-2026',
        },
        self,
      ),
    );
    expect(error).toMatchObject({
      statusCode: 400,
      message: 'Yangi parol joriy paroldan farq qilishi kerak',
    });
  });

  it('to‘g‘ri eski parol — saqlanadi, must_change_password va password_change_forced tushadi', async () => {
    const t = makeHarness({ existing: manager });
    await t.service.updateUser(
      '25',
      { password: 'Yangi-Parol-2026', old_password: 'Vaqtinchalik7K' },
      self,
    );
    expect(t.compare).toHaveBeenCalledWith(
      'Vaqtinchalik7K',
      'hash-of:Vaqtinchalik7K',
    );
    expect(t.saves[0]).toMatchObject({
      password: HASH,
      must_change_password: false,
      password_change_forced: false,
    });
    // eski parol hech qayerga yozilmaydi
    expect(JSON.stringify(t.saves)).not.toContain('Vaqtinchalik7K');
    expect(JSON.stringify(t.activityLog.logChange.mock.calls)).not.toContain(
      'Vaqtinchalik7K',
    );
  });

  it('min 8 / xodim 10 — siyosat baribir ishlaydi', async () => {
    const t = makeHarness({ existing: manager });
    const error = await rpcErrorOf(
      t.service.updateUser(
        '25',
        { password: 'Qisqa-12', old_password: 'Vaqtinchalik7K' },
        self,
      ),
    );
    expect(error).toMatchObject({
      statusCode: 400,
      message: "Parol kamida 10 belgidan iborat bo'lishi kerak",
    });
  });

  it('admin boshqa foydalanuvchi parolini o‘rnatganda eski parol kerak EMAS', async () => {
    const t = makeHarness({ existing: manager });
    await t.service.updateUser(
      '25',
      { password: 'Admin-Bergan-2026' },
      superadmin,
    );
    expect(t.compare).not.toHaveBeenCalled();
    expect(t.saves[0]).toMatchObject({ password: HASH });
  });
});
