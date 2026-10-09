import { of } from 'rxjs';
import { NotificationInboxService } from './notification-inbox.service';

/**
 * f2Ud5tju #6 — `notification.dispatched` jurnal qatorida entity_id qattiq
 * `'dispatch'` satri emas, haqiqiy dispatch partiyasi ID si.
 */
describe('NotificationInboxService.dispatch — jurnal entity_id (f2Ud5tju)', () => {
  function makeService() {
    let nextId = 500;
    const txRepo = {
      create: jest.fn((v: Record<string, unknown>) => ({ ...v })),
      insert: jest.fn((rows: unknown[]) =>
        Promise.resolve({
          identifiers: rows.map(() => ({ id: String(nextId++) })),
        }),
      ),
      find: jest.fn(({ where }: { where: { id?: { value: string[] } } }) =>
        Promise.resolve(
          (where.id?.value ?? []).map((id, i) => ({
            id,
            recipient_id: String(42 + i),
          })),
        ),
      ),
      update: jest.fn(),
    };
    const manager = { getRepository: jest.fn(() => txRepo) };
    const qb: Record<string, jest.Mock> = {};
    for (const m of ['update', 'set', 'setParameter', 'whereInIds']) {
      qb[m] = jest.fn(() => qb);
    }
    qb.execute = jest.fn().mockResolvedValue({ affected: 1 });
    const repo = {
      createQueryBuilder: jest.fn(() => qb),
      manager: {
        transaction: jest.fn((work: (m: unknown) => Promise<unknown>) =>
          work(manager),
        ),
      },
    };
    const activityLog = { log: jest.fn().mockResolvedValue(undefined) };
    const service = new NotificationInboxService(
      repo as never,
      { send: jest.fn() } as never,
      { emit: jest.fn(() => of(null)) } as never,
      { sendNotification: jest.fn() } as never,
      activityLog as never,
      { enqueue: jest.fn() } as never,
      { assertFanout: jest.fn(), queueForNotifications: jest.fn() } as never,
    );
    return { service, activityLog };
  }

  it('TC10 rmqSend `request_id` si partiya ID si bo`ladi va javobda qaytadi', async () => {
    const { service, activityLog } = makeService();
    const res = await service.dispatch({
      recipient_id: '42',
      type: 'order.sold',
      title: 'Sotildi',
      request_id: 'req-7f3a',
    } as never);

    const entry = activityLog.log.mock.calls[0][0];
    expect(entry.entity_id).toBe('req-7f3a');
    expect(entry.entity_id).not.toBe('dispatch');
    expect(entry.metadata).toMatchObject({
      dispatch_id: 'req-7f3a',
      dispatched_count: 1,
      notification_ids: ['500'],
    });
    expect(res.data.dispatch_id).toBe('req-7f3a');
  });

  it('TC10 request_id bo`lmasa har dispatch o`z UUID sini oladi', async () => {
    const { service, activityLog } = makeService();
    await service.dispatch({
      recipient_id: '42',
      type: 'order.sold',
      title: 'a',
    } as never);
    await service.dispatch({
      recipient_id: '43',
      type: 'order.sold',
      title: 'b',
    } as never);
    const [a, b] = activityLog.log.mock.calls.map((c) => c[0].entity_id);
    expect(a).toMatch(/^[0-9a-f-]{36}$/);
    expect(b).toMatch(/^[0-9a-f-]{36}$/);
    expect(a).not.toBe(b);
  });
});
