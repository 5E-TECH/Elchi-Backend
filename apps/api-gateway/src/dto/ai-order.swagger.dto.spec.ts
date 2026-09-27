import { randomUUID } from 'node:crypto';
import { validate, type ValidationError } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { AiConfirmRequestDto, AiParseRequestDto } from './ai-order.swagger.dto';

/**
 * AI buyurtma DTO'lari (C10) — ai-confirm AI xatosining bazaga kirishiga
 * OXIRGI to'siq (wgqxS0Cp, 32fNx0Ci), ai-parse esa kiritish chegarasi
 * (NsxoDSmm #2).
 *
 * Gateway'dagi global ValidationPipe bilan AYNAN bir xil sozlama:
 * `whitelist: true, forbidNonWhitelisted: true` (main.ts). Shu sabab
 * e'lon qilinmagan maydon (`status`, `operator_id`, preview metadatasi)
 * 400 beradi.
 */

/** Ichma-ich xatolarni `orders.0.customer.phone_number` ko'rinishida yoyadi. */
const flatten = (errors: ValidationError[], prefix = ''): string[] =>
  errors.flatMap((error) => {
    const path = prefix ? `${prefix}.${error.property}` : error.property;
    const own = error.constraints ? [path] : [];
    return [...own, ...flatten(error.children ?? [], path)];
  });

const constraintMessages = (errors: ValidationError[]): string[] =>
  errors.flatMap((error) => [
    ...Object.values(error.constraints ?? {}),
    ...constraintMessages(error.children ?? []),
  ]);

const validateBody = async (body: Record<string, unknown>) => {
  const dto = plainToInstance(AiConfirmRequestDto, body);
  return validate(dto, { whitelist: true, forbidNonWhitelisted: true });
};

const errorPaths = async (body: Record<string, unknown>) =>
  flatten(await validateBody(body));

const baseOrder = (
  overrides: Record<string, unknown> = {},
): Record<string, unknown> => ({
  customer: {
    name: 'Ali Valiyev',
    phone_number: '+998901234567',
    district_id: '12',
  },
  district_id: '12',
  items: [{ product_id: '15', quantity: 2 }],
  total_price: 150000,
  where_deliver: 'center',
  ...overrides,
});

const withCustomer = (patch: Record<string, unknown>) =>
  baseOrder({
    customer: {
      name: 'Ali Valiyev',
      phone_number: '+998901234567',
      district_id: '12',
      ...patch,
    },
  });

const body = (...orders: Record<string, unknown>[]) => ({ orders });

describe('AiConfirmRequestDto — qat’iy ai-confirm DTO (C10)', () => {
  it('to‘g‘ri buyurtma xatosiz o‘tadi', async () => {
    expect(await errorPaths(body(baseOrder()))).toEqual([]);
  });

  describe('narx (wgqxS0Cp #1, 32fNx0Ci #4)', () => {
    it('total_price = -1 → xato', async () => {
      expect(await errorPaths(body(baseOrder({ total_price: -1 })))).toContain(
        'orders.0.total_price',
      );
    });

    it('total_price = 0 qabul qilinadi (@Min(0))', async () => {
      expect(await errorPaths(body(baseOrder({ total_price: 0 })))).toEqual([]);
    });

    it('total_price satr yoki yo‘q → xato', async () => {
      expect(
        await errorPaths(body(baseOrder({ total_price: '150000' }))),
      ).toContain('orders.0.total_price');
      const withoutPrice = baseOrder();
      delete withoutPrice.total_price;
      expect(await errorPaths(body(withoutPrice))).toContain(
        'orders.0.total_price',
      );
    });
  });

  describe('mahsulotlar (wgqxS0Cp #2/#3/#9, 32fNx0Ci #5/#6)', () => {
    it('items: [] → xato (ArrayNotEmpty)', async () => {
      expect(await errorPaths(body(baseOrder({ items: [] })))).toContain(
        'orders.0.items',
      );
    });

    it.each([0, -1, 99999, 1.5])('quantity = %p → xato', async (quantity) => {
      expect(
        await errorPaths(
          body(baseOrder({ items: [{ product_id: '15', quantity }] })),
        ),
      ).toContain('orders.0.items.0.quantity');
    });

    it('quantity = 1000 (chegara) qabul qilinadi', async () => {
      expect(
        await errorPaths(
          body(baseOrder({ items: [{ product_id: '15', quantity: 1000 }] })),
        ),
      ).toEqual([]);
    });

    it('51 ta mahsulot → xato (ArrayMaxSize 50)', async () => {
      const items = Array.from({ length: 51 }, (_, i) => ({
        product_id: String(i + 1),
        quantity: 1,
      }));
      expect(await errorPaths(body(baseOrder({ items })))).toContain(
        'orders.0.items',
      );
    });

    it('allow_unlisted_product bayrog‘isiz product_name → xato (wgqxS0Cp #9)', async () => {
      expect(
        await errorPaths(
          body(
            baseOrder({ items: [{ product_name: 'Atir 50 ml', quantity: 1 }] }),
          ),
        ),
      ).toContain('orders.0.items.0.allow_unlisted_product');
      expect(
        await errorPaths(
          body(
            baseOrder({
              items: [
                {
                  product_name: 'Atir 50 ml',
                  quantity: 1,
                  allow_unlisted_product: false,
                },
              ],
            }),
          ),
        ),
      ).toContain('orders.0.items.0.allow_unlisted_product');
    });

    it('product_name + allow_unlisted_product: true qabul qilinadi', async () => {
      expect(
        await errorPaths(
          body(
            baseOrder({
              items: [
                {
                  product_name: 'Atir 50 ml',
                  quantity: 1,
                  allow_unlisted_product: true,
                },
              ],
            }),
          ),
        ),
      ).toEqual([]);
    });

    it('product_id ham product_name ham → xato (aynan bittasi)', async () => {
      expect(
        await errorPaths(
          body(
            baseOrder({
              items: [
                {
                  product_id: '15',
                  product_name: 'Atir',
                  quantity: 1,
                  allow_unlisted_product: true,
                },
              ],
            }),
          ),
        ),
      ).toContain('orders.0.items.0.product_name');
    });

    it('hech biri yo‘q → product_id xatosi', async () => {
      expect(
        await errorPaths(body(baseOrder({ items: [{ quantity: 1 }] }))),
      ).toContain('orders.0.items.0.product_id');
    });

    it('product_id UUID yoki matn → xato (faqat raqam)', async () => {
      expect(
        await errorPaths(
          body(
            baseOrder({ items: [{ product_id: randomUUID(), quantity: 1 }] }),
          ),
        ),
      ).toContain('orders.0.items.0.product_id');
    });
  });

  describe('telefon (wgqxS0Cp #4, 32fNx0Ci #7)', () => {
    it.each(['abc', '901234567', '998901234567', '+99890123456', ''])(
      'phone_number %p → xato',
      async (phone) => {
        expect(
          await errorPaths(body(withCustomer({ phone_number: phone }))),
        ).toContain('orders.0.customer.phone_number');
      },
    );

    it("'+998901234567' o‘tadi va O‘ZGARTIRILMAYDI (transform yo‘q)", async () => {
      const dto = plainToInstance(AiConfirmRequestDto, body(baseOrder()));
      expect(
        await validate(dto, { whitelist: true, forbidNonWhitelisted: true }),
      ).toEqual([]);
      expect(dto.orders[0].customer.phone_number).toBe('+998901234567');
    });

    it("extra_number '97-111-22-33' (frontend formati) qabul qilinadi", async () => {
      expect(
        await errorPaths(body(withCustomer({ extra_number: '97-111-22-33' }))),
      ).toEqual([]);
    });

    it('extra_number 20 belgidan uzun → xato', async () => {
      expect(
        await errorPaths(body(withCustomer({ extra_number: '9'.repeat(21) }))),
      ).toContain('orders.0.customer.extra_number');
    });
  });

  describe('tuman va viloyat (wgqxS0Cp #5/#7, 32fNx0Ci #9)', () => {
    it('district_id UUID ko‘rinishida → xato (@Matches(/^\\d+$/))', async () => {
      const uuid = randomUUID();
      expect(
        await errorPaths(body(baseOrder({ district_id: uuid }))),
      ).toContain('orders.0.district_id');
      expect(
        await errorPaths(body(withCustomer({ district_id: uuid }))),
      ).toContain('orders.0.customer.district_id');
    });

    it('customer.district_id majburiy', async () => {
      const order = baseOrder({
        customer: { name: 'Ali', phone_number: '+998901234567' },
      });
      expect(await errorPaths(body(order))).toContain(
        'orders.0.customer.district_id',
      );
    });

    it('region_id qabul qilinadi (lekin server uni o‘qimaydi)', async () => {
      expect(await errorPaths(body(baseOrder({ region_id: '999' })))).toEqual(
        [],
      );
    });
  });

  describe('partiya (wgqxS0Cp #14)', () => {
    it('31 ta buyurtma → xato (ArrayMaxSize 30)', async () => {
      const orders = Array.from({ length: 31 }, () => baseOrder());
      expect(await errorPaths({ orders })).toContain('orders');
    });

    it('30 ta buyurtma qabul qilinadi', async () => {
      const orders = Array.from({ length: 30 }, () => baseOrder());
      expect(await errorPaths({ orders })).toEqual([]);
    });

    it('orders: [] yoki yo‘q → xato', async () => {
      expect(await errorPaths({ orders: [] })).toContain('orders');
      expect(await errorPaths({})).toContain('orders');
    });

    it('request_id UUID qabul qilinadi, UUID bo‘lmasa xato', async () => {
      expect(
        await errorPaths({ request_id: randomUUID(), orders: [baseOrder()] }),
      ).toEqual([]);
      expect(
        await errorPaths({ request_id: 'abc', orders: [baseOrder()] }),
      ).toContain('request_id');
    });

    it('market_id faqat raqam', async () => {
      expect(
        await errorPaths({ market_id: '77', orders: [baseOrder()] }),
      ).toEqual([]);
      expect(
        await errorPaths({ market_id: 'abc', orders: [baseOrder()] }),
      ).toContain('market_id');
    });

    it('draft_id UUID qabul qilinadi, boshqa qiymat xato', async () => {
      expect(
        await errorPaths(body(baseOrder({ draft_id: randomUUID() }))),
      ).toEqual([]);
      expect(
        await errorPaths(body(baseOrder({ draft_id: 'draft-1' }))),
      ).toContain('orders.0.draft_id');
    });
  });

  describe('e’lon qilinmagan maydonlar (forbidNonWhitelisted)', () => {
    it('status yuborilsa → xato (buyurtma doim NEW)', async () => {
      expect(await errorPaths(body(baseOrder({ status: 'new' })))).toContain(
        'orders.0.status',
      );
    });

    it('where_deliver faqat center/address; katta harf kichraytiriladi', async () => {
      expect(
        await errorPaths(body(baseOrder({ where_deliver: 'free' }))),
      ).toContain('orders.0.where_deliver');
      expect(
        await errorPaths(body(baseOrder({ where_deliver: 'ADDRESS' }))),
      ).toEqual([]);
    });

    it('matn chegaralari: address 255, comment 1000, operator 100', async () => {
      expect(
        await errorPaths(body(baseOrder({ address: 'a'.repeat(256) }))),
      ).toContain('orders.0.address');
      expect(
        await errorPaths(body(baseOrder({ comment: 'a'.repeat(1001) }))),
      ).toContain('orders.0.comment');
      expect(
        await errorPaths(body(baseOrder({ operator: 'a'.repeat(101) }))),
      ).toContain('orders.0.operator');
    });

    it('preview obyektini to‘g‘ridan yuborish → xato (NsxoDSmm #10)', async () => {
      // order-service AiOrderPreview (C9) shakli — AI metadatasi bilan.
      const preview = {
        index: 0,
        ready: true,
        issues: [],
        customer_name: 'Ali',
        phone_number: '+998901234567',
        extra_number: null,
        region_id: '1',
        region_name: 'Toshkent shahri',
        region_given: true,
        district_id: '12',
        district_name: 'Chilonzor',
        district_candidates: [],
        address: 'Chilonzor',
        items: [
          {
            name: 'Atir',
            quantity: 1,
            product_id: '15',
            resolved_name: 'Atir 50 ml',
            candidates: [],
            unresolved: false,
          },
        ],
        total_price: 150000,
        price_confirmed: false,
        where_deliver: 'center',
        comment: null,
        is_replacement: false,
        operator: null,
      };
      const paths = await errorPaths(body(preview));
      expect(paths).toEqual(
        expect.arrayContaining([
          'orders.0.customer',
          'orders.0.customer_name',
          'orders.0.region_given',
          'orders.0.district_candidates',
          'orders.0.ready',
          'orders.0.issues',
          'orders.0.items.0.name',
          'orders.0.items.0.candidates',
          'orders.0.items.0.resolved_name',
        ]),
      );
    });
  });

  describe('injection namunalari — DTO darajasi (32fNx0Ci #12 c/d/e)', () => {
    it('(c) AI to‘qigan manfiy narx total_price: -1 → 400', async () => {
      const errors = await validateBody(body(baseOrder({ total_price: -1 })));
      expect(flatten(errors)).toContain('orders.0.total_price');
      expect(constraintMessages(errors)).toContain(
        "total_price manfiy bo'lishi mumkin emas",
      );
    });

    it('(d) quantity 0 va 99999 → 400', async () => {
      for (const quantity of [0, 99999]) {
        expect(
          await errorPaths(
            body(baseOrder({ items: [{ product_id: '15', quantity }] })),
          ),
        ).toContain('orders.0.items.0.quantity');
      }
    });

    it("(e) operator '#admin' + operator_id → operator_id RAD etiladi, operator faqat matn", async () => {
      const paths = await errorPaths(
        body(baseOrder({ operator: '#admin', operator_id: '1' })),
      );
      expect(paths).toContain('orders.0.operator_id');
      expect(paths).not.toContain('orders.0.operator');
      // Mijoz obyektida ham begona id'lar o'tmaydi.
      expect(
        await errorPaths(body(withCustomer({ operator_id: '1' }))),
      ).toContain('orders.0.customer.operator_id');
    });

    it('market_id/branch_id buyurtma ichida → 400 (faqat yuqori darajada market_id)', async () => {
      const paths = await errorPaths(
        body(baseOrder({ market_id: '5', branch_id: '3', source: 'branch' })),
      );
      expect(paths).toEqual(
        expect.arrayContaining([
          'orders.0.market_id',
          'orders.0.branch_id',
          'orders.0.source',
        ]),
      );
    });
  });

  it('xabarlar o‘zbekcha (inglizcha sukut emas)', async () => {
    const errors = await validateBody(
      body(withCustomer({ phone_number: 'abc' })),
    );
    expect(constraintMessages(errors)).toContain(
      "Telefon raqami +998XXXXXXXXX ko'rinishida bo'lishi kerak",
    );
  });
});

describe('AiParseRequestDto — ai-parse kiritish chegarasi (NsxoDSmm #2)', () => {
  const parseErrors = async (payload: Record<string, unknown>) => {
    const dto = plainToInstance(AiParseRequestDto, payload);
    return flatten(
      await validate(dto, { whitelist: true, forbidNonWhitelisted: true }),
    );
  };

  it('4000 belgilik matn o‘tadi, 4001 → xato', async () => {
    expect(await parseErrors({ text: 'a'.repeat(4000) })).toEqual([]);
    expect(await parseErrors({ text: 'a'.repeat(4001) })).toContain('text');
  });

  it('matn trim qilinadi (bo‘shliqlar chegaraga kirmaydi)', async () => {
    const dto = plainToInstance(AiParseRequestDto, {
      text: `  ${'a'.repeat(4000)}  `,
    });
    expect(
      await validate(dto, { whitelist: true, forbidNonWhitelisted: true }),
    ).toEqual([]);
    expect(dto.text).toHaveLength(4000);
  });

  it('market_id faqat raqam; bo‘sh qiymat e’tiborsiz', async () => {
    expect(await parseErrors({ market_id: '12' })).toEqual([]);
    expect(await parseErrors({ market_id: '' })).toEqual([]);
    expect(await parseErrors({ market_id: 'abc' })).toContain('market_id');
  });

  it('begona maydon → xato', async () => {
    expect(await parseErrors({ text: 'x', status: 'new' })).toContain('status');
  });
});
