import { requestContext } from '../context/request-context';
import { ActivityLog } from './activity-log.entity';
import { ActivityLogService } from './activity-log.service';

/** be-brief D15: tranzaksiya ichida audit — xato THROW qilinadi (rollback). */
describe('ActivityLogService.logWithin', () => {
  function makeManager(save: jest.Mock) {
    const repo = { create: jest.fn((r: unknown) => r), save };
    const manager = { getRepository: jest.fn(() => repo) };
    return { manager, repo };
  }
  const service = new ActivityLogService(
    { create: jest.fn(), save: jest.fn() } as never,
    'ai-service',
  );

  it('berilgan manager orqali yozadi, kontekst va service qo‘shiladi', async () => {
    const save = jest.fn((r: unknown) => Promise.resolve(r));
    const { manager } = makeManager(save);
    const row = await requestContext.run(
      { traceId: 't-1', ip: '203.0.113.9', userId: '7' },
      () =>
        service.logWithin(manager as never, {
          entity_type: 'AiProviderKey',
          entity_id: 'k1',
          action: 'ai.key.add',
          new_value: { hint: 'sk-ant-…abcd', fingerprint: 'aaaa bbbb cccc' },
          metadata: { source: 'ui' },
        }),
    );
    expect(manager.getRepository).toHaveBeenCalledWith(ActivityLog);
    expect(row).toMatchObject({
      action: 'ai.key.add',
      entity_id: 'k1',
      service: 'ai-service',
      trace_id: 't-1',
      user_id: '7',
      metadata: { ip: '203.0.113.9', source: 'ui' },
    });
  });

  it('INSERT xatosi yutilmaydi — throw (chaqiruvchi tranzaksiyasi qaytadi)', async () => {
    const save = jest.fn(() => Promise.reject(new Error('db down')));
    const { manager } = makeManager(save);
    await expect(
      service.logWithin(manager as never, {
        entity_type: 'AiProviderKey',
        entity_id: 'k1',
        action: 'ai.key.add',
      }),
    ).rejects.toThrow('db down');
  });
});
