/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call */
import { FindOperator } from 'typeorm';
import { IntegrationServiceService } from './integration-service.service';

/**
 * Qidiruv limitlari (2026-11-27): «Integratsiyalar → Manbalar» ro'yxatidagi «Integratsiya nomi bo'yicha qidirish»
 * faqat yuklangan sahifa (sukut 10 ta) ichida edi. Endi `search` — nomi yoki slug (ILIKE), sahifalashdan OLDIN.
 */
describe('integration.find_all — server qidiruvi (search)', () => {
  const make = () => {
    const findAndCount = jest.fn().mockResolvedValue([[], 0]);
    const find = jest.fn().mockResolvedValue([]);
    const service = Object.create(IntegrationServiceService.prototype);
    service.integrationRepo = { findAndCount, find };
    service.attachMarketsAndImports = jest.fn((rows: unknown) =>
      Promise.resolve(rows),
    );
    return { service, findAndCount, find };
  };

  const ilikeValue = (operator: unknown) => {
    expect(operator).toBeInstanceOf(FindOperator);
    const op = operator as FindOperator<string>;
    expect(op.type).toBe('ilike');
    return op.value;
  };

  it('search bo‘lsa — nomi YOKI slug, boshqa filtrlar ikkala shartda; sahifalash o‘zgarmaydi', async () => {
    const { service, findAndCount } = make();

    await service.findAllIntegrations({
      search: '  Shop ',
      status: 'active',
      page: 2,
      limit: 10,
    });

    const arg = findAndCount.mock.calls[0][0];
    expect(Array.isArray(arg.where)).toBe(true);
    expect(arg.where).toHaveLength(2);
    expect(ilikeValue(arg.where[0].name)).toBe('%Shop%');
    expect(ilikeValue(arg.where[1].slug)).toBe('%Shop%');
    for (const clause of arg.where) {
      expect(clause).toMatchObject({ isDeleted: false, is_active: true });
    }
    expect(arg.skip).toBe(10);
    expect(arg.take).toBe(10);
  });

  it('% va _ — oddiy belgi sifatida (escape)', async () => {
    const { service, findAndCount } = make();
    await service.findAllIntegrations({ search: '50%_a', page: 1 });
    expect(ilikeValue(findAndCount.mock.calls[0][0].where[0].name)).toBe(
      '%50\\%\\_a%',
    );
  });

  it('search yo‘q yoki bo‘sh — avvalgidek bitta where obyekti', async () => {
    const { service, findAndCount, find } = make();
    await service.findAllIntegrations({ search: '   ', page: 1, limit: 10 });
    expect(Array.isArray(findAndCount.mock.calls[0][0].where)).toBe(false);

    await service.findAllIntegrations({ search: 'abc' });
    expect(Array.isArray(find.mock.calls[0][0].where)).toBe(true);
  });
});
