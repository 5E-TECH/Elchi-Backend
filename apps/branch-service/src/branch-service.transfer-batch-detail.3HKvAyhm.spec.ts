import { RpcException } from '@nestjs/microservices';
import { BranchServiceService } from './branch-service.service';

/**
 * 3HKvAyhm — `GET /transfer-batches/:id`: `source_branch` /
 * `destination_branch` `{ id, name }` (menejer ham ko'radi — `GET
 * branches/:id` faqat SA/admin); `GET /transfer-batches/:id/history` —
 * o'qiladigan tarix (ilgari faqat yozilardi, «Tarix» doim bo'sh edi).
 */
type Requester = { id: string; roles: string[] };
type Stubbed = {
  sendOrderCommand: jest.Mock;
  resolveAccessScope: jest.Mock;
  getRegionsByIds: jest.Mock;
  getUsersByIdsBatch: jest.Mock;
  branchRepo: { find: jest.Mock };
};

const MANAGER: Requester = { id: '25', roles: ['manager'] };
const OUTSIDER: Requester = { id: '77', roles: ['manager'] };

const BATCH = {
  id: '601',
  source_branch_id: '3',
  destination_branch_id: '1',
  target_region_id: null,
  items: [],
};
const HISTORY = [
  {
    id: '11',
    batch_id: '601',
    user_id: '25',
    action: 'CREATED',
    notes: null,
    created_at: '2026-10-24T08:00:00.000Z',
  },
  {
    id: '12',
    batch_id: '601',
    user_id: '25',
    action: 'SENT',
    notes: 'kuryer bilan',
    created_at: '2026-10-24T09:00:00.000Z',
  },
  {
    id: '13',
    batch_id: '601',
    user_id: '0',
    action: 'RECEIVED',
    notes: null,
    created_at: '2026-10-24T12:00:00.000Z',
  },
];

function make(users: Map<string, Record<string, unknown>> | null = null) {
  const svc = Object.create(BranchServiceService.prototype) as Stubbed &
    Pick<
      BranchServiceService,
      'findTransferBatchById' | 'findTransferBatchHistory'
    >;
  svc.sendOrderCommand = jest.fn((cmd: string) => {
    if (cmd === 'order.transfer_batch.find_by_id') {
      return Promise.resolve({ statusCode: 200, data: { ...BATCH } });
    }
    if (cmd === 'order.transfer_batch.history.find') {
      return Promise.resolve({ statusCode: 200, data: HISTORY });
    }
    return Promise.resolve({});
  });
  // Menejer 25 — faqat filial #3 (jo'natuvchi) ni o'qiy oladi.
  svc.resolveAccessScope = jest.fn((requester: Requester) =>
    Promise.resolve({
      readableBranchIds: new Set(requester.id === '25' ? ['3'] : []),
      writableBranchIds: new Set<string>(),
      managerReadableBranchIds: new Set<string>(),
    }),
  );
  svc.getRegionsByIds = jest.fn(() => Promise.resolve(new Map()));
  svc.getUsersByIdsBatch = jest.fn(() =>
    Promise.resolve(
      users ?? new Map([['25', { id: '25', name: 'Test Menejer' }]]),
    ),
  );
  svc.branchRepo = {
    find: jest.fn(() =>
      Promise.resolve([
        { id: '3', name: 'QA filial' },
        { id: '1', name: 'Bosh ofis' },
      ]),
    ),
  };
  return svc;
}

const statusOf = async (p: Promise<unknown>) => {
  try {
    await p;
    return undefined;
  } catch (e) {
    return e instanceof RpcException
      ? (e.getError() as { statusCode?: number }).statusCode
      : undefined;
  }
};

describe('3HKvAyhm — paket tafsilotida filial nomlari', () => {
  it('⭐ menejer (faqat jo‘natuvchi filial) — source_branch / destination_branch nomi bilan', async () => {
    const svc = make();
    const res = (await svc.findTransferBatchById('601', MANAGER)) as {
      source_branch: unknown;
      destination_branch: unknown;
      id: string;
    };
    expect(res.id).toBe('601');
    expect(res.source_branch).toEqual({ id: '3', name: 'QA filial' });
    expect(res.destination_branch).toEqual({ id: '1', name: 'Bosh ofis' });
    // Bitta so'rov, ikkala filial.
    expect(svc.branchRepo.find).toHaveBeenCalledTimes(1);
  });

  it('filial topilmasa — null (javob yiqilmaydi)', async () => {
    const svc = make();
    svc.branchRepo.find.mockResolvedValueOnce([{ id: '3', name: 'QA filial' }]);
    const res = (await svc.findTransferBatchById('601', {
      id: '1',
      roles: ['superadmin'],
    })) as { destination_branch: unknown };
    expect(res.destination_branch).toBeNull();
  });

  it('paketning hech bir filialiga kirishi yo‘q — 403 (avvalgidek)', async () => {
    const svc = make();
    expect(await statusOf(svc.findTransferBatchById('601', OUTSIDER))).toBe(
      403,
    );
  });
});

describe('3HKvAyhm — GET /transfer-batches/:id/history', () => {
  it('⭐ xronologik, action_label o‘zbekcha, foydalanuvchi {id, name}; tizim (0) — user null', async () => {
    const svc = make();
    const res = (await svc.findTransferBatchHistory('601', MANAGER)) as {
      statusCode: number;
      data: Array<{
        id: string;
        action: string;
        action_label: string;
        notes: string | null;
        user: unknown;
      }>;
    };
    expect(res.statusCode).toBe(200);
    expect(res.data.map((row) => [row.action, row.action_label])).toEqual([
      ['CREATED', 'Yaratildi'],
      ['SENT', "Jo'natildi"],
      ['RECEIVED', 'Qabul qilindi'],
    ]);
    expect(res.data[0].user).toEqual({ id: '25', name: 'Test Menejer' });
    expect(res.data[1].notes).toBe('kuryer bilan');
    expect(res.data[2].user).toBeNull();
    expect(svc.getUsersByIdsBatch).toHaveBeenCalledWith(['25', '25']);
    expect(svc.sendOrderCommand).toHaveBeenCalledWith(
      'order.transfer_batch.history.find',
      { id: '601' },
    );
  });

  it('kirish huquqi paket kabi — begona menejer 403, tarix so‘ralmaydi', async () => {
    const svc = make();
    expect(await statusOf(svc.findTransferBatchHistory('601', OUTSIDER))).toBe(
      403,
    );
    expect(svc.sendOrderCommand).not.toHaveBeenCalledWith(
      'order.transfer_batch.history.find',
      expect.anything(),
    );
  });

  it('identity javob bermasa — user null, ro‘yxat yiqilmaydi', async () => {
    const svc = make();
    svc.getUsersByIdsBatch.mockResolvedValueOnce(null);
    const res = (await svc.findTransferBatchHistory('601', MANAGER)) as {
      data: Array<{ user: unknown }>;
    };
    expect(res.data).toHaveLength(3);
    expect(res.data.every((row) => row.user === null)).toBe(true);
  });
});
