import 'reflect-metadata';
import { NEVER, TimeoutError } from 'rxjs';
import { BranchGatewayController } from './branch-gateway.controller';
import { LogisticsGatewayController } from './logistics-gateway.controller';

/**
 * Tuman ko'chirilganda logistics avval tumanning ochiq buyurtmalarini
 * order-service'dan sahifalab o'qiydi (eski filialda/kuryerda turganlarga
 * imtiyoz), keyin ko'chiradi va yana bir marta o'qiydi. Shuning uchun
 * PATCH /district/:id (rehome'siz ham) va PUT /branches/:id/districts — 30 s:
 * eski 8 s / 15 s da katta tumanda mijoz 504 olardi, ko'chirish esa orqada
 * baribir yakunlanardi.
 */
describe('Tuman ko`chirish marshrutlari — timeout 30 s', () => {
  const req = { user: { sub: '1', roles: ['superadmin'] } };

  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it.each([
    [{ assigned_region: '7' }],
    [{ assigned_region: '7', rehome_open_orders: true }],
  ])(
    'PATCH district/:id %j — 29 999 ms da hali kutadi, 30 000 ms da TimeoutError',
    (dto) => {
      const logisticsClient = { send: jest.fn(() => NEVER) };
      const controller = new LogisticsGatewayController(
        logisticsClient as never,
        { send: jest.fn(() => NEVER) } as never,
      );
      let error: unknown;
      const subscription = controller.update('12', dto, req).subscribe({
        error: (e: unknown) => {
          error = e;
        },
      });

      jest.advanceTimersByTime(29_999);
      expect(error).toBeUndefined();
      jest.advanceTimersByTime(1);
      expect(error).toBeInstanceOf(TimeoutError);
      subscription.unsubscribe();
    },
  );

  it('PUT branches/:id/districts — 29 999 ms da hali kutadi, 30 000 ms da TimeoutError', async () => {
    const logisticsClient = { send: jest.fn(() => NEVER) };
    const controller = new BranchGatewayController(
      { send: jest.fn(() => NEVER) } as never,
      undefined,
      undefined,
      logisticsClient as never,
    );
    let settled: unknown = 'pending';
    const pending = controller
      .setBranchDistricts('15', { district_ids: ['7'] }, req)
      .then(
        () => {
          settled = 'resolved';
        },
        (e: unknown) => {
          settled = e;
        },
      );

    await jest.advanceTimersByTimeAsync(29_999);
    expect(settled).toBe('pending');
    await jest.advanceTimersByTimeAsync(1);
    await pending;
    expect(settled).toBeInstanceOf(TimeoutError);
    expect(logisticsClient.send).toHaveBeenCalledWith(
      { cmd: 'logistics.district.set_serving_branch' },
      expect.objectContaining({ branch_id: '15', district_ids: ['7'] }),
    );
  });
});
