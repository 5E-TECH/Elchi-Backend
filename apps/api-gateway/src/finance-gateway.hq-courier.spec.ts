import 'reflect-metadata';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { isObservable, of, throwError, TimeoutError } from 'rxjs';
import request from 'supertest';

jest.mock('@app/common', () => ({
  Cashbox_type: {
    BRANCH: 'branch',
    FOR_COURIER: 'couriers',
    FOR_MARKET: 'markets',
    MAIN: 'main',
  },
  FinancialSource_type: { MANUAL_EXPENSE: 'manual_expense' },
  Operation_type: { EXPENSE: 'expense', INCOME: 'income' },
  Order_status: { PAID: 'paid', PARTLY_PAID: 'partly_paid', SOLD: 'sold' },
  PaymentMethod: {
    CASH: 'cash',
    CLICK: 'click',
    CLICK_TO_MARKET: 'click_to_market',
  },
  Roles: {
    SUPERADMIN: 'superadmin',
    ADMIN: 'admin',
    REGISTRATOR: 'registrator',
    COURIER: 'courier',
    MARKET: 'market',
    MANAGER: 'manager',
  },
  Source_type: {
    BRANCH_TO_MAIN: 'branch_to_main',
    COURIER_PAYMENT: 'courier_payment',
    MARKET_PAYMENT: 'market_payment',
  },
  Where_deliver: { CENTER: 'center' },
}));

import { FinanceGatewayController } from './finance-gateway.controller';
import { ROLES_KEY } from './auth/roles.decorator';
import { JwtAuthGuard } from './auth/jwt-auth.guard';
import { RolesGuard } from './auth/roles.guard';

/**
 * HQ kuryeri puli (C1–C4): superadmin/admin HQ kuryerlarining naqdini
 * to'g'ridan-to'g'ri Asosiy kassaga oladi, filial kuryerinikini — HECH QACHON
 * (u pul kuryer → filial menejeri → HQ yo'lidan keladi).
 *
 * Mock'lar `cmd` bo'yicha javob beradi; ro'yxatda yo'q `cmd` kelsa test
 * darhol yiqiladi (kutilmagan RPC chaqiruvi ham xato hisoblanadi).
 */

type Handler = (payload: any) => unknown;
type Client = { send: jest.Mock };

const HQ = '1';
const BRANCH_COURIER_MESSAGE =
  'Bu kuryer filialga tegishli — pulni filial menejeri qabul qiladi (kuryer → filial → HQ)';
const UNAVAILABLE_MESSAGE =
  "Tekshiruv xizmati javob bermadi, keyinroq urinib ko'ring";

function route(client: Client, handlers: Record<string, Handler>) {
  client.send.mockImplementation((pattern: { cmd: string }, payload: any) => {
    const handler = handlers[pattern.cmd];
    if (!handler) {
      return throwError(
        () =>
          new Error(
            `kutilmagan RPC: ${pattern.cmd} ${JSON.stringify(payload)}`,
          ),
      );
    }
    const result = handler(payload);
    return isObservable(result) ? result : of(result);
  });
}

const cmdsOf = (client: Client) =>
  client.send.mock.calls.map((call: any[]) => call[0]?.cmd);
const payloadOf = (client: Client, cmd: string) =>
  client.send.mock.calls.find((call: any[]) => call[0]?.cmd === cmd)?.[1];

function setup() {
  const financeClient: Client = { send: jest.fn() };
  const identityClient: Client = { send: jest.fn() };
  const branchClient: Client = { send: jest.fn() };
  const orderClient: Client = { send: jest.fn() };
  const controller = new FinanceGatewayController(
    financeClient as any,
    identityClient as any,
    branchClient as any,
    orderClient as any,
  );
  return {
    controller,
    financeClient,
    identityClient,
    branchClient,
    orderClient,
  };
}

const courierUser = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  name: 'Ali Valiyev',
  phone_number: '+998901112233',
  role: 'courier',
  status: 'active',
  password: 'hash-must-not-leak',
  ...over,
});

const superadmin = { user: { sub: '9', roles: ['superadmin'] } } as any;

/**
 * Identity soft-delete qilingan foydalanuvchiga shunday javob beradi:
 * `RpcException(errorRes('User topilmadi', 404))` gateway'ga oddiy obyekt
 * bo'lib keladi.
 */
const USER_NOT_FOUND = {
  statusCode: 404,
  message: 'User topilmadi',
  data: null,
};
const deletedUser: Handler = () => throwError(() => ({ ...USER_NOT_FOUND }));
/**
 * Superadmin/admin yo'li isbot topilmaganda identity 404 ni `NotFoundException`
 * (o'sha matn) sifatida qaytaradi — HTTP javobi avvalgidek: 404 + matn.
 */
const USER_NOT_FOUND_HTTP = { status: 404, message: 'User topilmadi' };

/** Superadmin → kuryer to'lovi uchun standart muhit (HQ kuryeri 263). */
function receiveEnv(
  over: {
    courierBranchId?: string | null;
    branchRole?: string;
    identity?: Record<string, unknown>;
    findUser?: Handler;
    scope?: Handler;
    findHq?: Handler;
    findByUser?: Handler;
    cashbox?: Handler;
  } = {},
) {
  const env = setup();
  route(env.identityClient, {
    'identity.user.find_by_id':
      over.findUser ??
      ((p) => ({
        data: courierUser(String(p.id), over.identity),
      })),
  });
  route(env.branchClient, {
    'branch.find_hq': over.findHq ?? (() => ({ data: { id: HQ, type: 'HQ' } })),
    'branch.user.find_by_user':
      over.findByUser ??
      ((p) => ({
        data:
          over.courierBranchId === null
            ? null
            : {
                id: `bu-${p.user_id}`,
                branch_id: over.courierBranchId ?? HQ,
                user_id: String(p.user_id),
                role: over.branchRole ?? 'COURIER',
                isDeleted: false,
                branch: { id: over.courierBranchId ?? HQ },
              },
      })),
  });
  route(env.orderClient, {
    'order.settlement.courier_scope':
      over.scope ??
      (() => ({
        data: {
          hq_pending_count: 2,
          hq_pending_amount: 250000,
          branch_pending_count: 0,
          branch_pending_amount: 0,
          branch_ids: [],
          carry_amount: 0,
        },
      })),
  });
  route(env.financeClient, {
    'finance.cashbox.find_by_user':
      over.cashbox ??
      ((p) => ({
        statusCode: 200,
        data: {
          id: `cb-${p.user_id}`,
          user_id: String(p.user_id),
          cashbox_type: p.cashbox_type,
          balance: 250000,
        },
      })),
    'finance.cashbox.payment_courier': () => ({
      statusCode: 200,
      data: { ok: true },
    }),
  });
  return env;
}

const dto = (over: Record<string, unknown> = {}) =>
  ({
    courier_id: '263',
    amount: 250000,
    payment_method: 'cash',
    ...over,
  }) as any;

describe('C4 — POST cashbox/payment/courier (superadmin/admin)', () => {
  it.each(['superadmin', 'admin'])(
    '%s + HQ kuryeri → MAIN ga (receiver_user_id YUBORILMAYDI)',
    async (role) => {
      const env = receiveEnv();
      const req = { user: { sub: '9', roles: [role] } } as any;

      await env.controller.paymentFromCourier(req, dto(), 'idem-1');

      const payload = payloadOf(
        env.financeClient,
        'finance.cashbox.payment_courier',
      );
      expect(payload).toEqual(
        expect.objectContaining({
          courier_id: '263',
          amount: 250000,
          payment_method: 'cash',
          created_by: '9',
          dedup_epoch: 'idem-1',
        }),
      );
      expect(payload).not.toHaveProperty('receiver_user_id');
      expect(payload).not.toHaveProperty('receiver_cashbox_type');
      expect(
        payloadOf(env.orderClient, 'order.settlement.courier_scope'),
      ).toEqual({
        courier_id: '263',
      });
      // Filial SA so'rovchi nomidan o'qiladi (branch-service'da privileged).
      expect(payloadOf(env.branchClient, 'branch.user.find_by_user')).toEqual(
        expect.objectContaining({
          user_id: '263',
          requester: expect.objectContaining({ roles: [role] }),
        }),
      );
      // Tirik kuryer: kassa mavjudligi alohida so'ralmaydi (bu faqat
      // o'chirilgan kuryer uchun isbot).
      expect(cmdsOf(env.financeClient)).toEqual([
        'finance.cashbox.payment_courier',
      ]);
    },
  );

  it('filial kuryeri (filial 15) → 403, finance ham, ledger ham chaqirilmaydi', async () => {
    const env = receiveEnv({ courierBranchId: '15' });

    await expect(
      env.controller.paymentFromCourier(superadmin, dto()),
    ).rejects.toMatchObject({
      status: 403,
      message: BRANCH_COURIER_MESSAGE,
    });
    expect(env.financeClient.send).not.toHaveBeenCalled();
    expect(env.orderClient.send).not.toHaveBeenCalled();
  });

  it('filialga biriktirilmagan kuryer → 403 (HQ deb taxmin qilinmaydi)', async () => {
    const env = receiveEnv({ courierBranchId: null });

    await expect(
      env.controller.paymentFromCourier(superadmin, dto()),
    ).rejects.toMatchObject({ status: 403, message: BRANCH_COURIER_MESSAGE });
    expect(env.financeClient.send).not.toHaveBeenCalled();
  });

  it('kuryer bo`lmagan foydalanuvchi (market) → 403 "Bu foydalanuvchi courier emas"', async () => {
    const env = receiveEnv({ identity: { role: 'market' } });

    await expect(
      env.controller.paymentFromCourier(superadmin, dto()),
    ).rejects.toMatchObject({
      status: 403,
      message: 'Bu foydalanuvchi courier emas',
    });
    expect(env.branchClient.send).not.toHaveBeenCalled();
    expect(env.financeClient.send).not.toHaveBeenCalled();
  });

  it.each(['cash', 'click', 'click_to_market'])(
    'HQ kuryerida filialga tegishli 2 ta PENDING savdo → 400 (%s)',
    async (method) => {
      const env = receiveEnv({
        scope: () => ({
          data: {
            hq_pending_count: 1,
            hq_pending_amount: 100000,
            branch_pending_count: 2,
            branch_pending_amount: 180000,
            branch_ids: ['15'],
            carry_amount: 0,
          },
        }),
      });

      await expect(
        env.controller.paymentFromCourier(
          superadmin,
          dto({ payment_method: method, market_id: '201' }),
        ),
      ).rejects.toMatchObject({
        status: 400,
        message:
          'Kuryerda filialga tegishli 2 ta topshirilmagan savdo bor — ularni filial menejeri qabul qiladi',
      });
      expect(env.financeClient.send).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['xato', () => throwError(() => ({ statusCode: 500, message: 'db down' }))],
    ['timeout', () => throwError(() => new TimeoutError())],
    ['javob shakli buzuq', () => ({ data: {} })],
    [
      "eski order-service (handler yo'q)",
      () => throwError(() => new Error('There is no matching message handler')),
    ],
  ])('ledger RPC %s → 503, pul KO`CHIRILMAYDI', async (_label, scope) => {
    const env = receiveEnv({ scope: scope as Handler });

    await expect(
      env.controller.paymentFromCourier(superadmin, dto()),
    ).rejects.toMatchObject({ status: 503, message: UNAVAILABLE_MESSAGE });
    expect(env.financeClient.send).not.toHaveBeenCalled();
  });

  it.each([
    [
      'branch.user.find_by_user xato',
      {
        findByUser: () => throwError(() => ({ statusCode: 500, message: 'x' })),
      },
    ],
    [
      'branch.user.find_by_user timeout',
      { findByUser: () => throwError(() => new TimeoutError()) },
    ],
    [
      'branch.find_hq xato',
      {
        findHq: () =>
          throwError(() => ({
            statusCode: 404,
            message: 'HQ branch topilmadi',
          })),
      },
    ],
    ['branch.find_hq id siz', { findHq: () => ({ data: null }) }],
  ])(
    'filial RPC (%s) → 503, ledger ham finance ham chaqirilmaydi',
    async (_label, over) => {
      const env = receiveEnv(over as any);

      await expect(
        env.controller.paymentFromCourier(superadmin, dto()),
      ).rejects.toMatchObject({ status: 503, message: UNAVAILABLE_MESSAGE });
      expect(env.orderClient.send).not.toHaveBeenCalled();
      expect(env.financeClient.send).not.toHaveBeenCalled();
    },
  );

  it('menejer yo`li o`zgarmagan: receiver = filial, kassa turi branch, HQ tekshiruvi yo`q', async () => {
    const env = setup();
    const req = {
      user: { sub: '198', roles: ['manager'], branch_id: '15' },
    } as any;
    route(env.identityClient, {
      'identity.user.find_by_id': (p) => ({
        data: courierUser(String(p.id), { branch_id: '15' }),
      }),
    });
    route(env.branchClient, {
      'branch.cashbox.resolve_for_manager': () => ({
        data: { branch_id: null },
      }),
      'branch.find_by_id': () => ({ data: { id: '15', parent_id: null } }),
      'branch.user.find_by_user': () => ({ data: { branch_id: '15' } }),
      // C3 (fix3): menejer yo'lida kuryerning faol qatori AYNAN filial 15 da.
      'branch.user.find_by_branch': () => ({
        data: [
          {
            user_id: '209',
            branch_id: '15',
            role: 'COURIER',
            isDeleted: false,
          },
        ],
      }),
    });
    route(env.financeClient, {
      'finance.cashbox.payment_courier': () => ({ statusCode: 200 }),
    });

    await env.controller.paymentFromCourier(req, dto({ courier_id: '209' }));

    expect(
      payloadOf(env.financeClient, 'finance.cashbox.payment_courier'),
    ).toEqual(
      expect.objectContaining({
        courier_id: '209',
        receiver_user_id: '15',
        receiver_cashbox_type: 'branch',
      }),
    );
    expect(cmdsOf(env.branchClient)).not.toContain('branch.find_hq');
    expect(env.orderClient.send).not.toHaveBeenCalled();
  });

  it('menejer: kuryer bo`lmagan foydalanuvchi → avvalgidek 403', async () => {
    const env = setup();
    const req = {
      user: { sub: '198', roles: ['manager'], branch_id: '15' },
    } as any;
    route(env.identityClient, {
      'identity.user.find_by_id': (p) => ({
        data: courierUser(String(p.id), { role: 'registrator' }),
      }),
    });

    await expect(
      env.controller.paymentFromCourier(req, dto({ courier_id: '210' })),
    ).rejects.toMatchObject({
      status: 403,
      message: 'Bu foydalanuvchi courier emas',
    });
    expect(env.financeClient.send).not.toHaveBeenCalled();
  });

  it('tirik, kuryer bo`lmagan foydalanuvchi — HQ qatori COURIER bo`lsa ham 403 (fallback faqat 404 da)', async () => {
    const env = receiveEnv({ identity: { role: 'registrator' } });

    await expect(
      env.controller.paymentFromCourier(superadmin, dto()),
    ).rejects.toMatchObject({
      status: 403,
      message: 'Bu foydalanuvchi courier emas',
    });
    expect(env.branchClient.send).not.toHaveBeenCalled();
    expect(env.financeClient.send).not.toHaveBeenCalled();
  });

  it('identity timeout (404 emas) → avvalgidek 504 uzatiladi, filial/finance chaqirilmaydi', async () => {
    const env = receiveEnv({
      findUser: () => throwError(() => new TimeoutError()),
    });

    await expect(
      env.controller.paymentFromCourier(superadmin, dto()),
    ).rejects.toMatchObject({ status: 504 });
    expect(env.branchClient.send).not.toHaveBeenCalled();
    expect(env.financeClient.send).not.toHaveBeenCalled();
  });
});

/**
 * Soft-delete qilingan HQ kuryeri: identity 404 beradi, lekin `branch_users`
 * qatori va FOR_COURIER kassasidagi naqd qoladi. Superadmin/admin bu naqdni
 * olishi SHART (aks holda pul abadiy osilib qoladi) — kuryerlikni filial
 * qatori (COURIER@HQ) va kassa mavjudligi isbotlaydi.
 */
describe('C4 — o`chirilgan (soft-delete) HQ kuryeri', () => {
  it.each(['superadmin', 'admin'])(
    '%s: identity 404 + COURIER@HQ qatori + kassa bor → MAIN ga qabul qilinadi',
    async (role) => {
      const env = receiveEnv({ findUser: deletedUser });
      const req = { user: { sub: '9', roles: [role] } } as any;

      await env.controller.paymentFromCourier(req, dto(), 'idem-del');

      expect(cmdsOf(env.financeClient)).toEqual([
        'finance.cashbox.find_by_user',
        'finance.cashbox.payment_courier',
      ]);
      expect(
        payloadOf(env.financeClient, 'finance.cashbox.find_by_user'),
      ).toEqual({ user_id: '263', cashbox_type: 'couriers' });
      const payload = payloadOf(
        env.financeClient,
        'finance.cashbox.payment_courier',
      );
      expect(payload).toEqual(
        expect.objectContaining({
          courier_id: '263',
          amount: 250000,
          created_by: '9',
          dedup_epoch: 'idem-del',
        }),
      );
      expect(payload).not.toHaveProperty('receiver_user_id');
      expect(payload).not.toHaveProperty('receiver_cashbox_type');
      // Filialga tegishli PENDING tekshiruvi o'chirilgan kuryerda ham ishlaydi.
      expect(
        payloadOf(env.orderClient, 'order.settlement.courier_scope'),
      ).toEqual({ courier_id: '263' });
    },
  );

  it('filialga tegishli PENDING savdo bo`lsa → 400, pul ko`chirilmaydi', async () => {
    const env = receiveEnv({
      findUser: deletedUser,
      scope: () => ({
        data: {
          hq_pending_count: 0,
          hq_pending_amount: 0,
          branch_pending_count: 1,
          branch_pending_amount: 90000,
          branch_ids: ['15'],
          carry_amount: 0,
        },
      }),
    });

    await expect(
      env.controller.paymentFromCourier(superadmin, dto()),
    ).rejects.toMatchObject({
      status: 400,
      message:
        'Kuryerda filialga tegishli 1 ta topshirilmagan savdo bor — ularni filial menejeri qabul qiladi',
    });
    expect(cmdsOf(env.financeClient)).not.toContain(
      'finance.cashbox.payment_courier',
    );
  });

  it('qatori filialda (15) → 403 filial xabari; kassa ham ledger ham so`ralmaydi', async () => {
    const env = receiveEnv({ findUser: deletedUser, courierBranchId: '15' });

    await expect(
      env.controller.paymentFromCourier(superadmin, dto()),
    ).rejects.toMatchObject({ status: 403, message: BRANCH_COURIER_MESSAGE });
    expect(env.financeClient.send).not.toHaveBeenCalled();
    expect(env.orderClient.send).not.toHaveBeenCalled();
  });

  it.each(['REGISTRATOR', 'MANAGER'])(
    'HQ qatori %s (kuryer emas) → 403 "Bu foydalanuvchi courier emas"',
    async (branchRole) => {
      const env = receiveEnv({ findUser: deletedUser, branchRole });

      await expect(
        env.controller.paymentFromCourier(superadmin, dto()),
      ).rejects.toMatchObject({
        status: 403,
        message: 'Bu foydalanuvchi courier emas',
      });
      expect(env.financeClient.send).not.toHaveBeenCalled();
      expect(env.orderClient.send).not.toHaveBeenCalled();
    },
  );

  it('faol filial qatori yo`q → avvalgidek identity 404 ("User topilmadi")', async () => {
    const env = receiveEnv({ findUser: deletedUser, courierBranchId: null });

    await expect(
      env.controller.paymentFromCourier(superadmin, dto()),
    ).rejects.toMatchObject(USER_NOT_FOUND_HTTP);
    expect(env.financeClient.send).not.toHaveBeenCalled();
    expect(env.orderClient.send).not.toHaveBeenCalled();
  });

  it('FOR_COURIER kassasi yo`q (finance 404) → identity 404, pul ko`chirilmaydi', async () => {
    const env = receiveEnv({
      findUser: deletedUser,
      cashbox: () =>
        throwError(() => ({ statusCode: 404, message: 'Cashbox not found' })),
    });

    await expect(
      env.controller.paymentFromCourier(superadmin, dto()),
    ).rejects.toMatchObject(USER_NOT_FOUND_HTTP);
    expect(cmdsOf(env.financeClient)).toEqual(['finance.cashbox.find_by_user']);
    expect(env.orderClient.send).not.toHaveBeenCalled();
  });

  it('kassa javobida id yo`q → identity 404', async () => {
    const env = receiveEnv({
      findUser: deletedUser,
      cashbox: () => ({ statusCode: 200, data: null }),
    });

    await expect(
      env.controller.paymentFromCourier(superadmin, dto()),
    ).rejects.toMatchObject(USER_NOT_FOUND_HTTP);
    expect(cmdsOf(env.financeClient)).toEqual(['finance.cashbox.find_by_user']);
  });

  it.each([
    ['timeout', () => throwError(() => new TimeoutError())],
    [
      'xato (500)',
      () => throwError(() => ({ statusCode: 500, message: 'db down' })),
    ],
  ])(
    'kassa tekshiruvi %s → 503, pul KO`CHIRILMAYDI',
    async (_label, cashbox) => {
      const env = receiveEnv({ findUser: deletedUser, cashbox });

      await expect(
        env.controller.paymentFromCourier(superadmin, dto()),
      ).rejects.toMatchObject({ status: 503, message: UNAVAILABLE_MESSAGE });
      expect(cmdsOf(env.financeClient)).toEqual([
        'finance.cashbox.find_by_user',
      ]);
      expect(env.orderClient.send).not.toHaveBeenCalled();
    },
  );

  it.each([
    [
      'branch.user.find_by_user xato',
      {
        findByUser: () => throwError(() => ({ statusCode: 500, message: 'x' })),
      },
    ],
    [
      'branch.find_hq timeout',
      { findHq: () => throwError(() => new TimeoutError()) },
    ],
  ])('filial RPC (%s) → 503', async (_label, over) => {
    const env = receiveEnv({ findUser: deletedUser, ...(over as any) });

    await expect(
      env.controller.paymentFromCourier(superadmin, dto()),
    ).rejects.toMatchObject({ status: 503, message: UNAVAILABLE_MESSAGE });
    expect(env.financeClient.send).not.toHaveBeenCalled();
    expect(env.orderClient.send).not.toHaveBeenCalled();
  });

  it('ledger RPC xato → 503', async () => {
    const env = receiveEnv({
      findUser: deletedUser,
      scope: () => throwError(() => new TimeoutError()),
    });

    await expect(
      env.controller.paymentFromCourier(superadmin, dto()),
    ).rejects.toMatchObject({ status: 503, message: UNAVAILABLE_MESSAGE });
    expect(cmdsOf(env.financeClient)).not.toContain(
      'finance.cashbox.payment_courier',
    );
  });

  it('menejer yo`li o`zgarmagan: identity 404 → 404 (fallback faqat superadmin/admin)', async () => {
    const env = setup();
    const req = {
      user: { sub: '198', roles: ['manager'], branch_id: '15' },
    } as any;
    route(env.identityClient, { 'identity.user.find_by_id': deletedUser });

    await expect(
      env.controller.paymentFromCourier(req, dto({ courier_id: '209' })),
    ).rejects.toMatchObject(USER_NOT_FOUND);
    expect(env.branchClient.send).not.toHaveBeenCalled();
    expect(env.financeClient.send).not.toHaveBeenCalled();
    expect(env.orderClient.send).not.toHaveBeenCalled();
  });
});

describe('C1 — GET cashbox/hq-couriers', () => {
  it('faqat superadmin va admin', () => {
    const descriptor = Object.getOwnPropertyDescriptor(
      FinanceGatewayController.prototype,
      'hqCourierReceivables',
    );
    expect(Reflect.getMetadata(ROLES_KEY, descriptor?.value)).toEqual([
      'superadmin',
      'admin',
    ]);
  });

  function listEnv(
    rows: any[],
    balances: Record<string, number | 'error' | 'missing'>,
    identity: Handler = () => ({ success: true, data: [] }),
  ) {
    const env = setup();
    route(env.branchClient, {
      'branch.find_hq': () => ({ data: { id: HQ } }),
      'branch.user.find_by_branch': () => ({ data: rows }),
    });
    route(env.identityClient, {
      'identity.courier.find_by_ids': identity,
    });
    route(env.financeClient, {
      'finance.cashbox.find_by_user': (p) => {
        const balance = balances[String(p.user_id)];
        if (balance === 'error' || balance === 'missing') {
          return throwError(() => ({
            statusCode: 404,
            message: 'Cashbox not found',
          }));
        }
        return {
          data: {
            id: `cb-${p.user_id}`,
            user_id: String(p.user_id),
            cashbox_type: p.cashbox_type,
            balance,
            balance_cash: balance,
            balance_card: 0,
          },
        };
      },
    });
    return env;
  }

  const row = (
    userId: string,
    role: string,
    user: Record<string, unknown> | null,
  ) => ({
    id: `bu-${userId}`,
    branch_id: HQ,
    user_id: userId,
    role,
    user,
  });

  it('faqat HQ kuryerlari, balans > 0, kamayish tartibida; bloklangani ham qoladi', async () => {
    const env = listEnv(
      [
        row('263', 'COURIER', {
          id: '263',
          name: 'Ali Valiyev',
          phone_number: '+998901112233',
          status: 'active',
        }),
        row('264', 'COURIER', {
          id: '264',
          name: 'Bobur Karimov',
          phone_number: '+998902223344',
          status: 'inactive',
        }),
        row('265', 'COURIER', {
          id: '265',
          name: 'Nol Balans',
          phone_number: null,
          status: 'active',
        }),
        row('266', 'COURIER', {
          id: '266',
          name: 'Kassasiz',
          phone_number: null,
          status: 'active',
        }),
        row('267', 'COURIER', null), // identity javob bermagan
        row('269', 'REGISTRATOR', { id: '269', name: 'Registrator' }),
        row('263', 'COURIER', { id: '263', name: 'Ali Valiyev' }), // takror qator
      ],
      {
        '263': 100000,
        '264': 250000,
        '265': 0,
        '266': 'error',
        '267': 40000,
        '269': 999999,
      },
    );

    const response: any = await env.controller.hqCourierReceivables(superadmin);

    expect(response.statusCode).toBe(200);
    expect(response.data).toEqual({
      items: [
        {
          id: '264',
          name: 'Bobur Karimov',
          phone_number: '+998902223344',
          status: 'inactive',
          balance: 250000,
          cashbox: {
            id: 'cb-264',
            balance: 250000,
            balance_cash: 250000,
            balance_card: 0,
          },
        },
        {
          id: '263',
          name: 'Ali Valiyev',
          phone_number: '+998901112233',
          status: 'active',
          balance: 100000,
          cashbox: {
            id: 'cb-263',
            balance: 100000,
            balance_cash: 100000,
            balance_card: 0,
          },
        },
        {
          id: '267',
          name: '',
          phone_number: null,
          status: '',
          balance: 40000,
          cashbox: {
            id: 'cb-267',
            balance: 40000,
            balance_cash: 40000,
            balance_card: 0,
          },
        },
      ],
      total: 3,
      hq_branch_id: HQ,
    });

    expect(payloadOf(env.branchClient, 'branch.user.find_by_branch')).toEqual(
      expect.objectContaining({ branch_id: HQ }),
    );
    // Har kuryerga bitta kassa so'rovi (couriers turi); registratorga yo'q,
    // takror qatorga ham yo'q.
    const cashboxCalls = env.financeClient.send.mock.calls.map(
      (call: any[]) => call[1],
    );
    expect(cashboxCalls).toHaveLength(5);
    expect(cashboxCalls.map((p: any) => p.user_id).sort()).toEqual([
      '263',
      '264',
      '265',
      '266',
      '267',
    ]);
    for (const p of cashboxCalls) {
      expect(p.cashbox_type).toBe('couriers');
    }
    // Ism uchun identity'ga BITTA batch so'rov (faqat HQ kuryerlari, takrorsiz);
    // GET /couriers (identity.user.find_all sahifasi) ishlatilmaydi.
    expect(cmdsOf(env.identityClient)).toEqual([
      'identity.courier.find_by_ids',
    ]);
    expect(
      [
        ...payloadOf(env.identityClient, 'identity.courier.find_by_ids').ids,
      ].sort(),
    ).toEqual(['263', '264', '265', '266', '267']);
  });

  it('ism/telefon/status: identity (bo`lsa) → branch_users qatori → ""', async () => {
    const env = listEnv(
      [
        // Identity ham, qator ham bor — identity ustun.
        row('263', 'COURIER', {
          id: '263',
          name: 'Eski Ism',
          phone_number: '+998900000000',
          status: 'inactive',
        }),
        // Identity bermadi (masalan roli o'zgargan) — qatordagi ma'lumot.
        row('264', 'COURIER', {
          id: '264',
          name: 'Bobur Karimov',
          phone_number: '+998902223344',
          status: 'active',
        }),
        // Soft-delete qilingan kuryer: identity ham, qatordagi `user` ham yo'q.
        row('267', 'COURIER', null),
      ],
      { '263': 300000, '264': 200000, '267': 100000 },
      () => ({
        success: true,
        data: [
          {
            id: '263',
            name: 'Ali Valiyev',
            phone_number: '+998901112233',
            status: 'active',
            role: 'courier',
          },
        ],
      }),
    );

    const response: any = await env.controller.hqCourierReceivables(superadmin);

    expect(
      response.data.items.map((item: any) => ({
        id: item.id,
        name: item.name,
        phone_number: item.phone_number,
        status: item.status,
        balance: item.balance,
      })),
    ).toEqual([
      {
        id: '263',
        name: 'Ali Valiyev',
        phone_number: '+998901112233',
        status: 'active',
        balance: 300000,
      },
      {
        id: '264',
        name: 'Bobur Karimov',
        phone_number: '+998902223344',
        status: 'active',
        balance: 200000,
      },
      // Puli bor — ro'yxatda qoladi (C4 uni qabul qila oladi).
      { id: '267', name: '', phone_number: null, status: '', balance: 100000 },
    ]);
  });

  it.each([
    ['xato', () => throwError(() => ({ statusCode: 500, message: 'down' }))],
    ['timeout', () => throwError(() => new TimeoutError())],
    ['buzuq javob', () => ({ success: true, data: { not: 'array' } })],
  ])(
    'identity %s → ism filial qatoridan, ro`yxat yiqilmaydi',
    async (_label, identity) => {
      const env = listEnv(
        [
          row('263', 'COURIER', {
            id: '263',
            name: 'Ali Valiyev',
            phone_number: '+998901112233',
            status: 'active',
          }),
        ],
        { '263': 100000 },
        identity as Handler,
      );

      const response: any =
        await env.controller.hqCourierReceivables(superadmin);

      expect(response.data.items).toEqual([
        expect.objectContaining({
          id: '263',
          name: 'Ali Valiyev',
          phone_number: '+998901112233',
          status: 'active',
          balance: 100000,
        }),
      ]);
    },
  );

  it('HQ kuryeri yo`q → bo`sh ro`yxat', async () => {
    const env = listEnv([row('269', 'REGISTRATOR', { id: '269' })], {});

    const response: any = await env.controller.hqCourierReceivables(superadmin);

    expect(response.data).toEqual({ items: [], total: 0, hq_branch_id: HQ });
    expect(env.financeClient.send).not.toHaveBeenCalled();
    expect(env.identityClient.send).not.toHaveBeenCalled();
  });

  it('HQ aniqlanmasa xato uzatiladi (jimgina bo`sh ro`yxat EMAS)', async () => {
    const env = setup();
    route(env.branchClient, {
      'branch.find_hq': () =>
        throwError(() => ({ statusCode: 404, message: 'HQ branch topilmadi' })),
    });

    await expect(
      env.controller.hqCourierReceivables(superadmin),
    ).rejects.toMatchObject({ statusCode: 404 });
  });
});

/**
 * MARSHRUT TARTIBI — haqiqiy Nest routeri orqali: statik `cashbox/hq-couriers`
 * hech qaysi `cashbox/...` parametrli GET'ga tushmasligi kerak.
 */
describe('C1 — marshrut tartibi', () => {
  let app: INestApplication;
  const financeSend = jest.fn();
  const branchSend = jest.fn();
  const identitySend = jest.fn();
  const orderSend = jest.fn();

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [FinanceGatewayController],
      providers: [
        { provide: 'FINANCE', useValue: { send: financeSend } },
        { provide: 'IDENTITY', useValue: { send: identitySend } },
        { provide: 'BRANCH', useValue: { send: branchSend } },
        { provide: 'ORDER', useValue: { send: orderSend } },
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(RolesGuard)
      .useValue({ canActivate: () => true })
      .compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  it('GET /finance/cashbox/hq-couriers → branch.find_hq, `:user_id` ga TUSHMAYDI', async () => {
    branchSend.mockImplementation((pattern: { cmd: string }) =>
      pattern.cmd === 'branch.find_hq'
        ? of({ data: { id: HQ } })
        : of({ data: [] }),
    );

    const res = await request(
      app.getHttpServer() as Parameters<typeof request>[0],
    ).get('/finance/cashbox/hq-couriers');

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ items: [], total: 0, hq_branch_id: HQ });
    expect(branchSend.mock.calls[0][0]).toEqual({ cmd: 'branch.find_hq' });
    expect(financeSend).not.toHaveBeenCalled();
  });
});

describe('C2 — GET cashbox/all-info (superadmin/admin)', () => {
  function allInfoEnv(branches: Handler) {
    const env = setup();
    route(env.financeClient, {
      'finance.cashbox.all_info': () => ({
        statusCode: 200,
        data: {
          mainCashboxTotal: 5000000,
          marketCashboxTotal: 2000000,
          courierCashboxTotal: 777,
        },
      }),
    });
    route(env.branchClient, { 'branch.find_all': branches });
    return env;
  }

  it('olinishi_kerak = courierCashboxTotal = filial menejerlari + HQ kuryerlari', async () => {
    const env = allInfoEnv(() => ({
      data: {
        items: [
          // HQ.olinishi_kerak — HQ kuryerlari kassalarining musbat yig'indisi.
          { id: HQ, type: 'HQ', olinishi_kerak: 350000 },
          { id: '15', type: 'REGIONAL', olinishi_kerak: 1000000 },
          { id: '16', type: 'HYBRID', olinishi_kerak: '200000' },
          { id: '17', type: 'REGIONAL', olinishi_kerak: -50000 },
          { id: '18', type: 'PICKUP', olinishi_kerak: 30000 },
        ],
      },
    }));

    const response: any = await env.controller.allCashboxesInfo(
      {} as any,
      superadmin,
    );

    expect(response.data).toEqual(
      expect.objectContaining({
        kassadagi_summa: 5000000,
        berilishi_kerak: 2000000,
        branch_managers_receivable: 1230000,
        hq_couriers_receivable: 350000,
        olinishi_kerak: 1580000,
        courierCashboxTotal: 1580000,
      }),
    );
    // Yangi chaqiruv yo'q: faqat branch.find_all (HQ qatori undan olinadi).
    expect(cmdsOf(env.branchClient)).toEqual(['branch.find_all']);
    expect(env.orderClient.send).not.toHaveBeenCalled();
    expect(env.identityClient.send).not.toHaveBeenCalled();
  });

  it('filiallar ro`yxati olinmasa — nollar, 500 emas', async () => {
    const env = allInfoEnv(() =>
      throwError(() => ({ statusCode: 500, message: 'down' })),
    );

    const response: any = await env.controller.allCashboxesInfo(
      {} as any,
      superadmin,
    );

    expect(response.data).toEqual(
      expect.objectContaining({
        branch_managers_receivable: 0,
        hq_couriers_receivable: 0,
        olinishi_kerak: 0,
        courierCashboxTotal: 0,
      }),
    );
  });
});

describe('C3 — GET cashbox/user/:id?cashbox_type=couriers', () => {
  const query = {
    cashbox_type: 'couriers',
    with_history: true,
    page: 1,
    limit: 20,
  } as any;

  function detailEnv(
    over: {
      balance?: number;
      courierBranchId?: string | null;
      branchRole?: string;
      /** `branch.user.find_by_user` qatoriga qo'shilgan foydalanuvchi (bo'lsa). */
      branchRowUser?: Record<string, unknown>;
      scope?: Handler;
      identity?: Handler;
      findByUser?: Handler;
      findHq?: Handler;
    } = {},
  ) {
    const env = setup();
    route(env.financeClient, {
      'finance.cashbox.find_by_user': (p) => ({
        data: {
          cashbox: {
            id: `cb-${p.user_id}`,
            user_id: String(p.user_id),
            cashbox_type: 'couriers',
            balance: over.balance ?? 250000,
          },
          history: [],
        },
      }),
    });
    route(env.identityClient, {
      'identity.user.find_by_id':
        over.identity ?? ((p) => ({ data: courierUser(String(p.id)) })),
    });
    route(env.branchClient, {
      'branch.find_hq': over.findHq ?? (() => ({ data: { id: HQ } })),
      'branch.user.find_by_user':
        over.findByUser ??
        ((p) => ({
          data:
            over.courierBranchId === null
              ? null
              : {
                  id: `bu-${p.user_id}`,
                  branch_id: over.courierBranchId ?? HQ,
                  user_id: String(p.user_id),
                  role: over.branchRole ?? 'COURIER',
                  ...(over.branchRowUser ? { user: over.branchRowUser } : {}),
                },
        })),
      // Menejer ruxsat tekshiruvlari uchun.
      'branch.cashbox.resolve_for_manager': () => ({
        data: { branch_id: null },
      }),
      'branch.find_by_id': () => ({ data: { id: '15', parent_id: null } }),
    });
    route(env.orderClient, {
      'order.settlement.courier_scope':
        over.scope ??
        (() => ({
          data: {
            hq_pending_count: 1,
            hq_pending_amount: 250000,
            branch_pending_count: 0,
            branch_pending_amount: 0,
            branch_ids: [],
            carry_amount: 0,
          },
        })),
    });
    return env;
  }

  it('superadmin + HQ kuryeri: user, is_hq_courier, can_receive, olinishi_kerak, counterparty', async () => {
    const env = detailEnv();

    const response: any = await env.controller.findCashboxByUser(
      '263',
      query,
      superadmin,
    );

    expect(response.data).toEqual(
      expect.objectContaining({
        user: {
          id: '263',
          name: 'Ali Valiyev',
          phone_number: '+998901112233',
          role: 'courier',
          status: 'active',
        },
        is_hq_courier: true,
        can_receive: true,
        olinishi_kerak: 250000,
        receive_check_failed: false,
        counterparty: 'HQ',
      }),
    );
    expect(response.data.user).not.toHaveProperty('password');
    expect(
      payloadOf(env.financeClient, 'finance.cashbox.find_by_user'),
    ).toEqual(
      expect.objectContaining({ user_id: '263', cashbox_type: 'couriers' }),
    );
    // Kuryer id si bilan filial qidirilmaydi (id fazosi umumiy).
    expect(cmdsOf(env.branchClient)).not.toContain('branch.find_by_id');
  });

  it('filial kuryeri: is_hq_courier false, can_receive false, olinishi_kerak 0', async () => {
    const env = detailEnv({ courierBranchId: '15' });

    const response: any = await env.controller.findCashboxByUser(
      '209',
      query,
      superadmin,
    );

    expect(response.data).toEqual(
      expect.objectContaining({
        is_hq_courier: false,
        can_receive: false,
        olinishi_kerak: 0,
        receive_check_failed: false,
        counterparty: 'HQ',
      }),
    );
    expect(response.data.user.name).toBe('Ali Valiyev');
    expect(env.orderClient.send).not.toHaveBeenCalled();
  });

  it('filialga biriktirilmagan kuryer: false/false/0, tekshiruv muvaffaqiyatli', async () => {
    const env = detailEnv({ courierBranchId: null });

    const response: any = await env.controller.findCashboxByUser(
      '263',
      query,
      superadmin,
    );

    expect(response.data).toEqual(
      expect.objectContaining({
        is_hq_courier: false,
        can_receive: false,
        olinishi_kerak: 0,
        receive_check_failed: false,
      }),
    );
    expect(env.orderClient.send).not.toHaveBeenCalled();
  });

  it('HQ kuryerida filialga tegishli PENDING savdo → can_receive false', async () => {
    const env = detailEnv({
      scope: () => ({
        data: {
          hq_pending_count: 0,
          hq_pending_amount: 0,
          branch_pending_count: 1,
          branch_pending_amount: 90000,
          branch_ids: ['15'],
          carry_amount: 0,
        },
      }),
    });

    const response: any = await env.controller.findCashboxByUser(
      '263',
      query,
      superadmin,
    );

    expect(response.data).toEqual(
      expect.objectContaining({
        is_hq_courier: true,
        can_receive: false,
        olinishi_kerak: 0,
        receive_check_failed: false,
      }),
    );
  });

  /**
   * Tekshiruv javob bermasa sahifa jimgina "olib bo'lmaydi / 0" DEMAYDI:
   * holat noma'lum (null), summa — musbat balans; frontend formani
   * ogohlantirish bilan ko'rsatadi, to'lov C4 da 503 matni bilan to'xtaydi.
   */
  it.each([
    ['timeout', () => throwError(() => new TimeoutError())],
    ['xato', () => throwError(() => ({ statusCode: 500, message: 'db down' }))],
    ['javob shakli buzuq', () => ({ data: {} })],
  ])(
    'ledger RPC %s → receive_check_failed, is_hq_courier/can_receive null, olinishi_kerak = balans',
    async (_label, scope) => {
      const env = detailEnv({ scope: scope as Handler });

      const response: any = await env.controller.findCashboxByUser(
        '263',
        query,
        superadmin,
      );

      expect(response.data).toEqual(
        expect.objectContaining({
          user: expect.objectContaining({ id: '263', name: 'Ali Valiyev' }),
          is_hq_courier: null,
          can_receive: null,
          olinishi_kerak: 250000,
          receive_check_failed: true,
          counterparty: 'HQ',
        }),
      );
    },
  );

  it.each([
    [
      'branch.user.find_by_user xato',
      {
        findByUser: () => throwError(() => ({ statusCode: 500, message: 'x' })),
      },
    ],
    [
      'branch.user.find_by_user timeout',
      { findByUser: () => throwError(() => new TimeoutError()) },
    ],
    [
      'branch.find_hq xato',
      {
        findHq: () =>
          throwError(() => ({
            statusCode: 404,
            message: 'HQ branch topilmadi',
          })),
      },
    ],
    ['branch.find_hq id siz', { findHq: () => ({ data: null }) }],
  ])(
    'filial RPC (%s) → receive_check_failed, null/null, olinishi_kerak = balans; ledger so`ralmaydi',
    async (_label, over) => {
      const env = detailEnv(over as any);

      const response: any = await env.controller.findCashboxByUser(
        '263',
        query,
        superadmin,
      );

      expect(response.data).toEqual(
        expect.objectContaining({
          user: expect.objectContaining({ id: '263', name: 'Ali Valiyev' }),
          is_hq_courier: null,
          can_receive: null,
          olinishi_kerak: 250000,
          receive_check_failed: true,
          counterparty: 'HQ',
        }),
      );
      expect(env.orderClient.send).not.toHaveBeenCalled();
    },
  );

  it('tekshiruv xato + manfiy balans → olinishi_kerak 0 (musbat qism)', async () => {
    const env = detailEnv({
      balance: -5000,
      findByUser: () => throwError(() => new TimeoutError()),
    });

    const response: any = await env.controller.findCashboxByUser(
      '263',
      query,
      superadmin,
    );

    expect(response.data.receive_check_failed).toBe(true);
    expect(response.data.can_receive).toBeNull();
    expect(response.data.olinishi_kerak).toBe(0);
  });

  it('tirik, kuryer bo`lmagan foydalanuvchi: filial xato bersa ham false/false/0 (tekshiruv xatosi emas)', async () => {
    const env = detailEnv({
      identity: (p) => ({
        data: courierUser(String(p.id), { role: 'market' }),
      }),
      findByUser: () => throwError(() => new TimeoutError()),
    });

    const response: any = await env.controller.findCashboxByUser(
      '263',
      query,
      superadmin,
    );

    expect(response.data).toEqual(
      expect.objectContaining({
        is_hq_courier: false,
        can_receive: false,
        olinishi_kerak: 0,
        receive_check_failed: false,
      }),
    );
    expect(env.orderClient.send).not.toHaveBeenCalled();
  });

  it('manfiy balans → olinishi_kerak 0', async () => {
    const env = detailEnv({ balance: -5000 });

    const response: any = await env.controller.findCashboxByUser(
      '263',
      query,
      superadmin,
    );

    expect(response.data.can_receive).toBe(true);
    expect(response.data.receive_check_failed).toBe(false);
    expect(response.data.olinishi_kerak).toBe(0);
  });

  it('identity javob bermasa: user null, HQ holati filialdan', async () => {
    const env = detailEnv({
      identity: () => throwError(() => new TimeoutError()),
    });

    const response: any = await env.controller.findCashboxByUser(
      '263',
      query,
      superadmin,
    );

    expect(response.data.user).toBeNull();
    expect(response.data.is_hq_courier).toBe(true);
    expect(response.data.receive_check_failed).toBe(false);
    expect(response.data.olinishi_kerak).toBe(250000);
  });

  describe('o`chirilgan (identity 404) kuryer', () => {
    const deletedIdentity: Handler = () =>
      throwError(() => ({
        statusCode: 404,
        message: 'User topilmadi',
        data: null,
      }));

    it('COURIER@HQ qatori: user status deleted, role courier; qabul qilsa bo`ladi', async () => {
      const env = detailEnv({ identity: deletedIdentity });

      const response: any = await env.controller.findCashboxByUser(
        '263',
        query,
        superadmin,
      );

      expect(response.data).toEqual(
        expect.objectContaining({
          user: {
            id: '263',
            name: '',
            phone_number: null,
            role: 'courier',
            status: 'deleted',
          },
          is_hq_courier: true,
          can_receive: true,
          olinishi_kerak: 250000,
          receive_check_failed: false,
          counterparty: 'HQ',
        }),
      );
      expect(
        payloadOf(env.orderClient, 'order.settlement.courier_scope'),
      ).toEqual({ courier_id: '263' });
    });

    it('ism va telefon filial qatorida bo`lsa — o`sha yerdan', async () => {
      const env = detailEnv({
        identity: deletedIdentity,
        branchRowUser: { name: 'Eski Kuryer', phone_number: '+998907776655' },
      });

      const response: any = await env.controller.findCashboxByUser(
        '263',
        query,
        superadmin,
      );

      expect(response.data.user).toEqual({
        id: '263',
        name: 'Eski Kuryer',
        phone_number: '+998907776655',
        role: 'courier',
        status: 'deleted',
      });
    });

    it('filialga tegishli PENDING bo`lsa → can_receive false, 0', async () => {
      const env = detailEnv({
        identity: deletedIdentity,
        scope: () => ({
          data: {
            hq_pending_count: 0,
            hq_pending_amount: 0,
            branch_pending_count: 2,
            branch_pending_amount: 120000,
            branch_ids: ['15'],
            carry_amount: 0,
          },
        }),
      });

      const response: any = await env.controller.findCashboxByUser(
        '263',
        query,
        superadmin,
      );

      expect(response.data).toEqual(
        expect.objectContaining({
          is_hq_courier: true,
          can_receive: false,
          olinishi_kerak: 0,
          receive_check_failed: false,
        }),
      );
    });

    it.each([
      ['HQ qatori REGISTRATOR', { branchRole: 'REGISTRATOR' }],
      ['qatori filialda (15)', { courierBranchId: '15' }],
      ['faol qatori yo`q', { courierBranchId: null }],
    ])('%s → is_hq_courier false, can_receive false, 0', async (_l, over) => {
      const env = detailEnv({ identity: deletedIdentity, ...(over as any) });

      const response: any = await env.controller.findCashboxByUser(
        '263',
        query,
        superadmin,
      );

      expect(response.data).toEqual(
        expect.objectContaining({
          user: expect.objectContaining({ id: '263', status: 'deleted' }),
          is_hq_courier: false,
          can_receive: false,
          olinishi_kerak: 0,
          receive_check_failed: false,
        }),
      );
      expect(env.orderClient.send).not.toHaveBeenCalled();
    });

    it('filial RPC xato → receive_check_failed, user status deleted', async () => {
      const env = detailEnv({
        identity: deletedIdentity,
        findByUser: () => throwError(() => new TimeoutError()),
      });

      const response: any = await env.controller.findCashboxByUser(
        '263',
        query,
        superadmin,
      );

      expect(response.data).toEqual(
        expect.objectContaining({
          user: {
            id: '263',
            name: '',
            phone_number: null,
            role: 'courier',
            status: 'deleted',
          },
          is_hq_courier: null,
          can_receive: null,
          olinishi_kerak: 250000,
          receive_check_failed: true,
        }),
      );
    });
  });

  it('menejer: FAQAT user qo`shiladi (olinishi_kerak yo`q — cashDetail hisobi buzilmasin)', async () => {
    const env = detailEnv();
    const manager = {
      user: { sub: '198', roles: ['manager'], branch_id: '15' },
    } as any;
    route(env.branchClient, {
      'branch.cashbox.resolve_for_manager': () => ({
        data: { branch_id: null },
      }),
      'branch.find_by_id': () => ({ data: { id: '15', parent_id: null } }),
      'branch.user.find_by_user': () => ({ data: { branch_id: '15' } }),
    });

    const response: any = await env.controller.findCashboxByUser(
      '209',
      query,
      manager,
    );

    expect(response.data.user).toEqual(
      expect.objectContaining({ id: '209', name: 'Ali Valiyev' }),
    );
    for (const key of [
      'olinishi_kerak',
      'can_receive',
      'is_hq_courier',
      'receive_check_failed',
      'counterparty',
    ]) {
      expect(response.data).not.toHaveProperty(key);
    }
    expect(cmdsOf(env.branchClient)).not.toContain('branch.find_hq');
    expect(env.orderClient.send).not.toHaveBeenCalled();
  });

  it('superadmin boshqa kassa turi (markets) → qo`shimcha maydonlar yo`q', async () => {
    const env = detailEnv();

    const response: any = await env.controller.findCashboxByUser(
      '201',
      { ...query, cashbox_type: 'markets' },
      superadmin,
    );

    expect(response.data).not.toHaveProperty('can_receive');
    expect(response.data).not.toHaveProperty('receive_check_failed');
    expect(response.data).not.toHaveProperty('user');
    expect(env.orderClient.send).not.toHaveBeenCalled();
  });
});
