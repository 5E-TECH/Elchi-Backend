import { Workbook, type Cell } from 'exceljs';
import { of, throwError } from 'rxjs';
import {
  buildBranchMessage,
  buildBranchSliceMessage,
  buildSuperadminMessage,
  type BranchSlice,
  type ShiftReportSnapshot,
} from './shift-report.builders';
import { buildBranchSliceXlsx, buildXlsx } from './shift-report.file';
import { ShiftReportService } from './shift-report.service';
import { REPORT_DEFAULTS } from '../shift-auto-close/shift-schedule.rules';

/**
 * (ega 2026-11-25) ASOSIY kassa smenasi yopilganda har ulangan filial guruhiga
 * FAQAT o'z hisoboti. Asosiy xavf — sizib chiqish: boshqa filial, kuryer,
 * market yoki asosiy kassa summasi filial guruhida ko'rinmasligi kerak.
 */

/** Filial 16 — 111 111 + 222 222; filial 37 — 777 777 (begona belgi). */
const ANDIJON: BranchSlice = {
  branch_id: '16',
  name: 'Andijon',
  total: 333_333,
  balance: 54_321,
  payments: [
    {
      history_id: '1',
      amount: 111_111,
      payment_method: 'cash',
      at: new Date('2026-11-24T16:05:00Z'),
    },
    {
      history_id: '2',
      amount: 222_222,
      payment_method: 'click',
      at: new Date('2026-11-24T17:05:00Z'),
    },
  ],
};
const SAMARQAND: BranchSlice = {
  branch_id: '37',
  name: 'Samarqand',
  total: 777_777,
  balance: 888_888,
  payments: [
    {
      history_id: '3',
      amount: 777_777,
      payment_method: 'cash',
      at: new Date('2026-11-24T18:05:00Z'),
    },
  ],
};

const block = (value: number) => ({
  opening_balance: value,
  total_income: value,
  total_expense: value,
  expected_balance: value,
  closing_balance: value,
  discrepancy: 0,
});

const snapshot = (
  patch: Partial<ShiftReportSnapshot> = {},
): ShiftReportSnapshot => ({
  shift_id: '16',
  round: 1,
  cashbox_type: 'main',
  cashbox_user_id: '0',
  opened_at: new Date('2026-11-24T12:53:00Z'),
  closed_at: new Date('2026-11-24T22:41:00Z'),
  opened_by: '1',
  opened_by_name: 'Ali',
  closed_by: '1',
  closed_by_name: 'Ali',
  close_reason: 'manual',
  cash: block(99_999_999),
  card: block(66_666_666),
  accounts: [],
  couriers: [
    {
      courier_id: '501',
      name: 'Begona Kuryer',
      count: 1,
      total: 444_444,
      remaining_debt: 0,
    },
  ],
  markets: [
    {
      market_id: '601',
      name: 'Begona Market',
      payments: [],
      total: 555_555,
      balance: null,
    },
  ],
  branches: [ANDIJON, SAMARQAND],
  ...patch,
});

/** Andijonga ketadigan narsada bo'lishi mumkin EMAS. */
const FOREIGN = [
  'Samarqand',
  '777',
  '888',
  'Begona',
  '444',
  '555',
  '99 999',
  '99999',
  '66 666',
  '66666',
];
const expectNoForeign = (value: unknown) => {
  const flat = typeof value === 'string' ? value : JSON.stringify(value);
  for (const needle of FOREIGN) expect(flat).not.toContain(needle);
};

/** Formula — natijasi bilan (`cell.value` 0 natijani tashlab yuboradi). */
const plain = (cell: Cell): unknown =>
  cell.formula ? cell.result : cell.value;

/**
 * Hamma varaq qatorlari (birlashtirilgan kataklar bir marta, bo'shsiz);
 * `all` — fayldagi hamma matn: formulalar, kolontitul, fayl nomi ham.
 */
const cellsOf = async (buffer: Buffer) => {
  const workbook = new Workbook();
  await workbook.xlsx.load(buffer as never);
  const rows: unknown[][] = [];
  for (const sheet of workbook.worksheets) {
    sheet.eachRow((row) => {
      const values: unknown[] = [];
      row.eachCell((cell) => {
        if (cell.isMerged && cell.master !== cell) return;
        if (cell.value !== null && cell.value !== '') {
          values.push(plain(cell));
        }
      });
      if (values.length) rows.push(values);
    });
  }
  return {
    rows,
    sheets: workbook.worksheets.map((sheet) => sheet.name),
    all: JSON.stringify([
      workbook.title,
      workbook.worksheets.map((sheet) => [
        sheet.headerFooter,
        sheet.getSheetValues(),
      ]),
    ]),
  };
};

describe('buildBranchSliceMessage', () => {
  it('⭐ faqat o‘z to‘lovlari, jami va kassa qoldig‘i', () => {
    const message = buildBranchSliceMessage(
      snapshot(),
      ANDIJON,
      'https://x.uz',
    );
    expect(message.title).toBe(
      '🧾 «Andijon» filiali — asosiy kassa smenasi yopildi',
    );
    expect(message.body).toContain('Asosiy kassa smenasi #16');
    expect(message.body).toContain(
      "⬆️ HQ'ga topshirilgan: 333 333 so'm (2 ta)",
    );
    expect(message.body).toContain("111 111 so'm — naqd");
    expect(message.body).toContain("222 222 so'm — karta");
    expect(message.body).toContain("💰 Filial kassasidagi qoldiq: 54 321 so'm");
    expect(message.data).toMatchObject({
      kind: 'branch_slice',
      branch_id: '16',
      total: 333_333,
      count: 2,
      balance: 54_321,
    });
    // Havola — filialning o'z kassasi (asosiy kassa hisoboti menejerga 404).
    expect(message.link).toBe('/cash-box');
    expect(message.telegram_text).toContain('href="https://x.uz/cash-box"');
    expect(message.telegram_text).not.toContain('/payments/shifts/');
    expectNoForeign(message);
  });

  it('topshirilmagan, qaytarilgan, avtomatik; nom HTML-escape', () => {
    const empty = buildBranchSliceMessage(snapshot({ close_reason: 'auto' }), {
      ...ANDIJON,
      name: 'A & <B>',
      payments: [],
      total: 0,
      balance: null,
    });
    expect(empty.title).toContain('asosiy kassa smenasi avtomatik yopildi');
    expect(empty.body).toContain("Bu smenada HQ'ga pul topshirilmagan");
    expect(empty.body).not.toContain('qoldiq');
    expect(empty.telegram_text).toContain('A &amp; &lt;B&gt;');

    const reversed = buildBranchSliceMessage(snapshot(), {
      ...ANDIJON,
      total: 222_222,
      payments: [
        ...ANDIJON.payments,
        {
          history_id: '9',
          amount: -111_111,
          payment_method: 'cash',
          at: new Date('2026-11-24T19:00:00Z'),
          reversed: true,
        },
      ],
    });
    expect(reversed.body).toContain("222 222 so'm (2 ta)");
    expect(reversed.body).toContain("−111 111 so'm — naqd");
    expect(reversed.body).toContain('qaytarildi');
  });
});

describe('HQ (asosiy kassa) hisoboti — filiallardan qabul', () => {
  it('HQ guruhi va superadmin: ro‘yxat (katta summa birinchi) va jami', () => {
    const hq = buildBranchMessage(snapshot(), 'HQ Toshkent');
    expect(hq.body).toContain(
      "⬇️ Filiallardan qabul: 1 111 110 so'm (2 ta filial)",
    );
    expect(hq.body).toContain("• Andijon — 333 333 so'm (2 ta)");
    expect(hq.body.indexOf('Samarqand')).toBeLessThan(
      hq.body.indexOf('Andijon'),
    );
    expect(buildSuperadminMessage(snapshot(), null).body).toContain(
      "Filiallar: 2 ta, 1 111 110 so'm",
    );
  });

  it('filial smenasi (branches yo‘q) va filialsiz smena — qator yo‘q', () => {
    for (const branches of [undefined, []]) {
      const body = buildBranchMessage(snapshot({ branches }), 'HQ').body;
      expect(body).not.toContain('Filiallardan');
    }
  });

  it('XLSX: «Filiallar» varag‘i faqat asosiy kassada', async () => {
    const main = await cellsOf(await buildXlsx(snapshot()));
    expect(main.sheets).toContain('Filiallar');
    expect(JSON.stringify(main.rows)).toContain('Samarqand');
    const branch = await cellsOf(
      await buildXlsx(
        snapshot({ cashbox_type: 'branch', branches: undefined }),
      ),
    );
    expect(branch.sheets).not.toContain('Filiallar');
  });

  it('⭐ filial Excel’i — faqat o‘z to‘lovlari', async () => {
    const { rows, sheets, all } = await cellsOf(
      await buildBranchSliceXlsx(snapshot(), ANDIJON),
    );
    expect(sheets).toEqual(["HQ'ga topshirilgan"]);
    expect(rows).toContainEqual(['Naqd', 111_111]);
    expect(rows).toContainEqual(['Karta', 222_222]);
    expect(rows).toContainEqual(['Jami topshirilgan', 333_333]);
    expect(rows).toContainEqual(['Filial kassasidagi qoldiq', 54_321]);
    expect(rows).toContainEqual([
      'Andijon filiali · Asosiy kassa smenasi #16',
      'Smena yopilgan',
    ]);
    expectNoForeign(rows);
    // Formula, kolontitul va fayl nomida ham.
    expectNoForeign(all);
  });

  it('filial Excel’i: avtomatik yopilgani lentada; qaytarilgan to‘lov; bo‘sh holat', async () => {
    const auto = await cellsOf(
      await buildBranchSliceXlsx(snapshot({ close_reason: 'auto' }), {
        ...ANDIJON,
        total: 222_222,
        payments: [
          ...ANDIJON.payments,
          { ...ANDIJON.payments[0], amount: -111_111, reversed: true },
        ],
      }),
    );
    expect(auto.rows).toContainEqual([
      'Andijon filiali · Asosiy kassa smenasi #16',
      'Smena avtomatik yopilgan',
    ]);
    expect(auto.rows).toContainEqual(['Qaytarilgan', -111_111]);
    expect(auto.rows).toContainEqual(['Jami topshirilgan', 222_222]);
    expect(
      auto.rows.some(
        (row) => row.includes(-111_111) && row.includes('Qaytarildi'),
      ),
    ).toBe(true);
    expectNoForeign(auto.all);

    const empty = await cellsOf(
      await buildBranchSliceXlsx(snapshot(), {
        branch_id: '16',
        name: null,
        payments: [],
        total: 0,
        balance: null,
      }),
    );
    expect(empty.rows).toContainEqual([
      'Filial #16 · Asosiy kassa smenasi #16',
      'Smena yopilgan',
    ]);
    expect(empty.rows).toContainEqual(["Bu smenada HQ'ga pul topshirilmagan"]);
    expect(empty.rows).toContainEqual(['Jami topshirilgan', 0]);
    expect(JSON.stringify(empty.rows)).not.toContain(
      '"Filial kassasidagi qoldiq"',
    );
  });
});

type RouteRow = {
  branch_id: string;
  report_target: 'group' | 'private';
  group: { active: boolean; inactive_reason: string | null } | null;
};
const ACTIVE = { active: true, inactive_reason: null };
const group = (branch_id: string): RouteRow => ({
  branch_id,
  report_target: 'group',
  group: ACTIVE,
});

const setup = (
  opts: {
    routes?: RouteRow[] | Error;
    managers?: Record<string, string[] | Error>;
    branches?: Array<{ id: string; name: string }> | Error;
    hqId?: string;
  } = {},
) => {
  const identity = {
    send: jest.fn((pattern: { cmd: string }, payload: { ids?: string[] }) =>
      pattern.cmd === 'identity.user.find_by_ids'
        ? of({ data: (payload.ids ?? []).map((id) => ({ id })) })
        : of({ data: [{ user_id: '1' }] }),
    ),
  };
  const notification = {
    send: jest.fn((pattern: { cmd: string }) => {
      if (pattern.cmd === 'notification.telegram.branch_routes') {
        return opts.routes instanceof Error
          ? throwError(() => opts.routes)
          : of({ data: opts.routes ?? [] });
      }
      return of({ data: { report_target: 'group', group: ACTIVE } });
    }),
  };
  const branch = {
    send: jest.fn(
      (pattern: { cmd: string }, payload: { branch_id?: string }) => {
        switch (pattern.cmd) {
          case 'branch.find_hq':
            return of({ data: opts.hqId === '' ? null : { id: '1' } });
          case 'branch.find_all':
            return opts.branches instanceof Error
              ? throwError(() => opts.branches)
              : of({
                  data: {
                    items: opts.branches ?? [
                      { id: '1', name: 'HQ Toshkent' },
                      { id: '16', name: 'Andijon' },
                      { id: '37', name: 'Samarqand' },
                      { id: '40', name: 'Buxoro' },
                    ],
                  },
                });
          case 'branch.user.find_by_branch': {
            const managers = opts.managers?.[payload.branch_id ?? ''] ?? [];
            return managers instanceof Error
              ? throwError(() => managers)
              : of({
                  data: managers.map((user_id) => ({
                    user_id,
                    role: 'MANAGER',
                  })),
                });
          }
          default:
            return of({ data: null });
        }
      },
    ),
  };
  const uploads: Array<Record<string, any>> = [];
  const file = {
    send: jest.fn((_pattern: unknown, payload: Record<string, any>) => {
      uploads.push(payload);
      return of({ data: { key: `key-${uploads.length}` } });
    }),
  };
  const find = jest.fn().mockResolvedValue([
    { user_id: '16', balance: 54_321 },
    { user_id: '37', balance: 888_888 },
    { user_id: '40', balance: 0 },
  ]);
  const service = new ShiftReportService(
    { manager: { find } } as never,
    { log: jest.fn() } as never,
    {} as never,
    {} as never,
    identity as never,
    file as never,
    notification as never,
    branch as never,
  );
  jest
    .spyOn(
      (service as unknown as { logger: { warn: () => void } }).logger,
      'warn',
    )
    .mockImplementation(() => undefined);
  const plan = (
    snap = snapshot(),
    channels = { telegram: true, in_app: false },
  ) =>
    (
      service as unknown as {
        planBranchSlices: (
          ...args: unknown[]
        ) => Promise<Array<Record<string, any>>>;
      }
    ).planBranchSlices(snap, channels);
  const attach = (recipients: Array<Record<string, any>>) =>
    (
      service as unknown as {
        attachExcel: (...args: unknown[]) => Promise<void>;
      }
    ).attachExcel(snapshot(), REPORT_DEFAULTS, recipients, new Map(), null);
  return { plan, attach, uploads, notification, branch };
};

describe('ShiftReportService.planBranchSlices', () => {
  it('⭐ har ulangan filialga faqat o‘zi; HQ va ulanmagan filial — yo‘q', async () => {
    const fx = setup({
      routes: [
        group('1'),
        group('16'),
        group('37'),
        { branch_id: '40', report_target: 'group', group: null },
      ],
      managers: { '16': ['301'], '37': ['302'] },
    });
    const planned = await fx.plan();
    expect(planned.map((p) => [p.kind, p.recipient_id, p.notify_ids])).toEqual([
      ['branch', '16', ['301']],
      ['branch', '37', ['302']],
    ]);
    expectNoForeign(planned[0]);
    expect(planned[1].message.body).toContain("777 777 so'm");
    expect(JSON.stringify(planned[1])).not.toContain('Andijon');
  });

  it('bu smenada pul topshirmagan ulangan filialga ham boradi', async () => {
    const fx = setup({
      routes: [group('40')],
      managers: { '40': ['303'] },
    });
    const [planned] = await fx.plan();
    expect(planned.message.title).toContain('«Buxoro» filiali');
    expect(planned.message.body).toContain('topshirilmagan');
    expect(planned.message.body).toContain("qoldiq: 0 so'm");
  });

  it('`private` — menejerlarga; menejer yo‘q / olinmadi — failed sababi bilan', async () => {
    const fx = setup({
      routes: ['16', '37', '40'].map((branch_id) => ({
        branch_id,
        report_target: 'private' as const,
        group: ACTIVE,
      })),
      managers: { '16': ['301', '304'], '37': [], '40': new Error('down') },
    });
    const planned = await fx.plan();
    expect(
      planned.map((p) => [p.kind, p.recipient_id, p.unreachable?.reason]),
    ).toEqual([
      ['branch_manager', '301', undefined],
      ['branch_manager', '304', undefined],
      ['branch', '37', 'branch_no_managers'],
      ['branch', '40', 'branch_report_unavailable'],
    ]);
  });

  it('nofaol guruh — guruh holati bilan (yuborishda failed bo‘ladi)', async () => {
    const inactive = { active: false, inactive_reason: 'kicked' };
    const fx = setup({
      routes: [{ ...group('16'), group: inactive }],
      managers: { '16': ['301'] },
    });
    expect((await fx.plan())[0].group).toEqual(inactive);
  });

  it('menejersiz filial: guruhga ketadi, ilova ichida begonaga yozilmaydi', async () => {
    const fx = setup({ routes: [group('16')] });
    const [planned] = await fx.plan(snapshot(), {
      telegram: true,
      in_app: true,
    });
    expect(planned.notify_ids).toEqual(['1']);
    expect(planned.channels).toEqual({ telegram: true, in_app: false });
  });

  it('o‘chirilgan filial — yo‘q; ro‘yxat olinmasa filtrsiz (nom `#id`)', async () => {
    const managers = { '16': ['301'], '99': ['309'] };
    const deleted = setup({ routes: [group('16'), group('99')], managers });
    expect((await deleted.plan()).map((p) => p.recipient_id)).toEqual(['16']);
    const unknown = setup({
      routes: [group('99')],
      managers,
      branches: new Error('branch down'),
    });
    expect((await unknown.plan())[0].message.title).toContain(
      'Filial kassasi #99',
    );
  });

  it('filial smenasi yoki telegram o‘chiq — hech narsa so‘ralmaydi', async () => {
    const fx = setup({ routes: [group('16')] });
    expect(await fx.plan(snapshot({ cashbox_type: 'branch' }))).toEqual([]);
    expect(
      await fx.plan(snapshot(), { telegram: false, in_app: true }),
    ).toEqual([]);
    expect(fx.notification.send).not.toHaveBeenCalled();
  });

  it('fail-soft: manzillar olinmasa yoki HQ noma’lum bo‘lsa — hech kimga (xato emas)', async () => {
    await expect(
      setup({ routes: new Error('notification down') }).plan(),
    ).resolves.toEqual([]);
    await expect(
      setup({ routes: [group('1'), group('16')], hqId: '' }).plan(),
    ).resolves.toEqual([]);
  });
});

describe('attachExcel — filial bo‘lagiga to‘liq hisobot HECH QACHON ketmaydi', () => {
  it('⭐ HQ guruhi — to‘liq; filial — faqat o‘z fayli; to‘lovsiz filial — faylsiz', async () => {
    const fx = setup({
      routes: [group('16'), group('40')],
      managers: { '16': ['301'], '40': ['303'] },
    });
    const slices = await fx.plan();
    const hq = {
      kind: 'branch',
      recipient_id: '1',
      message: buildBranchMessage(snapshot(), 'HQ'),
      channels: { telegram: true, in_app: false },
      group: ACTIVE,
    };
    const recipients = [hq, ...slices];
    await fx.attach(recipients);
    expect(fx.uploads.map((u) => u.file_name).sort()).toEqual([
      'smena-16-filial-16-hq.xlsx',
      'smena-16-hisobot.xlsx',
    ]);
    const keyOf = (name: string) =>
      `key-${fx.uploads.findIndex((u) => u.file_name === name) + 1}`;
    expect(hq.message.data.telegram_media).toEqual([
      keyOf('smena-16-hisobot.xlsx'),
    ]);
    expect(slices[0].message.data.telegram_media).toEqual([
      keyOf('smena-16-filial-16-hq.xlsx'),
    ]);
    expect(slices[1].message.data.telegram_media).toBeUndefined();
    const own = fx.uploads.find((u) => u.file_name.includes('filial-16'))!;
    expectNoForeign(
      (await cellsOf(Buffer.from(own.file_base64, 'base64'))).all,
    );
  });

  it('`private` menejerlar — bitta o‘z fayli (to‘liq hisobot emas)', async () => {
    const fx = setup({
      routes: [{ branch_id: '16', report_target: 'private', group: null }],
      managers: { '16': ['301', '304'] },
    });
    const planned = await fx.plan();
    await fx.attach(planned);
    expect(fx.uploads.map((u) => u.file_name)).toEqual([
      'smena-16-filial-16-hq.xlsx',
    ]);
    expect(planned[0].message.data.telegram_media).toEqual(['key-1']);
    expect(planned[1].message.data.telegram_media).toEqual(['key-1']);
  });
});
