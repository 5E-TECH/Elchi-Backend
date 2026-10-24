import 'reflect-metadata';
import { RequestMethod } from '@nestjs/common';
import {
  METHOD_METADATA,
  PATH_METADATA,
  ROUTE_ARGS_METADATA,
} from '@nestjs/common/constants';
import type { ClientProxy } from '@nestjs/microservices';
import { of } from 'rxjs';
import { ROLES_KEY } from './auth/roles.decorator';
import { RolesGuard } from './auth/roles.guard';
import { LogisticsGatewayController } from './logistics-gateway.controller';
import { ParseBigintIdPipe } from './pipes/parse-bigint-id.pipe';

/**
 * Is1zvHN7 — `GET /district/:id/usage` → `{ orders, users, branches }`
 * (ADMIN, SUPERADMIN). Sanoq logistics'da (`logistics.district.usage`).
 */
describe('GET district/:id/usage (Is1zvHN7)', () => {
  const handler = Object.getOwnPropertyDescriptor(
    LogisticsGatewayController.prototype,
    'getDistrictUsage',
  )?.value as object;

  it('marshrut: GET district/:id/usage', () => {
    expect(Reflect.getMetadata(PATH_METADATA, handler)).toBe(
      'district/:id/usage',
    );
    expect(Reflect.getMetadata(METHOD_METADATA, handler)).toBe(
      RequestMethod.GET,
    );
  });

  it('faqat admin va superadmin (manager/registrator/market/kuryer yo‘q)', () => {
    expect(Reflect.getMetadata('__guards__', handler)).toContain(RolesGuard);
    const roles = Reflect.getMetadata(ROLES_KEY, handler) as string[];
    expect([...roles].sort()).toEqual(['admin', 'superadmin']);
  });

  it('id ParseBigintIdPipe bilan tekshiriladi (harf → 400, 500 emas)', () => {
    const args = Reflect.getMetadata(
      ROUTE_ARGS_METADATA,
      LogisticsGatewayController,
      'getDistrictUsage',
    ) as Record<string, { data?: string; pipes?: unknown[] }>;
    const idArg = Object.values(args).find((a) => a.data === 'id');
    expect(idArg?.pipes).toContain(ParseBigintIdPipe);
    expect(() => new ParseBigintIdPipe().transform('abc')).toThrow();
  });

  it('logistics.district.usage ga id uzatiladi, javob o‘zgarmay qaytadi', async () => {
    const payload = {
      statusCode: 200,
      data: { orders: 5, users: 2, branches: 0 },
    };
    const logisticsClient = { send: jest.fn(() => of(payload)) };
    const controller = new LogisticsGatewayController(
      logisticsClient as unknown as ClientProxy,
      { send: jest.fn() } as unknown as ClientProxy,
    );

    const res = await new Promise((resolve, reject) =>
      controller.getDistrictUsage('173').subscribe({
        next: resolve,
        error: reject,
      }),
    );

    expect(logisticsClient.send).toHaveBeenCalledWith(
      { cmd: 'logistics.district.usage' },
      { id: '173' },
    );
    expect(res).toEqual(payload);
  });
});
