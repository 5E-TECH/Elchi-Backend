import {
  BadRequestException,
  ForbiddenException,
  GatewayTimeoutException,
  ValidationPipe,
} from '@nestjs/common';
import { GUARDS_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { Observable, of, throwError, TimeoutError } from 'rxjs';
import { Roles as RoleEnum } from '@app/common';
import { ROLES_KEY } from './auth/roles.decorator';
import { RolesGuard } from './auth/roles.guard';
import { CatalogGatewayController } from './catalog-gateway.controller';
import {
  CreateProductRequestDto,
  UpdateProductRequestDto,
} from './dto/catalog.swagger.dto';

/**
 * MH-3 (9fHyFp3y) + hY7uacJu — gateway qatlami:
 *   • POST /product: o'lchov MAJBURIY (MH-S1), multipart satrlari songa
 *     aylanadi, `volumetric_enabled` sukuti catalog'da (true);
 *   • PATCH /product/:id: o'lchov ixtiyoriy, `null`/'' (/product/my/:id
 *     Pc4CAFdB da olib tashlangan)
 *     — 400; DTO'da yo'q maydon (sku_code, user_id, id, isDeleted) — 400;
 *   • GET /product/by-code/:code: market scoping `GET /product/:id` bilan
 *     bir xil, `:id` dan OLDIN e'lon qilingan.
 * Pipe `main.ts` dagi global ValidationPipe bilan AYNI sozlamada.
 */

type Send = jest.Mock<Observable<unknown>, [{ cmd: string }, unknown]>;

const MARKET = { sub: '121', roles: ['market'] };
const OPERATOR = { sub: '501', roles: ['market_operator'] };
const ADMIN = { sub: '1', roles: ['admin'] };
// Pc4CAFdB: mahsulotni faqat xodim yaratadi — `market_id` majburiy.
const REGISTRATOR = { sub: '77', roles: ['registrator'] };
const BRANCH = { sub: '77', roles: ['branch'] };

const pipe = new ValidationPipe({
  whitelist: true,
  forbidNonWhitelisted: true,
  transform: true,
});

/** Multipart forma qiymatlari — hammasi SATR. */
const MEASURES = {
  weight_kg: '1.2',
  length_cm: '30',
  width_cm: '22',
  height_cm: '15',
};

const validateCreate = (body: Record<string, unknown>) =>
  pipe.transform(body, {
    type: 'body',
    metatype: CreateProductRequestDto,
  }) as Promise<CreateProductRequestDto>;

const validateUpdate = (body: Record<string, unknown>) =>
  pipe.transform(body, {
    type: 'body',
    metatype: UpdateProductRequestDto,
  }) as Promise<UpdateProductRequestDto>;

/** Pc4CAFdB: xodim yaratadi — tanaga `market_id` qo'shiladi. */
const withMarket = <T extends object>(dto: T): T =>
  Object.assign(dto, { market_id: '121' });

const rejects400 = async (promise: Promise<unknown>) => {
  await expect(promise).rejects.toBeInstanceOf(BadRequestException);
};

const setup = (opts?: {
  operatorMarketId?: string | null;
  catalogReply?: () => Observable<unknown>;
}) => {
  const catalogSend: Send = jest.fn(
    opts?.catalogReply ?? (() => of({ data: [], total: 0, matched_by: null })),
  );
  const identitySend: Send = jest.fn(() =>
    of({
      data: {
        id: OPERATOR.sub,
        market_id:
          opts && 'operatorMarketId' in opts ? opts.operatorMarketId : '121',
      },
    }),
  );
  const controller = new CatalogGatewayController(
    { send: catalogSend } as any,
    { send: jest.fn() } as any,
    { send: identitySend } as any,
  );
  return { controller, catalogSend, identitySend };
};

const payloadOf = (send: Send, cmd: string) =>
  send.mock.calls.find(([pattern]) => pattern.cmd === cmd)?.[1] as
    | Record<string, unknown>
    | undefined;

const req = (user: { sub: string; roles: string[] }) => ({
  user,
  protocol: 'https',
  get: (name: string) => (name === 'host' ? 'api.test' : undefined),
  headers: {},
});

describe('MH-3 — POST /product: o`lchov (CL3–CL7)', () => {
  it('⭐ CL3: multipart satrlari songa aylanadi va catalog.product.create`ga RAQAM bo`lib ketadi', async () => {
    const dto = await validateCreate({ name: 'Kitob', ...MEASURES });
    expect(dto).toMatchObject({
      weight_kg: 1.2,
      length_cm: 30,
      width_cm: 22,
      height_cm: 15,
    });

    const { controller, catalogSend } = setup();
    await controller.create(
      undefined,
      withMarket(dto),
      req(REGISTRATOR) as any,
    );
    const sent = payloadOf(catalogSend, 'catalog.product.create')?.dto as
      | Record<string, unknown>
      | undefined;
    expect(sent).toMatchObject({
      name: 'Kitob',
      user_id: '121',
      weight_kg: 1.2,
      length_cm: 30,
      width_cm: 22,
      height_cm: 15,
    });
    expect(typeof sent?.weight_kg).toBe('number');
    expect(typeof sent?.length_cm).toBe('number');
  });

  it.each([
    [' 1,5 ', 1.5],
    ['0.001', 0.001],
    ['1000', 1000],
    [2, 2],
  ])('weight_kg %p → %p', async (input, expected) => {
    const dto = await validateCreate({
      name: 'Kitob',
      ...MEASURES,
      weight_kg: input,
    });
    expect(dto.weight_kg).toBe(expected);
  });

  it.each([
    ['faqat name', { name: 'Kitob' }],
    [
      'uchala o`lcham bor, weight_kg yo`q',
      { name: 'Kitob', length_cm: '30', width_cm: '22', height_cm: '15' },
    ],
    [
      'height_cm yo`q',
      { name: 'Kitob', weight_kg: '1.2', length_cm: '30', width_cm: '22' },
    ],
    ['JSON null', { name: 'Kitob', ...MEASURES, weight_kg: null }],
    ['weight_kg bo`sh satr', { name: 'Kitob', ...MEASURES, weight_kg: '' }],
    ['length_cm probel', { name: 'Kitob', ...MEASURES, length_cm: '  ' }],
  ])('⭐ CL4: o`lchovsiz (%s) → 400 (MH-S1)', async (_label, body) => {
    await rejects400(validateCreate(body));
  });

  it.each([
    ['weight_kg', 'ikki'],
    ['height_cm', -5],
    ['height_cm', '-5'],
    ['length_cm', '30.5'],
    ['weight_kg', '1.2345'],
    ['weight_kg', '1e2'],
    ['weight_kg', '0'],
    ['weight_kg', 1001],
    ['width_cm', '0'],
    ['width_cm', 1001],
    ['length_cm', '0x10'],
  ])('⭐ CL5: %s = %p → 400', async (field, value) => {
    await rejects400(
      validateCreate({ name: 'Kitob', ...MEASURES, [field]: value }),
    );
  });

  // class-validator 0.14 `IsNumber({ maxDecimalPlaces })` 1e-6 dan kichik
  // sonni (`String(1e-7) === '1e-7'`) ko'rganda TypeError tashlardi →
  // ValidationPipe o'rniga HTTP 500. Endi — oddiy 400.
  it.each([
    ['weight_kg', '0.0000001'],
    ['weight_kg', 1e-7],
    ['weight_kg', '0.0000002'],
    ['weight_kg', 2e-7],
    ['weight_kg', 5e-10],
    ['weight_kg', '0,0000001'],
    ['weight_kg', 1.2e-7],
    ['price', '0.0000001'],
    ['price', 1e-7],
  ])('⭐ juda kichik son %s = %p → 400 (500 emas)', async (field, value) => {
    const body = { name: 'Kitob', ...MEASURES, [field]: value };
    await rejects400(validateCreate(body));
    await rejects400(validateUpdate({ [field]: value }));
  });

  it('⭐ kasr chegarasi: weight_kg 3 kasr, price 2 kasr — o`tadi; ortig`i — 400', async () => {
    const ok = await validateCreate({
      name: 'Kitob',
      ...MEASURES,
      weight_kg: '0.005',
      price: '0.01',
    });
    expect(ok).toMatchObject({ weight_kg: 0.005, price: 0.01 });
    await rejects400(
      validateCreate({ name: 'Kitob', ...MEASURES, weight_kg: 0.0005 }),
    );
    await rejects400(
      validateCreate({ name: 'Kitob', ...MEASURES, price: '0.001' }),
    );
  });

  it('⭐ CL6: volumetric_enabled yuborilmasa (yoki "") — payload`da kalit YO`Q (catalog sukuti true)', async () => {
    for (const extra of [{}, { volumetric_enabled: '' }]) {
      const dto = await validateCreate({
        name: 'Kitob',
        ...MEASURES,
        ...extra,
      });
      const { controller, catalogSend } = setup();
      await controller.create(
        undefined,
        withMarket(dto),
        req(REGISTRATOR) as any,
      );
      const sent = payloadOf(catalogSend, 'catalog.product.create')
        ?.dto as Record<string, unknown>;
      expect(sent).not.toHaveProperty('volumetric_enabled');
      expect(sent).not.toHaveProperty('barcode');
    }
  });

  it.each([
    ['false', false],
    ['0', false],
    ['off', false],
    ['no', false],
    [false, false],
    ['true', true],
    ['1', true],
    ['on', true],
    [true, true],
  ])('⭐ CL7: volumetric_enabled %p → %p', async (input, expected) => {
    const dto = await validateCreate({
      name: 'Kitob',
      ...MEASURES,
      volumetric_enabled: input,
    });
    expect(dto.volumetric_enabled).toBe(expected);

    const { controller, catalogSend } = setup();
    await controller.create(
      undefined,
      withMarket(dto),
      req(REGISTRATOR) as any,
    );
    expect(payloadOf(catalogSend, 'catalog.product.create')?.dto).toMatchObject(
      { volumetric_enabled: expected },
    );
  });

  it.each([['maybe'], ['yo`q'], [2]])(
    'CL7: volumetric_enabled %p → 400',
    async (input) => {
      await rejects400(
        validateCreate({
          name: 'Kitob',
          ...MEASURES,
          volumetric_enabled: input,
        }),
      );
    },
  );

  it('hY7uacJu: barcode — trim; "" → null (kodsiz); 513 belgi / raqam (JSON) → 400', async () => {
    expect(
      (
        await validateCreate({
          name: 'Kitob',
          ...MEASURES,
          barcode: ' 4780000000007 ',
        })
      ).barcode,
    ).toBe('4780000000007');
    expect(
      (await validateCreate({ name: 'Kitob', ...MEASURES, barcode: '' }))
        .barcode,
    ).toBeNull();
    await rejects400(
      validateCreate({ name: 'Kitob', ...MEASURES, barcode: 'x'.repeat(513) }),
    );
    await rejects400(
      validateCreate({ name: 'Kitob', ...MEASURES, barcode: 4780000000007 }),
    );
  });

  it('barcode va volumetric_enabled berilsa — catalog`ga uzatiladi', async () => {
    const dto = await validateCreate({
      name: 'Kitob',
      ...MEASURES,
      volumetric_enabled: 'false',
      barcode: '036000291452',
    });
    const { controller, catalogSend } = setup();
    await controller.create(
      undefined,
      withMarket(dto),
      req(REGISTRATOR) as any,
    );
    expect(payloadOf(catalogSend, 'catalog.product.create')?.dto).toMatchObject(
      { volumetric_enabled: false, barcode: '036000291452' },
    );
  });
});

describe('MH-3 — PATCH: o`lchov ixtiyoriy, tozalab bo`lmaydi (CL8)', () => {
  it('⭐ {} — OK; faqat length_cm "40" — OK (son)', async () => {
    await expect(validateUpdate({})).resolves.toBeDefined();
    const dto = await validateUpdate({ length_cm: '40' });
    expect(dto.length_cm).toBe(40);
    expect(dto.weight_kg).toBeUndefined();
  });

  it.each([
    ['weight_kg', null],
    ['weight_kg', ''],
    ['length_cm', null],
    ['height_cm', ''],
    ['height_cm', '-5'],
    ['volumetric_enabled', null],
    ['volumetric_enabled', 'maybe'],
    ['weight_kg', '0.0000005'],
    ['weight_kg', 5e-7],
  ])('⭐ PATCH %s = %p → 400', async (field, value) => {
    await rejects400(validateUpdate({ [field]: value }));
  });

  it('PATCH barcode "" → null (tozalash), volumetric "" → berilmagan', async () => {
    const dto = await validateUpdate({ barcode: '', volumetric_enabled: '' });
    expect(dto.barcode).toBeNull();
    expect(dto.volumetric_enabled).toBeUndefined();
  });

  it('⭐ PATCH /product/:id — catalog.product.update payload`ida yangi maydonlar', async () => {
    const dto = await validateUpdate({
      weight_kg: '2,5',
      length_cm: '40',
      width_cm: '30',
      height_cm: '20',
      volumetric_enabled: 'off',
      barcode: '4780000000007',
    });
    const { controller, catalogSend } = setup({ catalogReply: () => of({}) });
    await controller.update('5', undefined, dto, req(ADMIN) as any);
    expect(payloadOf(catalogSend, 'catalog.product.update')).toMatchObject({
      id: '5',
      dto: {
        weight_kg: 2.5,
        length_cm: 40,
        width_cm: 30,
        height_cm: 20,
        volumetric_enabled: false,
        barcode: '4780000000007',
      },
    });
  });
});

describe('MH-3 — CL9: DTO`da yo`q maydon (forbidNonWhitelisted)', () => {
  it.each([
    ['sku_code', 'ELC-P-000001'],
    ['user_id', '999'],
    ['id', '6'],
    ['isDeleted', 'true'],
    ['is_deleted', 'true'],
    ['createdAt', '2020-01-01'],
  ])('%s = %p — POST ham, PATCH ham → 400', async (field, value) => {
    await rejects400(
      validateCreate({ name: 'Kitob', ...MEASURES, [field]: value }),
    );
    await rejects400(validateUpdate({ [field]: value }));
  });
});

describe('hY7uacJu — GET /product/by-code/:code', () => {
  const sentCode = (send: Send) =>
    payloadOf(send, 'catalog.product.find_by_code');

  it('⭐ market o`z kodi bilan — user_id = token sub, kod trim qilinadi', async () => {
    const { controller, catalogSend } = setup();
    await controller.findByCode(' ELC-P-000007 ', undefined, { user: MARKET });
    expect(sentCode(catalogSend)).toEqual({
      code: 'ELC-P-000007',
      user_id: '121',
    });
  });

  it('market o`z market_id si bilan — OK; boshqa market_id → 403 (RMQ chaqirilmaydi)', async () => {
    const own = setup();
    await own.controller.findByCode('4780000000007', '121', { user: MARKET });
    expect(sentCode(own.catalogSend)).toMatchObject({ user_id: '121' });

    const other = setup();
    await expect(
      other.controller.findByCode('4780000000007', '202', { user: MARKET }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(other.catalogSend).not.toHaveBeenCalled();
  });

  it('⭐ operator — biriktirilgan market; biriktirilmagan → 400', async () => {
    const assigned = setup({ operatorMarketId: '121' });
    await assigned.controller.findByCode('4780000000007', undefined, {
      user: OPERATOR,
    });
    expect(sentCode(assigned.catalogSend)).toMatchObject({ user_id: '121' });
    expect(assigned.identitySend).toHaveBeenCalledWith(
      { cmd: 'identity.user.find_by_id' },
      { id: OPERATOR.sub },
    );

    const foreign = setup({ operatorMarketId: '121' });
    await expect(
      foreign.controller.findByCode('4780000000007', '202', {
        user: OPERATOR,
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);

    const unassigned = setup({ operatorMarketId: null });
    await expect(
      unassigned.controller.findByCode('4780000000007', undefined, {
        user: OPERATOR,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(unassigned.catalogSend).not.toHaveBeenCalled();
  });

  it('⭐ admin market_id`siz — user_id undefined (hamma market); market_id bilan — filtr', async () => {
    const all = setup();
    await all.controller.findByCode('4780000000007', undefined, {
      user: ADMIN,
    });
    expect(sentCode(all.catalogSend)).toEqual({
      code: '4780000000007',
      user_id: undefined,
    });

    const filtered = setup();
    await filtered.controller.findByCode('4780000000007', ' 202 ', {
      user: ADMIN,
    });
    expect(sentCode(filtered.catalogSend)).toMatchObject({ user_id: '202' });

    const branch = setup();
    await branch.controller.findByCode('4780000000007', '202', {
      user: BRANCH,
    });
    expect(sentCode(branch.catalogSend)).toMatchObject({ user_id: '202' });
  });

  it.each([
    ['bo`sh', ''],
    ['probel', '   '],
    ['513 belgi', 'x'.repeat(513)],
  ])('kod (%s) → 400, RMQ chaqirilmaydi', async (_label, code) => {
    const { controller, catalogSend } = setup();
    await expect(
      controller.findByCode(code, undefined, { user: ADMIN }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(catalogSend).not.toHaveBeenCalled();
  });

  it('aynan 512 belgili kod — uzatiladi', async () => {
    const { controller, catalogSend } = setup();
    await controller.findByCode('x'.repeat(512), undefined, { user: ADMIN });
    expect(sentCode(catalogSend)).toMatchObject({ code: 'x'.repeat(512) });
  });

  it('catalog javob bermasa (TimeoutError) → 504', async () => {
    const { controller } = setup({
      catalogReply: () => throwError(() => new TimeoutError()),
    });
    await expect(
      controller.findByCode('4780000000007', undefined, { user: ADMIN }),
    ).rejects.toBeInstanceOf(GatewayTimeoutException);
  });

  it('catalog javobi o`zgarishsiz qaytadi', async () => {
    const reply = {
      data: [{ id: '7', sku_code: 'ELC-P-000007' }],
      total: 1,
      matched_by: 'sku_code',
    };
    const { controller } = setup({ catalogReply: () => of(reply) });
    await expect(
      controller.findByCode('ELC-P-000007', undefined, { user: ADMIN }),
    ).resolves.toEqual(reply);
  });

  it('⭐ marshrut `by-code/:code`, `:id` dan OLDIN e`lon qilingan; rollar = GET /product/:id rollari', () => {
    const proto = CatalogGatewayController.prototype;
    const handler = (name: keyof CatalogGatewayController) =>
      Object.getOwnPropertyDescriptor(proto, name)?.value as object;

    expect(Reflect.getMetadata(PATH_METADATA, handler('findByCode'))).toBe(
      'by-code/:code',
    );
    expect(Reflect.getMetadata(PATH_METADATA, handler('findById'))).toBe(':id');
    // Nest marshrutlarni prototip metodlari tartibida ro'yxatdan o'tkazadi.
    const methods = Object.getOwnPropertyNames(proto);
    expect(methods.indexOf('findByCode')).toBeGreaterThan(-1);
    expect(methods.indexOf('findByCode')).toBeLessThan(
      methods.indexOf('findById'),
    );

    expect(
      Reflect.getMetadata(GUARDS_METADATA, handler('findByCode')),
    ).toContain(RolesGuard);
    const roles = Reflect.getMetadata(
      ROLES_KEY,
      handler('findByCode'),
    ) as string[];
    expect(roles).toEqual(
      Reflect.getMetadata(ROLES_KEY, handler('findById')) as string[],
    );
    expect([...roles].sort()).toEqual(
      [
        RoleEnum.SUPERADMIN,
        RoleEnum.ADMIN,
        RoleEnum.REGISTRATOR,
        RoleEnum.MANAGER,
        RoleEnum.BRANCH,
        RoleEnum.MARKET,
        RoleEnum.MARKET_OPERATOR,
      ].sort(),
    );
  });
});
