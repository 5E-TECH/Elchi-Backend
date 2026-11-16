import { of } from 'rxjs';
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
    await controller.entityHistory('ai_advisor_alert', '1040');
    expect(ai.send).toHaveBeenCalledWith(
      { cmd: 'ai.activity_log.find_by_entity' },
      expect.objectContaining({
        entity_type: 'ai_advisor_alert',
        entity_id: '1040',
      }),
    );
  });

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
