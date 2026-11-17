import { ClientProxy } from '@nestjs/microservices';
import { Subject, of } from 'rxjs';
import { AiStatusPoller } from './ai-status.poller';

/** be-brief §8: ai.status — ai_config_queue orqali; yozuvdan keyin darhol yangilanadi. */
describe('AiStatusPoller — ai_config_queue va refreshNow', () => {
  it('AI_CONFIG mijozi bo‘lsa — u ishlatiladi (eski AI emas)', async () => {
    const legacy = { send: jest.fn(() => of({})) };
    const cfg = { send: jest.fn(() => of({})) };
    const p = new AiStatusPoller(
      legacy as unknown as ClientProxy,
      undefined,
      cfg as unknown as ClientProxy,
    );
    await p.poll();
    expect(cfg.send).toHaveBeenCalledWith({ cmd: 'ai.status' }, {});
    expect(legacy.send).not.toHaveBeenCalled();
  });

  it('AI_CONFIG yo‘q — eski AI mijozi', async () => {
    const legacy = { send: jest.fn(() => of({})) };
    await new AiStatusPoller(legacy as unknown as ClientProxy).poll();
    expect(legacy.send).toHaveBeenCalled();
  });

  it('refreshNow: so‘rov ketayotgan bo‘lsa — tugagach yana bitta', async () => {
    const first = new Subject<unknown>();
    const cfg = {
      send: jest.fn().mockReturnValueOnce(first).mockReturnValue(of({})),
    };
    const p = new AiStatusPoller(
      undefined,
      undefined,
      cfg as unknown as ClientProxy,
    );
    const running = p.poll();
    p.refreshNow();
    p.refreshNow();
    expect(cfg.send).toHaveBeenCalledTimes(1);
    first.next({});
    first.complete();
    await running;
    await new Promise((r) => setImmediate(r));
    expect(cfg.send).toHaveBeenCalledTimes(2);
    p.refreshNow();
    await new Promise((r) => setImmediate(r));
    expect(cfg.send).toHaveBeenCalledTimes(3);
  });
});
