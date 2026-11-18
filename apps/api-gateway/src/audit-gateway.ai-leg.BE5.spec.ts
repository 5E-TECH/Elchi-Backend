import { NEVER, of } from 'rxjs';
import { AuditGatewayController } from './audit-gateway.controller';

/**
 * BE-5 §11 — `/activity-logs` fan-in'iga ai-service oyog'i: `ai.cap.raise`
 * va `ai.advisor.*` yozuvlari (`ai.activity_log.find_by_entity`) ko'rinadi.
 */
describe('AuditGatewayController — ai oyog‘i (BE-5)', () => {
  const client = () => ({ send: jest.fn(() => of([])) });
  const legs = () => Array.from({ length: 9 }, client);

  it('AI mijozi berilsa — `ai` oyog‘i fan-in ro‘yxatida, find_by_entity unga ham boradi', async () => {
    const base = legs();
    const ai = client();
    const controller = new AuditGatewayController(
      ...(base as unknown as [
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
      { enrich: jest.fn((x: unknown) => Promise.resolve(x)) } as never,
      ai as never,
    );
    const names = (
      controller as unknown as { services: Array<{ name: string }> }
    ).services.map((s) => s.name);
    expect(names).toContain('ai');
    expect(names[names.length - 1]).toBe('ai');
    await controller.entityHistory('ai_advisor_alert', '1040', undefined, {
      user: { roles: ['superadmin'] },
    });
    expect(ai.send).toHaveBeenCalledWith(
      { cmd: 'ai.activity_log.find_by_entity' },
      expect.objectContaining({
        entity_type: 'ai_advisor_alert',
        entity_id: '1040',
      }),
    );
  });

  it('B2/S5 (ega 2026-11-18): ADMIN — ai oyog‘i umuman so‘ralmaydi (ro‘yxat, obyekt tarixi, foydalanuvchi)', async () => {
    const base = legs();
    const ai = client();
    const controller = new AuditGatewayController(
      ...(base as unknown as [
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
      { enrich: jest.fn((x: unknown) => Promise.resolve(x)) } as never,
      ai as never,
    );
    const admin = { user: { roles: ['admin'] } };
    await controller.list({}, admin);
    await controller.list({ service: 'ai' }, admin);
    await controller.entityHistory(
      'ai_advisor_alert',
      '1040',
      undefined,
      admin,
    );
    await controller.userHistory('42', {}, admin);
    await controller.entityHistory('ai_advisor_alert', '1040');
    expect(ai.send).not.toHaveBeenCalled();
    expect(base[0].send).toHaveBeenCalled();

    await controller.list({}, { user: { roles: ['superadmin'] } });
    expect(ai.send).toHaveBeenCalledWith(
      { cmd: 'ai.activity_log.find_all' },
      expect.anything(),
    );
  });

  it('round-4 S6: ai oyog‘i javob bermasa — 3 s da failed_services [ai], qolganlari qaytadi (12 s emas)', async () => {
    const base = legs();
    const ai = { send: jest.fn(() => NEVER) };
    const controller = new AuditGatewayController(
      ...(base as unknown as [
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
      { enrich: jest.fn((x: unknown) => Promise.resolve(x)) } as never,
      ai as never,
    );
    const t0 = Date.now();
    const res = await controller.list({}, { user: { roles: ['superadmin'] } });
    const took = Date.now() - t0;
    expect(ai.send).toHaveBeenCalled();
    expect(res.data.meta).toMatchObject({ failed_services: ['ai'] });
    expect(took).toBeGreaterThanOrEqual(2900);
    expect(took).toBeLessThan(6000);
  }, 15_000);

  it('AI mijozisiz (eski konstruktor) — oyoqlar avvalgidek 9 ta', () => {
    const controller = new AuditGatewayController(
      ...(legs() as unknown as [
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
      {} as never,
    );
    expect(
      (controller as unknown as { services: unknown[] }).services,
    ).toHaveLength(9);
  });
});
