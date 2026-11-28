import { Roles, Status } from '@app/common';
import { UserServiceService } from './user-service.service';
import { MarketOperatorMembershipStatus } from './entities/market-operator-membership.entity';
import type { MarketOperatorMembershipView } from './market-operator/market-operator-membership.service';

/**
 * Bitta operator — bir nechta market, 2-bosqich: identity `find_by_id`
 * market operatori uchun `operator_markets` (ochiq a'zoliklar) qaytaradi —
 * gateway operator doirasini shundan hisoblaydi.
 *
 *  - faqat doira uchun maydonlar (market_id, status, is_primary, ombor
 *    kaliti) — komissiya va market nomi YO'Q;
 *  - boshqa rollarda kalit yo'q;
 *  - a'zolik servisi yo'q yoki o'qish xatosi — kalit YO'Q (gateway eski
 *    `market_id` ga tushadi), `find_by_id` yiqilmaydi.
 */
const view = (
  market_id: string,
  status: MarketOperatorMembershipStatus,
  is_primary = false,
): MarketOperatorMembershipView => ({
  market_id,
  status,
  is_primary,
  commission_type: null,
  commission_value: 12,
  can_view_warehouse_stock: market_id === '20',
  accepted_at: '2026-11-01T00:00:00.000Z',
  market: {
    id: market_id,
    name: `Market ${market_id}`,
    status: 'active',
    add_order: true,
    is_deleted: false,
  },
});

function makeService(
  user: Record<string, unknown>,
  memberships?: { listForOperator: jest.Mock },
) {
  const repo = {
    findOne: jest.fn().mockResolvedValue({ ...user }),
    find: jest.fn().mockResolvedValue([]),
  };
  const send = jest.fn();
  const service = new UserServiceService(
    repo as never,
    { send } as never, // search
    { send } as never, // catalog
    { send } as never, // order
    { send } as never, // logistics
    { send } as never, // finance
    { send } as never, // branch
    { encrypt: jest.fn(), compare: jest.fn() } as never,
    { get: jest.fn() } as never,
    { log: jest.fn(), logChange: jest.fn() } as never,
    undefined, // authSessions
    undefined, // contacts
    undefined, // tempPasswords
    memberships as never,
  );
  return service;
}

const OPERATOR = {
  id: '55',
  name: 'Ali',
  role: Roles.MARKET_OPERATOR,
  status: Status.ACTIVE,
  market_id: '20',
  region_id: null,
  isDeleted: false,
  password: 'hash',
};

type Data = { data: Record<string, unknown> };

describe('identity find_by_id — operator_markets', () => {
  it('market operatori: ochiq a`zoliklar faqat doira maydonlari bilan (komissiyasiz, nomsiz), ichki va GET /users/:id yo`lida', async () => {
    const memberships = {
      listForOperator: jest
        .fn()
        .mockResolvedValue([
          view('20', MarketOperatorMembershipStatus.ACTIVE, true),
          view('10', MarketOperatorMembershipStatus.PENDING),
        ]),
    };
    const service = makeService(OPERATOR, memberships);

    const internal = (await service.findUserById('55')) as Data;
    expect(memberships.listForOperator).toHaveBeenCalledWith('55');
    expect(internal.data.operator_markets).toEqual([
      {
        market_id: '20',
        status: 'active',
        is_primary: true,
        can_view_warehouse_stock: true,
      },
      {
        market_id: '10',
        status: 'pending',
        is_primary: false,
        can_view_warehouse_stock: false,
      },
    ]);
    expect(internal.data.market_id).toBe('20');
    expect(internal.data.password).toBeUndefined();

    const withBranch = (await service.findUserById('55', {
      includeBranch: true,
    })) as Data;
    expect(withBranch.data.operator_markets).toEqual(
      internal.data.operator_markets,
    );
  });

  it('boshqa rol — kalit yo`q, a`zolik so`ralmaydi', async () => {
    const memberships = { listForOperator: jest.fn() };
    const service = makeService(
      { ...OPERATOR, id: '7', role: Roles.COURIER, market_id: null },
      memberships,
    );
    const res = (await service.findUserById('7')) as Data;
    expect(res.data).not.toHaveProperty('operator_markets');
    expect(memberships.listForOperator).not.toHaveBeenCalled();
  });

  it('a`zolik servisi yo`q yoki o`qish xatosi — kalit yo`q (gateway `market_id` ga tushadi), find_by_id yiqilmaydi', async () => {
    const without = (await makeService(OPERATOR).findUserById('55')) as Data;
    expect(without.data).not.toHaveProperty('operator_markets');
    expect(without.data.market_id).toBe('20');

    const failing = makeService(OPERATOR, {
      listForOperator: jest.fn().mockRejectedValue(new Error('db down')),
    });
    const res = (await failing.findUserById('55')) as Data;
    expect(res.data).not.toHaveProperty('operator_markets');
    expect(res.data.market_id).toBe('20');
  });

  it('a`zolik yo`q (bo`sh ro`yxat) — bo`sh `operator_markets` (gateway uchun «faol market yo`q»)', async () => {
    const service = makeService(OPERATOR, {
      listForOperator: jest.fn().mockResolvedValue([]),
    });
    const res = (await service.findUserById('55')) as Data;
    expect(res.data.operator_markets).toEqual([]);
  });
});
