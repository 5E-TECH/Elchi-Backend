import { of, throwError } from 'rxjs';
import { OrderGatewayController } from './order-gateway.controller';
import {
  BRANCH_CONTACT_CACHE_TTL_MS,
  BranchContactLoader,
  branchContactScope,
  withBranchContact,
} from './contacts/branch-contact';

/**
 * 0Rn5U6AD (P0, ega 2026-11-20) — GET /orders/:id: filial kontakti (telefon,
 * menejer) va kuryer kontakti birga; market va kuryerga filial kontakti yo'q.
 */
type Row = Record<string, any>;

const CONTACT = {
  id: '3',
  name: 'Andijon filiali',
  phone_number: '+998742001122',
  manager: { id: '5', name: 'Menejer', phone_number: '+998900000005' },
};

const order = (over: Row = {}): Row => ({
  id: '81',
  market_id: '16',
  customer_id: '29',
  status: 'received',
  branch_id: '3',
  home_branch_id: '3',
  holder_branch_id: '3',
  holder_type: 'BRANCH',
  courier_id: null,
  courier: null,
  total_price: 100000,
  branch: { id: '3', name: 'Andijon filiali' },
  customer: { id: '29', name: 'Mijoz' },
  market: { id: '16', name: 'Market' },
  ...over,
});

const user = (roles: string[], sub: string, branchId?: string) =>
  ({
    user: {
      sub,
      username: 'u',
      roles,
      ...(branchId ? { branch_id: branchId } : {}),
    },
  }) as never;

const gateway = (
  row: Row,
  contact: unknown = { statusCode: 200, data: CONTACT },
) => {
  const branchSend = jest.fn(({ cmd }: { cmd: string }) => {
    if (cmd === 'branch.contact') {
      return contact instanceof Error ? throwError(() => contact) : of(contact);
    }
    return cmd === 'branch.find_hq'
      ? of({ statusCode: 200, data: { id: '1' } })
      : cmd === 'branch.user.find_by_user'
        ? of({ data: { branch_id: '3', role: 'REGISTRATOR' } })
        : of({ data: [] });
  });
  const controller = new OrderGatewayController(
    {
      send: jest.fn(({ cmd }: { cmd: string }) =>
        of(cmd === 'order.find_by_id_enriched' ? row : { data: null }),
      ),
    } as never,
    { send: jest.fn(() => of({ data: { market_id: '16' } })) } as never,
    { send: jest.fn(() => of({ data: null })) } as never,
    { send: branchSend } as never,
  );
  const contactCalls = () =>
    branchSend.mock.calls.filter(([p]) => p.cmd === 'branch.contact');
  return { controller, contactCalls };
};

describe('0Rn5U6AD — GET /orders/:id filial va kuryer kontakti', () => {
  it.each([
    ['superadmin', '1', undefined],
    ['admin', '2', undefined],
    ['registrator', '7', '3'],
    ['manager', '5', '3'],
  ])(
    '⭐ %s: kuryersiz buyurtmada ham filial telefoni va menejeri',
    async (role, sub, branchId) => {
      const { controller } = gateway(order());
      const res: any = await controller.findById(
        '81',
        user([role], sub, branchId),
      );
      expect(res.branch).toEqual(CONTACT);
      expect(res.courier).toBeNull();
    },
  );

  it('⭐ registrator: kuryerli buyurtmada filial VA kuryer kontakti birga', async () => {
    const courier = {
      id: '26',
      name: 'Jasur',
      phone_number: '+998911112233',
    };
    const { controller } = gateway(order({ courier_id: '26', courier }));
    const res: any = await controller.findById(
      '81',
      user(['registrator'], '7', '3'),
    );
    expect(res.branch.phone_number).toBe('+998742001122');
    expect(res.branch.manager.phone_number).toBe('+998900000005');
    expect(res.courier).toEqual(courier);
  });

  it.each([
    ['market', '16', undefined],
    ['courier', '26', '3'],
  ])(
    '⭐ %s: filial telefoni va menejeri YO`Q, so`rov ham ketmaydi',
    async (role, sub, branchId) => {
      const { controller, contactCalls } = gateway(
        order({
          courier_id: '26',
          holder_type: 'COURIER',
          holder_courier_id: '26',
        }),
      );
      const res: any = await controller.findById(
        '81',
        user([role], sub, branchId),
      );
      expect(res.branch).toEqual({ id: '3', name: 'Andijon filiali' });
      expect(contactCalls()).toHaveLength(0);
    },
  );

  it('⭐ menejer: boshqa filial buyurtmasida kontakt yo`q', async () => {
    // Buyurtma filiali boshqa (9), posilka shu menejer filialida (3).
    const { controller, contactCalls } = gateway(
      order({ branch_id: '9', branch: { id: '9', name: 'Boshqa' } }),
    );
    const res: any = await controller.findById(
      '81',
      user(['manager'], '5', '3'),
    );
    expect(res.branch).toEqual({ id: '9', name: 'Boshqa' });
    expect(contactCalls()).toHaveLength(0);
  });

  it.each([
    ['branch-service javob bermadi', new Error('timeout')],
    ['buzuq javob', { data: { name: 'x' } }],
  ])('%s — buyurtma javobi buzilmaydi', async (_label, contact) => {
    const { controller } = gateway(order(), contact);
    const res: any = await controller.findById('81', user(['admin'], '2'));
    expect(res.id).toBe('81');
    expect(res.branch).toEqual({ id: '3', name: 'Andijon filiali' });
  });

  it('filialsiz buyurtma — so`rov ketmaydi', async () => {
    const { controller, contactCalls } = gateway(
      order({ branch_id: null, branch: null }),
    );
    const res: any = await controller.findById('81', user(['admin'], '2'));
    expect(res.branch).toBeNull();
    expect(contactCalls()).toHaveLength(0);
  });
});

describe('0Rn5U6AD — yuklovchi va yordamchilar', () => {
  it('kesh 60 s; xato javob keshlanmaydi', async () => {
    let reply: () => unknown = () => throwError(() => new Error('x'));
    const send = jest.fn(() => reply());
    const loader = new BranchContactLoader({ send } as never);
    let now = 0;
    loader.now = () => now;
    expect(await loader.find('3')).toBeNull();
    reply = () => of({ data: CONTACT });
    expect(await loader.find('3')).toEqual(CONTACT);
    expect(await loader.find(3)).toEqual(CONTACT);
    expect(send).toHaveBeenCalledTimes(2);
    now = BRANCH_CONTACT_CACHE_TTL_MS + 1;
    await loader.find('3');
    expect(send).toHaveBeenCalledTimes(3);
    expect(await loader.find('abc')).toBeNull();
    expect(send).toHaveBeenCalledTimes(3);
  });

  it('doira: rol bo`yicha', () => {
    expect(branchContactScope(['ADMIN'])).toBe('any');
    expect(branchContactScope(['manager', 'registrator'])).toBe('any');
    expect(branchContactScope(['branch'])).toBe('own');
    for (const roles of [['market'], ['courier'], ['logist'], [], undefined]) {
      expect(branchContactScope(roles)).toBe('none');
    }
  });

  it('o`ramli javob va `branch` siz qator', () => {
    const payload = { statusCode: 200, data: { id: '81' } };
    expect(withBranchContact(payload, CONTACT)).toEqual({
      statusCode: 200,
      data: { id: '81', branch: CONTACT },
    });
    expect(withBranchContact(payload, null)).toBe(payload);
  });
});
