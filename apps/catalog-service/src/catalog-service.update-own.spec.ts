import { RpcException } from '@nestjs/microservices';
import { of } from 'rxjs';
import { CatalogServiceService } from './catalog-service.service';

/**
 * tsEevElW — `catalog.product.update_own`: egalik market id bo'yicha
 * (operator uchun gateway biriktirilgan marketni yuboradi), activity log
 * aktyori esa operatorning o'zi.
 */
const make = (product: Record<string, unknown>) => {
  const activityLog = { log: jest.fn(), logChange: jest.fn() };
  // Aws1oApe: nom o'zgarsa registrga befarq dublikat tekshiruvi
  // (`createQueryBuilder ... getOne`) — bu yerda dublikat yo'q.
  const nameCheck = {
    select: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    getOne: jest.fn(() => Promise.resolve(null)),
  };
  const productRepo = {
    findOne: jest.fn(() => Promise.resolve({ ...product })),
    save: jest.fn((row: Record<string, unknown>) => Promise.resolve(row)),
    createQueryBuilder: jest.fn(() => nameCheck),
  };
  const svc = new CatalogServiceService(
    productRepo as any,
    { send: jest.fn(() => of({})) } as any,
    { send: jest.fn(() => of({ data: { id: '121', name: 'M' } })) } as any,
    activityLog as any,
  );
  return { svc, activityLog, productRepo };
};

describe('updateOwn (tsEevElW)', () => {
  it('⭐ TC3: operator (actor) o`z marketining mahsulotini tahrirlaydi — aktyor operator', async () => {
    const { svc, activityLog } = make({ id: '5', user_id: '121', name: 'A' });
    await svc.updateOwn(
      '5',
      '121',
      { name: 'B' },
      { id: '501', role: 'market_operator' },
    );
    expect(activityLog.logChange).toHaveBeenCalledWith(
      expect.objectContaining({
        user_id: '501',
        user_role: 'market_operator',
        new_value: expect.objectContaining({ name: 'B' }),
      }),
    );
  });

  it('⭐ TC3: begona marketning mahsuloti — 403, saqlanmaydi', async () => {
    const { svc, productRepo } = make({ id: '6', user_id: '202', name: 'A' });
    const error: unknown = await svc
      .updateOwn('6', '121', { name: 'B' }, { id: '501' })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RpcException);
    expect((error as RpcException).getError()).toMatchObject({
      statusCode: 403,
    });
    expect(productRepo.save).not.toHaveBeenCalled();
  });

  it('bo`sh egasi (user_id) — 403 (fail-closed)', async () => {
    const { svc, productRepo } = make({ id: '6', user_id: '202', name: 'A' });
    await expect(svc.updateOwn('6', '', { name: 'B' })).rejects.toBeInstanceOf(
      RpcException,
    );
    expect(productRepo.save).not.toHaveBeenCalled();
  });

  it('market (aktyorsiz) — avvalgidek user_role=market', async () => {
    const { svc, activityLog } = make({ id: '5', user_id: '121', name: 'A' });
    await svc.updateOwn('5', '121', { name: 'B' });
    expect(activityLog.logChange).toHaveBeenCalledWith(
      expect.objectContaining({ user_id: '121', user_role: 'market' }),
    );
  });
});
