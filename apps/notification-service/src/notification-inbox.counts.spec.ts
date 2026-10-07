import { NotificationCategory, NotificationPriority } from '@app/common';
import { NotificationInboxService } from './notification-inbox.service';

/**
 * INBOX FILTRLARI (n1sNvGLn): kategoriya sanoqlari BITTA GROUP BY so'rovdan,
 * "Faqat muhim" = critical + high.
 */

const setup = (raw: unknown[] = []) => {
  const qb: Record<string, jest.Mock> = {};
  for (const m of [
    'select',
    'addSelect',
    'where',
    'andWhere',
    'setParameter',
    'groupBy',
  ]) {
    qb[m] = jest.fn(() => qb);
  }
  qb.getRawMany = jest.fn().mockResolvedValue(raw);
  const repo = {
    createQueryBuilder: jest.fn(() => qb),
    findAndCount: jest.fn().mockResolvedValue([[], 0]),
    count: jest.fn().mockResolvedValue(0),
  };
  const service = Object.create(
    NotificationInboxService.prototype,
  ) as NotificationInboxService;
  Object.assign(service, { repo });
  return { service, repo, qb };
};

describe('inbox counts', () => {
  it('bitta so‘rov; har kategoriya (yozuvsizi ham 0) va muhim o‘qilmaganlar', async () => {
    const { service, qb, repo } = setup([
      { category: 'order', total: '3', unread: '2', important_unread: '1' },
      { category: 'finance', total: '1', unread: '1', important_unread: '1' },
    ]);
    const res: any = await service.counts('42');

    expect(repo.createQueryBuilder).toHaveBeenCalledTimes(1);
    expect(qb.getRawMany).toHaveBeenCalledTimes(1);
    expect(Object.keys(res.data.categories).sort()).toEqual(
      Object.values(NotificationCategory).sort(),
    );
    expect(res.data.categories.order).toEqual({ total: 3, unread: 2 });
    expect(res.data.categories.marketing).toEqual({ total: 0, unread: 0 });
    expect(res.data.unread).toBe(3);
    expect(res.data.important_unread).toBe(2);
  });

  it('noto‘g‘ri recipient_id — xato (boshqa odamning sanog‘i emas)', async () => {
    const { service } = setup();
    await expect(service.counts('abc')).rejects.toBeDefined();
  });
});

describe('inbox list — "Faqat muhim"', () => {
  it('important=true → priority IN (critical, high), bitta priority dan ustun', async () => {
    const { service, repo } = setup();
    await service.list({
      recipient_id: '42',
      important: true,
      priority: NotificationPriority.LOW,
    } as any);
    const where = repo.findAndCount.mock.calls[0][0].where;
    expect(where.priority.value).toEqual([
      NotificationPriority.CRITICAL,
      NotificationPriority.HIGH,
    ]);
  });
});
