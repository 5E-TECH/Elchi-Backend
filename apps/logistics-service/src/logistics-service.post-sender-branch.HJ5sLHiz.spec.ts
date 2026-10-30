/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return */
import { NEVER, of, throwError } from 'rxjs';
import { Post_status, Roles } from '@app/common';
import { LogisticsServiceService } from './logistics-service.service';

/**
 * T9 (HJ5sLHiz, BE-2) — «Pochta cheki»dagi «Qayerdan»: GET /post/orders/:id
 * (`withSenderBranch`) meta'sida `post.branch = { id, name } | null` —
 * pochtani JO'NATGAN filial (`branch_id` ko'pincha manzil):
 *   - HQ → filial o'tkazmasi (kuryersiz SENT, branch_id = manzil) → HQ;
 *   - bekorlar HQ'ga (CANCELED, courier_id = menejer, branch_id = HQ) →
 *     menejerning filiali;
 *   - filial kuryeri pochtasi (branch_id null) → kuryer filiali;
 *   - HQ kuryeri pochtasi → HQ (kuryer HQ'ga biriktirilgan);
 *   - kuryersiz yig'ilayotgan NEW: branch_id → shu filial, null → HQ;
 *   - aniqlab bo'lmasa / xizmat xatosi / 5 s timeout → null, javob 200;
 *   - faqat `id`, `name`; tizim so'rovchisi; skan va dispatch so'ramaydi.
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
/** branch_users: foydalanuvchi → filial. */
const ASSIGNMENTS: Record<string, string> = {
  '119': '7', // Buxoro kuryeri
  '120': '1', // HQ kuryeri
  '55': '7', // Buxoro menejeri
};

type BranchMode = 'ok' | 'down' | 'never';

function makeService(opts: {
  post: Record<string, unknown>;
  branch?: BranchMode;
}) {
  const branchSend = jest.fn((pattern: { cmd: string }, payload: any) => {
    if (opts.branch === 'down') {
      return throwError(() => new Error('branch down'));
    }
    if (opts.branch === 'never') {
      return NEVER;
    }
    if (pattern.cmd === 'branch.find_hq') {
      return of({ data: BRANCHES['1'] });
    }
    if (pattern.cmd === 'branch.find_by_id') {
      return of({ data: BRANCHES[String(payload.id)] ?? null });
    }
    if (pattern.cmd === 'branch.user.find_by_user') {
      const branchId = ASSIGNMENTS[String(payload.user_id)];
      return of({
        data: branchId
          ? {
              user_id: payload.user_id,
              branch_id: branchId,
              role: 'COURIER',
              branch: BRANCHES[branchId],
            }
          : null,
      });
    }
    return of({ data: null });
  });
  const postRepo = {
    findOne: jest.fn(() => Promise.resolve({ ...opts.post })),
    // CANCELED pochtalar guruhi (`findCanceledPostGroup`).
    find: jest.fn(() => Promise.resolve([{ ...opts.post }])),
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
  jest.spyOn(service as any, 'resolveScopedBranchId').mockResolvedValue(null);
  jest.spyOn(service as any, 'findOrders').mockResolvedValue([]);
  return { service, branchSend };
}

const post = (over: Record<string, unknown>) => ({
  id: '90',
  status: Post_status.SENT,
  courier_id: '119',
  region_id: '6',
  region: { id: '6', name: 'Buxoro' },
  branch_id: null,
  qr_code_token: 'POST-QR-90',
  order_quantity: 0,
  createdAt: new Date('2026-10-30T09:00:00.000Z'),
  ...over,
});

const ADMIN = { id: '1', roles: [Roles.ADMIN] };
const DETAIL = { withSenderBranch: true };
const HQ = { id: '1', name: 'Toshkent HQ' };
const BUXORO = { id: '7', name: 'Buxoro filiali' };

const senderOf = async (
  over: Record<string, unknown>,
  branch: BranchMode = 'ok',
) => {
  const { service, branchSend } = makeService({ post: post(over), branch });
  const res: any = await service.getPostOrders('90', ADMIN, DETAIL);
  return { branch: res.data.post.branch, res, branchSend };
};

describe('T9 (HJ5sLHiz, BE-2) — post.branch «Qayerdan» (jo`natuvchi)', () => {
  it('⭐ HQ → filial o`tkazmasi (kuryersiz SENT, branch_id = manzil) → HQ', async () => {
    const { branch } = await senderOf({ courier_id: '0', branch_id: '7' });
    expect(branch).toEqual(HQ);
  });

  it('⭐ bekorlar HQ`ga (CANCELED, courier_id = menejer, branch_id = HQ) → menejer filiali', async () => {
    const { branch, branchSend } = await senderOf({
      status: Post_status.CANCELED,
      courier_id: '55',
      branch_id: '1',
    });
    expect(branch).toEqual(BUXORO);
    expect(branchSend).toHaveBeenCalledWith(
      { cmd: 'branch.user.find_by_user' },
      { user_id: '55', requester: { id: 'system', roles: [Roles.SUPERADMIN] } },
    );
  });

  it('⭐ filial kuryeri pochtasi (branch_id null) → kuryer filiali, HQ emas', async () => {
    const { branch } = await senderOf({ courier_id: '119', branch_id: null });
    expect(branch).toEqual(BUXORO);
  });

  it('HQ kuryeri pochtasi → HQ', async () => {
    const { branch } = await senderOf({ courier_id: '120' });
    expect(branch).toEqual(HQ);
  });

  it('kuryersiz NEW: branch_id → shu filial; null → HQ', async () => {
    expect(
      (
        await senderOf({
          status: Post_status.NEW,
          courier_id: '0',
          branch_id: '7',
        })
      ).branch,
    ).toEqual(BUXORO);
    expect(
      (
        await senderOf({
          status: Post_status.NEW,
          courier_id: '0',
          branch_id: null,
        })
      ).branch,
    ).toEqual(HQ);
  });

  it('aniqlab bo`lmaydi → null: biriktirilmagan kuryer, kuryersiz CANCELED', async () => {
    expect((await senderOf({ courier_id: '999' })).branch).toBeNull();
    expect(
      (await senderOf({ status: Post_status.CANCELED, courier_id: '0' }))
        .branch,
    ).toBeNull();
  });

  it('branch xizmati xatosi → null, 200, branch_id o`zgarmaydi', async () => {
    const { branch, res } = await senderOf({ branch_id: '7' }, 'down');
    expect(res.statusCode).toBe(200);
    expect(branch).toBeNull();
    expect(res.data.post.branch_id).toBe('7');
  });

  it('⭐ branch xizmati javob bermaydi → 5000 ms dan keyin null, 200', async () => {
    jest.useFakeTimers();
    try {
      const { service } = makeService({ post: post({}), branch: 'never' });
      let settled: any;
      const pending = service.getPostOrders('90', ADMIN, DETAIL).then((r) => {
        settled = r;
      });
      await jest.advanceTimersByTimeAsync(4999);
      expect(settled).toBeUndefined();
      await jest.advanceTimersByTimeAsync(1);
      await pending;
      expect(settled.statusCode).toBe(200);
      expect(settled.data.post.branch).toBeNull();
    } finally {
      jest.useRealTimers();
    }
  });

  it('faqat detal: skan / dispatch (withSenderBranch yo`q) — branch so`ralmaydi, kalit yo`q', async () => {
    const { service, branchSend } = makeService({ post: post({}) });
    const res: any = await service.getPostOrders('90', ADMIN);
    expect(res.data.post).not.toHaveProperty('branch');
    expect(branchSend).not.toHaveBeenCalled();
  });

  it('kalitlar faqat id, name (filialning boshqa maydonlari chiqmaydi)', async () => {
    const { branch } = await senderOf({ courier_id: '0', branch_id: '7' });
    expect(Object.keys(branch).sort()).toEqual(['id', 'name']);
  });
});
