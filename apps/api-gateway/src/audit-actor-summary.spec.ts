import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { of } from 'rxjs';
import { requestContext } from '@app/common';
import { JwtStrategy } from './auth/jwt.strategy';
import { AuditEnrichmentService } from './audit/audit-enrichment.service';

/**
 * fQi6NNUL / y8CxCtcK — gateway tomoni:
 *  • JWT tekshiruvidan keyin aktyor (id/ism/rol) so'rov kontekstiga tushadi;
 *  • `identity.user.summary_by_ids` FAQAT audit enrichment'dan chaqiriladi,
 *    HTTP marshrut sifatida ochilmagan;
 *  • actor qatordagi (yozilgan paytdagi) ism/rolni USTUN qo'yadi — rol keyin
 *    o'zgarsa ham eski qator o'zgarmaydi; hal qilinmasa aniq belgi.
 */
type Row = Record<string, unknown>;

describe('JwtStrategy.validate — aktyor kontekstga (fQi6NNUL)', () => {
  const strategy = new JwtStrategy({
    get: () => 'secret',
  } as never);

  it('⭐ id/ism/rol AYNI so`rov do`koniga yoziladi (keyingi RMQ chaqiruvlari ko`radi)', async () => {
    const store = { traceId: 't-1' };
    await requestContext.run(store, () =>
      strategy.validate({
        sub: '1',
        username: 'dilshod',
        name: 'Dilshod',
        roles: ['SUPERADMIN'],
      }),
    );
    expect(store).toEqual({
      traceId: 't-1',
      userId: '1',
      userName: 'Dilshod',
      userRole: 'superadmin',
    });
  });

  it('eski token (name claim`siz) — id/rol bor, ism yo`q (enrichment hal qiladi)', async () => {
    const store = { traceId: 't-2' } as Record<string, unknown>;
    await requestContext.run(store as never, () =>
      strategy.validate({ sub: '37', username: 'm', roles: ['market'] }),
    );
    expect(store.userId).toBe('37');
    expect(store.userName).toBeUndefined();
    expect(store.userRole).toBe('market');
  });

  it('kontekstdan tashqarida (WS/test) — xato bermaydi', async () => {
    await expect(
      strategy.validate({ sub: '1', username: 'x', roles: [] }),
    ).resolves.toEqual(expect.objectContaining({ sub: '1' }));
  });
});

describe('identity.user.summary_by_ids — faqat ichki audit oqimi (y8CxCtcK)', () => {
  const gatewayDir = __dirname;
  const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) return walk(full);
      return full.endsWith('.ts') && !full.endsWith('.spec.ts') ? [full] : [];
    });

  it('⭐ gateway kodida summary_by_ids FAQAT audit-enrichment.service.ts da (HTTP marshrut yo`q)', () => {
    const files = walk(gatewayDir);
    expect(files.length).toBeGreaterThan(50);
    const users = files.filter((f) => {
      const src = readFileSync(f, 'utf8');
      return /identity\.user\.summary_by_ids|USER_SUMMARY_BY_IDS_PATTERN/.test(
        src,
      );
    });
    expect(users.map((f) => f.slice(gatewayDir.length + 1))).toEqual([
      'audit/audit-enrichment.service.ts',
    ]);
    // Enrichment — @Injectable servis, kontroller emas.
    const src = readFileSync(
      join(gatewayDir, 'audit/audit-enrichment.service.ts'),
      'utf8',
    );
    expect(src).not.toMatch(/@Controller|@Get\(|@Post\(/);
  });
});

describe('AuditEnrichmentService — actor (snapshot ustun, aniq belgi)', () => {
  function make(identityUsers: Row[]) {
    const identity = {
      send: jest.fn((pattern: { cmd: string }) =>
        pattern.cmd === 'identity.user.summary_by_ids'
          ? of({ success: true, data: identityUsers })
          : of({ data: [] }),
      ),
    };
    const empty = { send: jest.fn(() => of({ data: [] })) };
    return new AuditEnrichmentService(
      identity as never,
      empty as never,
      empty as never,
      empty as never,
      empty as never,
    );
  }

  it('⭐ rol keyin o`zgartirilsa ham eski qatordagi user_role/user_name o`zgarmaydi', async () => {
    // Identity hozir: 42 — admin, ismi o'zgargan. Qator yozilganda — manager.
    const svc = make([{ id: '42', name: 'Ali Valiyev', role: 'admin' }]);
    const [row] = await svc.enrich([
      {
        id: '1',
        entity_type: 'Order',
        entity_id: '9',
        user_id: '42',
        user_name: 'Ali',
        user_role: 'manager',
      },
    ]);
    expect(row.actor).toMatchObject({
      id: '42',
      name: 'Ali',
      role: 'manager',
      resolved: true,
    });
    expect(row.actor_status).toBe('snapshot');
  });

  it('⭐ superadmin (user_name NULL eski qator) — identity`dan ism, `1` emas', async () => {
    const svc = make([{ id: '1', name: 'Dilshod', role: 'superadmin' }]);
    const [row] = await svc.enrich([
      {
        id: '2',
        entity_type: 'Cashbox',
        entity_id: '3',
        action: 'finance.manual_expense',
        user_id: '1',
        user_name: null,
        user_role: null,
      },
    ]);
    expect(row.actor).toMatchObject({
      id: '1',
      name: 'Dilshod',
      role: 'superadmin',
      phone_number: null,
    });
    expect(row.actor_status).toBe('resolved');
  });

  it('mijoz bajargan amal — ism ko`rinadi (rol filtri yo`q)', async () => {
    const svc = make([{ id: '900', name: 'Mijoz Ismi', role: 'customer' }]);
    const [row] = await svc.enrich([
      { id: '3', entity_type: 'Order', entity_id: '5', user_id: '900' },
    ]);
    expect(row.actor).toMatchObject({ name: 'Mijoz Ismi', role: 'customer' });
  });

  it('⭐ hal qilinmadi — actor null EMAS, aniq belgi; aktyorsiz — `system`', async () => {
    const svc = make([]);
    const [unknown, system] = await svc.enrich([
      { id: '4', entity_type: 'Order', entity_id: '5', user_id: '555' },
      { id: '5', entity_type: 'SyncQueue', entity_id: 'tick', user_id: null },
    ]);
    expect(unknown.actor).toMatchObject({
      id: '555',
      name: null,
      resolved: false,
    });
    expect(unknown.actor_status).toBe('unresolved');
    expect(system.actor).toBeNull();
    expect(system.actor_status).toBe('system');
  });
});
