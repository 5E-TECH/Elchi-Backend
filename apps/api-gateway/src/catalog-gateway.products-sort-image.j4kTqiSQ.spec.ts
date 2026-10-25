/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument */
import { BadRequestException } from '@nestjs/common';
import { Observable, of } from 'rxjs';
import {
  buildProductListQuery,
  CatalogGatewayController,
  parseProductSort,
  wantsProductImageRemoval,
} from './catalog-gateway.controller';

/**
 * j4kTqiSQ — GET product* `sort_by`/`sort_dir` (whitelist) va PATCH
 * /product/:id da rasmni o'chirish (`image: null`).
 */
type Send = jest.Mock<Observable<unknown>, [{ cmd: string }, unknown]>;

const MARKET = { sub: '121', roles: ['market'] };
const ADMIN = { sub: '1', roles: ['admin'] };

const setup = () => {
  const catalogSend: Send = jest.fn<
    Observable<unknown>,
    [{ cmd: string }, unknown]
  >(() => of({ data: [], total: 0, page: 1, limit: 10 }));
  const controller = new CatalogGatewayController(
    { send: catalogSend } as any,
    { send: jest.fn() } as any,
    { send: jest.fn() } as any,
  );
  return { controller, catalogSend };
};

const sent = (send: Send, cmd: string) =>
  send.mock.calls.find(([p]) => p.cmd === cmd)?.[1] as any;

describe('j4kTqiSQ — sort_by / sort_dir', () => {
  it.each([
    ['name', 'asc'],
    ['created_at', 'desc'],
    ['price', 'asc'],
    ['PRICE', 'DESC'],
  ])('%s %s — qabul qilinadi', (by, dir) => {
    expect(parseProductSort(by, dir)).toEqual({
      sort_by: by.toLowerCase(),
      sort_dir: dir.toLowerCase(),
    });
  });

  it.each([['id'], ['user_id'], ['name; drop table'], ['createdAt']])(
    'ro‘yxatdan tashqari sort_by=%s — 400',
    (by) => {
      expect(() => parseProductSort(by)).toThrow(BadRequestException);
    },
  );

  it('noto‘g‘ri sort_dir — 400; berilmasa — bo‘sh (eski tartib)', () => {
    expect(() => parseProductSort('name', 'up')).toThrow(BadRequestException);
    expect(parseProductSort()).toEqual({});
    expect(buildProductListQuery('7', undefined, '1', '10')).toEqual({
      user_id: '7',
      search: undefined,
      page: 1,
      limit: 10,
    });
  });

  it('GET /product, /product/market/:id, /product/my-products — catalog so‘roviga uzatiladi', async () => {
    const a = setup();
    a.controller.findAll(
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { user: ADMIN } as any,
      'price',
      'asc',
    );
    expect(sent(a.catalogSend, 'catalog.product.find_all').query).toMatchObject(
      { sort_by: 'price', sort_dir: 'asc' },
    );

    const b = setup();
    b.controller.getByMarketId('7', undefined, undefined, undefined, 'name');
    expect(sent(b.catalogSend, 'catalog.product.find_all').query).toMatchObject(
      { user_id: '7', sort_by: 'name' },
    );

    const c = setup();
    await c.controller.getMyProducts(
      { user: MARKET } as any,
      undefined,
      undefined,
      undefined,
      'created_at',
      'asc',
    );
    expect(sent(c.catalogSend, 'catalog.product.find_all').query).toMatchObject(
      { user_id: '121', sort_by: 'created_at', sort_dir: 'asc' },
    );
  });

  it('my-products: noto‘g‘ri sort_by — 400, catalog chaqirilmaydi', async () => {
    const { controller, catalogSend } = setup();
    await expect(
      controller.getMyProducts({ user: MARKET } as any, '', '', '', 'x'),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(catalogSend).not.toHaveBeenCalled();
  });
});

describe('j4kTqiSQ — PATCH /product/:id rasmni o‘chirish', () => {
  it.each([
    [{ image: null }],
    [{ image: 'null' }],
    [{ image_url: null }],
    [{ image_url: '' }],
    [{ remove_image: true }],
    [{ remove_image: 'true' }],
    [{ remove_image: '1' }],
  ])('%j — o‘chirish so‘rovi', (dto) => {
    expect(wantsProductImageRemoval(dto)).toBe(true);
  });

  it.each([
    [{}],
    [{ name: 'X' }],
    [{ remove_image: 'false' }],
    [{ image: '' }],
  ])('%j — rasmga tegilmaydi', (dto: Record<string, unknown>) => {
    expect(wantsProductImageRemoval(dto)).toBe(false);
  });

  it('image: null — catalog’ga image_url: null ketadi, image/remove_image uzatilmaydi', async () => {
    const { controller, catalogSend } = setup();
    controller.update(
      '55',
      undefined,
      { image: null, name: 'Olma' } as any,
      { user: ADMIN } as any,
    );
    await Promise.resolve();
    const payload = sent(catalogSend, 'catalog.product.update');
    expect(payload).toEqual({
      id: '55',
      dto: { name: 'Olma', image_url: null },
    });
  });

  it('multipart remove_image=true — image_url: null', async () => {
    const { controller, catalogSend } = setup();
    controller.update(
      '55',
      undefined,
      { remove_image: 'true' } as any,
      { user: ADMIN } as any,
    );
    await Promise.resolve();
    expect(sent(catalogSend, 'catalog.product.update').dto).toEqual({
      image_url: null,
    });
  });

  it('rasm maydonlarisiz — image_url uzatilmaydi (eski xulq)', async () => {
    const { controller, catalogSend } = setup();
    controller.update(
      '55',
      undefined,
      { name: 'Olma' } as any,
      {
        user: ADMIN,
      } as any,
    );
    await Promise.resolve();
    expect(sent(catalogSend, 'catalog.product.update').dto.image_url).toBe(
      undefined,
    );
  });
});
