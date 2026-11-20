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
}) => {
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
    { send: jest.fn() } as never,
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
  return { service, notification, branch, notifications, plan };
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

  it('guruh ulanmagan va `group` — hech kim (jim)', async () => {
    const fx = setup({
      route: { report_target: 'group', group: null },
      managers: MANAGERS,
    });
    await expect(fx.plan(snapshot())).resolves.toEqual([]);
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

  it('asosiy kassa → HQ filiali; marshrut xatosi asosiy kassada jim (superadmin hisoboti kechikmaydi)', async () => {
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
    await expect(
      failing.plan(snapshot({ cashbox_type: 'main', cashbox_user_id: '0' })),
    ).resolves.toEqual([]);
    // Filial kassasida esa XATO — da'vo bo'shatiladi, keyingi tick qayta uradi.
    await expect(failing.plan(snapshot())).rejects.toThrow('notification down');
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
