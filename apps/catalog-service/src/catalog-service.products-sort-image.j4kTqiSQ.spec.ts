/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call */
import { CatalogServiceService } from './catalog-service.service';

/**
 * j4kTqiSQ — catalog `findAll` saralashi (whitelist ustun + id tie-break) va
 * `image_url: null` — rasm o'chiriladi.
 */
describe('j4kTqiSQ — catalog findAll sort va image_url null', () => {
  const makeQb = () => {
    const qb: Record<string, jest.Mock> = {};
    for (const m of [
      'where',
      'andWhere',
      'orderBy',
      'addOrderBy',
      'skip',
      'take',
    ]) {
      qb[m] = jest.fn(() => qb);
    }
    qb.getManyAndCount = jest.fn().mockResolvedValue([[], 0]);
    return qb;
  };

  const setup = () => {
    const qb = makeQb();
    const service: any = Object.create(CatalogServiceService.prototype);
    service.productRepo = { createQueryBuilder: jest.fn(() => qb) };
    service.attachMarkets = jest.fn().mockResolvedValue([]);
    return { service, qb };
  };

  it('sukut — createdAt DESC, id DESC', async () => {
    const { service, qb } = setup();
    await service.findAll({});
    expect(qb.orderBy).toHaveBeenCalledWith(
      'product.createdAt',
      'DESC',
      undefined,
    );
    expect(qb.addOrderBy).toHaveBeenCalledWith('product.id', 'DESC');
  });

  it.each([
    ['name', 'asc', 'product.name', 'ASC', undefined],
    ['created_at', 'asc', 'product.createdAt', 'ASC', undefined],
    ['price', 'desc', 'product.price', 'DESC', 'NULLS LAST'],
  ])('%s %s → %s %s', async (by, dir, col, sqlDir, nulls) => {
    const { service, qb } = setup();
    await service.findAll({ sort_by: by, sort_dir: dir });
    expect(qb.orderBy).toHaveBeenCalledWith(col, sqlDir, nulls);
    expect(qb.addOrderBy).toHaveBeenCalledWith('product.id', sqlDir);
  });

  it('noma’lum sort_by SQL’ga kirmaydi — sukut ustun', async () => {
    const { service, qb } = setup();
    await service.findAll({ sort_by: 'id; drop table x', sort_dir: 'asc' });
    expect(qb.orderBy).toHaveBeenCalledWith(
      'product.createdAt',
      'ASC',
      undefined,
    );
  });

  it('update: image_url null / "" — NULL yoziladi; berilmasa tegilmaydi', async () => {
    const service: any = Object.create(CatalogServiceService.prototype);
    const apply = (product: Record<string, any>, dto: Record<string, any>) =>
      service.applyProductChanges(product, dto);
    const base = () => ({
      id: '5',
      user_id: '7',
      name: 'Olma',
      image_url: 'https://cdn/x.png',
      length_cm: null,
      width_cm: null,
      height_cm: null,
    });
    const p1 = base();
    await apply(p1, { image_url: null });
    expect(p1.image_url).toBeNull();
    const p2 = base();
    await apply(p2, { image_url: '' });
    expect(p2.image_url).toBeNull();
    const p3 = base();
    await apply(p3, { price: 100 });
    expect(p3.image_url).toBe('https://cdn/x.png');
  });
});
