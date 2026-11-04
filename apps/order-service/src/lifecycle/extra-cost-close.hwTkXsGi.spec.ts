import { Order_status } from '@app/common';
import { RpcException } from '@nestjs/microservices';
import {
  EXTRA_COST_CLOSE_REASON,
  ExtraCostExecutionOptions,
  ExtraCostRequestClosedError,
  OrderLifecycleService,
} from './order-lifecycle.service';
import {
  extraCostApprovalTable,
  extraCostManager,
} from '../testing/extra-cost-kit-spec';

/**
 * hwTkXsGi — qo'shimcha xarajat so'rovi «kutilmoqda» bo'lib osilib qolmaydi.
 *
 * Sotish / bekor qilish / qisman sotish va orqaga qaytarish tranzaksiyasi
 * ichidagi yordamchilar — haqiqiy WHERE semantikasi bilan (kit jadvali):
 *  - amal haqiqatda bajarilsa — shu buyurtmaning ochiq so'rovlari `void`;
 *  - tasdiqni qayta ijro — darvoza + shartli «tasdiqlandi» (claim), qolgan
 *    ochiq so'rovlar `void`;
 *  - orqaga qaytarish — `pending` → `void`, `approved` → `reversed`;
 *    qo'shiladigan qisman sotuv qoldiqlaridagi ochiq so'rovlar ham `void`.
 */
type Row = Record<string, unknown>;

const request = (overrides: Row = {}): Row => ({
  id: '7',
  order_id: '7001',
  market_id: '501',
  requested_by_user_id: '289',
  requested_by_role: 'courier',
  action: 'sell',
  amount: 10000,
  operation_payload: { extraCost: 10000 },
  status: 'pending',
  createdAt: new Date('2026-11-04T10:00:00Z'),
  ...overrides,
});

type Helpers = {
  applyExtraCostApprovalsOnExecution: (
    tx: unknown,
    orderId: string,
    requester: { id: string },
    options?: ExtraCostExecutionOptions,
  ) => Promise<void>;
  closeExtraCostApprovalsOnRollback: (
    tx: unknown,
    orderId: string,
    requester: { id: string },
  ) => Promise<void>;
  mergePartialChildrenBack: (
    tx: unknown,
    order: Row,
    requester: { id: string },
  ) => Promise<number>;
};

function setup(rows: Row[], changedTo: string | null = null) {
  const table = extraCostApprovalTable(rows);
  const manager = extraCostManager({ table, changedTo });
  const svc = Object.create(OrderLifecycleService.prototype) as Helpers &
    Record<string, unknown>;
  Object.assign(svc, {
    logger: { warn: jest.fn(), log: jest.fn(), error: jest.fn() },
  });
  return { svc, table, manager };
}

const states = (table: ReturnType<typeof extraCostApprovalTable>) =>
  Object.fromEntries(table.rows.map((row) => [row.id, row.status]));

const replay = (id: string): ExtraCostExecutionOptions => ({
  extraCostApproval: {
    id,
    patch: {
      decided_by_user_id: '501',
      decided_at: new Date('2026-11-04T11:00:00Z'),
      decision_comment: null,
      auto_approved: false,
    },
  },
});

describe('hwTkXsGi — amal haqiqatda bajarilganda', () => {
  it('⭐ TC1/TC4/TC5: oddiy sotuv (xarajatsiz, ommaviy, bot) — buyurtmaning ochiq so‘rovi void, sababi bilan', async () => {
    const { svc, table, manager } = setup([
      request({ id: '7' }),
      request({ id: '8', status: 'rejected' }),
      request({ id: '9', status: 'approved' }),
      request({ id: '10', order_id: '7002' }),
    ]);

    await svc.applyExtraCostApprovalsOnExecution(manager, '7001', {
      id: '289',
    });

    expect(states(table)).toEqual({
      7: 'void',
      8: 'rejected',
      9: 'approved',
      10: 'pending',
    });
    expect(table.row('7')).toMatchObject({
      closed_reason:
        "Buyurtma boshqa so'rov bilan yakunlandi — eski so'rov yopildi",
      closed_by_user_id: '289',
      closed_at: expect.any(Date),
    });
    // Market qaror qilmagan — qaror maydonlari bo'sh qoladi.
    expect(table.row('7')!.decided_at).toBeUndefined();
  });

  it('hamkor amali (`partner:N`) — yopuvchi NULL (bigint ustun)', async () => {
    const { svc, table, manager } = setup([request()]);

    await svc.applyExtraCostApprovalsOnExecution(manager, '7001', {
      id: 'partner:4',
    });

    expect(table.row('7')).toMatchObject({
      status: 'void',
      closed_by_user_id: null,
    });
  });

  it('⭐ qayta ijro: o‘z so‘rovi «tasdiqlandi» (claim), shu buyurtmadagi boshqa ochiq so‘rov void', async () => {
    const { svc, table, manager } = setup([
      request({ id: '7' }),
      // Eski kod qoldirgan ikkinchi ochiq so'rov (indeksdan oldin).
      request({ id: '6', createdAt: new Date('2026-11-04T09:00:00Z') }),
    ]);

    await svc.applyExtraCostApprovalsOnExecution(
      manager,
      '7001',
      { id: '289' },
      replay('7'),
    );

    expect(table.row('7')).toMatchObject({
      status: 'approved',
      decided_by_user_id: '501',
      decided_at: expect.any(Date),
      reject_reason: null,
      auto_approved: false,
    });
    expect(table.row('6')).toMatchObject({
      status: 'void',
      closed_reason: EXTRA_COST_CLOSE_REASON.executed,
    });
  });

  it('⭐ qayta ijro: so‘rov allaqachon yakunlangan (parallel qaror) — ClosedError, hech narsa yozilmaydi', async () => {
    const { svc, table, manager } = setup([
      request({ id: '7', status: 'rejected' }),
      request({ id: '6' }),
    ]);

    const error = await svc
      .applyExtraCostApprovalsOnExecution(
        manager,
        '7001',
        { id: '289' },
        replay('7'),
      )
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ExtraCostRequestClosedError);
    expect((error as ExtraCostRequestClosedError).closeReason).toBeNull();
    expect(states(table)).toEqual({ 7: 'rejected', 6: 'pending' });
  });

  it('⭐ qayta ijro darvozasi qulf ostida: so‘rovdan keyin holat o‘zgargan — ClosedError(sabab), claim yo‘q', async () => {
    const { svc, table, manager } = setup([request()], Order_status.SOLD);

    const error = await svc
      .applyExtraCostApprovalsOnExecution(
        manager,
        '7001',
        { id: '289' },
        replay('7'),
      )
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ExtraCostRequestClosedError);
    expect((error as RpcException).getError()).toEqual({
      statusCode: 409,
      message:
        "Bu so'rov allaqachon yakunlangan — so'rov ochilgandan keyin buyurtma holati o'zgargan (sold)",
    });
    expect(table.row('7')!.status).toBe('pending');
  });
});

describe('hwTkXsGi — orqaga qaytarishda', () => {
  it('⭐ TC6/TC7: pending → void «Buyurtma orqaga qaytarildi», approved → reversed; boshqalari tegilmaydi', async () => {
    const { svc, table, manager } = setup([
      request({ id: '7' }),
      request({ id: '9', status: 'approved' }),
      request({ id: '8', status: 'rejected' }),
      request({ id: '5', status: 'void' }),
      request({ id: '10', order_id: '7002', status: 'approved' }),
    ]);

    await svc.closeExtraCostApprovalsOnRollback(manager, '7001', {
      id: '1',
    });

    expect(states(table)).toEqual({
      7: 'void',
      9: 'reversed',
      8: 'rejected',
      5: 'void',
      10: 'approved',
    });
    expect(table.row('7')).toMatchObject({
      closed_reason: 'Buyurtma orqaga qaytarildi',
      closed_by_user_id: '1',
    });
    expect(table.row('9')).toMatchObject({
      closed_reason:
        'Buyurtma orqaga qaytarildi — tasdiqlangan xarajat teskari yozildi',
      closed_by_user_id: '1',
      closed_at: expect.any(Date),
    });
    expect(table.row('5')!.closed_reason).toBeUndefined();
  });

  it('qo‘shiladigan qisman sotuv qoldig‘idagi ochiq so‘rov ham void (qoldiq o‘chiriladi)', async () => {
    const { svc, table } = setup([
      request({ id: '7', order_id: '7101' }),
      request({ id: '8', order_id: '7999' }),
    ]);
    const children = [{ id: '7101', total_price: 50000, product_quantity: 1 }];
    const orderRepo = {
      findOne: jest.fn().mockResolvedValue({ id: '7001', total_price: 100000 }),
      find: jest.fn().mockResolvedValue(children),
      save: jest.fn((row: Row) => Promise.resolve(row)),
    };
    const itemRepo = {
      find: jest.fn().mockResolvedValue([]),
      save: jest.fn(),
      create: jest.fn(),
    };
    const manager = extraCostManager({ table, orderRepo });
    const base = manager.getRepository.getMockImplementation()!;
    manager.getRepository.mockImplementation((entity: unknown) =>
      (entity as { name?: string })?.name === 'OrderItem'
        ? itemRepo
        : base(entity),
    );
    Object.assign(svc, {
      removeOrderFromSearch: jest.fn().mockResolvedValue(undefined),
      syncOrderToSearch: jest.fn().mockResolvedValue(undefined),
    });

    const merged = await svc.mergePartialChildrenBack(
      manager,
      { id: '7001' },
      { id: '1' },
    );

    expect(merged).toBe(1);
    // Qoldiqlar qulf bilan o'qiladi (buyurtma → so'rov tartibi, deadlock yo'q).
    expect(orderRepo.find).toHaveBeenCalledWith(
      expect.objectContaining({ lock: { mode: 'pessimistic_write' } }),
    );
    expect(table.row('7')).toMatchObject({
      status: 'void',
      closed_reason: 'Buyurtma orqaga qaytarildi',
    });
    expect(table.row('8')!.status).toBe('pending');
  });
});

/**
 * (hwTkXsGi, ko'rib chiqish) Market tasdig'ini qayta ijroda biznes xatosi
 * (400/403/404/409) so'rovni `void` qiladi, infratuzilma xatosi esa `pending`
 * qoldiradi. Lookup'lar RPC xatosini yutib, uni «ruxsat yo'q» 403 / «biriktirilmagan»
 * 400 / standart chegara 400 ga aylantirmasligi kerak — endi 503.
 */
describe('hwTkXsGi — infratuzilma xatosi biznes xatosi bo‘lib ko‘rinmaydi', () => {
  type Infra = {
    assertCanAddExtraCost: (params: {
      actor: { can_add_extra_cost?: boolean | null } | undefined;
      requester: { id: string; roles?: string[]; branch_id?: string | null };
      order: { branch_id?: string | null };
    }) => Promise<void>;
    assertExtraCostWithinLimit: (params: {
      extraCost: number;
      mode: 'sell' | 'cancel';
      whereDeliver: string;
      tariffCenter: number;
      tariffHome: number;
      engineError?: string | null;
    }) => void;
    resolveActorCourierId: (
      requester: { id: string; roles?: string[] },
      order: Row,
      post: Row | undefined,
      postLookupFailed?: boolean,
    ) => string;
    settleFailedExtraCostReplay: (
      approval: Row,
      error: unknown,
      actorId: string | null,
    ) => Promise<never>;
    lockWaitingOrder: (tx: unknown, orderId: string) => Promise<Row>;
  };

  const COURIER = { id: '289', roles: ['courier'], branch_id: '77' };
  const ORDER = { branch_id: '77' };
  const timeout = () => Promise.reject(new Error('Timeout has occurred'));

  function infra(lookup: Row = {}) {
    const svc = Object.create(OrderLifecycleService.prototype) as Infra &
      Record<string, unknown>;
    Object.assign(svc, {
      logger: { warn: jest.fn(), log: jest.fn(), error: jest.fn() },
      lookup,
    });
    return svc;
  }

  const statusOf = async (promise: Promise<unknown>) => {
    const error = await promise.then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(RpcException);
    return (error as RpcException).getError() as {
      statusCode: number;
      message: string;
    };
  };

  it('⭐ filial biriktiruvi o‘qilmadi (timeout) — 503, 403 emas', async () => {
    const svc = infra({
      getBranchAssignmentByUserStrict: jest.fn(timeout),
      getBranchUsersStrict: jest.fn(),
    });

    const error = await statusOf(
      svc.assertCanAddExtraCost({
        actor: { can_add_extra_cost: false },
        requester: COURIER,
        order: ORDER,
      }),
    );

    expect(error.statusCode).toBe(503);
    expect(error.message).toMatch(/Filial ma'lumotini o'qib bo'lmadi/);
  });

  it('⭐ filial foydalanuvchilari o‘qilmadi — 503', async () => {
    const svc = infra({
      getBranchAssignmentByUserStrict: jest
        .fn()
        .mockResolvedValue({ branch_id: '77' }),
      getBranchUsersStrict: jest.fn(timeout),
    });

    const error = await statusOf(
      svc.assertCanAddExtraCost({
        actor: undefined,
        requester: COURIER,
        order: ORDER,
      }),
    );

    expect(error.statusCode).toBe(503);
  });

  it("⭐ menejer identity'dan o‘qilmagan (`user: null`) — ruxsat noma’lum, 503", async () => {
    const svc = infra({
      getBranchAssignmentByUserStrict: jest
        .fn()
        .mockResolvedValue({ branch_id: '77' }),
      getBranchUsersStrict: jest
        .fn()
        .mockResolvedValue([{ role: 'manager', user: null }]),
    });

    const error = await statusOf(
      svc.assertCanAddExtraCost({
        actor: undefined,
        requester: COURIER,
        order: ORDER,
      }),
    );

    expect(error.statusCode).toBe(503);
  });

  it('haqiqiy biznes holatlari o‘zgarmagan: biriktirilmagan — 403, menejer ruxsat bermagan — 403, ruxsat bor — o‘tadi', async () => {
    const unassigned = infra({
      getBranchAssignmentByUserStrict: jest.fn().mockResolvedValue(null),
    });
    expect(
      (
        await statusOf(
          unassigned.assertCanAddExtraCost({
            actor: undefined,
            requester: COURIER,
            order: ORDER,
          }),
        )
      ).statusCode,
    ).toBe(403);

    const branch = (canAdd: boolean) =>
      infra({
        getBranchAssignmentByUserStrict: jest
          .fn()
          .mockResolvedValue({ branch_id: '77' }),
        getBranchUsersStrict: jest.fn().mockResolvedValue([
          { role: 'courier', user: { id: '289' } },
          { role: 'manager', user: { id: '5', can_add_extra_cost: canAdd } },
        ]),
      });
    expect(
      (
        await statusOf(
          branch(false).assertCanAddExtraCost({
            actor: undefined,
            requester: COURIER,
            order: ORDER,
          }),
        )
      ).statusCode,
    ).toBe(403);
    await expect(
      branch(true).assertCanAddExtraCost({
        actor: undefined,
        requester: COURIER,
        order: ORDER,
      }),
    ).resolves.toBeUndefined();
  });

  it('⭐ narx dvigateli javob bermagan va standart chegaradan oshgan — 503; dvigatel xatosiz — avvalgidek 400', () => {
    const svc = infra();
    const limit = (engineError: string | null) => () =>
      svc.assertExtraCostWithinLimit({
        extraCost: 9000,
        mode: 'sell',
        whereDeliver: 'center',
        tariffCenter: 15000,
        tariffHome: 20000,
        engineError,
      });

    const unavailable = (() => {
      try {
        limit('timeout')();
      } catch (e) {
        return (e as RpcException).getError() as { statusCode: number };
      }
    })();
    expect(unavailable).toMatchObject({ statusCode: 503 });

    const business = (() => {
      try {
        limit(null)();
      } catch (e) {
        return (e as RpcException).getError() as { statusCode: number };
      }
    })();
    expect(business).toMatchObject({ statusCode: 400 });
  });

  it('⭐ pochta o‘qilmagan va kuryer faqat pochta orqali bog‘langan — 503; o‘qilgan — 400; buyurtmada biriktirilgan bo‘lsa pochta kerak emas', () => {
    const svc = infra();
    const failed = (() => {
      try {
        svc.resolveActorCourierId(
          COURIER,
          { courier_id: null, holder_courier_id: null },
          undefined,
          true,
        );
      } catch (e) {
        return (e as RpcException).getError() as { statusCode: number };
      }
    })();
    expect(failed).toMatchObject({ statusCode: 503 });

    expect(() =>
      svc.resolveActorCourierId(
        COURIER,
        { courier_id: null, holder_courier_id: null },
        { courier_id: '999' },
      ),
    ).toThrow(RpcException);

    expect(
      svc.resolveActorCourierId(
        COURIER,
        { courier_id: null, holder_courier_id: '289' },
        undefined,
        true,
      ),
    ).toBe('289');
  });

  it('⭐ qayta ijroda 503 — so‘rov pending qoladi, xato o‘zgarmay qaytadi; 403 — void + 409', async () => {
    const table = extraCostApprovalTable([request()]);
    const svc = infra();
    Object.assign(svc, { extraCostApprovalRepo: table });
    const unavailable = new RpcException({
      statusCode: 503,
      message: "Filial ma'lumotini o'qib bo'lmadi",
    });

    await expect(
      svc.settleFailedExtraCostReplay(request(), unavailable, '501'),
    ).rejects.toBe(unavailable);
    expect(table.row('7')!.status).toBe('pending');

    const closed = await svc
      .settleFailedExtraCostReplay(
        request(),
        new RpcException({
          statusCode: 403,
          message: "Bu filial manageriga qo'shimcha xarajat ruxsati berilmagan",
        }),
        '501',
      )
      .catch((e: unknown) => e);
    expect(closed).toBeInstanceOf(ExtraCostRequestClosedError);
    expect(table.row('7')).toMatchObject({
      status: 'void',
      closed_reason:
        "amalni bajarib bo'lmadi: Bu filial manageriga qo'shimcha xarajat ruxsati berilmagan",
    });
  });

  it('o‘chirilgan buyurtma (qo‘shib yuborilgan qisman sotuv qoldig‘i) — sotuv / so‘rov qulfi 400', async () => {
    const svc = infra();
    const tx = {
      getRepository: () => ({
        findOne: jest.fn().mockResolvedValue({
          id: '7101',
          status: Order_status.WAITING,
          isDeleted: true,
        }),
      }),
    };

    const error = await statusOf(svc.lockWaitingOrder(tx, '7101'));

    expect(error).toEqual({
      statusCode: 400,
      message: 'Buyurtma topilmadi yoki kutilmoqda (waiting) holatida emas',
    });
  });
});
