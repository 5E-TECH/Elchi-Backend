import { RpcException } from '@nestjs/microservices';
import { of } from 'rxjs';
import { ActivityAction } from '@app/common';
import { CatalogServiceService } from './catalog-service.service';

/**
 * 6tGZzupr — o'lchovsiz avtomatik mahsulot teshigi (servis qatlami):
 *   - `create()` requester oladi; hamkor yo'li `system` — jurnalda ko'rinadi;
 *   - `needs_measurement` — saqlanmaydi, o'lchovdan KELIB CHIQADI (dvigatel
 *     `estimated` qoidasi bilan AYNI), registrator PATCH qilsa o'zi tushadi;
 *   - ro'yxat filtri `needs_measurement`;
 *   - `fillMissingMeasure` — faqat BO'SH maydon, xodim o'lchovi almashmaydi.
 */

type Row = Record<string, unknown>;

const SYSTEM = { id: 'system', roles: ['system'], via: 'partner:7' };

const make = (opts?: { product?: Row }) => {
  const activityLog = { log: jest.fn(), logChange: jest.fn() };
  const andWhere = jest.fn().mockReturnThis();
  const qb = {
    select: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    andWhere,
    orderBy: jest.fn().mockReturnThis(),
    addOrderBy: jest.fn().mockReturnThis(),
    skip: jest.fn().mockReturnThis(),
    take: jest.fn().mockReturnThis(),
    getOne: jest.fn(() => Promise.resolve(null)),
    getManyAndCount: jest.fn(() => Promise.resolve([[], 0])),
  };
  const stored = new Map<string, Row>();
  if (opts?.product) stored.set(String(opts.product.id), opts.product);
  const productRepo = {
    create: jest.fn((row: Row) => ({ ...row })),
    save: jest.fn((row: Row) => {
      const id = typeof row.id === 'string' ? row.id : '7';
      const saved = { ...row, id, sku_code: 'ELC-P-000007' };
      stored.set(id, saved);
      return Promise.resolve(saved);
    }),
    findOne: jest.fn(({ where }: { where: { id: string } }) => {
      const row = stored.get(String(where.id));
      return Promise.resolve(row ? { ...row } : null);
    }),
    createQueryBuilder: jest.fn(() => qb),
  };
  const svc = new CatalogServiceService(
    productRepo as any,
    { send: jest.fn(() => of({})) } as any,
    {
      send: jest.fn(() => of({ success: true, data: { id: '55', name: 'M' } })),
    } as any,
    activityLog as any,
  );
  return { svc, activityLog, productRepo, qb, andWhere };
};

const rpcStatus = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(RpcException);
    return ((error as RpcException).getError() as { statusCode: number })
      .statusCode;
  }
  throw new Error('RpcException kutilgan edi');
};

describe('6tGZzupr — catalog create() requester', () => {
  it('⭐ hamkor yo`li `system`: jurnalda aktyor va «o`lchov kutilmoqda»', async () => {
    const { svc, activityLog } = make();

    const created = await svc.create({ name: 'Qalam', user_id: '55' }, SYSTEM);

    expect(activityLog.log).toHaveBeenCalledWith(
      expect.objectContaining({
        entity_type: 'Product',
        action: ActivityAction.CREATED,
        user_id: 'system',
        user_role: 'system',
        metadata: {
          user_id: '55',
          source: 'system',
          via: 'partner:7',
          needs_measurement: true,
        },
      }),
    );
    expect(created.needs_measurement).toBe(true);
  });

  it('hamkor o`lchov yuborsa: «o`lchov kutilmoqda» emas', async () => {
    const { svc, activityLog } = make();

    const created = await svc.create(
      {
        name: 'Qalam',
        user_id: '55',
        weight_kg: 1.25,
        length_cm: 30,
        width_cm: 20,
        height_cm: 10,
      },
      SYSTEM,
    );

    expect(created.needs_measurement).toBe(false);
    expect(activityLog.log.mock.calls[0][0].metadata.needs_measurement).toBe(
      false,
    );
  });

  it('xodim: requester HTTP foydalanuvchisi', async () => {
    const { svc, activityLog } = make();

    await svc.create(
      {
        name: 'Qalam',
        user_id: '55',
        weight_kg: 1,
        length_cm: 1,
        width_cm: 1,
        height_cm: 1,
      },
      { id: '12', roles: ['registrator'] },
    );

    expect(activityLog.log).toHaveBeenCalledWith(
      expect.objectContaining({
        user_id: '12',
        user_role: 'registrator',
        metadata: expect.objectContaining({ source: 'staff' }),
      }),
    );
  });

  it.each(['market', 'market_operator'])(
    '%s roli servis qatlamida ham yarata olmaydi (Pc4CAFdB)',
    async (role) => {
      const { svc, productRepo } = make();

      expect(
        await rpcStatus(
          svc.create(
            { name: 'Qalam', user_id: '55' },
            { id: '55', roles: [role] },
          ),
        ),
      ).toBe(403);
      expect(productRepo.save).not.toHaveBeenCalled();
    },
  );

  it('requester berilmagan eski chaqiruv buzilmaydi (rolling deploy)', async () => {
    const { svc, activityLog } = make();

    await svc.create({ name: 'Qalam', user_id: '55' });

    expect(activityLog.log).toHaveBeenCalledWith(
      expect.objectContaining({
        user_id: null,
        user_role: null,
        metadata: expect.objectContaining({ source: 'unknown' }),
      }),
    );
  });
});

describe('6tGZzupr — needs_measurement (o`lchovdan kelib chiqadi)', () => {
  const productOf = (over: Row): Row => ({
    id: '9',
    name: 'Qalam',
    user_id: '55',
    image_url: null,
    price: null,
    weight_kg: null,
    length_cm: null,
    width_cm: null,
    height_cm: null,
    volumetric_enabled: true,
    barcode: null,
    sku_code: 'ELC-P-000009',
    ...over,
  });

  it.each<[string, Row, boolean]>([
    ['hech narsa yo`q', {}, true],
    ['faqat og`irlik, hajm yoqiq', { weight_kg: 1 }, true],
    [
      'faqat og`irlik, hajm o`chiq',
      { weight_kg: 1, volumetric_enabled: false },
      false,
    ],
    [
      'o`lcham bor, og`irlik yo`q',
      { length_cm: 1, width_cm: 1, height_cm: 1 },
      true,
    ],
    [
      'to`liq',
      { weight_kg: 1, length_cm: 1, width_cm: 1, height_cm: 1 },
      false,
    ],
  ])('%s', async (_name, over, expected) => {
    const { svc } = make({ product: productOf(over) });

    const found = await svc.findById('9');

    expect(found.needs_measurement).toBe(expected);
  });

  it('registrator o`lchov kiritsa holat o`zi tushadi (migratsiya/flag yo`q)', async () => {
    const { svc } = make({ product: productOf({}) });

    const updated = await svc.update('9', {
      weight_kg: 1,
      length_cm: 10,
      width_cm: 10,
      height_cm: 10,
    });

    expect(updated.needs_measurement).toBe(false);
  });

  it('ro`yxat filtri: faqat o`lchov kutayotganlar', async () => {
    const { svc, andWhere } = make();

    await svc.findAll({ needs_measurement: true });

    const conditions = andWhere.mock.calls.map(([sql]) => String(sql));
    expect(
      conditions.some(
        (sql) =>
          sql.includes('product.weight_kg IS NULL') &&
          sql.includes('product.volumetric_enabled = true'),
      ),
    ).toBe(true);
  });

  it('ro`yxat filtri: false — o`lchovi to`liqlar', async () => {
    const { svc, andWhere } = make();

    await svc.findAll({ needs_measurement: false });

    const conditions = andWhere.mock.calls.map(([sql]) => String(sql));
    expect(
      conditions.some((sql) =>
        sql.startsWith('NOT (product.weight_kg IS NULL'),
      ),
    ).toBe(true);
  });

  it('filtr berilmasa — eski so`rov o`zgarmaydi', async () => {
    const { svc, andWhere } = make();

    await svc.findAll({});

    const conditions = andWhere.mock.calls.map(([sql]) => String(sql));
    expect(conditions.some((sql) => sql.includes('weight_kg'))).toBe(false);
  });
});

describe('6tGZzupr — fillMissingMeasure', () => {
  const productOf = (over: Row): Row => ({
    id: '9',
    name: 'Qalam',
    user_id: '55',
    image_url: null,
    price: null,
    weight_kg: null,
    length_cm: null,
    width_cm: null,
    height_cm: null,
    volumetric_enabled: true,
    barcode: null,
    sku_code: 'ELC-P-000009',
    ...over,
  });
  const MEASURE = {
    user_id: '55',
    weight_kg: 1.25,
    length_cm: 30,
    width_cm: 20,
    height_cm: 10,
  };

  it('bo`sh o`lchov to`ldiriladi va jurnalga yoziladi', async () => {
    const { svc, productRepo, activityLog } = make({ product: productOf({}) });

    await svc.fillMissingMeasure('9', MEASURE, SYSTEM);

    expect(productRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({
        weight_kg: 1.25,
        length_cm: 30,
        width_cm: 20,
        height_cm: 10,
      }),
    );
    expect(activityLog.logChange).toHaveBeenCalledWith(
      expect.objectContaining({
        action: ActivityAction.UPDATED,
        user_id: 'system',
        user_role: 'system',
        metadata: expect.objectContaining({ source: 'system' }),
      }),
    );
  });

  it('⭐ xodim kiritgan o`lchov ALMASHTIRILMAYDI', async () => {
    const { svc, productRepo, activityLog } = make({
      product: productOf({
        weight_kg: 2,
        length_cm: 5,
        width_cm: 5,
        height_cm: 5,
      }),
    });

    await svc.fillMissingMeasure('9', MEASURE, SYSTEM);

    expect(productRepo.save).not.toHaveBeenCalled();
    expect(activityLog.logChange).not.toHaveBeenCalled();
  });

  it('faqat o`lcham yetishmasa — og`irlik tegilmaydi', async () => {
    const { svc, productRepo } = make({
      product: productOf({ weight_kg: 2 }),
    });

    await svc.fillMissingMeasure('9', MEASURE, SYSTEM);

    expect(productRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({
        weight_kg: 2,
        length_cm: 30,
        width_cm: 20,
        height_cm: 10,
      }),
    );
  });

  it('boshqa market mahsuloti — 403', async () => {
    const { svc, productRepo } = make({ product: productOf({}) });

    expect(
      await rpcStatus(
        svc.fillMissingMeasure('9', { ...MEASURE, user_id: '56' }, SYSTEM),
      ),
    ).toBe(403);
    expect(productRepo.save).not.toHaveBeenCalled();
  });

  it('noto`g`ri o`lchov — 400', async () => {
    const { svc } = make({ product: productOf({}) });

    expect(
      await rpcStatus(
        svc.fillMissingMeasure('9', { user_id: '55', length_cm: 30 }, SYSTEM),
      ),
    ).toBe(400);
  });
});
