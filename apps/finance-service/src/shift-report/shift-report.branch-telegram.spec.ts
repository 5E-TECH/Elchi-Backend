import { of, throwError } from 'rxjs';
import {
  buildBranchMessage,
  type ShiftReportSnapshot,
} from './shift-report.builders';
import { ShiftReportService } from './shift-report.service';

/**
 * Filial kassasi Telegram guruhi — smena (kassa) yopilganda hisobot filial
 * guruhiga yoki (filial `private`) menejerlarning shaxsiy chatiga.
 */

const snapshot = (
  patch: Partial<ShiftReportSnapshot> = {},
): ShiftReportSnapshot => ({
  shift_id: '77',
  round: 1,
  cashbox_type: 'branch',
  cashbox_user_id: '12',
  opened_at: new Date('2026-11-20T04:00:00Z'),
  closed_at: new Date('2026-11-20T14:05:00Z'),
  opened_by: '301',
  opened_by_name: 'Ali',
  closed_by: '301',
  closed_by_name: 'Ali <Menejer>',
  close_reason: 'manual',
  cash: {
    opening_balance: 1_200_000,
    total_income: 4_200_000,
    total_expense: 1_000_000,
    expected_balance: 4_400_000,
    closing_balance: 4_380_000,
    discrepancy: -20_000,
  },
  card: {
    opening_balance: 0,
    total_income: 0,
    total_expense: 0,
    expected_balance: 0,
    closing_balance: null,
    discrepancy: null,
  },
  accounts: [],
  couriers: [
    {
      courier_id: '501',
      name: 'Kuryer A',
      count: 2,
      total: 1_000_000,
      remaining_debt: 0,
    },
    {
      courier_id: '502',
      name: 'Kuryer B',
      count: 4,
      total: 3_200_000,
      remaining_debt: 0,
    },
  ],
  markets: [
    {
      market_id: '601',
      name: 'Market & Co',
      payments: [],
      total: 1_000_000,
      balance: null,
    },
  ],
  ...patch,
});

describe('buildBranchMessage', () => {
  it('filial kassasi: nom, kassa (bitta jami), sanalgan + farq, kuryerlar (katta summa birinchi), marketlar', () => {
    const message = buildBranchMessage(snapshot(), 'Chilonzor', 'https://x.uz');
    expect(message.title).toBe('🧾 «Chilonzor» filiali — kassa yopildi');
    expect(message.body).toContain('Smena #77');
    expect(message.body).toContain('👤 Yopdi: Ali <Menejer>');
    expect(message.body).toContain(
      "💰 Kassa: 1 200 000 so'm → kutilgan 4 400 000 so'm (kirim 4 200 000 so'm, chiqim 1 000 000 so'm)",
    );
    expect(message.body).toContain(
      "Sanalgan: 4 380 000 so'm · farq: −20 000 so'm",
    );
    expect(message.body).not.toContain('Karta');
    expect(message.body).toContain(
      "⬇️ Kuryerlardan qabul: 4 200 000 so'm (2 ta kuryer)",
    );
    expect(message.body.indexOf('Kuryer B')).toBeLessThan(
      message.body.indexOf('Kuryer A'),
    );
    expect(message.body).toContain("⬆️ Marketlarga to'lov: 1 000 000 so'm");
    expect(message.data).toMatchObject({
      kind: 'branch',
      shift_id: '77',
      discrepancy: -20_000,
      couriers_total: 4_200_000,
    });
    // Guruh matni — HTML escape (ism / market nomidagi < va &).
    expect(message.telegram_text).toContain('Ali &lt;Menejer&gt;');
    expect(message.telegram_text).toContain('Market &amp; Co');
    expect(message.telegram_text).toContain(
      '<a href="https://x.uz/payments/shifts/77">',
    );
  });

  it('asosiy kassa (HQ): naqd va karta alohida; avtomatik yopilgan', () => {
    const message = buildBranchMessage(
      snapshot({
        cashbox_type: 'main',
        cashbox_user_id: '0',
        close_reason: 'auto',
      }),
      'HQ Toshkent',
    );
    expect(message.title).toBe(
      '⏰ Asosiy kassa (HQ Toshkent) — kassa avtomatik yopildi',
    );
    expect(message.body).toContain('💵 Naqd:');
    expect(message.body).toContain('💳 Karta:');
    expect(message.body).toContain('kassir yopmagan');
  });
});

type Route = {
  report_target: 'group' | 'private';
  group: { active: boolean; inactive_reason: string | null } | null;
};

const setup = (opts: {
  route?: Route | Error;
  managers?: Array<{ user_id: string; role: string; isDeleted?: boolean }>;
  hqId?: string;
  /** identity'da mavjud (o'chirilmagan) id'lar; berilmasa — hammasi mavjud. */
  users?: string[] | Error;
  superadmins?: string[];
}) => {
  const identity = {
    send: jest.fn((pattern: { cmd: string }, payload: { ids?: string[] }) => {
      if (pattern.cmd === 'identity.user.find_by_ids') {
        if (opts.users instanceof Error) {
          return throwError(() => opts.users);
        }
        const existing = opts.users;
        return of({
          data: (payload.ids ?? [])
            .filter((id) => !existing || existing.includes(id))
            .map((id) => ({ id, name: `U${id}` })),
        });
      }
      return of({
        data: (opts.superadmins ?? []).map((id) => ({ user_id: id })),
      });
    }),
  };
  const notification = {
    send: jest.fn(() =>
      opts.route instanceof Error
        ? throwError(() => opts.route)
        : of({ statusCode: 200, data: opts.route ?? null }),
    ),
  };
  const branch = {
    send: jest.fn((pattern: { cmd: string }) => {
      if (pattern.cmd === 'branch.find_hq') {
        return of({ data: { id: opts.hqId ?? '1' } });
      }
      if (pattern.cmd === 'branch.find_by_id') {
        return of({ data: { id: '12', name: 'Chilonzor' } });
      }
      return of({ data: opts.managers ?? [] });
    }),
  };
  const notifications = { shiftReport: jest.fn().mockResolvedValue(undefined) };
  const service = new ShiftReportService(
    {} as never,
    { log: jest.fn() } as never,
    {} as never,
    notifications as never,
    identity as never,
    undefined,
    notification as never,
    branch as never,
  );
  const plan = (
    snap: ShiftReportSnapshot,
    channels = { telegram: true, in_app: false },
  ) =>
    (
      service as unknown as {
        planBranchRecipients: (
          s: ShiftReportSnapshot,
          c: { telegram: boolean; in_app: boolean },
        ) => Promise<Array<Record<string, unknown>>>;
      }
    ).planBranchRecipients(snap, channels);
  return { service, notification, branch, notifications, identity, plan };
};

const MANAGERS = [
  { user_id: '301', role: 'MANAGER' },
  { user_id: '302', role: 'MANAGER' },
  { user_id: '303', role: 'COURIER' },
  { user_id: '304', role: 'MANAGER', isDeleted: true },
];

describe('ShiftReportService — filial qabul qiluvchilari', () => {
  it('guruh ulangan (sukut `group`): bitta `branch` qatori, dispatch menejerlar nomidan', async () => {
    const fx = setup({
      route: {
        report_target: 'group',
        group: { active: true, inactive_reason: null },
      },
      managers: MANAGERS,
    });
    const planned = await fx.plan(snapshot());
    expect(planned).toHaveLength(1);
    expect(planned[0]).toMatchObject({
      kind: 'branch',
      recipient_id: '12',
      notify_ids: ['301', '302'],
      channels: { telegram: true, in_app: false },
      group: { active: true, inactive_reason: null },
    });
    expect(fx.notification.send).toHaveBeenCalledWith(
      { cmd: 'notification.telegram.branch_route' },
      expect.objectContaining({ branch_id: '12' }),
    );
  });

  it('`private` (guruhdan uzib shaxsiy chatga): har menejerga `branch_manager`', async () => {
    const fx = setup({
      route: {
        report_target: 'private',
        group: { active: true, inactive_reason: null },
      },
      managers: MANAGERS,
    });
    const planned = await fx.plan(snapshot());
    expect(planned.map((p) => [p.kind, p.recipient_id])).toEqual([
      ['branch_manager', '301'],
      ['branch_manager', '302'],
    ]);
    expect(planned[0].channels).toEqual({ telegram: true, in_app: false });
  });

  describe('guruh ulanmagan (prod 2026-11-25) — sababi ko‘rinadi', () => {
    const NOT_LINKED: Route = { report_target: 'group', group: null };

    it.each([
      ['filial kassasi', {}, '12'],
      [
        'asosiy kassa → HQ',
        { cashbox_type: 'main' as const, cashbox_user_id: '0' },
        '1',
      ],
    ])('%s: `failed` (branch_group_not_linked)', async (_l, patch, id) => {
      const fx = setup({ route: NOT_LINKED, managers: MANAGERS, hqId: '1' });
      await expect(fx.plan(snapshot(patch))).resolves.toEqual([
        expect.objectContaining({
          kind: 'branch',
          recipient_id: id,
          channels: { telegram: true, in_app: false },
          unreachable: {
            reason: 'branch_group_not_linked',
            channel: 'telegram_group',
          },
        }),
      ]);
      // Menejerlar / superadminlar so'ralmaydi — hech narsa yuborilmaydi.
      expect(fx.identity.send).not.toHaveBeenCalled();
    });

    it('in_app ham yoqilgan — menejerlarga ilova ichida, telegram esa so‘ralgan (guruhsiz)', async () => {
      const fx = setup({ route: NOT_LINKED, managers: MANAGERS });
      const planned = await fx.plan(snapshot(), {
        telegram: true,
        in_app: true,
      });
      expect(planned).toEqual([
        expect.objectContaining({
          kind: 'branch',
          notify_ids: ['301', '302'],
          channels: { telegram: true, in_app: true },
        }),
      ]);
      expect(planned[0].group).toBeUndefined();
      expect(planned[0].unreachable).toBeUndefined();
    });

    it('telegram sozlamada o‘chiq — marshrut so‘ralmaydi, hech kim', async () => {
      const fx = setup({ route: NOT_LINKED, managers: MANAGERS });
      await expect(
        fx.plan(snapshot(), { telegram: false, in_app: false }),
      ).resolves.toEqual([]);
      expect(fx.notification.send).not.toHaveBeenCalled();
    });
  });

  it('menejer yo‘q — guruh xabari smenani yopgan xodim nomidan', async () => {
    const fx = setup({
      route: {
        report_target: 'group',
        group: { active: true, inactive_reason: null },
      },
      managers: [],
    });
    const planned = await fx.plan(
      snapshot({ closed_by: '900', opened_by: null }),
    );
    expect(planned[0].notify_ids).toEqual(['900']);
  });

  it('asosiy kassa → HQ filiali; marshrut xatosi asosiy kassada yiqitmaydi, lekin `failed` qatori (jim emas)', async () => {
    const ok = setup({
      route: {
        report_target: 'group',
        group: { active: true, inactive_reason: null },
      },
      managers: MANAGERS,
      hqId: '1',
    });
    const planned = await ok.plan(
      snapshot({ cashbox_type: 'main', cashbox_user_id: '0' }),
    );
    expect(planned[0]).toMatchObject({ kind: 'branch', recipient_id: '1' });

    const failing = setup({ route: new Error('notification down') });
    const failed = await failing.plan(
      snapshot({ cashbox_type: 'main', cashbox_user_id: '0' }),
    );
    expect(failed).toEqual([
      expect.objectContaining({
        kind: 'branch',
        recipient_id: '1',
        channels: { telegram: true, in_app: false },
        unreachable: {
          reason: 'branch_report_unavailable',
          channel: 'telegram_group',
        },
      }),
    ]);
    expect(failed[0].notify_ids).toBeUndefined();
    // Filial kassasida esa XATO — da'vo bo'shatiladi, keyingi tick qayta uradi.
    await expect(failing.plan(snapshot())).rejects.toThrow('notification down');
  });

  describe('(audit 2026-11-22 #3) guruh hisoboti jim yo‘qolmaydi', () => {
    const GROUP: Route = {
      report_target: 'group',
      group: { active: true, inactive_reason: null },
    };
    const HQ_AUTO = {
      cashbox_type: 'main' as const,
      cashbox_user_id: '0',
      close_reason: 'auto' as const,
      closed_by: null,
      opened_by: null,
    };

    it('HQ avto-smenasi (menejer ham, yopgan / ochgan ham yo‘q) — dispatch superadminlar nomidan', async () => {
      const fx = setup({
        route: GROUP,
        managers: [],
        hqId: '1',
        superadmins: ['9001', '9002'],
      });
      const planned = await fx.plan(snapshot(HQ_AUTO));
      expect(planned).toEqual([
        expect.objectContaining({
          kind: 'branch',
          recipient_id: '1',
          notify_ids: ['9001', '9002'],
          group: { active: true, inactive_reason: null },
        }),
      ]);
      expect(planned[0].unreachable).toBeUndefined();
    });

    it('yagona menejer identity’da o‘chirilgan — smenani yopgan xodim nomidan (400 emas)', async () => {
      const fx = setup({
        route: GROUP,
        managers: [{ user_id: '301', role: 'MANAGER' }],
        users: ['900'],
      });
      const planned = await fx.plan(
        snapshot({ closed_by: '900', opened_by: '301' }),
      );
      expect(planned[0].notify_ids).toEqual(['900']);
    });

    it('menejer ham, xodimlar ham o‘chirilgan — superadminlar nomidan', async () => {
      const fx = setup({
        route: GROUP,
        managers: [{ user_id: '301', role: 'MANAGER' }],
        users: ['9001'],
        superadmins: ['9001'],
      });
      const planned = await fx.plan(snapshot());
      expect(planned[0].notify_ids).toEqual(['9001']);
    });

    it('hech kim topilmadi — `failed` qatori (no_report_recipient), dispatch yo‘q', async () => {
      const fx = setup({
        route: GROUP,
        managers: [],
        hqId: '1',
        superadmins: [],
      });
      const planned = await fx.plan(snapshot(HQ_AUTO));
      expect(planned).toEqual([
        expect.objectContaining({
          kind: 'branch',
          recipient_id: '1',
          unreachable: {
            reason: 'no_report_recipient',
            channel: 'telegram_group',
          },
        }),
      ]);
    });

    it('identity javob bermasa — filtrsiz (avvalgi xatti-harakat)', async () => {
      const fx = setup({
        route: GROUP,
        managers: MANAGERS,
        users: new Error('identity down'),
      });
      const planned = await fx.plan(snapshot());
      expect(planned[0].notify_ids).toEqual(['301', '302']);
    });

    it('`private`, faol menejer yo‘q (HQ) — `failed` qatori (branch_no_managers)', async () => {
      const fx = setup({
        route: { report_target: 'private', group: null },
        managers: [],
        hqId: '1',
      });
      const planned = await fx.plan(snapshot(HQ_AUTO), {
        telegram: true,
        in_app: true,
      });
      expect(planned).toEqual([
        expect.objectContaining({
          kind: 'branch',
          recipient_id: '1',
          channels: { telegram: true, in_app: true },
          unreachable: { reason: 'branch_no_managers', channel: 'telegram' },
        }),
      ]);
    });

    it('`private`: o‘chirilgan menejer chiqarib tashlanadi', async () => {
      const fx = setup({
        route: { report_target: 'private', group: null },
        managers: MANAGERS,
        users: ['302'],
      });
      const planned = await fx.plan(snapshot());
      expect(planned.map((p) => [p.kind, p.recipient_id])).toEqual([
        ['branch_manager', '302'],
      ]);
    });
  });

  describe('enqueueRecipient', () => {
    const insertManager = () => {
      const inserted: Array<Record<string, unknown>> = [];
      const qb: Record<string, jest.Mock> = {};
      for (const name of ['insert', 'into', 'orIgnore', 'returning']) {
        qb[name] = jest.fn(() => qb);
      }
      qb.values = jest.fn((row: Record<string, unknown>) => {
        inserted.push(row);
        return qb;
      });
      qb.execute = jest.fn(() => Promise.resolve({ raw: [{ id: '1' }] }));
      return { manager: { createQueryBuilder: jest.fn(() => qb) }, inserted };
    };
    const enqueue = (
      service: ShiftReportService,
      manager: unknown,
      recipient: Record<string, unknown>,
    ) =>
      (
        service as unknown as {
          enqueueRecipient: (...args: unknown[]) => Promise<number>;
        }
      ).enqueueRecipient(
        manager,
        snapshot(),
        recipient,
        'finance.shift_closed',
        new Map(),
      );

    it('faol guruh: telegram_group qatori + dispatch `telegram.branch_id`, menejerlar nomidan', async () => {
      const fx = setup({});
      const { manager, inserted } = insertManager();
      const message = buildBranchMessage(snapshot(), 'Chilonzor');
      await enqueue(fx.service, manager, {
        kind: 'branch',
        recipient_id: '12',
        notify_ids: ['301', '302'],
        message,
        channels: { telegram: true, in_app: false },
        group: { active: true, inactive_reason: null },
      });
      expect(inserted).toEqual([
        expect.objectContaining({
          recipient_kind: 'branch',
          recipient_id: '12',
          channel: 'telegram_group',
          status: 'queued',
        }),
      ]);
      const [payload] = fx.notifications.shiftReport.mock.calls[0] as [
        Record<string, any>,
      ];
      expect(payload.recipient_ids).toEqual(['301', '302']);
      expect(payload.channels).toEqual(['telegram']);
      expect(payload.telegram).toEqual({
        branch_id: '12',
        text: message.telegram_text,
      });
      // (audit #16) Filial dispatch'i — o'z group_key'i (superadmin
      // hisobot qatori bilan almashmasin).
      expect(payload.group_key).toBe('finance:shift:77:report:1:branch:12');
    });

    it('shaxsiy hisobot (branch_manager) — umumiy group_key o‘zgarmagan', async () => {
      const fx = setup({});
      const { manager } = insertManager();
      await enqueue(fx.service, manager, {
        kind: 'branch_manager',
        recipient_id: '301',
        message: buildBranchMessage(snapshot(), null),
        channels: { telegram: true, in_app: true },
      });
      const [payload] = fx.notifications.shiftReport.mock.calls[0] as [
        Record<string, any>,
      ];
      expect(payload.group_key).toBe('finance:shift:77:report:1');
    });

    it('(audit #3) yuborib bo‘lmaydi: so‘ralgan kanallar `failed` + sabab, dispatch yo‘q', async () => {
      const fx = setup({});
      const { manager, inserted } = insertManager();
      await enqueue(fx.service, manager, {
        kind: 'branch',
        recipient_id: '1',
        message: buildBranchMessage(snapshot(), null),
        channels: { telegram: true, in_app: true },
        unreachable: { reason: 'branch_no_managers', channel: 'telegram' },
      });
      expect(inserted).toEqual([
        expect.objectContaining({
          recipient_kind: 'branch',
          recipient_id: '1',
          channel: 'in_app',
          status: 'failed',
          dispatch_id: null,
          failed_reason: expect.stringContaining("faol menejer yo'q"),
        }),
        expect.objectContaining({
          channel: 'telegram',
          status: 'failed',
          dispatch_id: null,
        }),
      ]);
      expect(fx.notifications.shiftReport).not.toHaveBeenCalled();
    });

    it('nofaol guruh: failed qatori, dispatch yo‘q', async () => {
      const fx = setup({});
      const { manager, inserted } = insertManager();
      await enqueue(fx.service, manager, {
        kind: 'branch',
        recipient_id: '12',
        notify_ids: ['301'],
        message: buildBranchMessage(snapshot(), null),
        channels: { telegram: true, in_app: false },
        group: { active: false, inactive_reason: 'kicked' },
      });
      expect(inserted).toEqual([
        expect.objectContaining({
          channel: 'telegram_group',
          status: 'failed',
          dispatch_id: null,
        }),
      ]);
      expect(fx.notifications.shiftReport).not.toHaveBeenCalled();
    });

    it('guruh ulanmagan + in_app: ilova ichida ketadi, guruh — failed «ulanmagan»', async () => {
      const fx = setup({});
      const { manager, inserted } = insertManager();
      await enqueue(fx.service, manager, {
        kind: 'branch',
        recipient_id: '12',
        notify_ids: ['301'],
        message: buildBranchMessage(snapshot(), null),
        channels: { telegram: true, in_app: true },
      });
      expect(inserted).toEqual([
        expect.objectContaining({ channel: 'in_app', status: 'queued' }),
        expect.objectContaining({
          channel: 'telegram_group',
          status: 'failed',
          failed_reason: expect.stringContaining('Filial guruhi ulanmagan'),
        }),
      ]);
      const [payload] = fx.notifications.shiftReport.mock.calls[0] as [
        Record<string, any>,
      ];
      expect(payload.channels).toEqual(['in_app', 'realtime']);
      expect(payload.telegram).toBeUndefined();
    });

    it('filial va foydalanuvchi id bir xil bo‘lsa ham dispatch id farqli', async () => {
      const fx = setup({});
      const a = insertManager();
      const b = insertManager();
      const message = buildBranchMessage(snapshot(), null);
      await enqueue(fx.service, a.manager, {
        kind: 'branch',
        recipient_id: '12',
        notify_ids: ['301'],
        message,
        channels: { telegram: true, in_app: false },
        group: { active: true, inactive_reason: null },
      });
      await enqueue(fx.service, b.manager, {
        kind: 'branch_manager',
        recipient_id: '12',
        message,
        channels: { telegram: true, in_app: false },
      });
      expect(a.inserted[0].dispatch_id).not.toEqual(b.inserted[0].dispatch_id);
    });
  });
});

describe('ShiftReportService.deliver — yagona qabul qiluvchi guruhi ulanmagan filial', () => {
  const BRANCH_ONLY = {
    recipients: {
      superadmin: { telegram: false, in_app: false },
      couriers: { telegram: false, in_app: false },
      markets: { telegram: false, in_app: false },
      branches: { telegram: true, in_app: false },
    },
    format: 'pdf',
  };

  const deliver = async (group: Route['group']) => {
    const inserted: Array<Record<string, unknown>> = [];
    const qb: Record<string, jest.Mock> = {};
    for (const name of ['insert', 'into', 'orIgnore', 'returning']) {
      qb[name] = jest.fn(() => qb);
    }
    qb.values = jest.fn((row: Record<string, unknown>) => {
      inserted.push(row);
      return qb;
    });
    qb.execute = jest.fn(() => Promise.resolve({ raw: [{ id: '1' }] }));
    const manager = {
      findOne: jest.fn().mockResolvedValue({ id: '77' }),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
      createQueryBuilder: jest.fn(() => qb),
    };
    const activityLog = { log: jest.fn().mockResolvedValue(undefined) };
    const notifications = { shiftReport: jest.fn() };
    const file = { send: jest.fn(() => throwError(() => new Error('off'))) };
    const fx = setup({
      route: { report_target: 'group', group },
      managers: MANAGERS,
      hqId: '1',
    });
    const service = new ShiftReportService(
      {
        manager,
        transaction: (run: (m: unknown) => Promise<unknown>) => run(manager),
      } as never,
      activityLog as never,
      {
        loadAutomationSettings: () => Promise.resolve({ report: BRANCH_ONLY }),
      } as never,
      notifications as never,
      fx.identity as never,
      file as never,
      fx.notification as never,
      fx.branch as never,
    );
    Object.assign(service, {
      claim: () => Promise.resolve({ round: 1 }),
      buildSnapshot: () =>
        Promise.resolve(
          snapshot({ cashbox_type: 'main', cashbox_user_id: '0' }),
        ),
    });
    const result = await service.deliver('77');
    return { result, inserted, manager, activityLog, notifications, file };
  };

  it('holat `skipped`, sababi yoziladi; fayl, outbox va «yuborildi» jurnali yo‘q', async () => {
    const fx = await deliver(null);
    expect(fx.result).toEqual({
      claimed: true,
      shift_id: '77',
      round: 1,
      status: 'skipped',
      recipients: 0,
    });
    expect(fx.inserted).toEqual([
      expect.objectContaining({
        shift_id: '77',
        recipient_kind: 'branch',
        recipient_id: '1',
        channel: 'telegram_group',
        status: 'failed',
        dispatch_id: null,
        failed_reason: expect.stringContaining('Filial guruhi ulanmagan'),
      }),
    ]);
    expect(fx.manager.update).toHaveBeenCalledWith(
      expect.anything(),
      { id: '77' },
      { report_status: 'skipped' },
    );
    expect(fx.notifications.shiftReport).not.toHaveBeenCalled();
    expect(fx.file.send).not.toHaveBeenCalled();
    expect(fx.activityLog.log).not.toHaveBeenCalled();
  });

  it('guruh ulangach (qayta yuborish) — `sent` va dispatch ketadi', async () => {
    const fx = await deliver({ active: true, inactive_reason: null });
    expect(fx.result).toMatchObject({ status: 'sent', recipients: 1 });
    expect(fx.inserted).toEqual([
      expect.objectContaining({ channel: 'telegram_group', status: 'queued' }),
    ]);
    expect(fx.notifications.shiftReport).toHaveBeenCalledTimes(1);
  });
});
