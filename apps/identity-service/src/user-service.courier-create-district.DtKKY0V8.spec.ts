import { RpcException } from '@nestjs/microservices';
import { of, throwError } from 'rxjs';
import { RequesterContext } from './contracts/user.payloads';
import { UserServiceService } from './user-service.service';

/**
 * DtKKY0V8 — POST /couriers `district_id`: PATCH /users/:id (YEThmZBn) dagi
 * qoida — tuman mavjud va kuryer viloyatiga tegishli (viloyatsiz HQ kuryeri —
 * faqat mavjudligi). Noto'g'ri tuman — 400, logistika javob bermasa — 503;
 * ikkalasida ham kuryer YOZILMAYDI (tekshiruv user yaratilishidan oldin).
 */
type Row = Record<string, unknown>;
type DistrictReply = () => unknown;

function makeService(district: DistrictReply = () => ({ data: null })) {
  const saves: Row[] = [];
  const repo = {
    findOne: jest.fn(() => Promise.resolve(null)),
    create: jest.fn((value: Row) => ({ ...value })),
    save: jest.fn((value: Row) => {
      saves.push({ ...value });
      return Promise.resolve({ ...value, id: '700' });
    }),
  };
  const logisticsClient = {
    send: jest.fn(({ cmd }: { cmd: string }) => {
      if (cmd === 'logistics.district.find_by_id') {
        try {
          return of(district());
        } catch (error: unknown) {
          return throwError(() => error);
        }
      }
      return of({ data: { id: '3', name: 'Andijon' } });
    }),
  };
  const ok = { send: jest.fn(() => of({ statusCode: 201 })), emit: jest.fn() };
  const service = new UserServiceService(
    repo as never,
    ok as never, // search
    ok as never, // catalog
    ok as never, // order
    logisticsClient as never, // logistics
    ok as never, // finance
    ok as never, // branch
    {
      encrypt: jest.fn().mockResolvedValue('hashed'),
      compare: jest.fn(),
    } as never,
    { get: jest.fn() } as never,
    {
      log: jest.fn().mockResolvedValue(undefined),
      logChange: jest.fn().mockResolvedValue(undefined),
    } as never,
  );
  return { service, saves, logisticsClient };
}

const superadmin: RequesterContext = { id: '1', roles: ['superadmin'] };

const courierDto = (over: Row = {}) =>
  ({
    name: 'TEST Kuryer',
    phone_number: '+998903001299',
    password: '0990',
    tariff_home: 15000,
    tariff_center: 10000,
    region_id: '3',
    branch_id: '15',
    ...over,
  }) as never;

const districtCalls = (client: { send: jest.Mock }): unknown[] =>
  (client.send.mock.calls as Array<[{ cmd: string }, unknown]>).filter(
    ([pattern]) => pattern.cmd === 'logistics.district.find_by_id',
  );

async function rpcErrorOf(promise: Promise<unknown>) {
  const error: unknown = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(RpcException);
  return (error as RpcException).getError() as {
    statusCode?: number;
    message?: string;
  };
}

describe('DtKKY0V8 — POST /couriers district_id', () => {
  it('⭐ viloyatdagi mavjud tuman — kuryer shu tuman bilan yaratiladi', async () => {
    const { service, saves, logisticsClient } = makeService(() => ({
      data: { id: '41', name: 'Asaka', region_id: '3' },
    }));

    const res = (await service.createCourier(
      courierDto({ district_id: '41' }),
      superadmin,
    )) as { statusCode: number; data: Row };

    expect(res.statusCode).toBe(201);
    expect(saves[0]).toMatchObject({ district_id: '41', region_id: '3' });
    expect(res.data.district_id).toBe('41');
    expect(districtCalls(logisticsClient)).toEqual([
      [{ cmd: 'logistics.district.find_by_id' }, { id: '41' }],
    ]);
  });

  it.each([
    ['berilmagan', {}],
    ['null', { district_id: null }],
    ['bo`sh satr', { district_id: '' }],
  ])('%s — tumansiz (null), logistika tumani so`ralmaydi', async (_l, over) => {
    const { service, saves, logisticsClient } = makeService();

    await service.createCourier(courierDto(over), superadmin);

    expect(saves[0]).toHaveProperty('district_id', null);
    expect(districtCalls(logisticsClient)).toHaveLength(0);
  });

  it('boshqa viloyat tumani — 400, kuryer yozilmaydi', async () => {
    const { service, saves } = makeService(() => ({
      data: { id: '77', name: 'Chilonzor', region_id: '1' },
    }));

    const err = await rpcErrorOf(
      service.createCourier(courierDto({ district_id: '77' }), superadmin),
    );

    expect(err).toMatchObject({
      statusCode: 400,
      message: 'Tuman foydalanuvchining viloyatiga tegishli emas',
    });
    expect(saves).toHaveLength(0);
  });

  it('tuman topilmadi — 400, kuryer yozilmaydi', async () => {
    const { service, saves } = makeService(() => ({ data: null }));

    const err = await rpcErrorOf(
      service.createCourier(courierDto({ district_id: '999' }), superadmin),
    );

    expect(err).toMatchObject({ statusCode: 400, message: 'Tuman topilmadi' });
    expect(saves).toHaveLength(0);
  });

  it('raqamli bo`lmagan district_id (RMQ`da ValidationPipe yo`q) — 400', async () => {
    const { service, saves, logisticsClient } = makeService();

    const err = await rpcErrorOf(
      service.createCourier(courierDto({ district_id: 'abc' }), superadmin),
    );

    expect(err.statusCode).toBe(400);
    expect(districtCalls(logisticsClient)).toHaveLength(0);
    expect(saves).toHaveLength(0);
  });

  it('logistika javob bermasa — 503, kuryer yozilmaydi', async () => {
    const { service, saves } = makeService(() => {
      throw new Error('timeout');
    });

    const err = await rpcErrorOf(
      service.createCourier(courierDto({ district_id: '41' }), superadmin),
    );

    expect(err.statusCode).toBe(503);
    expect(saves).toHaveLength(0);
  });

  it('viloyatsiz (HQ) kuryer — faqat tuman mavjudligi tekshiriladi', async () => {
    const { service, saves } = makeService(() => ({
      data: { id: '77', name: 'Chilonzor', region_id: '1' },
    }));

    await service.createCourier(
      courierDto({ region_id: undefined, district_id: '77' }),
      superadmin,
    );

    expect(saves[0]).toHaveProperty('district_id', '77');
  });

  it('ruxsatsiz rol (registrator) — 403, tuman tekshirilmaydi', async () => {
    const { service, saves, logisticsClient } = makeService(() => ({
      data: { id: '41', region_id: '3' },
    }));

    const err = await rpcErrorOf(
      service.createCourier(courierDto({ district_id: '41' }), {
        id: '9',
        roles: ['registrator'],
      }),
    );

    expect(err.statusCode).toBe(403);
    expect(districtCalls(logisticsClient)).toHaveLength(0);
    expect(saves).toHaveLength(0);
  });
});
