import { Logger } from '@nestjs/common';
import type { ClientProxy } from '@nestjs/microservices';
import { of, throwError } from 'rxjs';
import { AiConfigNotifier } from './ai-config.notifier';
import type { AiKeyStoreService } from './ai-key-store.service';

describe('AiConfigNotifier', () => {
  beforeAll(() => jest.spyOn(Logger.prototype, 'warn').mockImplementation());
  afterAll(() => jest.restoreAllMocks());

  it('kalit o‘zgarishi → ai.key_alert (superadmin+admin), matnda faqat hint', async () => {
    const send = jest.fn().mockReturnValue(of({ ok: true }));
    const n = new AiConfigNotifier({ send } as unknown as ClientProxy);
    await n.notify({
      action: 'ai.key.replace',
      auditId: '55',
      hint: 'sk-ant-…abcd',
      actorName: 'Ega',
    });
    const [pattern, payload] = send.mock.calls[0] as [
      unknown,
      Record<string, unknown>,
    ];
    expect(pattern).toEqual({ cmd: 'notification.dispatch' });
    expect(payload).toMatchObject({
      roles: ['superadmin', 'admin'],
      type: 'ai.key_alert',
      priority: 'high',
      title: 'AI kaliti almashtirildi',
      group_key: 'ai.key_alert:55',
      data: { action: 'ai.key.replace', audit_id: '55', hint: 'sk-ant-…abcd' },
    });
    expect(String(payload.body)).toContain('Kim: Ega');
  });

  it('runtime_failure → critical; model → ai.model_alert; verify/attempt → yuborilmaydi', async () => {
    const send = jest.fn().mockReturnValue(of({}));
    const n = new AiConfigNotifier({ send } as unknown as ClientProxy);
    await n.notify({ action: 'ai.key.runtime_failure', auditId: '1' });
    await n.notify({ action: 'ai.models.auto_revert', auditId: '2' });
    await n.notify({ action: 'ai.key.verify', auditId: '3' });
    await n.notify({ action: 'ai.key.attempt_rejected', auditId: '4' });
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[0][1]).toMatchObject({
      type: 'ai.key_alert',
      priority: 'critical',
    });
    expect(send.mock.calls[1][1]).toMatchObject({ type: 'ai.model_alert' });
  });

  it('xato yutiladi (yozuvga ta’sir yo‘q); store o‘zgarishiga obuna', async () => {
    const send = jest.fn().mockReturnValue(throwError(() => new Error('down')));
    let listener: ((e: unknown) => void) | undefined;
    const store = { onChange: (l: (e: unknown) => void) => (listener = l) };
    const n = new AiConfigNotifier(
      { send } as unknown as ClientProxy,
      store as unknown as AiKeyStoreService,
    );
    n.onModuleInit();
    expect(() =>
      listener?.({
        action: 'ai.key.add',
        auditId: '9',
        hint: null,
        actorName: null,
      }),
    ).not.toThrow();
    await expect(
      n.notify({ action: 'ai.key.add', auditId: '9' }),
    ).resolves.toBeUndefined();
  });
});
