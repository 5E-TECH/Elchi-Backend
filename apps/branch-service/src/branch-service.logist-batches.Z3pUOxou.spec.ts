import { RpcException } from '@nestjs/microservices';
import { BranchServiceService } from './branch-service.service';

/**
 * Z3pUOxou — logist: filial paketlari ro'yxati va tafsiloti — faqat o'z
 * viloyatlariga boruvchi paketlar (`target_region_id IN` gateway uzatgan
 * `requester.region_ids`), faqat ko'rish.
 *
 * Avval logist filialga biriktirilmagani uchun 403 «Filial biriktirilmagan
 * foydalanuvchi» olardi. Endi: o'z viloyati — 200, boshqa viloyat — 400/403,
 * to'plam bo'sh — bo'sh sahifa. Filial xodimlari doirasi o'zgarmagan.
 */
type Stubbed = {
  sendOrderCommand: jest.Mock;
  resolveAccessScope: jest.Mock;
  getRegionsByIds: jest.Mock;
  branchRepo: { find: jest.Mock };
  branchUserRepo: { findOne: jest.Mock };
};

const LOGIST = { id: '42', roles: ['logist'], region_ids: ['5', '9'] };

const batch = (id: string, target_region_id: string | null) => ({
  id,
  source_branch_id: '1',
  destination_branch_id: '3',
  target_region_id,
  total_price: 250000,
  items: [{ id: `${id}-1`, order_id: '100', snapshot_price: 250000 }],
});

function make(listItems = [batch('601', '5'), batch('602', '7')]) {
  const svc = Object.create(BranchServiceService.prototype) as Stubbed &
    Pick<BranchServiceService, 'findTransferBatches' | 'findTransferBatchById'>;
  svc.sendOrderCommand = jest.fn((cmd: string, payload: { id?: string }) => {
    if (cmd === 'order.transfer_batch.find_all') {
      return Promise.resolve({
        statusCode: 200,
        data: {
          items: listItems,
          meta: { page: 1, limit: 20, total: listItems.length, totalPages: 1 },
        },
      });
    }
    if (cmd === 'order.transfer_batch.find_by_id') {
      return Promise.resolve({
        statusCode: 200,
        data: batch(String(payload?.id), payload?.id === '601' ? '5' : '7'),
      });
    }
    if (cmd === 'order.find_by_id_enriched') {
      return Promise.resolve({ id: '100', total_price: 250000 });
    }
    return Promise.resolve({});
  });
  svc.resolveAccessScope = jest.fn(() =>
    Promise.resolve({
      readableBranchIds: new Set<string>(),
      writableBranchIds: new Set<string>(),
      managerReadableBranchIds: new Set<string>(),
    }),
  );
  svc.getRegionsByIds = jest.fn(() =>
    Promise.resolve(new Map([['5', { id: '5', name: 'Samarqand' }]])),
  );
  svc.branchRepo = { find: jest.fn(() => Promise.resolve([])) };
  svc.branchUserRepo = {
    findOne: jest.fn(() => Promise.resolve({ branch_id: '3' })),
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
      : 'not-rpc';
  }
};

const findAllPayload = (svc: Stubbed) =>
  (svc.sendOrderCommand.mock.calls as unknown[][]).find(
    ([cmd]) => cmd === 'order.transfer_batch.find_all',
  )?.[1] as Record<string, unknown> | undefined;

describe('Z3pUOxou — GET /transfer-batches (logist)', () => {
  it('order-service’ga target_region_ids = o‘z viloyatlari; filial biriktiruvi so‘ralmaydi', async () => {
    const svc = make();
    const res = (await svc.findTransferBatches({ status: 'SENT' }, LOGIST)) as {
      data: { items: Array<{ id: string; region: unknown }> };
    };
    expect(findAllPayload(svc)).toEqual(
      expect.objectContaining({
        status: 'SENT',
        target_region_ids: ['5', '9'],
        source_branch_id: undefined,
        destination_branch_id: undefined,
      }),
    );
    expect(svc.branchUserRepo.findOne).not.toHaveBeenCalled();
    expect(svc.resolveAccessScope).not.toHaveBeenCalled();
    // Himoya: begona viloyat (7) qatori olib tashlanadi.
    expect(res.data.items.map((b) => b.id)).toEqual(['601']);
    expect(res.data.items[0].region).toEqual({ id: '5', name: 'Samarqand' });
  });

  it('o‘z viloyati filtri o‘tadi; ⛔ boshqa viloyat — 400 (order-service chaqirilmaydi)', async () => {
    const svc = make();
    await svc.findTransferBatches({ target_region_id: '9' }, LOGIST);
    expect(findAllPayload(svc)).toEqual(
      expect.objectContaining({
        target_region_id: '9',
        target_region_ids: ['5', '9'],
      }),
    );

    const denied = make();
    expect(
      await statusOf(
        denied.findTransferBatches({ target_region_id: '7' }, LOGIST),
      ),
    ).toBe(400);
    expect(denied.sendOrderCommand).not.toHaveBeenCalled();
  });

  it('region_ids yo‘q/bo‘sh — bo‘sh sahifa (fail-closed), order-service chaqirilmaydi', async () => {
    for (const requester of [
      { id: '42', roles: ['logist'] },
      { id: '42', roles: ['logist'], region_ids: [] },
      { id: '42', roles: ['logist'], region_ids: ['x'] },
    ]) {
      const svc = make();
      const res = (await svc.findTransferBatches({}, requester)) as {
        data: { items: unknown[]; meta: { total: number } };
      };
      expect(res.data.items).toEqual([]);
      expect(res.data.meta.total).toBe(0);
      expect(svc.sendOrderCommand).not.toHaveBeenCalled();
    }
  });

  it('filial xodimi doirasi o‘zgarmagan (region_ids e’tiborsiz)', async () => {
    const svc = make();
    await svc.findTransferBatches({}, {
      id: '20',
      roles: ['manager'],
      region_ids: ['5'],
    } as never);
    expect(svc.branchUserRepo.findOne).toHaveBeenCalled();
    expect(findAllPayload(svc)).toEqual(
      expect.objectContaining({ source_branch_id: '3' }),
    );
    expect(findAllPayload(svc)).not.toHaveProperty('target_region_ids');
  });
});

describe('Z3pUOxou — GET /transfer-batches/:id (logist)', () => {
  it('o‘z viloyatiga boruvchi paket — 200 (filial ruxsati talab qilinmaydi)', async () => {
    const svc = make();
    const res = (await svc.findTransferBatchById('601', LOGIST)) as {
      id: string;
    };
    expect(res.id).toBe('601');
    expect(svc.resolveAccessScope).not.toHaveBeenCalled();
  });

  it('⛔ boshqa viloyat yoki viloyatsiz paket — 403', async () => {
    const svc = make();
    expect(await statusOf(svc.findTransferBatchById('602', LOGIST))).toBe(403);
    const noRegions = make();
    expect(
      await statusOf(
        noRegions.findTransferBatchById('601', {
          id: '42',
          roles: ['logist'],
        } as never),
      ),
    ).toBe(403);
  });
});
