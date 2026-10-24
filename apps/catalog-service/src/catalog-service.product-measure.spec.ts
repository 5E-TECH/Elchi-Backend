import { RpcException } from '@nestjs/microservices';
import { of } from 'rxjs';
import { QueryFailedError } from 'typeorm';
import { ActivityAction } from '@app/common';
import { CatalogServiceService } from './catalog-service.service';

/**
 * MH-3 (9fHyFp3y) + hY7uacJu — mahsulot o'lchovi va kodlari, servis
 * qatlami (mock repozitoriy). Haqiqiy Postgres'dagi qoidalar (CHECK, unique
 * indeks, generated `sku_code`) — `catalog-product.pg.spec.ts`.
 */

type Row = Record<string, unknown>;

const MEASURED = {
  weight_kg: 1.2,
  length_cm: 30,
  width_cm: 22,
  height_cm: 15,
  volumetric_enabled: true,
};

const make = (opts?: {
  product?: Row;
  duplicateOf?: { id: string; name: string } | null;
}) => {
  const activityLog = { log: jest.fn(), logChange: jest.fn() };
  const searchSend = jest.fn(() => of({}));
  const identitySend = jest.fn(() =>
    of({ success: true, data: { id: '121', name: 'M' } }),
  );
  const duplicateCheck = {
    select: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    take: jest.fn().mockReturnThis(),
    getOne: jest.fn(() => Promise.resolve(opts?.duplicateOf ?? null)),
    getManyAndCount: jest.fn(() => Promise.resolve([[], 0])),
  };
  const stored = new Map<string, Row>();
  if (opts?.product) stored.set(String(opts.product.id), opts.product);
  const productRepo = {
    create: jest.fn((row: Row) => ({ ...row })),
    save: jest.fn((row: Row) => {
      const id = typeof row.id === 'string' ? row.id : '7';
      const saved = {
        ...row,
        id,
        sku_code: row.sku_code ?? 'ELC-P-000007',
      };
      stored.set(id, saved);
      return Promise.resolve(saved);
    }),
    findOne: jest.fn(({ where }: { where: { id: string } }) => {
      const row = stored.get(String(where.id));
      return Promise.resolve(row ? { ...row } : null);
    }),
    createQueryBuilder: jest.fn(() => duplicateCheck),
  };
  const svc = new CatalogServiceService(
    productRepo as any,
    { send: searchSend } as any,
    { send: identitySend } as any,
    activityLog as any,
  );
  return {
    svc,
    activityLog,
    productRepo,
    searchSend,
    identitySend,
    duplicateCheck,
  };
};

const rpcError = async (promise: Promise<unknown>) => {
  const error: unknown = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(RpcException);
  return (error as RpcException).getError() as {
    statusCode?: number;
    message?: string;
  };
};

const flush = () => new Promise((resolve) => setImmediate(resolve));

describe('MH-3 — create: o`lchov', () => {
  it('⭐ ichki yo`l (hamkor `{ name, user_id }`) — o`lchovsiz muvaffaqiyatli: NULL, volumetric true', async () => {
    const { svc, productRepo } = make();
    await svc.create({ name: 'Olma', user_id: '121' });
    expect(productRepo.create).toHaveBeenCalledWith({
      name: 'Olma',
      user_id: '121',
      image_url: null,
      price: null,
      weight_kg: null,
      length_cm: null,
      width_cm: null,
      height_cm: null,
      volumetric_enabled: true,
      barcode: null,
    });
  });

  it('⭐ CL3: raqamli satrlar (RMQ) — son bo`lib saqlanadi', async () => {
    const { svc, productRepo } = make();
    await svc.create({
      name: 'Olma',
      user_id: '121',
      weight_kg: '1.2',
      length_cm: '30',
      width_cm: 22,
      height_cm: '15',
      volumetric_enabled: 'false',
    });
    expect(productRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        weight_kg: 1.2,
        length_cm: 30,
        width_cm: 22,
        height_cm: 15,
        volumetric_enabled: false,
      }),
    );
  });

  it.each([
    ['weight_kg', 'ikki'],
    ['weight_kg', -1],
    ['weight_kg', '0'],
    ['weight_kg', '1.2345'],
    ['weight_kg', 1001],
    ['weight_kg', '1e2'],
    ['height_cm', '-5'],
    ['height_cm', 0],
    ['height_cm', '12.5'],
    ['height_cm', 'abc'],
    ['height_cm', 1001],
    ['volumetric_enabled', 'maybe'],
  ])(
    '⭐ CL5: %s = %p → 400, market so`ralmaydi, saqlanmaydi',
    async (field, value) => {
      const { svc, productRepo, identitySend } = make();
      const base: Row = { name: 'Olma', user_id: '121', ...MEASURED };
      expect(
        await rpcError(svc.create({ ...base, [field]: value } as never)),
      ).toMatchObject({ statusCode: 400 });
      expect(identitySend).not.toHaveBeenCalled();
      expect(productRepo.save).not.toHaveBeenCalled();
    },
  );

  it('chala o`lcham (faqat length_cm) → 400 «uchalasi ham»', async () => {
    const { svc, productRepo } = make();
    const error = await rpcError(
      svc.create({ name: 'Olma', user_id: '121', length_cm: 30 }),
    );
    expect(error).toMatchObject({ statusCode: 400 });
    expect(error.message).toMatch(/uchalasi/);
    expect(productRepo.save).not.toHaveBeenCalled();
  });
});

describe('hY7uacJu — create: shtrix kod', () => {
  it('EAN normalizatsiya qilinadi (probel olinadi) va saqlanadi', async () => {
    const { svc, productRepo } = make();
    await svc.create({
      name: 'Olma',
      user_id: '121',
      barcode: ' 4 780000 000007 ',
    });
    expect(productRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({ barcode: '4780000000007' }),
    );
  });

  it.each([
    ['036000291452', '0036000291452', ['0036000291452']],
    ['00036000291452', '0036000291452', ['0036000291452']],
    [']d20104780000000007215xyz', '4780000000007', ['4780000000007']],
    // ⭐ UPC-E (Coca-Cola) — kengaytirilgan UPC-A ning kanonik shakli.
    ['04963406', '0049000006346', ['0049000006346']],
    // UPC-E / EAN-8 ikkiligi — teng yozuv ham band deb tekshiriladi.
    ['10017265', '10017265', ['10017265', '0100172000065']],
    ['100172000065', '0100172000065', ['0100172000065', '10017265']],
  ])(
    '⭐ GTIN KANONIK shaklda saqlanadi: %p → %p (dublikat tekshiruvi: %p)',
    async (raw, canonical, checked) => {
      const { svc, productRepo, duplicateCheck } = make();
      await svc.create({ name: 'Olma', user_id: '121', barcode: raw });
      expect(productRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({ barcode: canonical }),
      );
      expect(duplicateCheck.andWhere).toHaveBeenCalledWith(
        'product.barcode IN (:...barcodes)',
        { barcodes: checked },
      );
    },
  );

  it('⭐ UPC-E nazorat raqami noto`g`ri (EAN-8 ham emas) → 400', async () => {
    const { svc, productRepo } = make();
    const error = await rpcError(
      svc.create({ name: 'Olma', user_id: '121', barcode: '04963407' }),
    );
    expect(error).toMatchObject({ statusCode: 400 });
    expect(error.message).toMatch(/EAN-8\/UPC-E/);
    expect(productRepo.save).not.toHaveBeenCalled();
  });

  it.each([['4006381333932'], ['ELC-P-000001'], ['AB\u0000C'], ['00000000']])(
    'noto`g`ri kod %p → 400',
    async (barcode) => {
      const { svc, productRepo } = make();
      expect(
        await rpcError(svc.create({ name: 'Olma', user_id: '121', barcode })),
      ).toMatchObject({ statusCode: 400 });
      expect(productRepo.save).not.toHaveBeenCalled();
    },
  );

  it('JSON raqami (satr emas) → 400', async () => {
    const { svc } = make();
    expect(
      await rpcError(
        svc.create({
          name: 'Olma',
          user_id: '121',
          barcode: 4780000000007 as unknown as string,
        }),
      ),
    ).toMatchObject({ statusCode: 400 });
  });

  it('⭐ shu marketda kod band → 409, xabarda mahsulot nomi', async () => {
    // Nom tekshiruvi (1-getOne) — bo'sh; kod tekshiruvi (2-getOne) — band.
    const { svc, duplicateCheck, productRepo } = make();
    duplicateCheck.getOne
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: '3', name: 'Pepsi 0.5' });
    const error = await rpcError(
      svc.create({ name: 'Cola', user_id: '121', barcode: '4780000000007' }),
    );
    expect(error).toMatchObject({ statusCode: 409 });
    expect(error.message).toContain('Pepsi 0.5');
    expect(error.message).toMatch(/shtrix kod/);
    expect(productRepo.save).not.toHaveBeenCalled();
  });

  it('poyga: INSERT 23505 `UQ_products_barcode_user_id` → kod 409 (nom xabari emas)', async () => {
    const { svc, productRepo } = make();
    productRepo.save.mockRejectedValueOnce(
      new QueryFailedError('INSERT', [], {
        code: '23505',
        constraint: 'UQ_products_barcode_user_id',
      } as never),
    );
    const error = await rpcError(
      svc.create({ name: 'Cola', user_id: '121', barcode: '4780000000007' }),
    );
    expect(error).toMatchObject({ statusCode: 409 });
    expect(error.message).toMatch(/shtrix kod/);
    expect(error.message).not.toMatch(/nomdagi/);
  });

  it('DB CHECK (23514) nomsiz → umumiy 400', async () => {
    const { svc, productRepo } = make();
    productRepo.save.mockRejectedValueOnce(
      new QueryFailedError('INSERT', [], { code: '23514' } as never),
    );
    expect(
      await rpcError(svc.create({ name: 'Cola', user_id: '121' })),
    ).toMatchObject({
      statusCode: 400,
      message: expect.stringMatching(/o'lchovi/),
    });
  });

  it.each([
    ['CHK_products_weight_kg_positive', /weight_kg/],
    ['CHK_products_dimensions_positive', /0 dan katta/],
    ['CHK_products_dimensions_all_or_none', /uchalasi/],
    ['CHK_products_barcode_not_blank', /Shtrix kod bo'sh/],
  ])('DB CHECK 23514 %s → aniq 400 xabari', async (constraint, message) => {
    const { svc, productRepo } = make();
    productRepo.save.mockRejectedValueOnce(
      new QueryFailedError('INSERT', [], {
        code: '23514',
        constraint,
      } as never),
    );
    const error = await rpcError(svc.create({ name: 'Cola', user_id: '121' }));
    expect(error.statusCode).toBe(400);
    expect(error.message).toMatch(message);
  });
});

describe('MH-3 — update (xodim) va whitelist', () => {
  const measuredProduct = (): Row => ({
    id: '5',
    user_id: '121',
    name: 'Olma',
    image_url: null,
    price: null,
    ...MEASURED,
    barcode: null,
    sku_code: 'ELC-P-000005',
    isDeleted: false,
  });
  const unmeasuredProduct = (): Row => ({
    ...measuredProduct(),
    weight_kg: null,
    length_cm: null,
    width_cm: null,
    height_cm: null,
  });

  it('⭐ CL9: id / user_id / sku_code / isDeleted / createdAt — entity`ga YOZILMAYDI', async () => {
    const { svc, productRepo } = make({ product: measuredProduct() });
    await svc.update('5', {
      name: 'Olma 2',
      user_id: '999',
      sku_code: 'X',
      id: '6',
      isDeleted: true,
      createdAt: new Date(0),
    } as never);
    const saved = productRepo.save.mock.calls[0][0];
    expect(saved).toMatchObject({
      id: '5',
      user_id: '121',
      sku_code: 'ELC-P-000005',
      isDeleted: false,
      name: 'Olma 2',
    });
    expect(saved).not.toHaveProperty('createdAt');
  });

  it('⭐ CL8: to`liq o`lchovli mahsulotda faqat height_cm o`zgaradi', async () => {
    const { svc, productRepo } = make({ product: measuredProduct() });
    await svc.update('5', { height_cm: '20' });
    expect(productRepo.save.mock.calls[0][0]).toMatchObject({
      ...MEASURED,
      height_cm: 20,
    });
  });

  it('⭐ CL8: o`lchovsiz eski mahsulotga faqat height_cm → 400 (uchalasi yoki hech biri)', async () => {
    const { svc, productRepo } = make({ product: unmeasuredProduct() });
    expect(await rpcError(svc.update('5', { height_cm: 20 }))).toMatchObject({
      statusCode: 400,
    });
    expect(productRepo.save).not.toHaveBeenCalled();
  });

  it('o`lchovsiz eski mahsulotda faqat nom tahriri ishlayveradi', async () => {
    const { svc, productRepo } = make({ product: unmeasuredProduct() });
    await svc.update('5', { name: 'Yangi' });
    expect(productRepo.save.mock.calls[0][0]).toMatchObject({
      name: 'Yangi',
      weight_kg: null,
      length_cm: null,
    });
  });

  it.each([
    ['weight_kg', null],
    ['weight_kg', ''],
    ['length_cm', null],
    ['volumetric_enabled', null],
  ])(
    '⭐ PATCH %s = %p → 400 (o`lchovni tozalab bo`lmaydi)',
    async (field, value) => {
      const { svc, productRepo } = make({ product: measuredProduct() });
      const error = await rpcError(
        svc.update('5', { [field]: value } as never),
      );
      expect(error).toMatchObject({ statusCode: 400 });
      expect(error.message).toContain(field);
      expect(error.message).toMatch(/faqat yangi qiymat/);
      expect(productRepo.save).not.toHaveBeenCalled();
    },
  );

  it('PATCH barcode: noto`g`ri EAN → 400; "" / null → tozalash', async () => {
    const first = make({
      product: { ...measuredProduct(), barcode: '4780000000007' },
    });
    expect(
      await rpcError(first.svc.update('5', { barcode: '4780000000008' })),
    ).toMatchObject({ statusCode: 400 });

    for (const value of ['', null]) {
      const { svc, productRepo } = make({
        product: { ...measuredProduct(), barcode: '4780000000007' },
      });
      await svc.update('5', { barcode: value });
      expect(productRepo.save.mock.calls[0][0]).toMatchObject({
        barcode: null,
      });
    }
  });

  it('PATCH barcode: o`zi bilan bir xil kod — dublikat tekshirilmaydi', async () => {
    const { svc, duplicateCheck } = make({
      product: { ...measuredProduct(), barcode: '4780000000007' },
    });
    await svc.update('5', { barcode: '4780000000007' });
    expect(duplicateCheck.getOne).not.toHaveBeenCalled();
  });
});

describe('MH-3 — update_own (market / operator): xodim bilan bir xil ro`yxat', () => {
  const product = (): Row => ({
    id: '5',
    user_id: '121',
    name: 'A',
    ...MEASURED,
    barcode: '4780000000007',
    sku_code: 'ELC-P-000005',
  });

  it('⭐ egasi o`lchov va shtrix kodni tuzatadi — saqlanadi, logChange aktyori operator', async () => {
    const { svc, productRepo, activityLog } = make({ product: product() });
    await svc.updateOwn(
      '5',
      '121',
      {
        weight_kg: '2.5',
        length_cm: 40,
        volumetric_enabled: 'false',
        barcode: '036000291452',
      },
      { id: '501', role: 'market_operator' },
    );
    expect(productRepo.save.mock.calls[0][0]).toMatchObject({
      weight_kg: 2.5,
      length_cm: 40,
      width_cm: 22,
      height_cm: 15,
      volumetric_enabled: false,
      barcode: '0036000291452',
    });
    expect(activityLog.logChange).toHaveBeenCalledWith(
      expect.objectContaining({
        user_id: '501',
        user_role: 'market_operator',
        old_value: expect.objectContaining({ weight_kg: 1.2 }),
        new_value: expect.objectContaining({
          weight_kg: 2.5,
          barcode: '0036000291452',
        }),
      }),
    );
  });

  it('barcode "" — tozalash (null)', async () => {
    const { svc, productRepo } = make({ product: product() });
    await svc.updateOwn('5', '121', { barcode: '' });
    expect(productRepo.save.mock.calls[0][0]).toMatchObject({ barcode: null });
  });

  it('qiymat qoidalari xodim bilan bir xil: null o`lchov / noto`g`ri EAN → 400', async () => {
    for (const dto of [{ weight_kg: null }, { barcode: '4780000000008' }]) {
      const { svc, productRepo } = make({ product: product() });
      expect(await rpcError(svc.updateOwn('5', '121', dto))).toMatchObject({
        statusCode: 400,
      });
      expect(productRepo.save).not.toHaveBeenCalled();
    }
  });

  it('⭐ begona marketning mahsuloti — o`lchov bilan ham 403 (egalik avval)', async () => {
    const { svc, productRepo } = make({ product: product() });
    expect(
      await rpcError(svc.updateOwn('5', '202', { weight_kg: 2 })),
    ).toMatchObject({ statusCode: 403 });
    expect(productRepo.save).not.toHaveBeenCalled();
  });

  it('faqat nom / rasm — avvalgidek ishlaydi', async () => {
    const { svc, productRepo } = make({ product: product() });
    await svc.updateOwn('5', '121', { name: 'B', image_url: 'x.png' });
    expect(productRepo.save).toHaveBeenCalled();
  });
});

describe('CL11 — qidiruv indeksi (search.index.upsert)', () => {
  it('⭐ tags — faqat product (kodlar global qidiruvga OCHILMAYDI); metadata: o`lchov va kodlar', async () => {
    const { svc, searchSend } = make();
    await svc.create({
      name: 'Olma',
      user_id: '121',
      ...MEASURED,
      volumetric_enabled: false,
      barcode: '4780000000007',
    });
    await flush();
    const upsert = searchSend.mock.calls.find(
      (call) =>
        (call as unknown as [{ cmd: string }])[0].cmd === 'search.index.upsert',
    ) as unknown as [unknown, Row] | undefined;
    expect(upsert?.[1]).toMatchObject({ tags: ['product'] });
    expect(upsert?.[1]).toMatchObject({
      metadata: {
        user_id: '121',
        sku_code: 'ELC-P-000007',
        barcode: '4780000000007',
        weight_kg: 1.2,
        length_cm: 30,
        width_cm: 22,
        height_cm: 15,
        volumetric_enabled: false,
      },
    });
  });

  it('kodsiz, o`lchovsiz mahsulot — tags product; metadata`da null va volumetric true', async () => {
    const { svc, searchSend } = make();
    await svc.create({ name: 'Olma', user_id: '121' });
    await flush();
    const upsert = searchSend.mock.calls.find(
      (call) =>
        (call as unknown as [{ cmd: string }])[0].cmd === 'search.index.upsert',
    ) as unknown as [unknown, Row] | undefined;
    expect(upsert?.[1]).toMatchObject({
      tags: ['product'],
      metadata: {
        sku_code: 'ELC-P-000007',
        barcode: null,
        weight_kg: null,
        volumetric_enabled: true,
      },
    });
  });
});

describe('CL12 — activity_log', () => {
  it('⭐ CREATED new_value: o`lchov, barcode va sku_code', async () => {
    const { svc, activityLog } = make();
    await svc.create({
      name: 'Olma',
      user_id: '121',
      ...MEASURED,
      barcode: '4780000000007',
    });
    expect(activityLog.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: ActivityAction.CREATED,
        new_value: expect.objectContaining({
          ...MEASURED,
          barcode: '4780000000007',
          sku_code: 'ELC-P-000007',
        }),
      }),
    );
  });

  it('⭐ update: weight_kg 1.2 → 2 — logChange old/new snapshot`larida', async () => {
    const { svc, activityLog } = make({
      product: {
        id: '5',
        user_id: '121',
        name: 'Olma',
        ...MEASURED,
        barcode: null,
        sku_code: 'ELC-P-000005',
      },
    });
    await svc.update('5', { weight_kg: 2 });
    expect(activityLog.logChange).toHaveBeenCalledWith(
      expect.objectContaining({
        old_value: expect.objectContaining({ weight_kg: 1.2 }),
        new_value: expect.objectContaining({ weight_kg: 2 }),
      }),
    );
  });

  it('remove old_value: sku_code va barcode', async () => {
    const { svc, activityLog } = make({
      product: {
        id: '5',
        user_id: '121',
        name: 'Olma',
        barcode: '4780000000007',
        sku_code: 'ELC-P-000005',
      },
    });
    await svc.remove('5');
    expect(activityLog.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: ActivityAction.DELETED,
        old_value: {
          name: 'Olma',
          sku_code: 'ELC-P-000005',
          barcode: '4780000000007',
        },
      }),
    );
  });
});

describe('hY7uacJu — findByCode: so`rov sharti', () => {
  it('⭐ 12 xonali UPC skani — [xom, kanonik] variantlar bilan qidiriladi; market scoping', async () => {
    const { svc, duplicateCheck } = make();
    await expect(svc.findByCode(' 036000291452 ', '121')).resolves.toEqual({
      data: [],
      total: 0,
      matched_by: null,
    });
    expect(duplicateCheck.andWhere).toHaveBeenCalledWith(
      'product.barcode IN (:...barcodes)',
      { barcodes: ['036000291452', '0036000291452'] },
    );
    expect(duplicateCheck.andWhere).toHaveBeenCalledWith(
      'product.user_id = :user_id',
      { user_id: '121' },
    );
    expect(duplicateCheck.take).toHaveBeenCalledWith(50);
  });

  it.each([
    ['04963406', ['04963406', '0049000006346']],
    ['049000006346', ['049000006346', '0049000006346']],
    ['100172000065', ['100172000065', '0100172000065', '10017265']],
  ])(
    '⭐ UPC-E / UPC-A skani %p — saqlashdagi kanonik va teng qiymatlar bilan qidiriladi',
    async (scan, barcodes) => {
      const { svc, duplicateCheck } = make();
      await svc.findByCode(scan, '121');
      expect(duplicateCheck.andWhere).toHaveBeenCalledWith(
        'product.barcode IN (:...barcodes)',
        { barcodes },
      );
    },
  );

  it('ELC-P (nolsiz, kichik harf) — sku_code bo`yicha, barcode sharti yo`q', async () => {
    const { svc, duplicateCheck } = make();
    await svc.findByCode('elc-p-7');
    expect(duplicateCheck.andWhere).toHaveBeenCalledWith(
      'product.sku_code = :skuCode',
      { skuCode: 'ELC-P-000007' },
    );
    expect(duplicateCheck.andWhere).not.toHaveBeenCalledWith(
      'product.barcode IN (:...barcodes)',
      expect.anything(),
    );
  });
});

describe('hY7uacJu — findByCode: kirish tekshiruvi (DB so`ralmaydi)', () => {
  it.each([
    ['bo`sh', ''],
    ['probel', '   '],
    ['noto`g`ri ELC-P', 'ELC-P-x'],
    ['ELC-P nol id', 'ELC-P-0'],
    ['513 belgi', 'x'.repeat(513)],
    ['null', null],
  ])('kod (%s) → 400', async (_label, code) => {
    const { svc, productRepo } = make();
    expect(await rpcError(svc.findByCode(code))).toMatchObject({
      statusCode: 400,
    });
    expect(productRepo.createQueryBuilder).not.toHaveBeenCalled();
  });
});
