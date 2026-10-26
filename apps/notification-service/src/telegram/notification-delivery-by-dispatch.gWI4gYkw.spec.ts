import { PATTERN_METADATA } from '@nestjs/microservices/constants';
import type { Repository } from 'typeorm';
import type { Notification } from '../entities/notification.entity';
import { TelegramDmController } from './telegram-dm.controller';
import { TelegramDmDeliveryReportService } from './telegram-dm-delivery-report.service';

/**
 * gWI4gYkw — smena hisoboti yetkazish holati (`notification.delivery.by_dispatch`):
 * faqat UUID dispatch_id lar, faqat `dispatch_id / recipient_id / delivery`
 * (matn / data qaytmaydi), bo'sh kirish — so'rovsiz.
 */
describe('gWI4gYkw — notification.delivery.by_dispatch', () => {
  const uuid = '3f2a1b4c-5d6e-5f70-8a9b-0c1d2e3f4a5b';

  const make = (rows: unknown[]) => {
    const qb = {
      select: jest.fn().mockReturnThis(),
      addSelect: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      getRawMany: jest.fn().mockResolvedValue(rows),
    };
    const repo = { createQueryBuilder: jest.fn(() => qb) };
    const service = new TelegramDmDeliveryReportService(
      repo as unknown as Repository<Notification>,
    );
    return { service, qb, repo };
  };

  it('UUID lar bo‘yicha delivery qaytadi; yaroqsiz id lar tashlanadi', async () => {
    const { service, qb } = make([
      { dispatch_id: uuid, recipient_id: '7', delivery: { telegram: 'sent' } },
      { dispatch_id: uuid, recipient_id: '8', delivery: null },
    ]);
    const res = (await service.byDispatch({
      dispatch_ids: [uuid.toUpperCase(), "1' OR 1=1", 42],
    })) as { data: unknown[] };
    expect(qb.where).toHaveBeenCalledWith('n.dispatch_id IN (:...ids)', {
      ids: [uuid],
    });
    expect(res.data).toEqual([
      { dispatch_id: uuid, recipient_id: '7', delivery: { telegram: 'sent' } },
      { dispatch_id: uuid, recipient_id: '8', delivery: {} },
    ]);
    const selected = [
      ...qb.select.mock.calls.map((call) => call[0]),
      ...qb.addSelect.mock.calls.map((call) => call[0]),
    ];
    expect(selected).toEqual(['n.dispatch_id', 'n.recipient_id', 'n.delivery']);
  });

  it('bo‘sh / yaroqsiz kirish — DB so‘rovi yo‘q', async () => {
    const { service, repo } = make([]);
    expect(await service.byDispatch({ dispatch_ids: ['x'] })).toEqual(
      expect.objectContaining({ data: [] }),
    );
    expect(await service.byDispatch({})).toEqual(
      expect.objectContaining({ data: [] }),
    );
    expect(repo.createQueryBuilder).not.toHaveBeenCalled();
  });

  it('RMQ patterni ro‘yxatda', () => {
    const proto = TelegramDmController.prototype as unknown as Record<
      string,
      object
    >;
    const cmds = Object.getOwnPropertyNames(proto).flatMap((name) => {
      const meta = Reflect.getMetadata(PATTERN_METADATA, proto[name]) as
        | Array<{ cmd?: string }>
        | undefined;
      return (meta ?? []).map((pattern) => pattern.cmd);
    });
    expect(cmds).toContain('notification.delivery.by_dispatch');
  });
});
