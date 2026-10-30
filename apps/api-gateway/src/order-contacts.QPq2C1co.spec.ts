import { of, throwError } from 'rxjs';
import {
  projectMarketRowContactsForRoles,
  projectOrderContactsForRoles,
  shouldHideMarketContacts,
} from './auth/order-contact-projection';
import { projectOrderPayloadForRoles } from './auth/order-role-projection';
import {
  PROBLEM_CONTACTS_CACHE_TTL_MS,
  ProblemContactsService,
} from './contacts/problem-contacts.service';
import { OrderGatewayController } from './order-gateway.controller';
import PDFDocument from 'pdfkit';
import {
  contactPhonesOf,
  renderReceiptHtml,
  renderThermalPdf,
} from './printer/printer.util';
import { PrinterGatewayController } from './printer-gateway.controller';

/**
 * T7 (QPq2C1co) — buyurtma javoblarida aloqa raqamlari:
 *  - B3: market/operator telefoni menejer, filial va kuryerga YO'Q
 *    (`order-contact-projection.ts`), mijoz telefoni qoladi;
 *  - B2: `problem_contacts` (viloyat logisti / zaxira) — bitta RPC, kesh 60 s;
 *  - printer: «Muammo bo'lsa» faqat `problem_contacts` dan, yo'q — qator yo'q.
 */
const ANDIJON_LOGIST = {
  name: 'Andijon logisti',
  phone: '+998901112233',
  source: 'logist' as const,
};

const orderRow = (over: Record<string, unknown> = {}) => ({
  id: '81',
  market_id: '37',
  customer_id: '29',
  region_id: '1',
  district_id: '10',
  status: 'new',
  operator_phone: '+998901234500',
  secondary_operator_phone: '+998901234501',
  total_price: 100000,
  market_tariff: 20000,
  courier_tariff: 15000,
  customer: { id: '29', name: 'Mijoz', phone_number: '+998935556677' },
  courier: { id: '26', name: 'Kuryer', phone_number: '+998911112233' },
  market: {
    id: '37',
    name: 'TEST Market',
    phone_number: '+998901234567',
    extra_number: '+998901234568',
    default_operator_phone: '+998901234569',
    username: 'test_market',
    tariff_home: 30000,
    tariff_center: 20000,
  },
  ...over,
});

describe('T7 B3 — market telefoni menejer/kuryerdan yashiriladi', () => {
  it('qaysi rollar: SA/admin/registrator/logist — ko`radi; menejer/filial/kuryer — yo`q; ko`p rol — to`liq ustun', () => {
    for (const roles of [
      ['superadmin'],
      ['admin'],
      ['registrator'],
      ['logist'],
      ['market'],
      ['market_operator'],
      ['manager', 'admin'],
      ['courier', 'registrator'],
    ]) {
      expect(shouldHideMarketContacts(roles)).toBe(false);
    }
    for (const roles of [
      ['manager'],
      ['branch'],
      ['courier'],
      ['courier', 'manager'],
    ]) {
      expect(shouldHideMarketContacts(roles)).toBe(true);
    }
  });

  it('⭐ QM3: menejer GET /orders/:id — market.phone_number, operator_phone yo`q; customer, market_tariff bor', () => {
    const projected = projectOrderPayloadForRoles(['manager'], {
      data: orderRow({ problem_contacts: [ANDIJON_LOGIST] }),
    }) as { data: Record<string, any> };
    const row = projected.data;
    expect(row).not.toHaveProperty('operator_phone');
    expect(row).not.toHaveProperty('secondary_operator_phone');
    expect(row.market).toEqual({
      id: '37',
      name: 'TEST Market',
      tariff_home: 30000,
      tariff_center: 20000,
    });
    expect(row.customer.phone_number).toBe('+998935556677');
    expect(row.courier.phone_number).toBe('+998911112233');
    expect(row.market_tariff).toBe(20000);
    expect(row.problem_contacts).toEqual([ANDIJON_LOGIST]);
  });

  it('admin / registrator / logist — telefonlar o`zgarishsiz', () => {
    for (const role of ['admin', 'registrator']) {
      const payload = { data: orderRow() };
      expect(projectOrderContactsForRoles([role], payload)).toBe(payload);
    }
    const logist = projectOrderPayloadForRoles(['logist'], {
      data: orderRow(),
    }) as { data: Record<string, any> };
    expect(logist.data.operator_phone).toBe('+998901234500');
    expect(logist.data.market.phone_number).toBe('+998901234567');
  });

  it('ichma-ich konvert («Yangi buyurtmalar» market qatorlari, pochta) ham qamraladi', () => {
    const payload = {
      data: [
        { market_id: '37', count: 3, market: orderRow().market },
        { allOrdersByPostId: [orderRow()] },
      ],
    };
    const projected = projectOrderContactsForRoles(['courier'], payload) as any;
    expect(projected.data[0].market).not.toHaveProperty('phone_number');
    expect(projected.data[0].market).not.toHaveProperty('username');
    expect(projected.data[1].allOrdersByPostId[0]).not.toHaveProperty(
      'operator_phone',
    );
    // Asl obyekt o'zgarmaydi (copy-on-write).
    expect(payload.data[0].market?.phone_number).toBe('+998901234567');
  });

  it('GET /markets / GET /users/:id qatori: menejerga telefonlarsiz', () => {
    const market = {
      id: '37',
      name: 'M',
      phone_number: '+998901234567',
      status: 'active',
    };
    expect(projectMarketRowContactsForRoles(['manager'], market)).toEqual({
      id: '37',
      name: 'M',
      status: 'active',
    });
    expect(projectMarketRowContactsForRoles(['registrator'], market)).toBe(
      market,
    );
  });

  it('⭐ QM3: GET /orders/markets/new — menejerda phone_number yo`q, registratorda bor', async () => {
    const build = (roles: string[]) => {
      const order = {
        send: jest.fn(() => of([{ market_id: '37', count: 2 }])),
      };
      const identity = {
        send: jest.fn(() => of({ data: [orderRow().market] })),
      };
      const branch = {
        send: jest.fn(() =>
          of({
            data: {
              branch_id: '3',
              role: roles[0].toUpperCase(),
              branch: { id: '3', type: 'REGIONAL' },
            },
          }),
        ),
      };
      return new OrderGatewayController(
        order as never,
        identity as never,
        { send: jest.fn() } as never,
        branch as never,
      ).findNewMarkets({ user: { sub: '5', roles } } as never);
    };
    const manager = (await build(['manager'])) as any[];
    expect(manager[0].market).not.toHaveProperty('phone_number');
    expect(manager[0].market.name).toBe('TEST Market');
    const registrator = (await build(['registrator'])) as any[];
    expect(registrator[0].market.phone_number).toBe('+998901234567');
  });
});

describe('T7 B2 — problem_contacts (gateway)', () => {
  const reply = {
    statusCode: 200,
    data: {
      regions: {
        '1': [ANDIJON_LOGIST],
        '2': [{ name: null, phone: '+998712001122', source: 'support' }],
      },
      districts: { '10': [ANDIJON_LOGIST] },
      fallback: [{ name: null, phone: '+998712001122', source: 'support' }],
    },
  };

  it('⭐ N+1 yo`q: 50 ta buyurtma — bitta RPC; ichma-ich (data.data[], pochta) qatorlarga qo`shiladi', async () => {
    const identity = { send: jest.fn(() => of(reply)) };
    const service = new ProblemContactsService(identity as never);
    const rows = Array.from({ length: 50 }, (_, i) =>
      orderRow({ id: String(i), region_id: i % 2 ? '1' : '2' }),
    );
    const payload = {
      data: {
        data: rows,
        nested: {
          allOrdersByPostId: [orderRow({ region_id: null, district_id: '10' })],
        },
      },
    };
    await service.attach(payload);
    expect(identity.send).toHaveBeenCalledTimes(1);
    expect(identity.send).toHaveBeenCalledWith(
      { cmd: 'identity.contacts.problem' },
      { region_ids: ['2', '1'], district_ids: ['10'] },
    );
    expect((rows[1] as any).problem_contacts).toEqual([ANDIJON_LOGIST]);
    expect((rows[0] as any).problem_contacts).toEqual([
      { name: null, phone: '+998712001122', source: 'support' },
    ]);
    expect(
      (payload.data.nested.allOrdersByPostId[0] as any).problem_contacts,
    ).toEqual([ANDIJON_LOGIST]);
    // Market / mijoz obyektlariga qo'shilmaydi.
    expect((rows[0] as any).market).not.toHaveProperty('problem_contacts');
    expect((rows[0] as any).customer).not.toHaveProperty('problem_contacts');
  });

  it('kesh 60 s: ichida qayta RPC yo`q, keyin — yangi raqam', async () => {
    const identity = { send: jest.fn(() => of(reply)) };
    const service = new ProblemContactsService(identity as never);
    let now = 1_000_000;
    service.now = () => now;
    await service.attach({ data: [orderRow()] });
    await service.attach({ data: [orderRow()] });
    expect(identity.send).toHaveBeenCalledTimes(1);
    now += PROBLEM_CONTACTS_CACHE_TTL_MS + 1;
    await service.attach({ data: [orderRow()] });
    expect(identity.send).toHaveBeenCalledTimes(2);
  });

  it('identity xatosi — maydon qo`shilmaydi, javob buzilmaydi, xato keshlanmaydi', async () => {
    const identity = {
      send: jest
        .fn()
        .mockReturnValueOnce(throwError(() => new Error('down')))
        .mockReturnValue(of(reply)),
    };
    const service = new ProblemContactsService(identity as never);
    const payload = { data: [orderRow()] };
    await expect(service.attach(payload)).resolves.toBe(payload);
    expect(payload.data[0]).not.toHaveProperty('problem_contacts');
    await service.attach(payload);
    expect((payload.data[0] as any).problem_contacts).toEqual([ANDIJON_LOGIST]);
  });

  it('GET /orders/:id: problem_contacts proyeksiyadan OLDIN, har rolga (market ham)', async () => {
    const identity = {
      send: jest.fn((pattern: { cmd: string }) =>
        pattern.cmd === 'identity.contacts.problem'
          ? of(reply)
          : of({ data: null }),
      ),
    };
    const order = {
      send: jest.fn(() => of({ statusCode: 200, data: orderRow() })),
    };
    const controller = new OrderGatewayController(
      order as never,
      identity as never,
      { send: jest.fn() } as never,
      { send: jest.fn() } as never,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      new ProblemContactsService(identity as never),
    );
    const res = (await controller.findById('81', {
      user: { sub: '37', roles: ['market'] },
    } as never)) as { data: Record<string, unknown> };
    expect(res.data.problem_contacts).toEqual([ANDIJON_LOGIST]);
  });
});

describe('T7 — printer «Muammo bo`lsa»', () => {
  const printRow = (over: Record<string, unknown> = {}) =>
    ({
      id: '81',
      order_number: 'EL-100081',
      qr_code_token: '',
      created_at: Date.UTC(2026, 9, 30),
      where_deliver: 'address',
      total_price: 100000,
      comment: '',
      address: '',
      customer_name: 'Mijoz',
      customer_phone: '+998935556677',
      extra_number: '',
      region_name: 'Andijon',
      district_name: 'Asaka',
      market_name: 'TEST Market',
      market_phone: '+998901234567',
      operator: 'Ali',
      operator_phone: '+998901234500',
      secondary_operator_phone: '+998901234501',
      products: [],
      ...over,
    }) as never;

  it('⭐ QM1: faqat problem_contacts, «+998 90 111 22 33»; operator/market raqami yo`q', async () => {
    expect(
      contactPhonesOf({ problem_contacts: [ANDIJON_LOGIST, ANDIJON_LOGIST] }),
    ).toEqual(['+998 90 111 22 33']);
    const html = await renderReceiptHtml([
      printRow({ problem_contacts: [ANDIJON_LOGIST] }),
    ]);
    expect(html).toContain("Muammo bo'lsa:");
    expect(html).toContain('+998 90 111 22 33');
    expect(html).not.toContain('123-45-00');
    expect(html).not.toContain('(90) 123-45-67');
  });

  it('⭐ QM2: zaxira ham bo`sh — «Muammo bo`lsa» qismi UMUMAN yo`q («-» ham emas)', async () => {
    const html = await renderReceiptHtml([printRow({ problem_contacts: [] })]);
    expect(html).not.toContain("Muammo bo'lsa");
    const legacy = await renderReceiptHtml([printRow()]);
    expect(legacy).not.toContain("Muammo bo'lsa");
  });

  describe('termal PDF (POST /printer/thermal-pdf)', () => {
    let textSpy: jest.SpyInstance;
    beforeEach(() => {
      const proto = PDFDocument.prototype as unknown as Record<
        string,
        (...args: unknown[]) => unknown
      >;
      textSpy = jest.spyOn(proto, 'text');
    });
    afterEach(() => jest.restoreAllMocks());
    const texts = () => textSpy.mock.calls.map((call) => String(call[0]));

    it('⭐ QM1: Andijon buyurtmasi — «Muammo bo`lsa: +998 90 111 22 33», operator raqami yo`q', async () => {
      const order = {
        send: jest.fn(() =>
          of({ data: [printRow({ region_id: '1', district_id: '10' })] }),
        ),
      };
      const identity = {
        send: jest.fn(() =>
          of({
            data: {
              regions: { '1': [ANDIJON_LOGIST] },
              districts: {},
              fallback: [],
            },
          }),
        ),
      };
      const controller = new PrinterGatewayController(
        order as never,
        new ProblemContactsService(identity as never),
      );
      const res = { set: jest.fn(), end: jest.fn() };
      await controller.thermalPdf({ order_ids: ['81'] }, res as never);
      expect(res.end).toHaveBeenCalledWith(expect.any(Buffer));
      expect(texts()).toContain("Muammo bo'lsa:");
      expect(texts()).toContain('+998 90 111 22 33');
      expect(texts().join(' ')).not.toMatch(/123-45-0|\(90\) 123-45-67/);
    });

    it('⭐ QM2: raqam yo`q — qator chizilmaydi', async () => {
      await renderThermalPdf([printRow({ problem_contacts: [] })]);
      expect(texts()).not.toContain("Muammo bo'lsa:");
      expect(texts()).toContain('Izoh:');
    });
  });
});
