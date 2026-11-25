import 'reflect-metadata';
import {
  Body,
  Controller,
  ExecutionContext,
  HttpCode,
  INestApplication,
  Post,
  VERSION_NEUTRAL,
  VersioningType,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AllExceptionsFilter } from '@app/common';
import { Workbook } from 'exceljs';
import { sheetOrderProblems } from '@app/report-kit/testing/sheet-order';
import request from 'supertest';
import { JwtAuthGuard } from './auth/jwt-auth.guard';
import { OLD_MAILS_EXPORT_MAX_ROWS } from './dto/old-mails-export.swagger.dto';
import {
  OLD_MAILS_BODY_LIMIT_BYTES,
  applyOldMailsBodyLimit,
} from './order-export/old-mails-body-limit';
import { oldMailsXlsxFileName } from './order-export/old-mails-xlsx';
import { OldMailsExportController } from './old-mails-export.controller';
import { UzValidationPipe } from './validation/uz-validation.pipe';

/**
 * `POST /export/old-mails.xlsx` — «Eski pochtalar hisoboti» (sof render):
 * ruxsat, DTO, tana hajmi (boshqa yo'llarga ta'sirisiz), fayl mazmuni.
 */

@Controller('echo')
class EchoController {
  @Post()
  @HttpCode(200)
  echo(@Body() body: unknown) {
    return { body: body ?? null };
  }
}

type Row = Record<string, unknown>;

const row = (extra: Row = {}): Row => ({
  id: '2417',
  region: 'Andijon viloyati',
  courier: 'Jasur Tursunov',
  status: "Jo'natilgan",
  status_tone: 'warning',
  orders: 24,
  amount: 11_310_000,
  created_at: '2026-11-21T12:32:00.000Z',
  ...extra,
});

const ROWS = [
  row(),
  row({
    id: '2416',
    region: 'Samarqand viloyati',
    courier: 'Sardor Rashidov',
    status: 'Qabul qilingan',
    status_tone: 'success',
    orders: 31,
    amount: 13_845_000,
  }),
  row({
    id: '2412',
    courier: null,
    status: 'Rad etilgan',
    status_tone: 'danger',
    orders: 4,
    amount: 1_685_000,
    created_at: '',
  }),
];

const plain = (value: unknown): unknown => {
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    const cell = value as {
      formula?: string;
      result?: unknown;
      richText?: Array<{ text: string }>;
    };
    if (cell.richText) return cell.richText.map((part) => part.text).join('');
    if (cell.formula) return cell.result ?? 0;
  }
  return value;
};

const load = async (buffer: Buffer) => {
  const wb = new Workbook();
  // Excel «Repaired» qilmasin (exceljs o'qiganda sezmaydi).
  expect(sheetOrderProblems(buffer)).toEqual([]);
  await wb.xlsx.load(buffer as unknown as ArrayBuffer);
  return wb;
};

const sheetRows = (wb: Workbook, name: string): unknown[][] => {
  const rows: unknown[][] = [];
  wb.getWorksheet(name)!.eachRow({ includeEmpty: false }, (r) => {
    rows.push((r.values as unknown[]).slice(2).map(plain));
  });
  return rows;
};

describe('POST /export/old-mails.xlsx', () => {
  jest.setTimeout(30_000);
  let app: INestApplication;
  let roles: string[] = ['superadmin'];

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [OldMailsExportController, EchoController],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({
        canActivate: (ctx: ExecutionContext) => {
          ctx.switchToHttp().getRequest<{ user?: unknown }>().user = {
            sub: '1',
            roles,
          };
          return true;
        },
      })
      .compile();
    // main.ts bilan bir xil tartib: rawBody, versiyalar, tana chegarasi, pipe.
    app = moduleRef.createNestApplication({ rawBody: true, logger: false });
    app.enableVersioning({
      type: VersioningType.URI,
      defaultVersion: [VERSION_NEUTRAL, '1'],
    });
    applyOldMailsBodyLimit(app);
    app.useGlobalPipes(
      new UzValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    app.useGlobalFilters(new AllExceptionsFilter());
    await app.init();
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  beforeEach(() => {
    roles = ['superadmin'];
  });

  const http = () => app.getHttpServer() as Parameters<typeof request>[0];
  const post = (body: unknown, path = '/export/old-mails.xlsx') =>
    request(http())
      .post(path)
      .send(body as object)
      .buffer(true)
      .parse((res, cb) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => cb(null, Buffer.concat(chunks)));
      });
  const exportRows = (rows: unknown, extra: Row = {}) =>
    post({ title: 'Eski pochtalar hisoboti', rows, ...extra });
  const messageOf = (res: { body: unknown }) =>
    (JSON.parse((res.body as Buffer).toString('utf8')) as { message: string })
      .message;

  describe('ruxsat (FE `canViewMails`)', () => {
    it.each(['superadmin', 'admin', 'registrator', 'manager', 'courier'])(
      '%s — 200',
      async (role) => {
        roles = [role];
        expect((await exportRows([row()])).status).toBe(200);
      },
    );

    // LOGIST — moliyaga aralashmaydi (faylda summa bor).
    it.each([
      'logist',
      'market',
      'market_operator',
      'customer',
      'investor',
      'operator',
    ])('%s — 403', async (role) => {
      roles = [role];
      expect((await exportRows([row()])).status).toBe(403);
    });
  });

  describe('fayl', () => {
    it('haqiqiy .xlsx: nom, MIME, jami kartalar, ro‘yxat, SUBTOTAL', async () => {
      const res = await exportRows(ROWS, {
        subtitle: 'Davr: 14.11.2026 – 21.11.2026 · Holat: barchasi',
      });
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toContain('spreadsheetml.sheet');
      expect(res.headers['content-disposition']).toMatch(
        /^attachment; filename="old-mails-\d{4}-\d{2}-\d{2}\.xlsx"$/,
      );
      expect(res.headers['cache-control']).toBe('no-store');

      const wb = await load(res.body as Buffer);
      const ws = wb.getWorksheet('Eski pochtalar')!;
      const rows = sheetRows(wb, 'Eski pochtalar');
      expect(ws.getImages()).toHaveLength(1);
      expect(rows[0]).toEqual(
        expect.arrayContaining(['Eski pochtalar hisoboti', '3 ta pochta']),
      );
      expect(rows[1]).toContain(
        'Davr: 14.11.2026 – 21.11.2026 · Holat: barchasi',
      );
      expect(rows).toContainEqual(expect.arrayContaining([3, 59, 26_840_000]));
      expect((ws.getRow(9).values as unknown[]).slice(2)).toEqual([
        'T/r',
        'Pochta raqami',
        'Viloyat',
        'Kuryer',
        'Holati',
        'Buyurtmalar',
        "Summa, so'm",
        'Pochta sanasi',
      ]);
      expect((ws.getRow(10).values as unknown[]).slice(2)).toEqual([
        1,
        2417,
        'Andijon viloyati',
        'Jasur Tursunov',
        "Jo'natilgan",
        24,
        11_310_000,
        new Date('2026-11-21T17:32:00.000Z'),
      ]);
      expect((ws.getRow(12).values as unknown[]).slice(2)).toEqual([
        3,
        2412,
        'Andijon viloyati',
        '—',
        'Rad etilgan',
        4,
        1_685_000,
        '—',
      ]);
      // Holat rangi.
      expect(ws.getCell('F10').font.color?.argb).toBe('FF95560A');
      expect(ws.getCell('F12').font.color?.argb).toBe('FFBE2A3B');
      expect(ws.getCell('D13').value).toMatchObject({
        formula: 'SUBTOTAL(2,B10:B12)',
        result: 3,
      });
      expect(ws.getCell('H13').value).toMatchObject({
        formula: 'SUBTOTAL(9,H10:H12)',
        result: 26_840_000,
      });
      expect(ws.autoFilter).toBe('B9:I12');
      expect(rows.some((r) => /^DIQQAT/.test(String(r[0])))).toBe(false);
    });

    it('«Xulosa»: holat, viloyat, kuryer bo‘yicha (kuryersiz — Biriktirilmagan)', async () => {
      const wb = await load((await exportRows(ROWS)).body as Buffer);
      const rows = sheetRows(wb, 'Xulosa');
      const named = (name: string) => rows.find((r) => r[0] === name)!;
      // Kartalar tartibi: yashil, sariq, qizil.
      expect(rows.find((r) => r.includes('Rad etilgan'))).toEqual(
        expect.arrayContaining([
          'Qabul qilingan',
          "Jo'natilgan",
          'Rad etilgan',
        ]),
      );
      expect(named('Andijon viloyati')).toEqual(
        expect.arrayContaining([2, 28, 12_995_000]),
      );
      expect(named('Biriktirilmagan')).toEqual(
        expect.arrayContaining([1, 4, 1_685_000]),
      );
      expect(rows.filter((r) => r[0] === 'JAMI')).toHaveLength(3);
      for (const jami of rows.filter((r) => r[0] === 'JAMI')) {
        expect(jami).toEqual(expect.arrayContaining([3, 59, 1, 26_840_000]));
      }
      const bars = wb.getWorksheet('Xulosa') as unknown as {
        conditionalFormattings: Array<{ rules: Array<{ type: string }> }>;
      };
      expect(bars.conditionalFormattings.map((cf) => cf.rules[0].type)).toEqual(
        ['dataBar', 'dataBar', 'dataBar'],
      );
    });

    it('hide_courier («Filial paketlari») — kuryer ustuni ham, jadvali ham yo‘q', async () => {
      const wb = await load(
        (
          await exportRows(
            [row({ status: 'Yangi', status_tone: 'info', id: 'B-129' })],
            { title: 'Eski paketlar hisoboti', hide_courier: true },
          )
        ).body as Buffer,
      );
      const ws = wb.getWorksheet('Eski paketlar')!;
      expect(ws.getCell('C10').value).toBe('B-129');
      const cells = wb.worksheets.flatMap((sheet) =>
        sheetRows(wb, sheet.name).flat(),
      );
      expect(cells).not.toContain('Kuryer');
      expect(cells).not.toContain('Jasur Tursunov');
      expect(cells).not.toContain("Kuryerlar bo'yicha");
      expect(cells).toContain('1 ta paket');
    });

    it('capped — DIQQAT tepada, oxirida va «Xulosa» da; matn FE dan ham bo‘ladi', async () => {
      const wb = await load(
        (await exportRows(ROWS, { capped: true })).body as Buffer,
      );
      const rows = sheetRows(wb, 'Eski pochtalar');
      const warnings = rows.filter((r) => /^DIQQAT/.test(String(r[0])));
      expect(warnings).toHaveLength(2);
      expect(rows.indexOf(warnings[0])).toBeLessThan(
        rows.findIndex((r) => r[0] === 'T/r'),
      );
      expect(
        sheetRows(wb, 'Xulosa').some((r) => /^DIQQAT/.test(String(r[0]))),
      ).toBe(true);

      const ru = await load(
        (
          await exportRows(ROWS, {
            capped: true,
            labels: { capped_note: 'ВНИМАНИЕ: файл неполный' },
          })
        ).body as Buffer,
      );
      expect(sheetRows(ru, 'Eski pochtalar').flat()).toContain(
        'ВНИМАНИЕ: файл неполный',
      );
    });

    it('yorliqlar foydalanuvchi tilida; birlik matni formatni buzmaydi', async () => {
      const res = await exportRows(ROWS, {
        labels: {
          no: '№ п/п',
          courier: 'Курьер',
          amount: 'Сумма',
          currency: 'сум',
          total: 'ИТОГО',
          mails_unit: 'по"чт',
        },
      });
      const wb = await load(res.body as Buffer);
      const ws = wb.getWorksheet('Eski pochtalar')!;
      const header = (ws.getRow(9).values as unknown[]).slice(2);
      expect(header).toEqual(
        expect.arrayContaining(['№ п/п', 'Курьер', 'Сумма, сум', 'Viloyat']),
      );
      expect(ws.getCell('B13').value).toBe('ИТОГО');
      expect(ws.getCell('D13').numFmt).toBe('#,##0" почт"');
    });

    it('matn «=», «+», «-», «@» bilan boshlansa ham matn', async () => {
      const ws = (
        await load(
          (
            await exportRows(
              [
                row({
                  id: '=1+1',
                  region: '+SUM(1)',
                  courier: '-2',
                  status: '@x',
                  created_at: '=NOW()',
                }),
              ],
              { title: '=HYPERLINK("http://x")' },
            )
          ).body as Buffer,
        )
      ).getWorksheet('Eski pochtalar')!;
      expect((ws.getRow(10).values as unknown[]).slice(2)).toEqual([
        1,
        '=1+1',
        '+SUM(1)',
        '-2',
        '@x',
        24,
        11_310_000,
        '=NOW()',
      ]);
      ws.eachRow((r) =>
        r.eachCell((cell) => {
          if (cell.formula) expect(cell.formula).toMatch(/^SUBTOTAL\(/);
        }),
      );
    });

    it('bo‘sh ro‘yxat — fayl ochiladi', async () => {
      const res = await exportRows([]);
      expect(res.status).toBe(200);
      const rows = sheetRows(await load(res.body as Buffer), 'Eski pochtalar');
      expect(rows.find((r) => r[0] === 'JAMI')).toEqual(
        expect.arrayContaining([0]),
      );
    });

    it('fayl nomi — Toshkent kuni', () => {
      expect(oldMailsXlsxFileName(new Date('2026-10-31T20:30:00.000Z'))).toBe(
        'old-mails-2026-11-01.xlsx',
      );
    });
  });

  describe('DTO (whitelist)', () => {
    it.each<[string, Row, RegExp]>([
      ['title yo‘q', { title: undefined, rows: [row()] }, /title/],
      ['title uzun', { title: 'x'.repeat(121), rows: [row()] }, /title/],
      ['rows yo‘q', { rows: undefined }, /rows/],
      ['rows massiv emas', { rows: { 0: row() } }, /rows/],
      ['ortiqcha maydon', { rows: [], sql: 'x' }, /sql/],
      ['qatorda ortiqcha maydon', { rows: [row({ secret: 1 })] }, /secret/],
      ['labels da ortiqcha maydon', { rows: [], labels: { foo: 'x' } }, /foo/],
      ['id son', { rows: [row({ id: 1 })] }, /id/],
      ['id uzun', { rows: [row({ id: 'x'.repeat(41) })] }, /id/],
      ['region uzun', { rows: [row({ region: 'x'.repeat(121) })] }, /region/],
      [
        'courier uzun',
        { rows: [row({ courier: 'x'.repeat(121) })] },
        /courier/,
      ],
      ['status uzun', { rows: [row({ status: 'x'.repeat(61) })] }, /status/],
      [
        'status_tone noma’lum',
        { rows: [row({ status_tone: 'pink' })] },
        /tone/,
      ],
      ['orders matn', { rows: [row({ orders: '24' })] }, /orders/],
      ['orders manfiy', { rows: [row({ orders: -1 })] }, /orders/],
      ['orders kasr', { rows: [row({ orders: 1.5 })] }, /orders/],
      ['amount matn', { rows: [row({ amount: '=1' })] }, /amount/],
      ['amount null (NaN)', { rows: [row({ amount: NaN })] }, /amount/],
      ['amount juda katta', { rows: [row({ amount: 1e12 })] }, /amount/],
      [
        'created_at uzun',
        { rows: [row({ created_at: 'x'.repeat(41) })] },
        /created_at/,
      ],
      ['capped matn', { rows: [], capped: 'true' }, /capped/],
      ['qator null', { rows: [null] }, /rows/],
    ])('%s — 400', async (_name, extra, message) => {
      const res = await post({ title: 'Hisobot', rows: [], ...extra });
      expect(res.status).toBe(400);
      expect(messageOf(res)).toMatch(message);
    });

    it(`rows > ${OLD_MAILS_EXPORT_MAX_ROWS} — 400`, async () => {
      const rows = Array.from({ length: OLD_MAILS_EXPORT_MAX_ROWS + 1 }, () =>
        row(),
      );
      const res = await exportRows(rows);
      expect(res.status).toBe(400);
      expect(messageOf(res)).toMatch(/rows/);
    });
  });

  describe('tana hajmi', () => {
    it('10 000 qator (kirillcha nomlar bilan) sig‘adi — /v1 da ham', async () => {
      const rows = Array.from({ length: OLD_MAILS_EXPORT_MAX_ROWS }, (_, i) =>
        row({
          id: String(1_000_000 + i),
          region: 'Республика Каракалпакстан',
          courier: 'Турсунов Жасур Абдуллаевич',
          status: 'Принята',
        }),
      );
      const body = { title: 'Старые почты', rows };
      const size = Buffer.byteLength(JSON.stringify(body));
      expect(size).toBeGreaterThan(2_000_000);
      expect(size).toBeLessThan(OLD_MAILS_BODY_LIMIT_BYTES);
      const res = await post(body, '/v1/export/old-mails.xlsx');
      expect(res.status).toBe(200);
      const ws = (await load(res.body as Buffer)).getWorksheet(
        'Eski pochtalar',
      )!;
      expect(ws.getCell(9 + OLD_MAILS_EXPORT_MAX_ROWS, 2).value).toBe(
        OLD_MAILS_EXPORT_MAX_ROWS,
      );
    });

    it('chegaradan katta — 413 (o‘zbekcha xabar)', async () => {
      const res = await exportRows([
        row({ region: 'x'.repeat(OLD_MAILS_BODY_LIMIT_BYTES) }),
      ]);
      expect(res.status).toBe(413);
      expect(messageOf(res)).toContain("Ro'yxat juda katta");
    });

    it('buzuq JSON — 400', async () => {
      const res = await request(http())
        .post('/export/old-mails.xlsx')
        .set('Content-Type', 'application/json')
        .send('{"title":');
      expect(res.status).toBe(400);
    });

    // Nest umumiy parserni `jsonParser` nomi bo'yicha tekshiradi: path'li
    // parser uni siqib chiqarmasligi SHART.
    it('⚠️ boshqa yo‘llar: JSON o‘qiladi va chegara 100 KB ligicha', async () => {
      const ok = await request(http()).post('/echo').send({ a: 1 });
      expect(ok.body).toEqual({ body: { a: 1 } });
      const big = await request(http())
        .post('/echo')
        .send({ a: 'x'.repeat(150_000) });
      expect(big.status).toBe(413);
    });
  });
});
