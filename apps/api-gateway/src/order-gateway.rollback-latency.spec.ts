/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return */
import { GatewayTimeoutException } from '@nestjs/common';
import { NEVER, Observable, of, throwError } from 'rxjs';
import {
  isNoMessageHandlerError,
  OrderGatewayController,
  ROLLBACK_FIELD_TIMEOUT_MS,
} from './order-gateway.controller';

/**
 * Buyurtma ro'yxati / tafsilotining kechikishi:
 *  - `order.rollback_eligibility` javobni 1.5 s gacha ushlab turardi → endi
 *    `problem_contacts` bilan PARALLEL va 300 ms dan keyin `rollback: null`;
 *  - `sendOrderWithFallback` HAR QANDAY xatoda (400/403 ham) oddiy pattern'ga
 *    qayta yuborardi → endi faqat «handler topilmadi» holatida.
 */

const NO_HANDLER =
  'There is no matching message handler defined in the remote service.';
const SUPERADMIN = { sub: '1', username: 'sa', roles: ['superadmin'] };
const ROW = { id: '501', market_id: '9', status: 'new' };

type Handler = (data: any) => Observable<unknown>;

function makeController(
  handlers: Record<string, Handler>,
  problemContacts?: { attach: (payload: unknown) => Promise<unknown> },
) {
  const orderClient = {
    send: jest.fn((pattern: { cmd: string }, data: unknown) => {
      const handler = handlers[pattern.cmd];
      return handler ? handler(data) : throwError(() => NO_HANDLER);
    }),
  };
  const none = { send: jest.fn(() => NEVER) };
  const controller = new OrderGatewayController(
    orderClient as any,
    none as any,
    none as any,
    none as any,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    problemContacts as any,
  );
  const cmds = () => orderClient.send.mock.calls.map((call) => call[0].cmd);
  return { controller, orderClient, cmds };
}

const findById = (controller: OrderGatewayController, user = SUPERADMIN) =>
  controller.findById(ROW.id, { user });

describe('isNoMessageHandlerError', () => {
  it('Nest RMQ «handler yo‘q» satri va shu matnli Error — true', () => {
    expect(isNoMessageHandlerError(NO_HANDLER)).toBe(true);
    expect(
      isNoMessageHandlerError(
        new Error('There is no matching message handler'),
      ),
    ).toBe(true);
  });

  it('biznes xatolari, timeout va bo‘sh qiymat — false', () => {
    expect(
      isNoMessageHandlerError({ statusCode: 400, message: 'Noto‘g‘ri so‘rov' }),
    ).toBe(false);
    expect(isNoMessageHandlerError({ statusCode: 403 })).toBe(false);
    expect(isNoMessageHandlerError(new GatewayTimeoutException())).toBe(false);
    expect(isNoMessageHandlerError(null)).toBe(false);
    expect(isNoMessageHandlerError(undefined)).toBe(false);
  });
});

describe('sendOrderWithFallback — faqat pattern topilmaganda', () => {
  it.each([
    ['400', { statusCode: 400, message: 'Noto‘g‘ri id' }],
    ['403', { statusCode: 403, message: 'Ruxsat yo‘q' }],
    ['500', { status: 'error', message: 'Internal server error' }],
  ])(
    '%s xato — o‘zi qaytadi, find_by_id ga QAYTA YUBORILMAYDI',
    async (_label, remote) => {
      const { controller, cmds } = makeController({
        'order.find_by_id_enriched': () => throwError(() => remote),
        'order.find_by_id': () => of({ statusCode: 200, data: ROW }),
      });
      await expect(findById(controller)).rejects.toBe(remote);
      expect(cmds()).toEqual(['order.find_by_id_enriched']);
    },
  );

  it('enriched pattern yo‘q (eski order-service) — oddiy pattern ishlatiladi', async () => {
    const { controller, cmds } = makeController({
      'order.find_by_id': () => of({ statusCode: 200, data: ROW }),
      'order.rollback_eligibility': () =>
        of({ data: { items: [{ order_id: ROW.id, allowed: true }] } }),
    });
    const res = await findById(controller);
    expect(cmds().slice(0, 2)).toEqual([
      'order.find_by_id_enriched',
      'order.find_by_id',
    ]);
    expect(res.data).toMatchObject({ id: ROW.id, rollback: { allowed: true } });
  });

  it('timeout — 504, oddiy pattern’ga o‘tmaydi', async () => {
    jest.useFakeTimers();
    try {
      const { controller, cmds } = makeController({
        'order.find_by_id_enriched': () => NEVER,
        'order.find_by_id': () => of({ statusCode: 200, data: ROW }),
      });
      const pending = findById(controller);
      const assertion = expect(pending).rejects.toBeInstanceOf(
        GatewayTimeoutException,
      );
      await jest.advanceTimersByTimeAsync(8_001);
      await assertion;
      expect(cmds()).toEqual(['order.find_by_id_enriched']);
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('rollback maydoni — parallel va qisqa timeout', () => {
  it('timeout ~300 ms', () => {
    expect(ROLLBACK_FIELD_TIMEOUT_MS).toBe(300);
  });

  it('eligibility javob bermasa — javob 300 ms da, `rollback: null`', async () => {
    jest.useFakeTimers();
    try {
      const { controller } = makeController({
        'order.find_by_id_enriched': () => of({ statusCode: 200, data: ROW }),
        'order.rollback_eligibility': () => NEVER,
      });
      let settled: any;
      const pending = findById(controller).then((res) => (settled = res));

      await jest.advanceTimersByTimeAsync(ROLLBACK_FIELD_TIMEOUT_MS - 1);
      expect(settled).toBeUndefined();
      await jest.advanceTimersByTimeAsync(2);
      await pending;
      expect(settled.data).toMatchObject({ id: ROW.id, rollback: null });
    } finally {
      jest.useRealTimers();
    }
  });

  it('eligibility so‘rovi problem_contacts tugashini KUTMAYDI (parallel)', async () => {
    let releaseContacts!: () => void;
    const contactsGate = new Promise<void>((resolve) => {
      releaseContacts = resolve;
    });
    const problemContacts = {
      attach: jest.fn(async (payload: any) => {
        await contactsGate;
        payload.data.problem_contacts = [{ phone: '+998900000000' }];
        return payload;
      }),
    };
    const { controller, cmds } = makeController(
      {
        'order.find_by_id_enriched': () =>
          of({ statusCode: 200, data: { ...ROW } }),
        'order.rollback_eligibility': () =>
          of({
            data: {
              items: [{ order_id: ROW.id, allowed: false, code: 'X' }],
            },
          }),
      },
      problemContacts,
    );

    const pending = findById(controller);
    // Kontaktlar hali tugamagan — eligibility allaqachon yuborilgan.
    await new Promise((resolve) => setImmediate(resolve));
    expect(problemContacts.attach).toHaveBeenCalledTimes(1);
    expect(cmds()).toContain('order.rollback_eligibility');

    releaseContacts();
    const res = await pending;
    expect(res.data).toMatchObject({
      id: ROW.id,
      problem_contacts: [{ phone: '+998900000000' }],
      rollback: { allowed: false, code: 'X' },
    });
  });

  it('rollback qila olmaydigan rol — RPC yo‘q, NOT_ALLOWED_ROLE', async () => {
    const { controller, cmds } = makeController({
      'order.find_by_id_enriched': () => of({ statusCode: 200, data: ROW }),
    });
    const res = await findById(controller, {
      sub: '9',
      username: 'm',
      roles: ['market'],
    });
    expect(cmds()).toEqual(['order.find_by_id_enriched']);
    expect(res.data.rollback).toMatchObject({ allowed: false });
  });
});
