import { of, throwError, TimeoutError } from 'rxjs';
import { AuditGatewayController } from './audit-gateway.controller';
import { AuditEnrichmentService } from './audit/audit-enrichment.service';

/**
 * (2WRzdWpZ topilma, audit-actor-name) Faoliyat jurnalida superadmin amallari
 * "Kim" ustunida ism o'rniga "1" bo'lib ko'rinardi. Frontend ismni
 * `actor.name || user_name || user_id` tartibida oladi.
 *
 * Ildiz sabab: enrichment actor'ni `identity.user.find_all` (GET /users
 * ro'yxati) orqali qidirardi. U SUPERADMIN va mijozlarni ataylab chiqarib
 * tashlaydi, shuning uchun id=1 hech qachon topilmasdi. Natijada actor
 * `{ id: '1', name: user_name, role }` zaxira shakliga tushardi. Superadmin
 * amallarini yozgan servislarda `user_name` NULL bo'lgani uchun UI'da "1"
 * chiqardi.
 *
 * Tuzatish: actor/entity endi ichki `identity.user.find_by_ids` (barcha
 * rollar) orqali olinadi. Eski identity (deploy oralig'i) uchun find_all'ga
 * qaytiladi.
 */
type Row = Record<string, unknown>;

const USERS: Record<string, Row> = {
  '1': {
    id: '1',
    name: 'Dilshod',
    username: 'dilshod',
    phone_number: '+998900000001',
    role: 'superadmin',
    status: 'active',
  },
  '37': {
    id: '37',
    name: 'TEST Claude Market',
    username: 'test_claude_market_1009',
    phone_number: '+998887009113',
    role: 'market',
    status: 'active',
  },
};

/** Prod qatorlari (out/2WRzdWpZ-al-full.json) shakli. */
const rows: Row[] = [
  {
    id: '407',
    entity_type: 'User',
    entity_id: '37',
    action: 'created',
    old_value: null,
    new_value: { name: 'TEST Claude Market', role: 'market' },
    user_id: '1',
    user_name: null,
    user_role: 'superadmin',
    service: 'identity-service',
    metadata: null,
    description: null,
    created_at: '2026-10-09T09:10:19.064Z',
  },
  {
    id: '269',
    entity_type: 'User',
    entity_id: '1',
    action: 'updated',
    old_value: null,
    new_value: { name: 'Dilshod' },
    user_id: '1',
    user_name: null,
    user_role: null,
    service: 'identity-service',
    metadata: null,
    description: null,
    created_at: '2026-10-09T08:00:00.000Z',
  },
];

/**
 * Identity soxtasi haqiqiy xulqni takrorlaydi: `find_all` superadminni
 * qaytarmaydi, `find_by_ids` esa barcha rollarni qaytaradi.
 */
function makeIdentity(
  opts: { findByIdsFails?: boolean; findByIdsTimeout?: boolean } = {},
) {
  return {
    send: jest.fn((pattern: { cmd: string }, payload: any) => {
      if (pattern.cmd === 'identity.user.find_all') {
        const ids: string[] = payload?.query?.user_ids ?? [];
        const items = ids
          .map((id) => USERS[id])
          .filter((u) => u && u.role !== 'superadmin');
        return of({ data: { items, meta: { total: items.length } } });
      }
      if (pattern.cmd === 'identity.user.find_by_ids') {
        if (opts.findByIdsTimeout) {
          return throwError(() => new TimeoutError());
        }
        if (opts.findByIdsFails) {
          return throwError(
            () => new Error('There is no matching message handler defined'),
          );
        }
        const ids: string[] = payload?.ids ?? [];
        return of({
          success: true,
          data: ids.map((id) => USERS[id]).filter(Boolean),
        });
      }
      return of({ data: [] });
    }),
  };
}

function makeController(identity: ReturnType<typeof makeIdentity>) {
  const empty = { send: jest.fn(() => of({ data: { items: [] } })) };
  const idLeg = {
    send: jest.fn((pattern: { cmd: string }, payload: unknown) =>
      pattern.cmd === 'identity.activity_log.find_all'
        ? of({ items: rows, meta: { total: rows.length } })
        : identity.send(pattern, payload),
    ),
  };
  const enrichment = new AuditEnrichmentService(
    idLeg as never,
    empty as never,
    empty as never,
    empty as never,
    empty as never,
  );
  const controller = new AuditGatewayController(
    idLeg as never,
    empty as never,
    empty as never,
    empty as never,
    empty as never,
    empty as never,
    empty as never,
    empty as never,
    empty as never,
    enrichment,
  );
  return { controller, idLeg };
}

function cmdCalls(client: { send: jest.Mock }, cmd: string): unknown[][] {
  return client.send.mock.calls.filter(
    ([pattern]) => (pattern as { cmd: string }).cmd === cmd,
  );
}

describe('GET /activity-logs — superadmin "Kim" ustuni (2WRzdWpZ audit-actor-name)', () => {
  it('superadmin amali: actor ismi identity dan olinadi ("1" emas)', async () => {
    const { controller } = makeController(makeIdentity());

    const res = await controller.list({});
    const items = res.data.items as Row[];
    const created = items.find((r) => r.id === '407')!;

    expect(created.actor).toMatchObject({
      id: '1',
      name: 'Dilshod',
      role: 'superadmin',
    });
    // Obyekt (market 37) avvalgidek topiladi.
    expect(created.entity).toMatchObject({
      id: '37',
      name: 'TEST Claude Market',
    });
  });

  it('superadmin o`z profilini o`zgartirgan qator: actor ham, entity ham ismli', async () => {
    const { controller } = makeController(makeIdentity());

    const res = await controller.list({});
    const updated = (res.data.items as Row[]).find((r) => r.id === '269')!;

    // user_role NULL qatorda ham rol identity'dan keladi.
    expect(updated.actor).toMatchObject({
      id: '1',
      name: 'Dilshod',
      role: 'superadmin',
    });
    expect(updated.entity).toMatchObject({ id: '1', name: 'Dilshod' });
  });

  it('sahifadagi barcha foydalanuvchi id lari BITTA find_by_ids chaqiruvida', async () => {
    const { controller, idLeg } = makeController(makeIdentity());

    await controller.list({});

    const calls = cmdCalls(idLeg, 'identity.user.find_by_ids');
    expect(calls).toHaveLength(1);
    expect((calls[0][1] as { ids: string[] }).ids.sort()).toEqual(['1', '37']);
    expect(cmdCalls(idLeg, 'identity.user.find_all')).toHaveLength(0);
  });

  it('eski identity (find_by_ids yo`q): find_all ga qaytadi, ro`yxat yiqilmaydi', async () => {
    const { controller, idLeg } = makeController(
      makeIdentity({ findByIdsFails: true }),
    );

    const res = await controller.list({});
    const created = (res.data.items as Row[]).find((r) => r.id === '407')!;

    expect(cmdCalls(idLeg, 'identity.user.find_all')).toHaveLength(1);
    // Market find_all orqali topiladi; superadmin esa avvalgi zaxira shaklida.
    expect(created.entity).toMatchObject({ id: '37' });
    expect(created.actor).toMatchObject({ id: '1', role: 'superadmin' });
  });

  it('identity timeout: find_all ga qayta urinilmaydi (kutish ikki baravar bo`lmaydi)', async () => {
    const { controller, idLeg } = makeController(
      makeIdentity({ findByIdsTimeout: true }),
    );

    const res = await controller.list({});
    const created = (res.data.items as Row[]).find((r) => r.id === '407')!;

    expect(cmdCalls(idLeg, 'identity.user.find_all')).toHaveLength(0);
    // Ro'yxat yiqilmaydi — denormal ustunlar zaxirasi.
    expect(created.actor).toMatchObject({ id: '1', role: 'superadmin' });
  });
});

describe('AuditEnrichmentService — foydalanuvchi id larini tozalash (2WRzdWpZ)', () => {
  it('raqam bo`lmagan id (system/partner:2) identity ga yuborilmaydi', async () => {
    const identity = makeIdentity();
    const empty = { send: jest.fn(() => of({ data: [] })) };
    const svc = new AuditEnrichmentService(
      identity as never,
      empty as never,
      empty as never,
      empty as never,
      empty as never,
    );

    const out = await svc.enrich([
      { id: 'a', user_id: 'system', user_name: 'Tizim', entity_type: 'X' },
      { id: 'b', user_id: 'partner:2', entity_type: 'X' },
      { id: 'c', user_id: '1', entity_type: 'X' },
    ]);

    const calls = cmdCalls(identity, 'identity.user.find_by_ids');
    expect(calls).toHaveLength(1);
    expect((calls[0][1] as { ids: string[] }).ids).toEqual(['1']);
    // Raqamsiz id li qator denormal ustunlarga tayanadi (o'zgarmagan xulq).
    expect(out[0].actor).toMatchObject({ id: 'system', name: 'Tizim' });
    expect(out[2].actor).toMatchObject({ name: 'Dilshod' });
  });
});
