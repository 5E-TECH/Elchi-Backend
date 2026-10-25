import { RpcException } from '@nestjs/microservices';
import { of, throwError } from 'rxjs';
import { BranchServiceService } from './branch-service.service';

/**
 * j8hdXE1o — `GET /scan/:token` (BTB-/BTR-) → `branch.transfer_batch.find_by_token`:
 * qabul qiluvchi filial xodimi o'ziga kelgan paket QR'ini skanerlasa 403
 * olardi (token yo'li faqat jo'natuvchi filialni tekshirardi). Endi ID yo'li
 * (`GET /transfer-batches/:id`) bilan AYNI qoida: jo'natuvchi YOKI qabul
 * qiluvchi filial.
 *
 * dwJX3NjT (S1) — skan javobida filial/viloyat nomlari va `items[].order`
 * (mijoz, holat) — bitta `order.summary_by_ids` (100 tadan), fail-soft.
 */
type Requester = { id: string; roles: string[] };

// Paket: HQ (#1) → QA filial (#3), Buxoro (#6).
const BATCH = {
  id: '601',
  qr_code_token: 'BTB-a1b2c3',
  source_branch_id: '1',
  destination_branch_id: '3',
  target_region_id: '6',
  status: 'SENT',
  order_count: 2,
  total_price: 130000,
  items: [
    { id: '9001', order_id: '700', snapshot_price: 65000 },
    { id: '9002', order_id: '701', snapshot_price: 65000 },
  ],
};

const SUMMARIES: Record<string, Record<string, unknown>> = {
  '700': {
    id: '700',
    order_number: 'EL-100700',
    status: 'on the road',
    total_price: 65000,
    customer_name: 'Ali Valiyev',
    customer_phone: '+998901234567',
    region_name: 'Buxoro viloyati',
    district_name: 'Buxoro tumani',
  },
  '701': {
    id: '701',
    order_number: 'EL-100701',
    status: 'on the road',
    total_price: 65000,
    customer_name: null,
    customer_phone: null,
    region_name: null,
    district_name: null,
  },
};

/** Kim qaysi filialni o'qiy oladi (resolveAccessScope stub'i). */
const READABLE: Record<string, string[]> = {
  '25': ['3'], // QA filial menejeri — faqat QABUL QILUVCHI filial
  '26': ['3'], // QA filial kuryeri
  '40': ['1'], // HQ registratori — faqat JO'NATUVCHI filial
  '77': ['9'], // begona filial menejeri
};
const DEST_MANAGER: Requester = { id: '25', roles: ['manager'] };
const DEST_COURIER: Requester = { id: '26', roles: ['courier'] };
const SOURCE_REGISTRATOR: Requester = { id: '40', roles: ['registrator'] };
const OUTSIDER: Requester = { id: '77', roles: ['manager'] };
const MARKET: Requester = { id: '37', roles: ['market'] };

type Stubbed = Pick<BranchServiceService, 'findTransferBatchByToken'> & {
  orderClient: { send: jest.Mock };
  resolveAccessScope: jest.Mock;
  getRegionsByIds: jest.Mock;
  branchRepo: { find: jest.Mock };
  logger: { warn: jest.Mock };
};

function make(opts?: {
  batch?: Record<string, unknown>;
  summaries?: 'ok' | 'down';
  regions?: Map<string, unknown>;
}) {
  const svc = Object.create(BranchServiceService.prototype) as Stubbed;
  const batch = opts?.batch ?? BATCH;
  svc.orderClient = {
    send: jest.fn((pattern: { cmd: string }, payload: { ids?: string[] }) => {
      if (pattern.cmd === 'order.transfer_batch.find_by_qr') {
        return of({
          statusCode: 200,
          message: 'Transfer batch found',
          data: { ...batch },
        });
      }
      if (pattern.cmd === 'order.summary_by_ids') {
        if (opts?.summaries === 'down') {
          return throwError(() => new Error('order-service down'));
        }
        return of({
          statusCode: 200,
          data: (payload.ids ?? [])
            .map((id) => SUMMARIES[id] ?? { id, status: 'new' })
            .filter(Boolean),
        });
      }
      return of({});
    }),
  };
  svc.resolveAccessScope = jest.fn((requester: Requester) =>
    Promise.resolve({
      readableBranchIds: new Set(READABLE[requester.id] ?? []),
      writableBranchIds: new Set<string>(),
      managerReadableBranchIds: new Set<string>(),
    }),
  );
  svc.getRegionsByIds = jest.fn(() =>
    Promise.resolve(
      opts?.regions ??
        new Map([
          ['6', { id: '6', name: 'Buxoro viloyati', sato_code: '1706' }],
        ]),
    ),
  );
  svc.branchRepo = {
    find: jest.fn(() =>
      Promise.resolve([
        { id: '1', name: 'Bosh ofis' },
        { id: '3', name: 'QA filial' },
      ]),
    ),
  };
  svc.logger = { warn: jest.fn() };
  return svc;
}

const statusOf = async (p: Promise<unknown>) => {
  try {
    await p;
    return 200;
  } catch (e) {
    return e instanceof RpcException
      ? (e.getError() as { statusCode?: number }).statusCode
      : undefined;
  }
};

const summaryCalls = (svc: Stubbed) =>
  svc.orderClient.send.mock.calls.filter(
    ([pattern]: [{ cmd: string }]) => pattern.cmd === 'order.summary_by_ids',
  );

describe('j8hdXE1o — paket QR (token) yo`li: qabul qiluvchi filial zaxirasi', () => {
  it('⭐ qabul qiluvchi filial menejeri (faqat #3) — 403 EMAS, paket ochiladi', async () => {
    const svc = make();
    const res = (await svc.findTransferBatchByToken(
      'BTB-a1b2c3',
      DEST_MANAGER,
    )) as { statusCode: number; data: { id: string } };
    expect(res.statusCode).toBe(200);
    expect(res.data.id).toBe('601');
  });

  it('qabul qiluvchi filial kuryeri ham ko`radi', async () => {
    const svc = make();
    expect(
      await statusOf(svc.findTransferBatchByToken('BTB-a1b2c3', DEST_COURIER)),
    ).toBe(200);
  });

  it('jo`natuvchi filial xodimi — avvalgidek ko`radi', async () => {
    const svc = make();
    expect(
      await statusOf(
        svc.findTransferBatchByToken('BTB-a1b2c3', SOURCE_REGISTRATOR),
      ),
    ).toBe(200);
  });

  it('superadmin — doira tekshirilmaydi', async () => {
    const svc = make();
    expect(
      await statusOf(
        svc.findTransferBatchByToken('BTB-a1b2c3', {
          id: '1',
          roles: ['superadmin'],
        }),
      ),
    ).toBe(200);
    expect(svc.resolveAccessScope).not.toHaveBeenCalled();
  });

  it.each([
    ['begona filial menejeri', OUTSIDER],
    ['market', MARKET],
  ])(
    '%s — 403 (avvalgidek), buyurtma xulosasi so`ralmaydi',
    async (_label, requester) => {
      const svc = make();
      expect(
        await statusOf(svc.findTransferBatchByToken('BTB-a1b2c3', requester)),
      ).toBe(403);
      expect(summaryCalls(svc)).toHaveLength(0);
      expect(svc.branchRepo.find).not.toHaveBeenCalled();
    },
  );

  it('BTR- (qaytarish paketi) — xuddi shu qoida', async () => {
    const svc = make({
      batch: { ...BATCH, qr_code_token: 'BTR-z9', items: [] },
    });
    expect(
      await statusOf(svc.findTransferBatchByToken('BTR-z9', DEST_MANAGER)),
    ).toBe(200);
  });
});

describe('dwJX3NjT (S1) — paket skani mazmuni', () => {
  it('⭐ filial/viloyat nomlari va items[].order (mijoz, holat); eski maydonlar joyida', async () => {
    const svc = make();
    const res = (await svc.findTransferBatchByToken(
      'BTB-a1b2c3',
      DEST_COURIER,
    )) as {
      statusCode: number;
      message: string;
      data: Record<string, any>;
    };

    // Konvert va paket qatori o'zgarmagan (FE `unwrap` / `pickTyped`).
    expect(res.statusCode).toBe(200);
    expect(res.message).toBe('Transfer batch found');
    expect(res.data).toMatchObject({
      id: '601',
      qr_code_token: 'BTB-a1b2c3',
      status: 'SENT',
      order_count: 2,
      total_price: 130000,
      source_branch_id: '1',
      destination_branch_id: '3',
      target_region_id: '6',
    });

    expect(res.data.source_branch).toEqual({ id: '1', name: 'Bosh ofis' });
    expect(res.data.destination_branch).toEqual({ id: '3', name: 'QA filial' });
    expect(res.data.region).toEqual({ id: '6', name: 'Buxoro viloyati' });

    expect(res.data.items[0]).toEqual({
      id: '9001',
      order_id: '700',
      snapshot_price: 65000,
      order: {
        id: '700',
        order_number: 'EL-100700',
        status: 'on the road',
        total_price: 65000,
        region: 'Buxoro viloyati',
        district: 'Buxoro tumani',
        customer: { name: 'Ali Valiyev', phone_number: '+998901234567' },
      },
    });
    // Mijozsiz xulosa — customer null (bo'sh obyekt emas).
    expect(res.data.items[1].order).toMatchObject({
      id: '701',
      customer: null,
    });

    // BITTA xulosa so'rovi (N+1 emas).
    expect(summaryCalls(svc)).toHaveLength(1);
    expect(summaryCalls(svc)[0][1]).toEqual({ ids: ['700', '701'] });
    expect(svc.branchRepo.find).toHaveBeenCalledTimes(1);
  });

  it('xulosa xizmati javob bermasa — order null, skan YIQILMAYDI', async () => {
    const svc = make({ summaries: 'down' });
    const res = (await svc.findTransferBatchByToken(
      'BTB-a1b2c3',
      DEST_MANAGER,
    )) as { statusCode: number; data: { items: Array<{ order: unknown }> } };

    expect(res.statusCode).toBe(200);
    expect(res.data.items.map((item) => item.order)).toEqual([null, null]);
    expect(svc.logger.warn).toHaveBeenCalled();
  });

  it('filial nomlari o`qilmasa (DB xatosi) — null, skan yiqilmaydi', async () => {
    const svc = make();
    svc.branchRepo.find.mockRejectedValueOnce(new Error('db down'));
    const res = (await svc.findTransferBatchByToken(
      'BTB-a1b2c3',
      DEST_MANAGER,
    )) as { data: Record<string, unknown> };
    expect(res.data.source_branch).toBeNull();
    expect(res.data.destination_branch).toBeNull();
  });

  it('viloyat topilmasa — region null', async () => {
    const svc = make({ regions: new Map() });
    const res = (await svc.findTransferBatchByToken(
      'BTB-a1b2c3',
      DEST_MANAGER,
    )) as { data: Record<string, unknown> };
    expect(res.data.region).toBeNull();
  });

  it('100 tadan ortiq buyurtma — xulosa 100 talik bo`laklarda so`raladi', async () => {
    const items = Array.from({ length: 150 }, (_, i) => ({
      id: String(10_000 + i),
      order_id: String(1_000 + i),
    }));
    const svc = make({ batch: { ...BATCH, items } });
    const res = (await svc.findTransferBatchByToken(
      'BTB-a1b2c3',
      DEST_MANAGER,
    )) as { data: { items: Array<{ order: { id: string } | null }> } };

    const calls = summaryCalls(svc);
    expect(calls.map(([, payload]) => payload.ids.length)).toEqual([100, 50]);
    expect(res.data.items).toHaveLength(150);
    expect(res.data.items.every((item) => item.order !== null)).toBe(true);
    expect(res.data.items[149].order?.id).toBe('1149');
  });

  it('bo`sh paket — xulosa so`ralmaydi', async () => {
    const svc = make({ batch: { ...BATCH, items: [] } });
    const res = (await svc.findTransferBatchByToken(
      'BTB-a1b2c3',
      DEST_MANAGER,
    )) as { data: { items: unknown[] } };
    expect(res.data.items).toEqual([]);
    expect(summaryCalls(svc)).toHaveLength(0);
  });
});
