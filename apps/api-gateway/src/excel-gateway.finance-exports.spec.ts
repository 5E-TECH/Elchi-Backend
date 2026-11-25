import 'reflect-metadata';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Workbook, type Cell, type Worksheet } from 'exceljs';
import { of, throwError } from 'rxjs';
import request from 'supertest';
import { JwtAuthGuard } from './auth/jwt-auth.guard';
import { ROLES_KEY } from './auth/roles.decorator';
import {
  CASHBOX_REPORT_BRANCH_ONLY_MESSAGE,
  CASHBOX_REPORT_MAIN_ONLY_MESSAGE,
  ExcelGatewayController,
  SHIFT_NOT_FOUND_MESSAGE,
} from './excel-gateway.controller';

/**
 * Kassa va moliya eksportlari (B1–B3) va yangi kassa hisoboti (B5/B6) —
 * gateway: RPC yuklari, doira / ruxsat, davr, fail-open, 50 000 chegara.
 * HAQIQIY HTTP (RolesGuard bilan), fayl qayta o'qiladi.
 */

type Payload = Record<string, any>;
type Handler = (payload: Payload) => unknown;

/** Lahza: 2026-11-25 14:20 Toshkent. */
const NOW = new Date('2026-11-25T09:20:00.000Z');
const MAIN = { cashbox_type: 'main', user_id: '0' };
const BRANCH = { cashbox_type: 'branch', user_id: '13' };

const historyRow = (id: number, extra: Payload = {}): Payload => ({
  id: String(id),
  createdAt: new Date(Date.UTC(2026, 10, 25, 4, id)).toISOString(),
  operation_type: 'income',
  source_type: 'courier_payment',
  source_user: { name: 'Jasur Tursunov' },
  payment_method: 'cash',
  amount: 100,
  balance_after: 1100,
  balance_cash_after: 1100,
  balance_card_after: 0,
  cashbox_id: '1',
  cashbox: MAIN,
  created_by: '3',
  created_by_user: { name: 'Dilnoza Karimova' },
  ...extra,
});

/** Mikroservis xatosi (`RpcException(errorRes(...))` gateway'ga shunday keladi). */
const rpcError = (statusCode: number, message: string) =>
  Object.assign(new Error(message), { statusCode });

describe('Kassa va moliya eksportlari — gateway', () => {
  let app: INestApplication;
  let controller: ExcelGatewayController;
  let user: Payload;
  let finance: Record<string, Handler>;
  let branch: Record<string, Handler>;
  let identity: Record<string, Handler>;

  const client = (table: () => Record<string, Handler>) => ({
    send: jest.fn((pattern: { cmd: string }, payload: Payload) => {
      const handler = table()[pattern.cmd];
      if (!handler)
        return throwError(() => new Error(`RPC yo'q: ${pattern.cmd}`));
      try {
        return of(handler(payload));
      } catch (error) {
        return throwError(() => error);
      }
    }),
  });
  const financeClient = client(() => finance);
  const branchClient = client(() => branch);
  const identityClient = client(() => identity);

  const ADMIN = { sub: '8', roles: ['admin'] };
  const MANAGER = { sub: '25', roles: ['manager'], branch_id: '13' };

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [ExcelGatewayController],
      providers: [
        { provide: 'ORDER', useValue: { send: jest.fn() } },
        { provide: 'FINANCE', useValue: financeClient },
        { provide: 'BRANCH', useValue: branchClient },
        { provide: 'IDENTITY', useValue: identityClient },
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({
        canActivate: (context: {
          switchToHttp: () => { getRequest: () => Payload };
        }) => {
          context.switchToHttp().getRequest().user = user;
          return true;
        },
      })
      .compile();
    app = module.createNestApplication({ logger: false });
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    await app.init();
    controller = module.get(ExcelGatewayController);
  });

  afterAll(async () => {
    jest.useRealTimers();
    await app?.close();
  });

  beforeEach(() => {
    jest.useFakeTimers({
      now: NOW,
      doNotFake: [
        'nextTick',
        'setImmediate',
        'setTimeout',
        'setInterval',
        'clearTimeout',
        'clearInterval',
        'queueMicrotask',
      ],
    });
    user = ADMIN;
    [financeClient, branchClient, identityClient].forEach((c) =>
      c.send.mockClear(),
    );
    Object.assign(controller, { reportRowLimit: 50_000 });
    finance = {
      'finance.history.find_all': () => ({
        data: { items: [historyRow(1)], pagination: { total: 1 } },
      }),
      'finance.cashbox.find_by_user': (p) => ({
        data: {
          id: p.cashbox_type === 'main' ? '1' : '21',
          balance: 1100,
          balance_cash: 1100,
          balance_card: 0,
        },
      }),
    };
    branch = {
      'branch.find_all': () => ({
        data: { items: [{ id: '5', name: 'Andijon filiali' }] },
      }),
      'branch.find_by_id': () => ({ data: { id: '13', name: 'Andijon' } }),
      'branch.user.find_by_user': () => ({ data: null }),
    };
    identity = {
      'identity.user.find_by_ids': () => ({
        data: [{ id: '7', name: 'Ali Valiyev', phone_number: '+998900000001' }],
      }),
    };
  });

  const get = (path: string) =>
    request(app.getHttpServer())
      .get(`/export/${path}`)
      .buffer(true)
      .parse((r, cb) => {
        const chunks: Buffer[] = [];
        r.on('data', (c: Buffer) => chunks.push(c));
        r.on('end', () => cb(null, Buffer.concat(chunks)));
      });
  const message = (body: unknown) =>
    (JSON.parse((body as Buffer).toString()) as { message: string }).message;
  const load = async (body: unknown) => {
    const workbook = new Workbook();
    await workbook.xlsx.load(body as never);
    return workbook;
  };
  const value = (cell: Cell): unknown =>
    cell.formula ? cell.result : cell.value;
  const texts = (ws: Worksheet): string[] => {
    const out: string[] = [];
    ws.eachRow((r) =>
      r.eachCell((cell) => {
        const v = value(cell);
        if (cell.master === cell && typeof v === 'string') out.push(v);
      }),
    );
    return out;
  };
  const payloads = (target: { send: jest.Mock }, cmd: string): Payload[] =>
    (target.send.mock.calls as Array<[{ cmd: string }, Payload]>)
      .filter(([pattern]) => pattern.cmd === cmd)
      .map(([, payload]) => payload);
  const historyCall = (i = 0) =>
    payloads(financeClient, 'finance.history.find_all')[i];

  // ───────────────────────── B1–B3 ─────────────────────────

  describe('cashbox-history.xlsx (B1)', () => {
    it('so`rov o`zgarmagan (butun ro`yxat), fayl nomi va MIME avvalgidek', async () => {
      const res = await get(
        'cashbox-history.xlsx?cashbox_id=1&from_date=2026-11-18&to_date=2026-11-24',
      );
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toContain('spreadsheetml.sheet');
      expect(res.headers['content-disposition']).toBe(
        'attachment; filename="cashbox-history.xlsx"',
      );
      expect(historyCall()).toEqual({
        cashbox_id: '1',
        from_date: '2026-11-18',
        to_date: '2026-11-24',
        page: 0,
        limit: 0,
      });
      // Filial kassasi yo'q — nomlar so'ralmaydi.
      expect(branchClient.send).not.toHaveBeenCalled();
      const wb = await load(res.body);
      expect(wb.worksheets.map((w) => w.name)).toEqual([
        'Xulosa',
        'Harakatlar',
      ]);
      expect(texts(wb.worksheets[0]).some((t) => /^Mos keldi/.test(t))).toBe(
        true,
      );
    });

    it('filial nomlari bulk; branch javob bermasa — «Filial #13», fayl chiqadi', async () => {
      finance['finance.history.find_all'] = () => ({
        data: {
          items: [historyRow(1, { cashbox: BRANCH, cashbox_id: '21' })],
          pagination: { total: 1 },
        },
      });
      branch['branch.find_all'] = () => {
        throw new Error('timeout');
      };
      const res = await get('cashbox-history.xlsx');
      expect(res.status).toBe(200);
      expect(payloads(branchClient, 'branch.find_all')).toHaveLength(1);
      const wb = await load(res.body);
      expect(wb.worksheets[1].getCell('D7').value).toBe('Filial #13');
    });

    it('chegaradan ko`p — DIQQAT (jimgina qirqilmaydi)', async () => {
      Object.assign(controller, { reportRowLimit: 2 });
      finance['finance.history.find_all'] = () => ({
        data: {
          items: [historyRow(3), historyRow(2), historyRow(1)],
          pagination: { total: 3 },
        },
      });
      const wb = await load(
        (await get('cashbox-history.xlsx?cashbox_id=1')).body,
      );
      const all = texts(wb.worksheets[0]);
      expect(all.some((t) => t.startsWith('DIQQAT: jami 3 ta harakat'))).toBe(
        true,
      );
      expect(all).not.toContain('Qoldiq harakati');
    });

    it.each(['manager', 'registrator', 'courier', 'market', 'logist'])(
      '%s — 403, RPC yo`q',
      async (role) => {
        user = { sub: '1', roles: [role], branch_id: '13' };
        for (const path of [
          'cashbox-history.xlsx',
          'shifts.xlsx',
          'financial-balance.xlsx',
        ]) {
          expect((await get(path)).status).toBe(403);
        }
        expect(financeClient.send).not.toHaveBeenCalled();
      },
    );
  });

  describe('shifts.xlsx (B2)', () => {
    const shift = (id: number, extra: Payload = {}): Payload => ({
      id: String(id),
      status: 'closed',
      cashbox_user_id: '0',
      opened_at: new Date(1_780_000_000_000 + id * 3_600_000).toISOString(),
      closed_at: new Date(1_780_000_000_000 + id * 3_700_000).toISOString(),
      opened_by_name: 'Dilnoza Karimova',
      closed_by_system: true,
      closing_balance_cash: 10,
      discrepancy_cash: 0,
      discrepancy_card: 0,
      ...extra,
    });

    it('sahifalab o`qiydi; sahifalar orasida siljigan qator ikki marta tushmaydi', async () => {
      const all = Array.from({ length: 501 }, (_, i) => shift(501 - i));
      let calls = 0;
      finance['finance.shift.find_all'] = (p) => {
        calls += 1;
        // 1-sahifadan keyin yangi smena ochildi — hammasi bittaga siljidi.
        const source = calls === 1 ? all : [shift(600), ...all];
        const items = source.slice((p.page - 1) * p.limit, p.page * p.limit);
        return { data: { items, pagination: { total: source.length } } };
      };
      const res = await get('shifts.xlsx?status=closed&from_date=2026-06-01');
      expect(res.headers['content-disposition']).toBe(
        'attachment; filename="shifts.xlsx"',
      );
      expect(payloads(financeClient, 'finance.shift.find_all')[0]).toEqual({
        status: 'closed',
        from_date: '2026-06-01',
        page: 1,
        limit: 500,
      });
      const wb = await load(res.body);
      const list = wb.getWorksheet('Smenalar')!;
      expect(list.getCell('B8').value).toBe(1);
      expect(list.getCell('B508').value).toBe(501);
      expect(list.getCell('B509').value).toBe('JAMI');
      expect(texts(wb.worksheets[0]).some((t) => /DIQQAT/.test(t))).toBe(false);
    });

    it('Kassa / Ochgan / Yopgan: filial nomi bulk, tizim — «Tizim»', async () => {
      finance['finance.shift.find_all'] = () => ({
        data: {
          items: [shift(2, { cashbox_user_id: '5' }), shift(1)],
          pagination: { total: 2 },
        },
      });
      const list = (await load((await get('shifts.xlsx')).body)).getWorksheet(
        'Smenalar',
      )!;
      expect(
        ['C8', 'E8', 'G8', 'C9'].map((c) => list.getCell(c).value),
      ).toEqual([
        'Asosiy kassa',
        'Dilnoza Karimova',
        'Tizim',
        'Andijon filiali',
      ]);
      expect(payloads(branchClient, 'branch.find_all')[0]).toMatchObject({
        query: { page: 1, limit: 100 },
        requester: { id: '8', roles: ['admin'] },
      });
    });
  });

  describe('financial-balance.xlsx (B3)', () => {
    const entry = (id: number): Payload => ({
      id: String(id),
      createdAt: new Date(1_780_000_000_000 + id * 1000).toISOString(),
      source_type: 'sell_profit',
      amount: 10,
      balance_before: (id - 1) * 10,
      balance_after: id * 10,
      created_by: '7',
    });

    it('sahifalar orasida yangi yozuv tushsa — takror yo`q, zanjir mos; ismlar bitta so`rovda', async () => {
      const all = Array.from({ length: 250 }, (_, i) => entry(250 - i));
      let calls = 0;
      finance['finance.financial_balance.history'] = (p) => {
        calls += 1;
        const source = calls === 1 ? all : [entry(251), ...all];
        return {
          data: {
            items: source.slice(p.offset, p.offset + p.limit),
            total: source.length,
          },
        };
      };
      const res = await get('financial-balance.xlsx?from_date=2026-06-01');
      const wb = await load(res.body);
      const list = wb.getWorksheet('Daftar')!;
      expect(list.getCell('B7').value).toBe(1);
      expect(list.getCell('B256').value).toBe(250);
      expect(list.getCell('B257').value).toBe('JAMI');
      expect(list.getCell('J7').value).toBe('Ali Valiyev');
      const all2 = texts(wb.worksheets[0]);
      expect(all2.some((t) => /^Mos keldi/.test(t))).toBe(true);
      expect(all2.some((t) => /DIQQAT/.test(t))).toBe(false);
      expect(payloads(identityClient, 'identity.user.find_by_ids')).toEqual([
        { ids: ['7'] },
      ]);
    });

    it('identity xato — #id bilan fayl baribir chiqadi', async () => {
      finance['finance.financial_balance.history'] = () => ({
        data: { items: [entry(1)], total: 1 },
      });
      identity = {};
      const res = await get('financial-balance.xlsx');
      expect(res.status).toBe(200);
      const list = (await load(res.body)).getWorksheet('Daftar')!;
      expect(list.getCell('J7').value).toBe('#7');
    });

    it('chegaradan ko`p — DIQQAT', async () => {
      Object.assign(controller, { reportRowLimit: 3 });
      const all = Array.from({ length: 5 }, (_, i) => entry(5 - i));
      finance['finance.financial_balance.history'] = () => ({
        data: { items: all, total: 5 },
      });
      const wb = await load((await get('financial-balance.xlsx')).body);
      const all2 = texts(wb.worksheets[0]);
      expect(all2.some((t) => t.startsWith('DIQQAT: jami 5 ta yozuv'))).toBe(
        true,
      );
      expect(all2).not.toContain("Davr boshida, so'm");
    });
  });

  // ───────────────────────── B5 / B6 ─────────────────────────

  describe('cashbox-report.xlsx (B5 / B6)', () => {
    const PATH = 'cashbox-report.xlsx';

    it('faqat SUPERADMIN, ADMIN, MANAGER', () => {
      const handler = Object.getOwnPropertyDescriptor(
        ExcelGatewayController.prototype,
        'exportCashboxReport',
      )?.value as object;
      expect(
        [...(Reflect.getMetadata(ROLES_KEY, handler) as string[])].sort(),
      ).toEqual(['admin', 'manager', 'superadmin']);
    });

    it.each([
      'registrator',
      'branch',
      'courier',
      'market',
      'logist',
      'operator',
      'investor',
      'customer',
    ])('%s — 403, RPC yo`q', async (role) => {
      user = { sub: '1', roles: [role], branch_id: '13' };
      expect((await get(PATH)).status).toBe(403);
      expect(financeClient.send).not.toHaveBeenCalled();
      expect(branchClient.send).not.toHaveBeenCalled();
    });

    it('SA/admin: hech narsa berilmasa — asosiy kassa, BUGUN (Toshkent), butun tarix emas', async () => {
      const res = await get(PATH);
      expect(res.status).toBe(200);
      expect(historyCall()).toEqual({
        user_id: '0',
        cashbox_type: 'main',
        from_date: '2026-11-25',
        to_date: '2026-11-25',
        page: 0,
        limit: 0,
      });
      expect(payloads(financeClient, 'finance.cashbox.find_by_user')).toEqual([
        { user_id: '0', cashbox_type: 'main' },
      ]);
      expect(res.headers['content-type']).toContain('spreadsheetml.sheet');
      expect(res.headers['content-disposition']).toBe(
        'attachment; filename="kassa-hisobot-2026-11-25.xlsx"',
      );
      const wb = await load(res.body);
      expect(wb.worksheets.map((w) => w.name)).toEqual(['Asosiy kassa']);
      const all = texts(wb.worksheets[0]);
      expect(all).toContain('25.11.2026');
      expect(all).toContain('Kassa balansiga teng');
    });

    it('Toshkent yarim tunidan keyin «bugun» — yangi kun (UTC hali kecha)', async () => {
      jest.setSystemTime(new Date('2026-11-24T19:30:00.000Z')); // 25.11 00:30
      await get(PATH);
      expect(historyCall()).toMatchObject({
        from_date: '2026-11-25',
        to_date: '2026-11-25',
      });
    });

    it('davr: ikkala sana; o`tgan davrda balans nazorati yo`q; fayl nomi oraliq', async () => {
      const res = await get(`${PATH}?from_date=2026-11-18&to_date=2026-11-24`);
      expect(historyCall()).toMatchObject({
        from_date: '2026-11-18',
        to_date: '2026-11-24',
      });
      expect(res.headers['content-disposition']).toBe(
        'attachment; filename="kassa-hisobot-2026-11-18_2026-11-24.xlsx"',
      );
      const all = texts((await load(res.body)).worksheets[0]);
      expect(all).toContain('18.11 — 24.11.2026');
      expect(all).not.toContain('Kassa balansiga teng');
      expect(all.some((t) => t.startsWith('Hozirgi kassa balansi'))).toBe(true);
    });

    it('faqat from_date — hozirgacha; faqat to_date — o`sha kun', async () => {
      const open = await get(`${PATH}?from_date=2026-11-20`);
      expect(historyCall(0)).toEqual({
        user_id: '0',
        cashbox_type: 'main',
        from_date: '2026-11-20',
        page: 0,
        limit: 0,
      });
      expect(texts((await load(open.body)).worksheets[0])).toEqual(
        expect.arrayContaining(['20.11 — 25.11.2026', 'Kassa balansiga teng']),
      );
      await get(`${PATH}?to_date=2026-11-20`);
      expect(historyCall(1)).toMatchObject({
        from_date: '2026-11-20',
        to_date: '2026-11-20',
      });
    });

    it.each([
      'from_date=kecha',
      'to_date=kecha',
      'from_date=2026-11-24&to_date=2026-11-18',
      'from_date=2026-11-18&from_date=2026-11-19',
      'shift_id=abc',
      'shift_id=1&shift_id=2',
    ])('%s — 400, tarix o`qilmaydi', async (query) => {
      expect((await get(`${PATH}?${query}`)).status).toBe(400);
      expect(historyCall()).toBeUndefined();
    });

    describe('menejer — FAQAT o`z filiali kassasi', () => {
      beforeEach(() => {
        user = MANAGER;
        finance['finance.history.find_all'] = () => ({
          data: {
            items: [historyRow(1, { cashbox: BRANCH, cashbox_id: '21' })],
            pagination: { total: 1 },
          },
        });
      });

      it('doira JWT filialidan; bitta jami; filial nomi', async () => {
        const res = await get(PATH);
        expect(res.status).toBe(200);
        expect(historyCall()).toMatchObject({
          user_id: '13',
          cashbox_type: 'branch',
        });
        expect(payloads(financeClient, 'finance.cashbox.find_by_user')).toEqual(
          [{ user_id: '13', cashbox_type: 'branch' }],
        );
        const ws = (await load(res.body)).worksheets[0];
        const all = texts(ws);
        expect(ws.name).toBe('Filial kassasi');
        expect(all).toContain('Andijon kassasi');
        expect(
          all.some((t) => /Naqd qoldiq|Karta qoldiq|Asosiy kassa/.test(t)),
        ).toBe(false);
      });

      it('JWT da filial yo`q — branch_users dan; u ham yo`q — 403 (fail-closed)', async () => {
        user = { sub: '25', roles: ['manager'] };
        branch['branch.user.find_by_user'] = () => ({
          data: { branch_id: '13' },
        });
        expect((await get(PATH)).status).toBe(200);
        expect(historyCall()).toMatchObject({ user_id: '13' });
        financeClient.send.mockClear();
        branch['branch.user.find_by_user'] = () => ({ data: null });
        expect((await get(PATH)).status).toBe(403);
        expect(financeClient.send).not.toHaveBeenCalled();
      });

      it.each([
        'branch_id=14',
        'cashbox_user_id=0',
        'cashbox_user_id=14',
        'user_id=14',
        'cashbox_type=main',
        'cashbox_type=couriers',
      ])('?%s — 403, hech qanday ma`lumot o`qilmaydi', async (query) => {
        const res = await get(`${PATH}?${query}`);
        expect(res.status).toBe(403);
        expect(message(res.body)).toBe(CASHBOX_REPORT_BRANCH_ONLY_MESSAGE);
        expect(financeClient.send).not.toHaveBeenCalled();
      });

      it('?cashbox_id — begona kassa 403 (tarix o`qilmaydi), o`ziniki — fayl', async () => {
        const foreign = await get(`${PATH}?cashbox_id=1`);
        expect(foreign.status).toBe(403);
        expect(historyCall()).toBeUndefined();
        const own = await get(
          `${PATH}?cashbox_id=21&branch_id=13&cashbox_type=branch`,
        );
        expect(own.status).toBe(200);
      });

      it('boshqa kassa qatori javobda kelsa ham faylga tushmaydi', async () => {
        finance['finance.history.find_all'] = () => ({
          data: {
            items: [
              historyRow(1, { cashbox: BRANCH, cashbox_id: '21' }),
              historyRow(2, {
                cashbox: MAIN,
                amount: 987_654,
                source_user: { name: 'Maxfiy Market' },
              }),
              historyRow(3, {
                cashbox: { cashbox_type: 'couriers', user_id: '13' },
                amount: 123_456,
              }),
            ],
            pagination: { total: 3 },
          },
        });
        const wb = await load((await get(PATH)).body);
        const dump = JSON.stringify(wb.worksheets[0].getSheetValues());
        expect(dump).not.toMatch(/987654|Maxfiy Market|123456/);
      });

      it('boshqa filial smenasi — 404; finance doirasi o`z filiali', async () => {
        finance['finance.shift.report'] = () => {
          throw rpcError(404, 'Smena topilmadi');
        };
        const res = await get(`${PATH}?shift_id=16`);
        expect(res.status).toBe(404);
        expect(message(res.body)).toBe(SHIFT_NOT_FOUND_MESSAGE);
        expect(payloads(financeClient, 'finance.shift.report')).toEqual([
          { shift_id: '16', cashbox_user_id: '13' },
        ]);
        expect(historyCall()).toBeUndefined();
      });

      it('filial nomi olinmasa — «Filial kassasi», fayl chiqadi', async () => {
        branch['branch.find_by_id'] = () => {
          throw new Error('timeout');
        };
        const res = await get(PATH);
        expect(res.status).toBe(200);
        expect(texts((await load(res.body)).worksheets[0])).toContain(
          'Filial kassasi',
        );
      });
    });

    describe('SA/admin', () => {
      it.each(['branch_id=13', 'cashbox_user_id=13', 'cashbox_type=branch'])(
        '?%s — 403 (bu hisobot faqat asosiy kassa), jimgina boshqa kassa chiqmaydi',
        async (query) => {
          const res = await get(`${PATH}?${query}`);
          expect(res.status).toBe(403);
          expect(message(res.body)).toBe(CASHBOX_REPORT_MAIN_ONLY_MESSAGE);
          expect(financeClient.send).not.toHaveBeenCalled();
        },
      );

      it('filial o`tkazmasi — filial nomi (bulk); branch xato — manba yorlig`i', async () => {
        finance['finance.history.find_all'] = () => ({
          data: {
            items: [
              historyRow(1, {
                source_type: 'branch_to_main',
                source_user: null,
                source_user_id: '5',
              }),
            ],
            pagination: { total: 1 },
          },
        });
        expect(
          texts((await load((await get(PATH)).body)).worksheets[0]),
        ).toContain('Andijon filiali');
        branch['branch.find_all'] = () => {
          throw new Error('timeout');
        };
        const res = await get(PATH);
        expect(res.status).toBe(200);
        expect(texts((await load(res.body)).worksheets[0])).toContain(
          "Filialdan HQ'ga o'tkazma",
        );
      });

      it('kassa hali ochilmagan (404) — 0 qoldiq, fayl chiqadi', async () => {
        finance['finance.cashbox.find_by_user'] = () => {
          throw rpcError(404, 'Kassa topilmadi');
        };
        finance['finance.history.find_all'] = () => ({
          data: { items: [], pagination: { total: 0 } },
        });
        expect((await get(PATH)).status).toBe(200);
      });

      it('ikki o`qish orasida amal tushsa — qayta o`qiladi, soxta «Mos kelmadi» chiqmaydi', async () => {
        let reads = 0;
        finance['finance.history.find_all'] = () => {
          reads += 1;
          return {
            data: {
              items:
                reads === 1
                  ? [historyRow(1)]
                  : [
                      historyRow(2, {
                        amount: 50,
                        balance_after: 1150,
                        balance_cash_after: 1150,
                      }),
                      historyRow(1),
                    ],
              pagination: { total: reads },
            },
          };
        };
        finance['finance.cashbox.find_by_user'] = () => ({
          data: { id: '1', balance: 1150, balance_cash: 1150, balance_card: 0 },
        });
        const all = texts((await load((await get(PATH)).body)).worksheets[0]);
        expect(reads).toBe(2);
        expect(all).toContain('Kassa balansiga teng');
      });

      it('doimiy farq — sariq «Mos kelmadi: farq …»', async () => {
        finance['finance.cashbox.find_by_user'] = () => ({
          data: { id: '1', balance: 900, balance_cash: 900, balance_card: 0 },
        });
        const all = texts((await load((await get(PATH)).body)).worksheets[0]);
        expect(all).toContain('Mos kelmadi: farq 200');
      });

      it('chegaradan ko`p — DIQQAT', async () => {
        Object.assign(controller, { reportRowLimit: 2 });
        finance['finance.history.find_all'] = () => ({
          data: {
            items: [historyRow(3), historyRow(2), historyRow(1)],
            pagination: { total: 3 },
          },
        });
        const all = texts((await load((await get(PATH)).body)).worksheets[0]);
        expect(
          all.some((t) => t.startsWith('DIQQAT: jami 3 ta operatsiya')),
        ).toBe(true);
        expect(all).not.toContain('Kassa harakati');
      });

      it('o`tgan davrda amal yo`q — qoldiq davrdan oldingi oxirgi qatordan', async () => {
        finance['finance.history.find_all'] = (p) => ({
          data: p.limit
            ? {
                items: [
                  historyRow(9, {
                    balance_after: 640,
                    balance_cash_after: 640,
                  }),
                ],
                pagination: { total: 1 },
              }
            : { items: [], pagination: { total: 0 } },
        });
        const ws = (
          await load(
            (await get(`${PATH}?from_date=2026-11-20&to_date=2026-11-20`)).body,
          )
        ).worksheets[0];
        expect(historyCall(1)).toEqual({
          user_id: '0',
          cashbox_type: 'main',
          to_date: '2026-11-20',
          page: 1,
          limit: 1,
        });
        expect(value(ws.getCell('B7'))).toBe(640);
      });
    });

    describe('smena bo`yicha', () => {
      const shiftReport = (extra: Payload = {}) => ({
        data: {
          cashbox_user_id: '0',
          shift: {
            id: '16',
            opened_at: '2026-11-24T03:02:00.000Z',
            closed_at: '2026-11-24T15:14:00.000Z',
            status: 'closed',
          },
          ...extra,
        },
      });

      it('yopilgan smena — opened_at … closed_at (from/to e`tiborsiz), balans nazorati yo`q', async () => {
        finance['finance.shift.report'] = () => shiftReport();
        const res = await get(
          `${PATH}?shift_id=16&from_date=2026-01-01&to_date=2026-12-31`,
        );
        expect(payloads(financeClient, 'finance.shift.report')).toEqual([
          { shift_id: '16', cashbox_user_id: '0' },
        ]);
        expect(historyCall()).toMatchObject({
          from_date: '2026-11-24T03:02:00.000Z',
          to_date: '2026-11-24T15:14:00.000Z',
        });
        expect(res.headers['content-disposition']).toBe(
          'attachment; filename="kassa-hisobot-2026-11-24.xlsx"',
        );
        const all = texts((await load(res.body)).worksheets[0]);
        expect(all).toContain('Smena №16 · 24.11 08:02 — 24.11 20:14');
        expect(all).not.toContain('Kassa balansiga teng');
      });

      it('ochiq smena — hozirgacha (to_date yuborilmaydi), balans nazorati bor', async () => {
        finance['finance.shift.report'] = () =>
          shiftReport({
            shift: {
              id: '17',
              opened_at: '2026-11-25T03:00:00.000Z',
              closed_at: null,
            },
          });
        const res = await get(`${PATH}?shift_id=17`);
        expect(historyCall()).toEqual({
          user_id: '0',
          cashbox_type: 'main',
          from_date: '2026-11-25T03:00:00.000Z',
          page: 0,
          limit: 0,
        });
        const all = texts((await load(res.body)).worksheets[0]);
        expect(all).toContain('Smena №17 · 25.11 08:00 — hozirgacha');
        expect(all).toContain('Kassa balansiga teng');
      });

      it('boshqa kassa smenasi (finance javobida ham) — 404', async () => {
        finance['finance.shift.report'] = () =>
          shiftReport({ cashbox_user_id: '13' });
        expect((await get(`${PATH}?shift_id=16`)).status).toBe(404);
        expect(historyCall()).toBeUndefined();
      });
    });
  });
});
