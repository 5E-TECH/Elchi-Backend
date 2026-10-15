import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { of } from 'rxjs';
import { Roles as RoleEnum } from '@app/common';
import { AuditGatewayController } from './audit-gateway.controller';
import { AuditEnrichmentService } from './audit/audit-enrichment.service';
import { ActivityLogQueryDto } from './dto/activity-log.swagger.dto';

/**
 * i6Nyedea TC "Arxiv varianti tanlangan bo'lsa, o'chirilgan qatorlar arxivda
 * topiladi" — gateway tomoni: `GET /activity-logs?archive=true` har servis
 * legiga `archive: true` ni uzatadi (servis `activity_logs_archive` dan
 * o'qiydi); berilmasa — uzatilmaydi (hot jadval, avvalgidek). Rollar —
 * mavjud jurnal bilan AYNI (SUPERADMIN, ADMIN).
 */
describe('AuditGatewayController.list — archive (i6Nyedea)', () => {
  const archived = {
    id: '41',
    entity_type: 'Order',
    entity_id: '100',
    action: 'order.sell',
    created_at: '2023-01-01T00:00:00.000Z',
    archived_at: '2026-10-15T03:15:00.000Z',
    archive_rule: 'default',
  };

  function makeController() {
    const leg = () => ({
      send: jest.fn((pattern: { cmd: string }, payload: any) =>
        pattern.cmd.endsWith('.activity_log.find_all') &&
        payload?.query?.archive === true &&
        pattern.cmd.startsWith('order.')
          ? of({ items: [archived], meta: { total: 1 } })
          : of({ items: [], meta: { total: 0 } }),
      ),
    });
    const legs = Array.from({ length: 9 }, leg);
    const empty = { send: jest.fn(() => of({ data: { items: [] } })) };
    const enrichment = new AuditEnrichmentService(
      empty as never,
      empty as never,
      empty as never,
      empty as never,
      empty as never,
    );
    const controller = new AuditGatewayController(
      ...(legs as never as [
        never,
        never,
        never,
        never,
        never,
        never,
        never,
        never,
        never,
      ]),
      enrichment,
    );
    return { controller, legs };
  }

  it('⭐ archive=true — HAR legga `archive: true`, arxiv qatori javobda, meta.archive', async () => {
    const { controller, legs } = makeController();
    const res = await controller.list({
      archive: true,
      entity_type: 'Order',
      entity_id: '100',
    } as ActivityLogQueryDto);
    for (const leg of legs) {
      expect(leg.send).toHaveBeenCalledWith(
        expect.objectContaining({
          cmd: expect.stringMatching(/\.activity_log\.find_all$/),
        }),
        expect.objectContaining({
          query: expect.objectContaining({
            archive: true,
            entity_type: 'Order',
            entity_id: '100',
          }),
        }),
      );
    }
    const items = res.data.items as Array<Record<string, unknown>>;
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      id: '41',
      archive_rule: 'default',
      archived_at: archived.archived_at,
    });
    expect(res.data.meta).toMatchObject({ archive: true, total: 1 });
  });

  it('archive berilmasa — legga `archive` UZATILMAYDI (hot jadval), meta.archive yo`q', async () => {
    const { controller, legs } = makeController();
    const res = await controller.list({} as ActivityLogQueryDto);
    for (const leg of legs) {
      const [, payload] = leg.send.mock.calls[0] as unknown as [
        unknown,
        { query: Record<string, unknown> },
      ];
      expect(payload.query).not.toHaveProperty('archive');
    }
    expect(res.data.meta).not.toHaveProperty('archive');
  });

  it('DTO: "true"/"false" boolean`ga; boshqa qiymat — validatsiya xatosi', async () => {
    const t = plainToInstance(ActivityLogQueryDto, { archive: 'true' });
    expect(t.archive).toBe(true);
    expect(await validate(t)).toEqual([]);
    const f = plainToInstance(ActivityLogQueryDto, { archive: 'false' });
    expect(f.archive).toBe(false);
    const bad = plainToInstance(ActivityLogQueryDto, { archive: 'yes' });
    expect((await validate(bad)).map((e) => e.property)).toEqual(['archive']);
  });

  it('rollar — mavjud jurnal bilan AYNI (SUPERADMIN, ADMIN)', () => {
    const roles = Reflect.getMetadata('roles', AuditGatewayController) as
      | string[]
      | undefined;
    expect([...(roles ?? [])].sort()).toEqual(
      [RoleEnum.SUPERADMIN, RoleEnum.ADMIN].sort(),
    );
  });
});
