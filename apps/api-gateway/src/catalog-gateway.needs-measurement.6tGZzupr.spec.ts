/// <reference types="jest" />
import { BadRequestException } from '@nestjs/common';
import { of } from 'rxjs';
import { Reflector } from '@nestjs/core';
import {
  buildProductListQuery,
  CatalogGatewayController,
  PRODUCT_WRITE_ROLES,
} from './catalog-gateway.controller';
import { Roles as RoleEnum } from '@app/common';

/**
 * 6tGZzupr — gateway: registrator ro'yxatidagi «o'lchov kutilmoqda» filtri
 * (`GET /product?needs_measurement=true`) va `catalog.product.create` ga
 * requester uzatish.
 */

const makeCatalog = () => {
  const catalogClient = { send: jest.fn(() => of({ data: [], total: 0 })) };
  const controller = new CatalogGatewayController(
    catalogClient as never,
    { send: jest.fn() } as never,
    { send: jest.fn() } as never,
  );
  return { controller, catalogClient };
};

describe('6tGZzupr — catalog gateway', () => {
  it.each<[string | undefined, boolean | undefined]>([
    ['true', true],
    ['1', true],
    ['false', false],
    ['0', false],
    [undefined, undefined],
    ['', undefined],
  ])('buildProductListQuery needs_measurement=%s', (raw, expected) => {
    const query = buildProductListQuery(
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      raw,
    );

    if (expected === undefined) {
      expect(query).not.toHaveProperty('needs_measurement');
    } else {
      expect(query.needs_measurement).toBe(expected);
    }
  });

  it('noto`g`ri qiymat — 400', () => {
    expect(() =>
      buildProductListQuery(
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        'ha',
      ),
    ).toThrow(BadRequestException);
  });

  it('GET /product filtrni catalog`ga uzatadi (registrator)', () => {
    const { controller, catalogClient } = makeCatalog();

    controller.findAll(
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { user: { sub: '12', roles: [RoleEnum.REGISTRATOR] } },
      undefined,
      undefined,
      'true',
    );

    expect(catalogClient.send).toHaveBeenCalledWith(
      { cmd: 'catalog.product.find_all' },
      {
        query: expect.objectContaining({ needs_measurement: true }),
      },
    );
  });

  it('POST /product requester bilan: xodim id va rollari', async () => {
    const { controller, catalogClient } = makeCatalog();

    await controller.create(
      undefined,
      {
        name: 'Qalam',
        market_id: '55',
        weight_kg: 1,
        length_cm: 1,
        width_cm: 1,
        height_cm: 1,
      },
      { user: { sub: '12', roles: [RoleEnum.REGISTRATOR] } },
    );

    expect(catalogClient.send).toHaveBeenCalledWith(
      { cmd: 'catalog.product.create' },
      expect.objectContaining({
        requester: { id: '12', roles: [RoleEnum.REGISTRATOR] },
      }),
    );
  });

  it('registrator GET /product ga kira oladi va yaratish rollari o`zgarmagan', () => {
    const roles = new Reflector().get<string[]>(
      'roles',
      // eslint-disable-next-line @typescript-eslint/unbound-method
      CatalogGatewayController.prototype.findAll,
    );

    expect(roles).toContain(RoleEnum.REGISTRATOR);
    expect(PRODUCT_WRITE_ROLES).toEqual([
      RoleEnum.SUPERADMIN,
      RoleEnum.ADMIN,
      RoleEnum.REGISTRATOR,
      RoleEnum.MANAGER,
    ]);
  });
});
