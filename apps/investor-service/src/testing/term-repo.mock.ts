import { InvestorShareTerm } from '../entities/investor-share-term.entity';

/**
 * Spec'lar uchun xotiradagi `investor_share_terms` reposi: `find` (investor +
 * isDeleted, `effective_from` bo'yicha), `create`, `save`, `update` va
 * `manager.transaction` (ichida shu repo va berilgan investor reposi).
 */
export function makeTermRepo(
  initial: Array<Partial<InvestorShareTerm>> = [],
  investorRepo?: { save: (row: unknown) => unknown },
) {
  const rows: Array<Record<string, any>> = initial.map((row, index) => ({
    id: String(index + 1),
    isDeleted: false,
    effective_to: null,
    profit_basis: 'net',
    note: null,
    created_by: null,
    ...row,
  }));
  let nextId = rows.length + 1;
  const repo: any = {
    rows,
    find: jest.fn((options: { where?: Record<string, unknown> }) => {
      const where = options?.where ?? {};
      return Promise.resolve(
        rows
          .filter(
            (row) =>
              (where.investor_id === undefined ||
                String(row.investor_id) === String(where.investor_id as string)) &&
              (where.isDeleted === undefined ||
                row.isDeleted === where.isDeleted),
          )
          .sort((a, b) =>
            String(a.effective_from).localeCompare(String(b.effective_from)),
          )
          .map((row) => ({ ...row })),
      );
    }),
    create: jest.fn((dto: Record<string, unknown>) => ({ ...dto })),
    save: jest.fn((row: Record<string, any>) => {
      if (row.id) {
        const existing = rows.find((r) => r.id === String(row.id));
        if (existing) Object.assign(existing, row);
        return Promise.resolve({ ...row });
      }
      const saved = { isDeleted: false, ...row, id: String(nextId++) };
      rows.push(saved);
      return Promise.resolve({ ...saved });
    }),
    update: jest.fn(
      (criteria: { id: string }, patch: Record<string, unknown>) => {
        const row = rows.find((r) => r.id === String(criteria.id));
        if (row) Object.assign(row, patch);
        return Promise.resolve({ affected: row ? 1 : 0 });
      },
    ),
  };
  const fallbackInvestorRepo = {
    save: jest.fn((row: unknown) => Promise.resolve(row)),
  };
  repo.manager = {
    transaction: jest.fn((cb: (manager: unknown) => unknown) =>
      Promise.resolve(
        cb({
          getRepository: (entity: unknown) =>
            entity === InvestorShareTerm
              ? repo
              : (investorRepo ?? fallbackInvestorRepo),
        }),
      ),
    ),
  };
  return repo;
}
