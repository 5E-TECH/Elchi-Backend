import { attachRollbackEligibility } from './order-rollback-field';

/** (2026-11-19, D1–D4) Ro'yxat / tafsilotga `rollback` maydoni. */
describe('attachRollbackEligibility', () => {
  const manager = { sub: '208', roles: ['manager'], branch_id: '15' };
  const reply = (items: Array<Record<string, unknown>>) =>
    jest.fn().mockResolvedValue({ statusCode: 200, data: { items } });

  it('ro`yxat ({ data: [...] }) — sahifaga BITTA so`rov, har qatorga qaror', async () => {
    const send = reply([
      { order_id: '1', allowed: true, code: null, message: null },
      {
        order_id: '2',
        allowed: false,
        code: 'SUPERADMIN_ONLY',
        message: 'Faqat superadmin qaytara oladi',
      },
    ]);
    const out = await attachRollbackEligibility(
      { data: [{ id: '1' }, { id: '2' }, { id: 'x' }], total: 3 },
      manager,
      send,
    );
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(
      { cmd: 'order.rollback_eligibility' },
      {
        order_ids: ['1', '2'],
        requester: { id: '208', roles: ['manager'], branch_id: '15' },
      },
    );
    expect(out).toEqual({
      data: [
        { id: '1', rollback: { allowed: true, code: null, message: null } },
        {
          id: '2',
          rollback: {
            allowed: false,
            code: 'SUPERADMIN_ONLY',
            message: 'Faqat superadmin qaytara oladi',
          },
        },
        { id: 'x' },
      ],
      total: 3,
    });
  });

  it('successRes({ data: [...] }) va tafsilot ({ data: {...} } / o`ramsiz) shakllari', async () => {
    const send = reply([
      { order_id: '7', allowed: true, code: null, message: null },
    ]);
    const nested = await attachRollbackEligibility(
      { statusCode: 200, data: { data: [{ id: '7' }], total: 1 } },
      manager,
      send,
    );
    expect(nested).toMatchObject({
      data: { data: [{ id: '7', rollback: { allowed: true } }] },
    });
    const wrapped = await attachRollbackEligibility(
      { data: { id: '7' } },
      manager,
      send,
    );
    expect(wrapped).toMatchObject({
      data: { id: '7', rollback: { allowed: true } },
    });
    const bare = await attachRollbackEligibility({ id: '7' }, manager, send);
    expect(bare).toMatchObject({ id: '7', rollback: { allowed: true } });
  });

  it('rollback qila olmaydigan rol — so`rovsiz NOT_ALLOWED_ROLE', async () => {
    const send = jest.fn();
    const out = await attachRollbackEligibility(
      { data: [{ id: '1' }] },
      { sub: '5', roles: ['registrator'] },
      send,
    );
    expect(send).not.toHaveBeenCalled();
    expect(out).toEqual({
      data: [
        {
          id: '1',
          rollback: {
            allowed: false,
            code: 'NOT_ALLOWED_ROLE',
            message:
              'Buyurtmani qaytarish faqat superadmin, menejer va kuryer uchun',
          },
        },
      ],
    });
  });

  it('order-service xatosi — `rollback: null`, ro`yxat yiqilmaydi', async () => {
    const send = jest.fn().mockRejectedValue(new Error('timeout'));
    const out = await attachRollbackEligibility(
      { data: [{ id: '1' }] },
      manager,
      send,
    );
    expect(out).toEqual({ data: [{ id: '1', rollback: null }] });
  });
});
