import { BranchServiceService } from './branch-service.service';

/** 0Rn5U6AD — `branch.contact`: filial telefoni va FAOL menejeri. */
type User = Record<string, unknown>;

const manager = (id: string, over: User = {}): User => ({
  id,
  name: `Menejer ${id}`,
  phone_number: `+99890000000${id}`,
  role: 'manager',
  status: 'active',
  salary: 5000000,
  ...over,
});

const make = (opts: {
  branch?: Record<string, unknown> | null;
  managerIds?: string[];
  users?: Map<string, User> | null;
}) => {
  const svc: any = Object.create(BranchServiceService.prototype);
  svc.branchRepo = {
    findOne: jest.fn(() =>
      Promise.resolve(
        opts.branch === undefined
          ? {
              id: '3',
              name: 'Andijon filiali',
              phone_number: '+998742001122',
              manager_id: null,
              per_order_share: 7000,
            }
          : opts.branch,
      ),
    ),
  };
  svc.branchUserRepo = {
    find: jest.fn(() =>
      Promise.resolve((opts.managerIds ?? []).map((user_id) => ({ user_id }))),
    ),
  };
  svc.getUsersByIdsBatch = jest.fn(() =>
    Promise.resolve(opts.users === undefined ? new Map() : opts.users),
  );
  return svc;
};

const statusOf = async (p: Promise<unknown>): Promise<number | undefined> => {
  try {
    await p;
    return undefined;
  } catch (e: any) {
    return e?.getError?.()?.statusCode;
  }
};

describe('branch.contact (0Rn5U6AD)', () => {
  it('⭐ telefon va menejer; faqat kontakt maydonlari (ulush, maosh yo`q)', async () => {
    const svc = make({
      managerIds: ['5'],
      users: new Map([['5', manager('5')]]),
    });
    expect((await svc.findBranchContact('3')).data).toEqual({
      id: '3',
      name: 'Andijon filiali',
      phone_number: '+998742001122',
      manager: {
        id: '5',
        name: 'Menejer 5',
        phone_number: '+998900000005',
      },
    });
  });

  it('⭐ bir nechta menejer: filial boshlig`i (`manager_id`) ustun; u faol emas — eng kichik id', async () => {
    const branch = {
      id: '3',
      name: 'F',
      phone_number: null,
      manager_id: '12',
    };
    const users = new Map([
      ['9', manager('9')],
      ['12', manager('12')],
      ['100', manager('100')],
    ]);
    const managerIds = ['100', '12', '9'];
    const head = await make({ branch, managerIds, users }).findBranchContact(
      '3',
    );
    expect(head.data.manager.id).toBe('12');

    users.set('12', manager('12', { status: 'inactive' }));
    const next = await make({ branch, managerIds, users }).findBranchContact(
      '3',
    );
    expect(next.data.manager.id).toBe('9');
  });

  it('menejer yo`q, o`chirilgan yoki identity javob bermadi — `manager: null`, telefon qoladi', async () => {
    for (const svc of [
      make({ managerIds: [] }),
      make({ managerIds: ['5'], users: null }),
      make({
        managerIds: ['5'],
        users: new Map([['5', manager('5', { isDeleted: true })]]),
      }),
      make({
        managerIds: ['5'],
        users: new Map([['5', manager('5', { role: 'courier' })]]),
      }),
    ]) {
      const { data } = await svc.findBranchContact('3');
      expect(data.manager).toBeNull();
      expect(data.phone_number).toBe('+998742001122');
    }
  });

  it('id noto`g`ri — 400; filial yo`q — 404', async () => {
    expect(await statusOf(make({}).findBranchContact('abc'))).toBe(400);
    expect(await statusOf(make({ branch: null }).findBranchContact('3'))).toBe(
      404,
    );
  });
});
