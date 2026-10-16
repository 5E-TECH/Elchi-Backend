/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access */
import { RpcException } from '@nestjs/microservices';
import { createMemoryBranchService } from '../test/branch-memory-repo';

/**
 * 8jtzNlFt — hamkor filial modeli (ownership / per_order_share) endi
 * create/update orqali o'rnatiladi va GET'da qaytadi. Pulga ta'sir qilgani
 * uchun invariant: OWNED ⇒ ulush 0, PARTNER ⇒ ulush > 0, HQ ⇒ faqat OWNED;
 * faqat admin/superadmin. Haqiqiy BranchServiceService xotiradagi jadval
 * ustida — GET aynan createBranch yozgan qatorni qaytaradi.
 */
describe('8jtzNlFt — filial ownership / per_order_share', () => {
  const ADMIN = { id: '1', roles: ['admin'] };
  const SUPERADMIN = { id: '2', roles: ['superadmin'] };

  const rpcErrorOf = async (promise: Promise<unknown>) => {
    try {
      await promise;
    } catch (error) {
      expect(error).toBeInstanceOf(RpcException);
      return (error as RpcException).getError() as {
        statusCode?: number;
        message?: string;
      };
    }
    throw new Error('chaqiruv rad etilishi kutilgandi');
  };

  async function world() {
    const w = createMemoryBranchService();
    const hq: any = await w.service.createBranch(
      { name: 'Bosh ofis', type: 'HQ', code: 'HQ' },
      SUPERADMIN,
    );
    return { ...w, hqId: String(hq.data.id) };
  }

  it("⭐ ownership='partner', per_order_share=5000 — 201, GET /branches/:id va GET /branches da shu qiymatlar", async () => {
    const { service, hqId, activityLog } = await world();

    const created: any = await service.createBranch(
      {
        name: 'Hamkor Samarqand',
        type: 'REGIONAL',
        code: 'SAM-P',
        parent_id: hqId,
        ownership: 'partner',
        per_order_share: '5000',
      },
      ADMIN,
    );

    expect(created.statusCode).toBe(201);
    expect(created.data).toMatchObject({
      ownership: 'partner',
      per_order_share: 5000,
    });
    expect(activityLog.log).toHaveBeenLastCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({
          ownership: 'partner',
          per_order_share: 5000,
        }),
      }),
    );

    const byId: any = await service.findBranchById(
      String(created.data.id),
      ADMIN,
    );
    expect(byId.data).toMatchObject({
      ownership: 'partner',
      per_order_share: 5000,
    });

    const list: any = await service.findAllBranches({ limit: 100 }, ADMIN);
    expect(
      list.data.items.find(
        (row: any) => String(row.id) === String(created.data.id),
      ),
    ).toMatchObject({ ownership: 'partner', per_order_share: 5000 });
  });

  it('per_order_share son (5000.5) ham qabul qilinadi', async () => {
    const { service, hqId } = await world();
    const res: any = await service.createBranch(
      {
        name: 'Hamkor 2',
        type: 'HYBRID',
        code: 'H-2',
        parent_id: hqId,
        ownership: 'partner',
        per_order_share: 5000.5,
      },
      ADMIN,
    );
    expect(res.data.per_order_share).toBe(5000.5);
  });

  it('maydonlarsiz — avvalgidek OWNED / 0 (eski xulq)', async () => {
    const { service, hqId } = await world();
    const res: any = await service.createBranch(
      { name: 'Oddiy', type: 'REGIONAL', code: 'ODD', parent_id: hqId },
      ADMIN,
    );
    expect(res.data).toMatchObject({ ownership: 'owned', per_order_share: 0 });
  });

  it.each([
    ['partner, ulushsiz', { ownership: 'partner' }],
    ['partner, ulush 0', { ownership: 'partner', per_order_share: '0' }],
    ['owned + musbat ulush', { ownership: 'owned', per_order_share: '5000' }],
    ['faqat musbat ulush (owned)', { per_order_share: '5000' }],
    ["noto'g'ri ownership", { ownership: 'franchise' }],
    ['manfiy ulush', { ownership: 'partner', per_order_share: '-100' }],
    ['3 kasr', { ownership: 'partner', per_order_share: '10.555' }],
    ['matn', { ownership: 'partner', per_order_share: 'abc' }],
  ])('%s — 400, hech narsa yozilmaydi', async (_label, extra) => {
    const { service, hqId, branchRepo } = await world();
    const before = branchRepo.rows.length;

    const err = await rpcErrorOf(
      service.createBranch(
        {
          name: 'Xato',
          type: 'REGIONAL',
          code: 'XATO',
          parent_id: hqId,
          ...extra,
        },
        ADMIN,
      ),
    );

    expect(err.statusCode).toBe(400);
    expect(branchRepo.rows.length).toBe(before);
  });

  it("HQ hamkor bo'la olmaydi — 400", async () => {
    const { service } = createMemoryBranchService();
    const err = await rpcErrorOf(
      service.createBranch(
        {
          name: 'Bosh ofis',
          type: 'HQ',
          code: 'HQ',
          ownership: 'partner',
          per_order_share: '5000',
        },
        SUPERADMIN,
      ),
    );
    expect(err).toEqual(expect.objectContaining({ statusCode: 400 }));
    expect(err.message).toContain('HQ');
  });

  it.each([
    ['menejer', { id: '9', roles: ['manager'] }],
    ['filial roli', { id: '9', roles: ['branch'] }],
    ["requester'siz", undefined],
  ])('%s ownership yubora olmaydi — 403', async (_label, requester) => {
    const { service, hqId, branchRepo } = await world();
    const before = branchRepo.rows.length;
    const err = await rpcErrorOf(
      service.createBranch(
        {
          name: 'Ruxsatsiz',
          type: 'REGIONAL',
          code: 'RUX',
          parent_id: hqId,
          ownership: 'partner',
          per_order_share: '5000',
        },
        requester as never,
      ),
    );
    expect(err.statusCode).toBe(403);
    expect(branchRepo.rows.length).toBe(before);
  });

  describe('updateBranch', () => {
    async function withBranch(extra: Record<string, unknown> = {}) {
      const w = await world();
      const res: any = await w.service.createBranch(
        {
          name: 'Namangan',
          type: 'REGIONAL',
          code: 'NAM',
          parent_id: w.hqId,
          ...extra,
        },
        ADMIN,
      );
      return { ...w, id: String(res.data.id) };
    }

    it('⭐ owned → partner 5000: saqlanadi, GET qaytaradi, jurnal eski/yangi', async () => {
      const { service, id, activityLog } = await withBranch();

      const res: any = await service.updateBranch(
        id,
        { ownership: 'partner', per_order_share: '5000' },
        ADMIN,
      );

      expect(res.data).toMatchObject({
        ownership: 'partner',
        per_order_share: 5000,
      });
      const byId: any = await service.findBranchById(id, ADMIN);
      expect(byId.data).toMatchObject({
        ownership: 'partner',
        per_order_share: 5000,
      });
      expect(activityLog.logChange).toHaveBeenCalledWith(
        expect.objectContaining({
          old_value: expect.objectContaining({
            ownership: 'owned',
            per_order_share: 0,
          }),
          new_value: expect.objectContaining({
            ownership: 'partner',
            per_order_share: 5000,
          }),
        }),
      );
    });

    it("partner filialda boshqa maydon o'zgarsa ulush saqlanadi; faqat ulush ham o'zgaradi", async () => {
      const { service, id } = await withBranch({
        ownership: 'partner',
        per_order_share: '5000',
      });

      const renamed: any = await service.updateBranch(
        id,
        { name: 'Namangan 2' },
        ADMIN,
      );
      expect(renamed.data).toMatchObject({
        ownership: 'partner',
        per_order_share: 5000,
      });

      const reshared: any = await service.updateBranch(
        id,
        { per_order_share: 7000 },
        ADMIN,
      );
      expect(reshared.data).toMatchObject({
        ownership: 'partner',
        per_order_share: 7000,
      });
    });

    it("partner → owned: ulush 0 ga tushadi (OWNED'da ulush yo'q)", async () => {
      const { service, id } = await withBranch({
        ownership: 'partner',
        per_order_share: '5000',
      });

      const res: any = await service.updateBranch(
        id,
        { ownership: 'owned' },
        ADMIN,
      );

      expect(res.data).toMatchObject({
        ownership: 'owned',
        per_order_share: 0,
      });
    });

    it('owned filialga faqat ulush — 400, qator o`zgarmaydi', async () => {
      const { service, id, branchRepo } = await withBranch();

      const err = await rpcErrorOf(
        service.updateBranch(id, { per_order_share: '5000' }, ADMIN),
      );

      expect(err.statusCode).toBe(400);
      expect(branchRepo.rows.find((r) => r.id === id)).toMatchObject({
        ownership: 'owned',
        per_order_share: 0,
      });
    });

    it('partner → ulush 0 — 400', async () => {
      const { service, id } = await withBranch({
        ownership: 'partner',
        per_order_share: '5000',
      });
      const err = await rpcErrorOf(
        service.updateBranch(id, { per_order_share: '0' }, ADMIN),
      );
      expect(err.statusCode).toBe(400);
    });

    it('menejer ownership o`zgartira olmaydi — 403', async () => {
      const { service, id } = await withBranch();
      // assertCanWriteBranch'dan o'tadi deb hisoblaymiz: tekshiruv
      // ownership qatlamida ham bor.
      jest
        .spyOn(service as any, 'assertCanWriteBranch')
        .mockResolvedValue(undefined);
      const err = await rpcErrorOf(
        service.updateBranch(
          id,
          { ownership: 'partner', per_order_share: '5000' },
          { id: '9', roles: ['manager'] },
        ),
      );
      expect(err.statusCode).toBe(403);
    });
  });
});
