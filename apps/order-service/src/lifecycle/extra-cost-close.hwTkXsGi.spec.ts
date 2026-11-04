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
    expect(table.row('7')).toMatchObject({
      status: 'void',
      closed_reason: 'Buyurtma orqaga qaytarildi',
    });
    expect(table.row('8')!.status).toBe('pending');
  });
});
