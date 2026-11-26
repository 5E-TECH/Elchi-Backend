import { RpcException } from '@nestjs/microservices';
import { BranchServiceService } from './branch-service.service';

/**
 * 9rzmWFVm — «Qabul va yaratish» → «Filial paketlari» registratorda ham.
 *
 * Avval: `GET /branches/with-sent-batches` registratorga BO'SH ro'yxat (u faqat
 * o'z filialini o'qiydi, manba filiallar filtrlab tashlanardi),
 * `GET /transfer-batches?source_branch_id=X` — 403. Endi registrator O'Z
 * filialiga (REGISTRATOR qatori bor filial) kelgan FORWARD paketlarni ko'radi;
 * sonlar faqat unga kelganlar bo'yicha. Boshqa rollar, RETURN va
 * `side=destination` o'zgarmagan.
 */
type Stubbed = {
  sendOrderCommand: jest.Mock;
  resolveAccessScope: jest.Mock;
  getRegionsByIds: jest.Mock;
  branchRepo: { find: jest.Mock };
  branchUserRepo: { find: jest.Mock; findOne: jest.Mock };
};

const HQ = '1';
const REGIONAL = '9';
const OTHER = '5';
const REGISTRATOR = { id: '77', roles: ['registrator'] };
const MANAGER = { id: '88', roles: ['manager'] };
const ADMIN = { id: '2', roles: ['admin'] };

type Assignment = { branch_id: string; role: string };

function make(
  assignments: Assignment[] = [{ branch_id: HQ, role: 'REGISTRATOR' }],
) {
  const svc = Object.create(BranchServiceService.prototype) as Stubbed &
    Pick<
      BranchServiceService,
      'findTransferBatches' | 'findBranchesWithSentBatches'
    >;
  svc.sendOrderCommand = jest.fn(
    (cmd: string, payload: { destination_branch_ids?: string[] }) => {
      if (cmd === 'order.transfer_batch.find_branches_with_sent') {
        // Butun kompaniya: 9 → HQ (2 ta), 5 → 9 (1 ta). Doira bilan — faqat HQ ga kelganlar.
        const scoped = payload?.destination_branch_ids;
        const items = scoped
          ? scoped.includes(HQ)
            ? [
                {
                  branch_id: REGIONAL,
                  sent_batches_count: 2,
                  sent_total_price: 700,
                },
              ]
            : []
          : [
              {
                branch_id: OTHER,
                sent_batches_count: 1,
                sent_total_price: 100,
              },
              {
                branch_id: REGIONAL,
                sent_batches_count: 3,
                sent_total_price: 900,
              },
            ];
        return Promise.resolve({
          data: { side: 'source', direction: 'FORWARD', items },
        });
      }
      if (cmd === 'order.transfer_batch.find_all') {
        return Promise.resolve({
          statusCode: 200,
          data: {
            items: [],
            meta: { page: 1, limit: 100, total: 0, totalPages: 1 },
          },
        });
      }
      return Promise.resolve({});
    },
  );
  // Registrator / menejer faqat biriktirilgan filialini o'qiydi (asl qoida).
  svc.resolveAccessScope = jest.fn(() =>
    Promise.resolve({
      readableBranchIds: new Set(assignments.map((a) => a.branch_id)),
      writableBranchIds: new Set<string>(),
      managerReadableBranchIds: new Set<string>(),
    }),
  );
  svc.getRegionsByIds = jest.fn(() => Promise.resolve(new Map()));
  svc.branchRepo = {
    find: jest.fn((opts: { where: { id: { value: string[] } } }) =>
      Promise.resolve(
        (opts.where.id.value ?? []).map((id) => ({
          id,
          name: `Filial ${id}`,
          phone_number: null,
        })),
      ),
    ),
  };
  svc.branchUserRepo = {
    find: jest.fn(() => Promise.resolve(assignments)),
    findOne: jest.fn(() => Promise.resolve(assignments[0] ?? null)),
  };
  return svc;
}

const sentCalls = (svc: Stubbed) =>
  (svc.sendOrderCommand.mock.calls as unknown[][])
    .filter(([cmd]) => cmd === 'order.transfer_batch.find_branches_with_sent')
    .map(([, payload]) => payload as Record<string, unknown>);

const findAllPayload = (svc: Stubbed) =>
  (svc.sendOrderCommand.mock.calls as unknown[][]).find(
    ([cmd]) => cmd === 'order.transfer_batch.find_all',
  )?.[1] as Record<string, unknown> | undefined;

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

type SentItems = {
  data: {
    items: Array<{
      id: string;
      sent_batches_count: number;
      sent_total_price: number;
    }>;
  };
};

describe('9rzmWFVm — GET /branches/with-sent-batches (registrator)', () => {
  const query = { side: 'source', direction: 'FORWARD' };

  it('HQ registratori — HQ ga paket yuborgan filial, son va summa faqat HQ ga kelganlar', async () => {
    const svc = make();
    const res = (await svc.findBranchesWithSentBatches(
      query,
      REGISTRATOR,
    )) as SentItems;
    expect(sentCalls(svc)).toEqual([
      { direction: 'FORWARD', side: 'source' },
      { direction: 'FORWARD', side: 'source', destination_branch_ids: [HQ] },
    ]);
    expect(res.data.items).toEqual([
      expect.objectContaining({
        id: REGIONAL,
        sent_batches_count: 2,
        sent_total_price: 700,
      }),
    ]);
  });

  it('avval (doirasiz) bo‘sh edi — endi ham boshqa filialga ketgan paket ko‘rinmaydi', async () => {
    const svc = make();
    const res = (await svc.findBranchesWithSentBatches(
      query,
      REGISTRATOR,
    )) as SentItems;
    expect(res.data.items.map((item) => item.id)).not.toContain(OTHER);
  });

  it('REGISTRATOR qatori bo‘lmasa (boshqa rol qatori) — doira yo‘q, ikkinchi so‘rov yo‘q', async () => {
    const svc = make([{ branch_id: HQ, role: 'COURIER' }]);
    const res = (await svc.findBranchesWithSentBatches(
      query,
      REGISTRATOR,
    )) as SentItems;
    expect(sentCalls(svc)).toHaveLength(1);
    expect(res.data.items).toEqual([]);
  });

  it.each([
    ['RETURN', { side: 'source', direction: 'RETURN' }],
    ['yo‘nalishsiz', { side: 'source' }],
    ['side=destination', { side: 'destination', direction: 'FORWARD' }],
  ])('%s — registrator doirasi qo‘llanmaydi', async (_label, q) => {
    const svc = make();
    await svc.findBranchesWithSentBatches(q, REGISTRATOR);
    expect(sentCalls(svc)).toHaveLength(1);
    expect(sentCalls(svc)[0]).not.toHaveProperty('destination_branch_ids');
  });

  it('menejer — o‘zgarmagan: faqat o‘qiy oladigan manba filiallari, doira so‘rovi yo‘q', async () => {
    const svc = make([{ branch_id: REGIONAL, role: 'MANAGER' }]);
    const res = (await svc.findBranchesWithSentBatches(
      query,
      MANAGER,
    )) as SentItems;
    expect(sentCalls(svc)).toHaveLength(1);
    expect(res.data.items).toEqual([
      expect.objectContaining({
        id: REGIONAL,
        sent_batches_count: 3,
        sent_total_price: 900,
      }),
    ]);
  });

  it('admin — o‘zgarmagan: hamma filial, butun kompaniya sonlari', async () => {
    const svc = make();
    const res = (await svc.findBranchesWithSentBatches(
      query,
      ADMIN,
    )) as SentItems;
    expect(sentCalls(svc)).toHaveLength(1);
    expect(
      res.data.items.map((item) => [item.id, item.sent_batches_count]),
    ).toEqual([
      [OTHER, 1],
      [REGIONAL, 3],
    ]);
  });
});

describe('9rzmWFVm — GET /transfer-batches?source_branch_id (registrator)', () => {
  const query = {
    source_branch_id: REGIONAL,
    status: 'SENT',
    direction: 'FORWARD',
    page: 1,
    limit: 100,
  };

  it('manba o‘qilmasa ham — manzil = registrator filiali bo‘lgan paketlar (avval 403)', async () => {
    const svc = make();
    expect(
      await statusOf(svc.findTransferBatches(query, REGISTRATOR)),
    ).toBeUndefined();
    expect(findAllPayload(svc)).toEqual(
      expect.objectContaining({
        source_branch_id: REGIONAL,
        destination_branch_ids: [HQ],
        status: 'SENT',
        direction: 'FORWARD',
      }),
    );
  });

  it('⛔ RETURN yoki yo‘nalishsiz — avvalgidek 403', async () => {
    for (const direction of ['RETURN', undefined]) {
      const svc = make();
      expect(
        await statusOf(
          svc.findTransferBatches({ ...query, direction }, REGISTRATOR),
        ),
      ).toBe(403);
      expect(findAllPayload(svc)).toBeUndefined();
    }
  });

  it('⛔ REGISTRATOR qatori yo‘q — 403', async () => {
    const svc = make([{ branch_id: HQ, role: 'COURIER' }]);
    expect(await statusOf(svc.findTransferBatches(query, REGISTRATOR))).toBe(
      403,
    );
  });

  it('⛔ menejer — o‘zgarmagan: begona manba 403', async () => {
    const svc = make([{ branch_id: OTHER, role: 'MANAGER' }]);
    expect(await statusOf(svc.findTransferBatches(query, MANAGER))).toBe(403);
  });

  it('o‘z filiali manba bo‘lsa — avvalgidek, manzil doirasi qo‘shilmaydi', async () => {
    const svc = make([{ branch_id: REGIONAL, role: 'REGISTRATOR' }]);
    await svc.findTransferBatches(query, REGISTRATOR);
    expect(findAllPayload(svc)).toEqual(
      expect.objectContaining({
        source_branch_id: REGIONAL,
        destination_branch_ids: undefined,
      }),
    );
  });

  it('admin — o‘zgarmagan', async () => {
    const svc = make();
    await svc.findTransferBatches(query, ADMIN);
    expect(findAllPayload(svc)).toEqual(
      expect.objectContaining({
        source_branch_id: REGIONAL,
        destination_branch_ids: undefined,
      }),
    );
    expect(svc.resolveAccessScope).not.toHaveBeenCalled();
  });
});
