/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call */
import { createMemoryBranchService } from '../test/branch-memory-repo';

/**
 * cI5gqN90 — filial ro'yxati va detalida XODIMLAR doim 0, SANA doim bugun
 * edi: backend `employees_count` ni umuman yubormasdi, `created_at` esa
 * faqat camelCase (`createdAt`) bo'lib kelardi. Endi GET /branches va GET
 * /branches/:id ikkalasi ham haqiqiy `employees_count` (detal jadvali —
 * GET /branches/:id/users — bilan AYNI qoida) va `created_at` ni beradi.
 */
describe('cI5gqN90 — employees_count va created_at', () => {
  const ADMIN = { id: '1', roles: ['admin'] };

  async function world() {
    const w = createMemoryBranchService();
    const hq: any = await w.service.createBranch(
      { name: 'Bosh ofis', type: 'HQ', code: 'HQ' },
      ADMIN,
    );
    const hqId = String(hq.data.id);
    const a: any = await w.service.createBranch(
      { name: 'Andijon', type: 'REGIONAL', code: 'AND', parent_id: hqId },
      ADMIN,
    );
    const b: any = await w.service.createBranch(
      { name: 'Buxoro', type: 'REGIONAL', code: 'BUX', parent_id: hqId },
      ADMIN,
    );
    const andijon = String(a.data.id);
    const buxoro = String(b.data.id);
    // Andijonda 3 xodim (menejer, registrator, kuryer) + 1 o'chirilgan
    // biriktiruv; Buxoroda 1 kuryer.
    for (const row of [
      { branch_id: andijon, user_id: '11', role: 'MANAGER' },
      { branch_id: andijon, user_id: '12', role: 'REGISTRATOR' },
      { branch_id: andijon, user_id: '13', role: 'COURIER' },
      { branch_id: andijon, user_id: '14', role: 'COURIER', isDeleted: true },
      { branch_id: buxoro, user_id: '21', role: 'COURIER' },
    ]) {
      await w.branchUserRepo.save(row);
    }
    return { ...w, hqId, andijon, buxoro };
  }

  it('⭐ 3 xodimli filial: GET /branches va GET /branches/:id da employees_count = 3', async () => {
    const { service, andijon, buxoro, hqId } = await world();

    const list: any = await service.findAllBranches({ limit: 100 }, ADMIN);
    const byId = (id: string) =>
      list.data.items.find((row: any) => String(row.id) === id);
    expect(byId(andijon).employees_count).toBe(3);
    expect(byId(buxoro).employees_count).toBe(1);
    expect(byId(hqId).employees_count).toBe(0);

    const detail: any = await service.findBranchById(andijon, ADMIN);
    expect(detail.data.employees_count).toBe(3);
  });

  it('⭐ XODIMLAR soni detal jadvalidagi (GET /branches/:id/users) qatorlar soniga teng', async () => {
    const { service, andijon, buxoro } = await world();

    for (const id of [andijon, buxoro]) {
      const detail: any = await service.findBranchById(id, ADMIN);
      const users: any = await service.findUsersByBranch(id, ADMIN);
      expect(detail.data.employees_count).toBe(users.data.length);
    }
  });

  it('⭐ created_at — haqiqiy yaratilgan sana (createdAt), bugungi kun EMAS', async () => {
    const { service, andijon, branchRepo } = await world();
    const stored = branchRepo.rows.find((r) => r.id === andijon)!;
    stored.createdAt = new Date('2026-06-02T05:00:00.000Z');

    const list: any = await service.findAllBranches({ limit: 100 }, ADMIN);
    const row = list.data.items.find((r: any) => String(r.id) === andijon);
    expect(row.created_at).toEqual(new Date('2026-06-02T05:00:00.000Z'));
    expect(row.createdAt).toEqual(row.created_at);
    expect(JSON.parse(JSON.stringify(row)).created_at).toBe(
      '2026-06-02T05:00:00.000Z',
    );

    const detail: any = await service.findBranchById(andijon, ADMIN);
    expect(detail.data.created_at).toEqual(
      new Date('2026-06-02T05:00:00.000Z'),
    );
  });

  it('bitta sahifa uchun bitta branch_users so`rovi (filial soniga bog`liq emas)', async () => {
    const { service, branchUserRepo } = await world();
    const findSpy = jest.spyOn(branchUserRepo, 'find');

    await service.findAllBranches({ limit: 100 }, ADMIN);

    const countCalls = findSpy.mock.calls.filter(
      ([options]: any[]) => !options?.where?.role,
    );
    expect(countCalls).toHaveLength(1);
  });

  it("filial bo'lmasa — xato yo'q, bo'sh ro'yxat", async () => {
    const { service } = createMemoryBranchService();
    const list: any = await service.findAllBranches({ limit: 10 }, ADMIN);
    expect(list.data.items).toEqual([]);
  });
});
