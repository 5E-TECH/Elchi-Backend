import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { of } from 'rxjs';
import { projectOrderPayloadForRoles } from './auth/order-role-projection';
import { OrderGatewayController } from './order-gateway.controller';

/**
 * 1mOjtOVC — yangi chek uchun buyurtma javobidagi maydonlar:
 * `operator_phone`, `secondary_operator_phone` va `order.market.phone_number`
 * GET /orders qatorlarida va GET /orders/:id da qaytadi — T7 (QPq2C1co) dan
 * beri menejer / filial / kuryerdan TASHQARI (ular uchun yashiriladi; pul
 * maydonlari — rol bo'yicha, avvalgidek). Swagger'da hujjatlashtirilgan
 * (paket va pochta cheki maydonlari ham).
 */
const orderRow = () => ({
  id: '81',
  order_number: 'EL-100081',
  status: 'new',
  market_id: '37',
  operator: 'Operator Ali',
  operator_phone: '+998901112233',
  secondary_operator_phone: '+998904445566',
  total_price: 100000,
  market_tariff: 20000,
  courier_tariff: 15000,
  branch_share: 5000,
  region_id: '5',
  market: {
    id: '37',
    name: 'TEST Market',
    phone_number: '+998901234567',
    tariff_home: 30000,
    tariff_center: 20000,
  },
});

const RECEIPT_KEYS = ['operator_phone', 'secondary_operator_phone'] as const;

// T7 (QPq2C1co, B3): menejer, filial va kuryer market/operator telefonini
// KO'RMAYDI (pastdagi alohida test) — ular viloyat logistiga bog'lanadi.
const ROLES = [
  ['superadmin'],
  ['admin'],
  ['registrator'],
  ['market'],
  ['market_operator'],
  ['logist'],
  ['customer'],
];

const CONTACT_HIDDEN_ROLES = [['manager'], ['branch'], ['courier']];

describe('1mOjtOVC — chek maydonlari rol proyeksiyasidan o‘tadi', () => {
  it.each(ROLES)(
    '⭐ %s: GET /orders qatori va GET /orders/:id — operator telefonlari va market telefoni bor',
    (role) => {
      const list = projectOrderPayloadForRoles([role], {
        data: [orderRow()],
        total: 1,
      }) as { data: Array<Record<string, unknown>> };
      const detail = projectOrderPayloadForRoles([role], orderRow()) as Record<
        string,
        unknown
      >;
      for (const row of [list.data[0], detail]) {
        for (const key of RECEIPT_KEYS) {
          expect(row[key]).toBe(orderRow()[key]);
        }
        expect((row.market as Record<string, unknown>).phone_number).toBe(
          '+998901234567',
        );
        expect((row.market as Record<string, unknown>).name).toBe(
          'TEST Market',
        );
      }
    },
  );

  it.each(CONTACT_HIDDEN_ROLES)(
    'T7 %s: operator telefonlari va market telefoni YO‘Q, market nomi bor',
    (role) => {
      const detail = projectOrderPayloadForRoles([role], orderRow()) as Record<
        string,
        unknown
      >;
      for (const key of RECEIPT_KEYS) {
        expect(detail).not.toHaveProperty(key);
      }
      expect(detail.market).not.toHaveProperty('phone_number');
      expect((detail.market as Record<string, unknown>).name).toBe(
        'TEST Market',
      );
    },
  );

  it('pul maydonlari rol bo‘yicha avvalgidek (kuryer — market tarifisiz, logist — pulsiz)', () => {
    const courier = projectOrderPayloadForRoles(
      ['courier'],
      orderRow(),
    ) as Record<string, unknown>;
    expect(courier).not.toHaveProperty('market_tariff');
    expect(courier.market).not.toHaveProperty('tariff_center');
    const logist = projectOrderPayloadForRoles(
      ['logist'],
      orderRow(),
    ) as Record<string, unknown>;
    expect(logist).not.toHaveProperty('total_price');
    expect(logist.operator_phone).toBe('+998901112233');
  });

  it('GET /orders (admin) — order-service qatoridagi telefonlar javobga yetadi', async () => {
    const orderClient = {
      send: jest.fn(() => of({ data: [orderRow()], total: 1, page: 1 })),
    };
    const noop = { send: jest.fn(() => of({ data: null })) };
    const controller = new OrderGatewayController(
      orderClient as never,
      noop as never,
      noop as never,
      noop as never,
    );
    const args: unknown[] = Array.from({ length: 16 }, () => undefined);
    args[15] = { user: { sub: '1', roles: ['admin'] } };
    const res = (await (
      controller.findAll as unknown as (...a: unknown[]) => Promise<unknown>
    ).apply(controller, args)) as { data: Array<Record<string, unknown>> };
    expect(res.data[0]).toMatchObject({
      operator_phone: '+998901112233',
      secondary_operator_phone: '+998904445566',
      market: { phone_number: '+998901234567' },
    });
  });
});

describe('1mOjtOVC — Swagger (docs/frontend/openapi.json)', () => {
  const doc = JSON.parse(
    readFileSync(
      join(__dirname, '../../../docs/frontend/openapi.json'),
      'utf8',
    ),
  ) as {
    paths: Record<string, Record<string, { responses: Record<string, any> }>>;
    components: {
      schemas: Record<string, { properties: Record<string, any> }>;
    };
  };
  const props = (name: string) =>
    Object.keys(doc.components.schemas[name]?.properties ?? {});
  const okRef = (path: string, method = 'get') =>
    JSON.stringify(doc.paths[path]?.[method]?.responses?.['200'] ?? {});

  it('⭐ GET /orders va GET /orders/:id javobida operator_phone, secondary_operator_phone, market.phone_number', () => {
    expect(props('OrderReceiptFieldsDto')).toEqual(
      expect.arrayContaining([
        'operator_phone',
        'secondary_operator_phone',
        'market',
      ]),
    );
    expect(props('OrderReceiptMarketDto')).toEqual(
      expect.arrayContaining(['name', 'phone_number']),
    );
    expect(okRef('/orders')).toContain('OrderListReceiptPageDto');
    expect(okRef('/orders/{id}')).toContain('OrderReceiptFieldsDto');
  });

  it('T7: problem_contacts (ProblemContactDto) bor; operator telefonlari va market.phone_number ixtiyoriy', () => {
    const receipt = doc.components.schemas.OrderReceiptFieldsDto as {
      properties: Record<string, any>;
      required?: string[];
    };
    expect(props('OrderReceiptFieldsDto')).toContain('problem_contacts');
    expect(JSON.stringify(receipt.properties.problem_contacts)).toContain(
      'ProblemContactDto',
    );
    expect(props('ProblemContactDto')).toEqual(
      expect.arrayContaining(['name', 'phone', 'source']),
    );
    for (const key of [
      'operator_phone',
      'secondary_operator_phone',
      'problem_contacts',
    ]) {
      expect(receipt.required ?? []).not.toContain(key);
    }
    const market = doc.components.schemas.OrderReceiptMarketDto as {
      required?: string[];
    };
    expect(market.required ?? []).not.toContain('phone_number');
  });

  it('⭐ paket (GET /transfer-batches/:id) va pochta (GET /post/:id) cheki maydonlari', () => {
    expect(props('TransferBatchDetailDto')).toEqual(
      expect.arrayContaining([
        'qr_code_token',
        'source_branch',
        'destination_branch',
        'direction',
        'order_count',
        'total_price',
        'driver_name',
        'driver_phone',
        'vehicle_plate',
        'createdAt',
      ]),
    );
    expect(okRef('/transfer-batches/{id}')).toContain('TransferBatchDetailDto');
    expect(props('PostReceiptDto')).toEqual(
      expect.arrayContaining([
        'courier',
        'qr_code_token',
        'order_quantity',
        'post_total_price',
        'createdAt',
      ]),
    );
    expect(props('PostCourierRefDto')).toEqual(
      expect.arrayContaining(['name', 'phone_number']),
    );
    expect(okRef('/post/{id}')).toContain('PostReceiptResponseDto');
  });
});
