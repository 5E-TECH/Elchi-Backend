import { Workbook, type CellRichTextValue, type Worksheet } from 'exceljs';
import type { UndeliveredItem } from './campaign-report.service';
import {
  channelLabel,
  reasonLabel,
  roleLabel,
  statusBucket,
  statusLabel,
} from './campaign-report.labels';
import { UndeliveredReport } from './campaign-report.xlsx';

/**
 * C7 — kampaniya «Yetkazilmaganlar» Excel hisoboti: varaqlar, 8 maydon,
 * o'zbekcha yorliqlar, formulalar, maskalash, formula in'ektsiyasi, oqimli
 * yozuv (katta fayl) oddiy yozuv bilan bir xil.
 */
const NOW = new Date('2026-11-24T23:41:00Z');

type FailureInput = [
  channel: string,
  status: string,
  code?: string | null,
  raw?: string | null,
];
const item = (
  i: number,
  failures: FailureInput[],
  over: Partial<UndeliveredItem> = {},
): UndeliveredItem => ({
  ref_id: String(918240 + i),
  recipient_id: String(20418 + i),
  name: `Ism ${i}`,
  role: 'customer',
  phone: `***${String(i).padStart(4, '0')}`,
  failures: failures.map(([channel, status, code = null, raw = null]) => ({
    channel,
    status,
    reason: raw ?? code,
    reason_code: code,
  })),
  ...over,
});

const load = async (file: Buffer) => {
  const workbook = new Workbook();
  await workbook.xlsx.load(file as never);
  return workbook;
};
const build = async (
  items: UndeliveredItem[],
  o: { kind?: 'notification' | 'sms'; id?: string; stream?: boolean } = {},
) => {
  const report = new UndeliveredReport(o.kind ?? 'notification', o.id ?? '57');
  for (const entry of items) report.add(entry);
  return load(await report.toXlsx(NOW, o.stream ? 0 : undefined));
};
const plain = (value: unknown): unknown =>
  value && typeof value === 'object' && 'richText' in value
    ? (value as CellRichTextValue).richText.map((part) => part.text).join('')
    : value;
const rowOf = (ws: Worksheet, r: number) =>
  Array.from({ length: 9 }, (_, i) => plain(ws.getCell(r, i + 2).value));
const findRow = (ws: Worksheet, text: string, column = 2, from = 1) => {
  for (let r = from; r <= ws.rowCount; r += 1) {
    if (ws.getCell(r, column).value === text) return r;
  }
  throw new Error(`topilmadi: ${text}`);
};
const allText = (workbook: Workbook) => {
  const out: string[] = [];
  workbook.eachSheet((ws) =>
    ws.eachRow((row) =>
      row.eachCell((cell) => out.push(JSON.stringify(cell.value))),
    ),
  );
  return out.join('\n');
};

const ITEMS: UndeliveredItem[] = [
  item(1, [['push', 'no_subscription', 'no_subscription']]),
  item(2, [
    ['telegram', 'failed', 'bot_blocked'],
    ['push', 'no_subscription', 'no_subscription'],
  ]),
  item(
    3,
    [
      ['sms', 'no_provider', 'provider_not_configured'],
      ['push', 'skipped', 'quiet_hours'],
    ],
    { role: 'courier' },
  ),
  item(4, [['sms', 'blocked', 'no_consent']], { role: 'market', phone: null }),
];

describe('C7 — «Yetkazilmaganlar» .xlsx', () => {
  it('«Xulosa»: lenta, ko‘rsatkichlar, sabab / kanal / rol kesimi (formula + natija)', async () => {
    const workbook = await build(ITEMS);
    expect(workbook.worksheets.map((ws) => ws.name)).toEqual([
      'Xulosa',
      'Yetkazilmaganlar',
    ]);
    const ws = workbook.getWorksheet('Xulosa')!;
    expect(ws.getCell('D2').value).toBe('Yetkazilmaganlar xulosasi');
    expect(ws.getCell('D3').value).toBe('Bildirishnoma kampaniyasi №57');
    expect(ws.getCell('G2').value).toBe('4 kishi');
    // Toshkent vaqti.
    expect(ws.getCell('G3').value).toBe('25.11.2026 04:41');
    expect(ws.getImages()).toHaveLength(1);

    expect([7, 8].map((r) => ws.getCell(r, 2).value)).toEqual([
      4,
      '6 ta kanal xabari',
    ]);
    expect([7, 8].map((r) => ws.getCell(r, 4).value)).toEqual([
      1,
      'kanal xabarlarining 16,7%',
    ]);
    expect([7, 8].map((r) => ws.getCell(r, 6).value)).toEqual([
      4,
      'provayder ulanmagan: 1 ta',
    ]);

    // Sabablar: eng ko'pi birinchi, ulush — formula.
    expect(ws.getCell('B12').value).toBe("Push obunasi yo'q");
    expect(ws.getCell('E12').value).toBe(2);
    expect(ws.getCell('F12').value).toEqual({
      formula: 'IF(E$17=0,0,E12/E$17)',
      result: 2 / 6,
    });
    expect(ws.getCell('F12').numFmt).toBe('0.0%');
    expect(ws.getCell('G12').value).toEqual({
      formula: 'REPT("█",ROUND(E12/MAX(E$12:E$16)*12,0))',
      result: '█'.repeat(12),
    });
    expect(ws.getCell('B17').value).toBe('JAMI');
    expect(ws.getCell('E17').value).toEqual({
      formula: 'SUM(E12:E16)',
      result: 6,
    });
    expect(ws.getCell('F17').value).toEqual({
      formula: 'SUM(F12:F16)',
      result: 1,
    });

    // Kanallar: Xato / O'tkazib yuborildi / Provayder ulanmagan / Jami.
    const push = findRow(ws, 'Push');
    expect([4, 5, 6].map((c) => ws.getCell(push, c).value)).toEqual([0, 3, 0]);
    expect(ws.getCell(push, 7).value).toEqual({
      formula: `SUM(D${push}:F${push})`,
      result: 3,
    });
    const channelTotal = findRow(ws, 'JAMI', 2, push);
    expect(
      [4, 5, 6, 7].map(
        (c) =>
          (ws.getCell(channelTotal, c).value as { result?: number }).result,
      ),
    ).toEqual([1, 4, 1, 6]);

    const roles = findRow(ws, 'Mijoz');
    expect(ws.getCell(roles, 5).value).toBe(2);
    expect(findRow(ws, 'Kuryer')).toBeGreaterThan(roles);
    expect(findRow(ws, 'Market')).toBeGreaterThan(roles);
  });

  it('ro‘yxat: 8 maydonning hammasi, o‘zbekcha yorliq, bir nechta kanal — alohida satrda', async () => {
    const workbook = await build(ITEMS);
    const ws = workbook.getWorksheet('Yetkazilmaganlar')!;
    expect(rowOf(ws, 9)).toEqual([
      '№',
      'Qabul qiluvchi ID',
      'Ism',
      'Rol',
      'Telefon',
      'Kanal',
      'Holat',
      'Sabab',
      'Xabar ID',
    ]);
    expect(rowOf(ws, 10)).toEqual([
      1,
      20419,
      'Ism 1',
      'Mijoz',
      '***0001',
      'Push',
      "O'tkazib yuborildi",
      "Push obunasi yo'q",
      918241,
    ]);
    expect(rowOf(ws, 11)).toEqual([
      2,
      20420,
      'Ism 2',
      'Mijoz',
      '***0002',
      'Telegram\nPush',
      "Xato\nO'tkazib yuborildi",
      "Botni bloklagan\nPush obunasi yo'q",
      918242,
    ]);
    // Har satr o'z rangida (xato — qizil, o'tkazib yuborildi — kulrang).
    const status = ws.getCell('H11').value as CellRichTextValue;
    expect(status.richText.map((part) => part.font?.color?.argb)).toEqual([
      'FFBE2A3B',
      'FF4B5575',
    ]);
    expect(ws.getCell('H11').alignment.wrapText).toBe(true);
    expect(ws.getRow(11).height).toBeGreaterThan(ws.getRow(10).height);
    // Telefon yo'q — «—».
    expect(ws.getCell('F13').value).toBe('—');
    expect(ws.getCell('C10').numFmt).toBe('0');

    // Ko'rsatkichlar va JAMI (filtrga moslashadi).
    expect(['B7', 'E7', 'H7', 'I7'].map((a) => ws.getCell(a).value)).toEqual([
      4, 1, 4, 1,
    ]);
    expect(ws.getCell('B14').value).toBe('JAMI');
    expect(ws.getCell('D14').value).toEqual({
      formula: 'SUBTOTAL(2,B10:B13)',
      result: 4,
    });
    expect(ws.autoFilter).toBe('B9:J13');
    expect(ws.views[0]).toEqual(
      expect.objectContaining({ state: 'frozen', ySplit: 9 }),
    );
    expect(ws.pageSetup.printTitlesRow).toBe('9:9');
  });

  it('SMS kampaniyasi: qabul qiluvchi ID yo‘q qator ham sanaladi, DLR javobi matn yonida', async () => {
    const workbook = await build(
      [
        item(1, [['sms', 'not_delivered', null, 'DLR: UNDELIV']], {
          recipient_id: null,
          name: null,
          role: null,
        }),
        item(2, [['sms', 'rejected', null, 'DLR: REJECTD']]),
        item(3, [['sms', 'failed', null, null]]),
      ],
      { kind: 'sms', id: '9' },
    );
    const ws = workbook.getWorksheet('Yetkazilmaganlar')!;
    expect(ws.getCell('D3').value).toBe('SMS kampaniyasi №9');
    expect(rowOf(ws, 10)).toEqual([
      1,
      '—',
      '—',
      '—',
      '***0001',
      'SMS',
      'Xato',
      'SMS yetkazilmadi (DLR: UNDELIV)',
      918241,
    ]);
    expect(ws.getCell('I11').value).toBe('Operator rad etdi (DLR: REJECTD)');
    expect(ws.getCell('I12').value).toBe('SMS yetkazilmadi');
    expect(ws.getCell('D13').value).toEqual({
      formula: 'SUBTOTAL(2,B10:B12)',
      result: 3,
    });
    const summary = workbook.getWorksheet('Xulosa')!;
    expect(findRow(summary, "Ko'rsatilmagan")).toBeGreaterThan(0);
  });

  it('noma’lum kod — xom qiymat (yo‘qolmaydi), jami baribir to‘g‘ri', async () => {
    const workbook = await build([
      item(1, [['pager', 'paused', 'new_code']], { role: 'robot' }),
      item(2, [['push', 'failed', 'push_failed']]),
    ]);
    const ws = workbook.getWorksheet('Yetkazilmaganlar')!;
    expect(rowOf(ws, 10).slice(3)).toEqual([
      'robot',
      '***0001',
      'pager',
      'paused',
      'new_code',
      918241,
    ]);
    const summary = workbook.getWorksheet('Xulosa')!;
    const row = findRow(summary, 'pager');
    expect(summary.getCell(row, 7).value).toEqual(
      expect.objectContaining({ result: 1 }),
    );
  });

  it('formula in’ektsiyasi: `=`, `+`, `@` bilan boshlangan matn — matn; boshqaruv belgisi faylni buzmaydi', async () => {
    for (const stream of [false, true]) {
      const workbook = await build(
        [
          item(1, [['telegram', 'failed', null, '=HYPERLINK("http://x")']], {
            name: '=SUM(A1:A9)',
          }),
          item(2, [['telegram', 'failed', null, '@cmd']], {
            name: '+998 boshlanadi',
          }),
          item(3, [['telegram', 'failed', null, 'a\u0000b\u0008c￿<&>"']], {
            name: 'Ali\u0001￾',
          }),
        ],
        { stream },
      );
      const ws = workbook.getWorksheet('Yetkazilmaganlar')!;
      expect(ws.getCell('D10').value).toBe('=SUM(A1:A9)');
      expect(ws.getCell('D10').numFmt).toBe('@');
      expect(ws.getCell('I10').value).toBe('=HYPERLINK("http://x")');
      expect(ws.getCell('D11').value).toBe('+998 boshlanadi');
      expect(ws.getCell('I11').value).toBe('@cmd');
      expect(ws.getCell('D12').value).toBe('Ali');
      expect(ws.getCell('I12').value).toBe('abc<&>"');
    }
  });

  it('maxfiylik: provayder xom matnidagi telefon maskalanadi', async () => {
    const workbook = await build([
      item(1, [
        ['telegram', 'failed', null, 'chat +998901237434 not found'],
        ['realtime', 'failed', null, 'user 998 90 123 74 34 offline'],
      ]),
    ]);
    const digits = allText(workbook).replace(/\D/g, '');
    expect(digits).not.toContain('901237434');
  });

  it('uzun ID aniqligi yo‘qolmaydi; juda uzun sabab katak chegarasida', async () => {
    const workbook = await build([
      item(1, [['telegram', 'failed', null, `x${'y'.repeat(40_000)}`]], {
        recipient_id: '9223372036854775807',
      }),
    ]);
    const ws = workbook.getWorksheet('Yetkazilmaganlar')!;
    expect(ws.getCell('C10').value).toBe('9223372036854775807');
    expect((ws.getCell('I10').value as string).length).toBeLessThanOrEqual(
      1000,
    );
    expect(ws.getRow(10).height).toBeLessThanOrEqual(409);
  });

  it('bo‘sh hisobot: ikkala varaq ochiladi, JAMI va filtr yo‘q', async () => {
    const workbook = await build([], { kind: 'sms', id: '9' });
    const ws = workbook.getWorksheet('Yetkazilmaganlar')!;
    expect(ws.getCell('B10').value).toBe("Yetkazilmaganlar yo'q");
    expect(ws.autoFilter ?? null).toBeNull();
    const summary = workbook.getWorksheet('Xulosa')!;
    expect(summary.getCell('B7').value).toBe(0);
    expect(summary.getCell('D8').value).toBe('kanal xabarlarining 0,0%');
    expect(summary.getCell('B12').value).toBe("Ma'lumot yo'q");
  });

  it('sabablar ko‘p bo‘lsa — 19 tasi + «Boshqalar», jami to‘liq', async () => {
    const workbook = await build(
      Array.from({ length: 60 }, (_, i) =>
        item(i, [['telegram', 'failed', null, `xato ${i % 30}`]]),
      ),
    );
    const ws = workbook.getWorksheet('Xulosa')!;
    const rest = findRow(ws, 'Boshqalar (11 ta)');
    expect(rest).toBe(31);
    expect(ws.getCell(rest, 5).value).toBe(22);
    expect(ws.getCell(rest + 1, 5).value).toEqual({
      formula: 'SUM(E12:E31)',
      result: 60,
    });
  });

  it('oqimli yozuv (katta fayl) — qiymat, uslub va formulalar oddiy fayl bilan bir xil', async () => {
    const items = Array.from({ length: 700 }, (_, i) => ({
      ...ITEMS[i % ITEMS.length],
      ref_id: String(1000 + i),
      name: `Ism ${i}`,
    }));
    const memory = await build(items);
    const stream = await build(items, { stream: true });
    expect(stream.worksheets.map((ws) => ws.name)).toEqual([
      'Xulosa',
      'Yetkazilmaganlar',
    ]);
    for (const ws of memory.worksheets) {
      const other = stream.getWorksheet(ws.name)!;
      expect(other.rowCount).toBe(ws.rowCount);
      expect(other.autoFilter).toEqual(ws.autoFilter);
      expect(other.views).toEqual(ws.views);
      expect(other.pageSetup.printTitlesRow).toBe(ws.pageSetup.printTitlesRow);
      for (let r = 1; r <= ws.rowCount; r += 1) {
        expect(other.getRow(r).height).toBe(ws.getRow(r).height);
        for (let c = 1; c <= ws.columnCount; c += 1) {
          // Logotip o'rni (B2:C2): oqimli faylda yozuv birlashtirilgan.
          if (r === 2 && c === 3) continue;
          const a = ws.getCell(r, c);
          const b = other.getCell(r, c);
          // Bo'sh matn: oqimli faylda katak bo'sh o'qiladi.
          if (
            JSON.stringify(a.value === '' ? null : a.value) !==
            JSON.stringify(b.value === '' ? null : b.value)
          ) {
            throw new Error(
              `${ws.name}!${a.address}: ${JSON.stringify([a.value, b.value])}`,
            );
          }
          expect(b.numFmt).toBe(a.numFmt);
          expect(b.font?.color).toEqual(a.font?.color);
        }
      }
      // Rasm oqimli faylda yo'q — o'rnida yozuv.
      expect(other.getImages()).toHaveLength(0);
      expect(other.getCell('B2').value).toBe('ELCHI POCHTA');
    }
  }, 30_000);

  it('hajm: 10 000 qator RMQ javobiga bemalol sig‘adi (base64 ≪ 16 MiB)', async () => {
    const report = new UndeliveredReport('notification', '57');
    for (let i = 0; i < 10_000; i += 1) {
      report.add({
        ...item(i, [
          ['push', 'failed', 'subscription_expired'],
          ['telegram', 'failed', null, `xom xato ${i}`],
        ]),
        name: `Foydalanuvchi Familiyasi ${i}`,
      });
    }
    expect(report.size).toBe(10_000);
    const file = await report.toXlsx(NOW);
    expect(file.toString('base64').length).toBeLessThan(4 * 1024 * 1024);
  }, 30_000);
});

describe('C7 — yorliqlar', () => {
  const reason = (
    channel: string,
    status: string,
    code: string | null,
    raw: string | null,
  ) => reasonLabel({ channel, status, reason: raw, reason_code: code });

  it.each([
    ['push', 'no_subscription', 'no_subscription', null, "Push obunasi yo'q"],
    ['push', 'failed', 'subscription_expired', '410 Gone', /eskirgan/],
    ['telegram', 'skipped', 'no_telegram_id', null, 'Telegram ulanmagan'],
    // Kod `reason` da kelgan (reason_code yo'q).
    ['sms', 'blocked', null, 'no_consent', "Reklama SMS'ga rozilik yo'q"],
    // Noma'lum kod / xom matn — xom qiymat.
    ['telegram', 'failed', 'brand_new_code', null, 'brand_new_code'],
    ['realtime', 'failed', null, 'timeout', 'timeout'],
    // Sabab yo'q — holat matni.
    ['telegram', 'not_eligible', null, null, 'Kanal ulanmagan'],
    ['sms', 'no_provider', null, null, 'Provayder ulanmagan'],
    ['telegram', 'failed', null, null, 'Telegram xatosi'],
    ['realtime', 'failed', null, null, 'Yetkazilmadi'],
    ['sms', 'expired', null, 'DLR: EXPIRED', /muddatida.*\(DLR: EXPIRED\)/],
    // Kodsiz `skipped` — aytadigan sabab yo'q.
    ['push', 'skipped', null, null, ''],
    // Obyekt prototipi kalitlari yorliq bo'lib chiqmaydi.
    ['push', 'failed', 'constructor', null, 'constructor'],
  ] as Array<[string, string, string | null, string | null, string | RegExp]>)(
    'sabab: %s / %s / %s / %s',
    (channel, status, code, raw, expected) => {
      const label = reason(channel, status, code, raw);
      if (typeof expected === 'string') expect(label).toBe(expected);
      else expect(label).toMatch(expected);
    },
  );

  it('kanal, rol, holat: yorliq yoki xom qiymat', () => {
    expect(channelLabel('realtime')).toBe('Darhol');
    expect(channelLabel('fax')).toBe('fax');
    expect(roleLabel('registrator')).toBe('Registrator');
    expect(roleLabel('admin, manager')).toBe('Admin, Menejer');
    expect(roleLabel('pilot')).toBe('pilot');
    expect(roleLabel(null)).toBe('');
    expect(statusLabel('blocked')).toBe("O'tkazib yuborildi");
    expect(statusLabel('expired')).toBe('Xato');
    expect(statusLabel('paused')).toBe('paused');
    expect(statusBucket('sms', 'transmitted')).toBe('failed');
    expect(statusBucket('notification', 'paused')).toBe('skipped');
  });
});
