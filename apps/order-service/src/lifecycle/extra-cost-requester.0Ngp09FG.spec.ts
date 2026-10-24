import { Logger } from '@nestjs/common';
import { of, throwError } from 'rxjs';
import { OrderLifecycleService } from './order-lifecycle.service';

/**
 * 0Ngp09FG — qo'shimcha xarajat so'rovida so'rovchi ismi va buyurtma raqami.
 *
 * Ilgari market kartasida `№{order_id}` (ichki id) va «rol · #user_id»
 * chiqardi — market pul qarorini kim so'raganini bilmay qabul qilardi.
 * Endi har bir so'rovda:
 *  - `order_number` — mijozga ko'rinadigan "EL-…" raqam;
 *  - `requested_by: { id, name }` — ism identity'dan BITTA batch so'rov
 *    bilan (ro'yxat, tasdiq/rad javoblari); identity yiqilsa ism `null`,
 *    ro'yxat baribir qaytadi.
 * Eski maydonlar (`order_id`, `requested_by_user_id/role`) o'zgarmaydi.
 */
type Row = Record<string, any>;

const approvalRow = (overrides: Row = {}): Row => ({
  id: '7',
  order_id: '76',
  market_id: '501',
  requested_by_user_id: '301',
  requested_by_role: 'courier',
  requester_branch_id: '77',
  action: 'sell',
  amount: 12000,
  proof_file_keys: [],
  operation_payload: { extraCost: 12000 },
  status: 'pending',
  isDeleted: false,
  auto_approved: false,
  createdAt: new Date('2026-10-24T08:00:00Z'),
  updatedAt: new Date('2026-10-24T08:00:00Z'),
  ...overrides,
});

function makeService(
  rows: Row[],
  identitySend: jest.Mock = jest.fn(() =>
    of({
      data: [
        { id: '301', name: 'Ali Kuryer' },
        { id: '302', name: '  Vali Menejer  ' },
      ],
    }),
  ),
) {
  const repo = {
    find: jest.fn().mockResolvedValue(rows),
    findOne: jest.fn(({ where }: { where: Row }) =>
      Promise.resolve(
        rows.find((row) => String(row.id) === String(where.id)) ?? null,
      ),
    ),
    createQueryBuilder: jest.fn(() => {
      const qb: Record<string, any> = {
        update: () => qb,
        set: () => qb,
        where: () => qb,
        andWhere: () => qb,
        returning: () => qb,
        execute: () => Promise.resolve({ affected: 1 }),
      };
      return qb;
    }),
  };
  const svc = Object.create(
    OrderLifecycleService.prototype,
  ) as OrderLifecycleService;
  Object.assign(svc, {
    extraCostApprovalRepo: repo,
    identityClient: { send: identitySend },
    outbox: { enqueue: jest.fn().mockResolvedValue(undefined) },
    activityLog: { log: jest.fn().mockResolvedValue(undefined) },
  });
  jest
    .spyOn(svc, 'sellOrder')
    .mockResolvedValue({ statusCode: 200, data: {} } as never);
  return { svc, repo, identitySend };
}

const market = { id: '501', roles: ['market'] };

beforeEach(() => {
  jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());

describe('0Ngp09FG — extra-cost so‘rovida so‘rovchi ismi va order_number', () => {
  it('⭐ ro‘yxat: order_number "EL-…", requested_by.name — BITTA identity batch (takroriy id bir marta)', async () => {
    const { svc, identitySend } = makeService([
      approvalRow({ id: '7', order_id: '76', requested_by_user_id: '301' }),
      approvalRow({
        id: '8',
        order_id: '81',
        requested_by_user_id: '302',
        requested_by_role: 'manager',
      }),
      approvalRow({ id: '9', order_id: '90', requested_by_user_id: '301' }),
    ]);

    const res: any = await svc.listExtraCostApprovals(market, {});

    expect(identitySend).toHaveBeenCalledTimes(1);
    expect(identitySend.mock.calls[0][0]).toEqual({
      cmd: 'identity.user.find_by_ids',
    });
    expect(identitySend.mock.calls[0][1].ids).toEqual(['301', '302']);
    expect(
      res.data.map((a: Row) => ({
        order_id: a.order_id,
        order_number: a.order_number,
        requested_by: a.requested_by,
      })),
    ).toEqual([
      {
        order_id: '76',
        order_number: 'EL-100076',
        requested_by: { id: '301', name: 'Ali Kuryer' },
      },
      {
        order_id: '81',
        order_number: 'EL-100081',
        requested_by: { id: '302', name: 'Vali Menejer' },
      },
      {
        order_id: '90',
        order_number: 'EL-100090',
        requested_by: { id: '301', name: 'Ali Kuryer' },
      },
    ]);
  });

  it('eski maydonlar o‘zgarmaydi (orqaga moslik)', async () => {
    const { svc } = makeService([approvalRow()]);

    const res: any = await svc.listExtraCostApprovals(market, {});

    expect(res.data[0]).toMatchObject({
      id: '7',
      order_id: '76',
      market_id: '501',
      requested_by_user_id: '301',
      requested_by_role: 'courier',
      amount: 12000,
      status: 'pending',
    });
  });

  it('identity yiqilsa — ro‘yxat baribir qaytadi, ism null', async () => {
    const { svc } = makeService(
      [approvalRow()],
      jest.fn(() => throwError(() => new Error('identity down'))),
    );

    const res: any = await svc.listExtraCostApprovals(market, {});

    expect(res.statusCode).toBe(200);
    expect(res.data[0].requested_by).toEqual({ id: '301', name: null });
    expect(res.data[0].order_number).toBe('EL-100076');
  });

  it('so‘rovchi topilmadi (o‘chirilgan) yoki ismi bo‘sh — name null', async () => {
    const { svc } = makeService(
      [
        approvalRow({ id: '7', requested_by_user_id: '301' }),
        approvalRow({ id: '8', requested_by_user_id: '999' }),
      ],
      jest.fn(() => of({ data: [{ id: '301', name: '   ' }] })),
    );

    const res: any = await svc.listExtraCostApprovals(market, {});

    expect(res.data.map((a: Row) => a.requested_by)).toEqual([
      { id: '301', name: null },
      { id: '999', name: null },
    ]);
  });

  it('bo‘sh ro‘yxat — identity chaqirilmaydi', async () => {
    const { svc, identitySend } = makeService([]);

    const res: any = await svc.listExtraCostApprovals(market, {});

    expect(res.data).toEqual([]);
    expect(identitySend).not.toHaveBeenCalled();
  });

  it('rad etish javobida ham requested_by.name va order_number', async () => {
    const { svc } = makeService([approvalRow()]);

    const res: any = await svc.rejectExtraCostApproval(market, '7', {});

    expect(res.data.approval).toMatchObject({
      order_number: 'EL-100076',
      requested_by: { id: '301', name: 'Ali Kuryer' },
      status: 'rejected',
    });
  });

  it('tasdiqlash javobida ham requested_by.name va order_number', async () => {
    const { svc } = makeService([approvalRow()]);

    const res: any = await svc.approveExtraCostApproval(market, '7');

    expect(res.data.approval).toMatchObject({
      order_number: 'EL-100076',
      requested_by: { id: '301', name: 'Ali Kuryer' },
      status: 'approved',
    });
  });

  it('kuryerning o‘z 202 javobi (serializer, ismsiz) — name null, order_number bor', () => {
    const svc = Object.create(OrderLifecycleService.prototype) as {
      serializeExtraCostApproval: (a: unknown) => Row;
    };

    const out = svc.serializeExtraCostApproval(approvalRow());

    expect(out.order_number).toBe('EL-100076');
    expect(out.requested_by).toEqual({ id: '301', name: null });
  });
});
