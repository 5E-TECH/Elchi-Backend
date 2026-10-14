import { Logger } from '@nestjs/common';
import { RpcException } from '@nestjs/microservices';
import { of } from 'rxjs';
import { NotificationInboxService } from '../notification-inbox.service';
import {
  ALL_CUSTOMERS_CONFIRM_HINT,
  CUSTOMER_TARGETING_HINT,
  SEGMENT_WITHOUT_CUSTOMERS_HINT,
} from './audience-request';

const rmqSendMock = jest.fn();
jest.mock('@app/common', () => {
  const actual = jest.requireActual('@app/common');
  return {
    ...actual,
    rmqSend: (...args: unknown[]): unknown => rmqSendMock(...args),
  };
});

/**
 * (W8aerwL6) Dispatch auditoriyasi: mijoz va superadmin nishonlanadi,
 * mijoz qoidalari (TC6/TC7), chegara (TC10), identity xatosi yutilmaydi.
 */
describe('W8aerwL6 — dispatch auditoriyasi (identity.audience.resolve)', () => {
  let service: NotificationInboxService;
  let txRepo: any;
  let store: Map<string, any>;

  const valuesOf = (operator: any): string[] =>
    (operator?.value ?? operator ?? []).map(String);

  const audiencePage = (
    ids: string[],
    role: string,
    next: string | null = null,
  ) => ({
    statusCode: 200,
    data: {
      items: ids.map((id) => ({ id, role, language: 'uz', phone_valid: true })),
      total: null,
      next_after_id: next,
    },
  });

  const errorOf = async (promise: Promise<unknown>) => {
    try {
      await promise;
    } catch (error) {
      if (error instanceof RpcException) return error.getError() as any;
      throw error;
    }
    throw new Error('expected RpcException');
  };

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    rmqSendMock.mockReset();
    store = new Map();
    let nextId = 1000;
    txRepo = {
      create: jest.fn((v) => ({ ...v })),
      insert: jest.fn((rows: any[]) =>
        Promise.resolve({
          identifiers: rows.map((row) => {
            const id = String(nextId++);
            store.set(id, { id, ...row });
            return { id };
          }),
        }),
      ),
      update: jest.fn(),
      find: jest.fn(({ where }: any) => {
        const ids = valuesOf(where.id);
        return Promise.resolve(
          [...store.values()].filter((row) => ids.includes(String(row.id))),
        );
      }),
    };
    const manager = { getRepository: jest.fn(() => txRepo) };
    const repo: any = {
      createQueryBuilder: jest.fn(() => {
        const qb: any = {
          update: jest.fn(() => qb),
          set: jest.fn(() => qb),
          setParameter: jest.fn(() => qb),
          whereInIds: jest.fn(() => qb),
          execute: jest.fn().mockResolvedValue({ affected: 1 }),
        };
        return qb;
      }),
      manager: {
        transaction: jest.fn((work: (m: any) => Promise<unknown>) =>
          work(manager),
        ),
      },
    };
    service = new NotificationInboxService(
      repo,
      { send: jest.fn() } as never,
      { emit: jest.fn(() => of(null)) } as never,
      { sendNotification: jest.fn() } as never,
      { log: jest.fn().mockResolvedValue(undefined) } as never,
      { enqueue: jest.fn() } as never,
      { assertFanout: jest.fn(), queueForNotifications: jest.fn() } as never,
    );
  });

  it('TC7: roles:[customer] bayroqsiz — 400, matn nima qilishni aytadi; identity chaqirilmaydi', async () => {
    const err = await errorOf(
      service.dispatch({
        roles: ['customer'],
        type: 'marketing.manual',
        title: 'Promo',
      } as any),
    );
    expect(err.statusCode).toBe(400);
    expect(err.message).toBe(CUSTOMER_TARGETING_HINT);
    expect(err.message).toContain('include_customers: true');
    expect(err.message).not.toContain('No recipients resolved');
    expect(rmqSendMock).not.toHaveBeenCalled();
    expect(txRepo.insert).not.toHaveBeenCalled();
  });

  it('TC6: segmentsiz include_customers:true tasdiqsiz — 400, hech narsa yozilmaydi', async () => {
    const err = await errorOf(
      service.dispatch({
        roles: ['customer'],
        include_customers: true,
        type: 'marketing.manual',
        title: 'Promo',
      } as any),
    );
    expect(err).toEqual(
      expect.objectContaining({
        statusCode: 400,
        message: ALL_CUSTOMERS_CONFIRM_HINT,
      }),
    );
    expect(rmqSendMock).not.toHaveBeenCalled();
    expect(txRepo.insert).not.toHaveBeenCalled();
  });

  it('segment mijozsiz — 400', async () => {
    const err = await errorOf(
      service.dispatch({
        roles: ['courier'],
        segment: { region_id: '3' },
        type: 'system.manual',
        title: 'x',
      } as any),
    );
    expect(err.message).toBe(SEGMENT_WITHOUT_CUSTOMERS_HINT);
  });

  it('TC4/TC5: roles:[customer] + include_customers + segment(hudud) — haqiqiy mijozlar topiladi va yoziladi', async () => {
    rmqSendMock.mockResolvedValueOnce(
      audiencePage(['501', '502', '503'], 'customer'),
    );
    const res: any = await service.dispatch({
      roles: ['customer'],
      include_customers: true,
      segment: { region_id: '5', market_id: '' },
      type: 'marketing.manual',
      title: 'Promo',
    } as any);

    expect(rmqSendMock).toHaveBeenCalledTimes(1);
    const [, pattern, payload] = rmqSendMock.mock.calls[0];
    expect(pattern).toEqual({ cmd: 'identity.audience.resolve' });
    expect(payload).toEqual(
      expect.objectContaining({
        roles: ['customer'],
        include_customers: true,
        segment: { region_id: '5' },
        fields: 'minimal',
        after_id: null,
      }),
    );
    expect(res.data.dispatched).toBe(3);
    const inserted = txRepo.insert.mock.calls[0][0];
    expect(
      inserted.map((r: any) => [r.recipient_id, r.recipient_role]),
    ).toEqual([
      ['501', 'customer'],
      ['502', 'customer'],
      ['503', 'customer'],
    ]);
  });

  it('roles:[superadmin] — superadmin endi nishonlanadi (avval 400 «No recipients resolved»)', async () => {
    rmqSendMock.mockResolvedValueOnce(audiencePage(['1'], 'superadmin'));
    const res: any = await service.dispatch({
      roles: ['superadmin'],
      type: 'system.manual',
      title: 'Xabar',
    } as any);
    expect(res.data.dispatched).toBe(1);
    expect(res.data.recipient_ids).toEqual(['1']);
    // `identity.user.find_all` superadminni chiqarib tashlaydi — u EMAS.
    expect(rmqSendMock.mock.calls[0][1]).toEqual({
      cmd: 'identity.audience.resolve',
    });
  });

  it('TC12: keyset sahifalash — birinchi sahifada to‘xtamaydi (250 mijoz)', async () => {
    const ids = Array.from({ length: 250 }, (_, i) => String(2000 + i));
    rmqSendMock
      .mockResolvedValueOnce(
        audiencePage(ids.slice(0, 100), 'customer', '2099'),
      )
      .mockResolvedValueOnce(
        audiencePage(ids.slice(100, 200), 'customer', '2199'),
      )
      .mockResolvedValueOnce(audiencePage(ids.slice(200), 'customer'));
    const res: any = await service.dispatch({
      include_customers: true,
      segment: { min_orders: 2 },
      type: 'marketing.manual',
      title: 'Promo',
    } as any);
    expect(res.data.dispatched).toBe(250);
    expect(rmqSendMock.mock.calls.map((c) => c[2].after_id)).toEqual([
      null,
      '2099',
      '2199',
    ]);
  });

  it('TC10: chegaradan (5000) oshsa 400 — jimgina kesilmaydi, hech narsa yozilmaydi', async () => {
    for (let page = 0; page < 51; page += 1) {
      const ids = Array.from({ length: 100 }, (_, i) =>
        String(10_000 + page * 100 + i),
      );
      rmqSendMock.mockResolvedValueOnce(
        audiencePage(ids, 'customer', ids[ids.length - 1]),
      );
    }
    const err = await errorOf(
      service.dispatch({
        include_customers: true,
        confirm_all_customers: true,
        type: 'marketing.manual',
        title: 'Promo',
      } as any),
    );
    expect(err.statusCode).toBe(400);
    expect(err.message).toContain('fan-out cap exceeded');
    expect(txRepo.insert).not.toHaveBeenCalled();
  });

  it('identity ishlamasa — 502, yarim auditoriyaga "muvaffaqiyat" yo‘q (avval jim to‘xtardi)', async () => {
    rmqSendMock
      .mockResolvedValueOnce(
        audiencePage(
          Array.from({ length: 100 }, (_, i) => String(300 + i)),
          'courier',
          '399',
        ),
      )
      .mockRejectedValueOnce(new Error('Timeout has occurred'));
    const err = await errorOf(
      service.dispatch({
        roles: ['courier'],
        type: 'system.manual',
        title: 'x',
      } as any),
    );
    expect(err.statusCode).toBe(502);
    expect(txRepo.insert).not.toHaveBeenCalled();
  });

  it('identity 400 (masalan noma’lum rol) — matni bilan qaytadi', async () => {
    rmqSendMock.mockRejectedValueOnce({
      statusCode: 400,
      message: "Noma'lum rol: boss",
    });
    const err = await errorOf(
      service.dispatch({
        roles: ['boss'],
        type: 'system.manual',
        title: 'x',
      } as any),
    );
    expect(err).toEqual({ statusCode: 400, message: "Noma'lum rol: boss" });
  });
});
