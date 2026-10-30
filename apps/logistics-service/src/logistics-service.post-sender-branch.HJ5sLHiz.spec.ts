/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return */
import { of, throwError } from 'rxjs';
import { Post_status, Roles } from '@app/common';
import { LogisticsServiceService } from './logistics-service.service';

/**
 * T9 (HJ5sLHiz, BE-2) — «Pochta cheki»dagi «Qayerdan»: GET /post/orders/:id
 * meta'sida `post.branch = { id, name } | null`.
 *   - `branch_id` bor → `branch.find_by_id` TIZIM so'rovchisi bilan (boshqa
 *     filial menejeri ham nomni oladi);
 *   - `branch_id` null → HQ (`branch.find_hq`);
 *   - branch xizmati xatosi / topilmadi → `null`, javob 200;
 *   - faqat `id`, `name`.
 */
const BRANCHES: Record<string, Record<string, unknown>> = {
  '1': {
    id: '1',
    name: 'Toshkent HQ',
    type: 'HQ',
    code: 'HQ',
    region_id: '14',
  },
  '7': { id: '7', name: 'Buxoro filiali', type: 'REGIONAL', code: 'BX' },
};

function makeService(opts: {
  post: Record<string, unknown>;
  branchDown?: boolean;
  scopedBranchId?: string | null;
}) {
  const branchSend = jest.fn((pattern: { cmd: string }, payload: any) => {
    if (opts.branchDown) {
      return throwError(() => new Error('branch down'));
    }
    if (pattern.cmd === 'branch.find_hq') {
      return of({ data: BRANCHES['1'] });
    }
    if (pattern.cmd === 'branch.find_by_id') {
      return of({ data: BRANCHES[String(payload.id)] ?? null });
    }
    return of({ data: null });
  });
  const postRepo = {
    findOne: jest.fn(() => Promise.resolve({ ...opts.post })),
    save: jest.fn((p: unknown) => Promise.resolve(p)),
  };
  const service = new LogisticsServiceService(
    postRepo as any,
    {} as any,
    {} as any,
    { send: jest.fn(() => of({})) } as any, // order
    { send: branchSend } as any, // branch
    { send: jest.fn(() => of({ data: [] })) } as any, // identity
    { send: jest.fn(() => of({})) } as any, // search
    { log: jest.fn(), logChange: jest.fn() } as any,
  );
  jest
    .spyOn(service as any, 'resolveScopedBranchId')
    .mockResolvedValue(opts.scopedBranchId ?? null);
  jest.spyOn(service as any, 'findOrders').mockResolvedValue([]);
  return { service, branchSend };
}

const post = (over: Record<string, unknown>) => ({
  id: '90',
  status: Post_status.SENT,
  courier_id: '119',
  region_id: '6',
  region: { id: '6', name: 'Buxoro' },
  branch_id: '7',
  qr_code_token: 'POST-QR-90',
  order_quantity: 0,
  createdAt: new Date('2026-10-30T09:00:00.000Z'),
  ...over,
});

const ADMIN = { id: '1', roles: [Roles.ADMIN] };

describe('T9 (HJ5sLHiz, BE-2) — post.branch «Qayerdan»', () => {
  it('⭐ filial pochtasi → o`sha filial nomi; faqat id, name; tizim so`rovchisi', async () => {
    const { service, branchSend } = makeService({ post: post({}) });
    const res: any = await service.getPostOrders('90', ADMIN);
    expect(res.data.post.branch).toEqual({ id: '7', name: 'Buxoro filiali' });
    expect(res.data.post.branch_id).toBe('7');
    expect(branchSend).toHaveBeenCalledWith(
      { cmd: 'branch.find_by_id' },
      { id: '7', requester: { id: 'system', roles: [Roles.SUPERADMIN] } },
    );
  });

  it('⭐ HQ pochtasi (branch_id null) → HQ {id, name: "Toshkent HQ"}', async () => {
    const { service, branchSend } = makeService({
      post: post({ branch_id: null }),
    });
    const res: any = await service.getPostOrders('90', ADMIN);
    expect(res.data.post.branch).toEqual({ id: '1', name: 'Toshkent HQ' });
    expect(res.data.post.branch_id).toBeNull();
    expect(branchSend).toHaveBeenCalledWith({ cmd: 'branch.find_hq' }, {});
  });

  it('so`rovchi filialidan qat`i nazar (kuryer, boshqa filial) — nom tizim so`rovchisi bilan chiqadi', async () => {
    const { service } = makeService({
      post: post({ branch_id: '7', courier_id: '55' }),
      scopedBranchId: '3',
    });
    const res: any = await service.getPostOrders('90', {
      id: '55',
      roles: [Roles.COURIER],
    });
    expect(res.data.post.branch).toEqual({ id: '7', name: 'Buxoro filiali' });
  });

  it('branch xizmati o`chiq → branch: null, javob 200, branch_id o`zgarmaydi', async () => {
    const { service } = makeService({ post: post({}), branchDown: true });
    const res: any = await service.getPostOrders('90', ADMIN);
    expect(res.statusCode).toBe(200);
    expect(res.data.post.branch).toBeNull();
    expect(res.data.post.branch_id).toBe('7');
  });

  it('filial topilmadi → null', async () => {
    const { service } = makeService({ post: post({ branch_id: '999' }) });
    const res: any = await service.getPostOrders('90', ADMIN);
    expect(res.data.post.branch).toBeNull();
  });
});
