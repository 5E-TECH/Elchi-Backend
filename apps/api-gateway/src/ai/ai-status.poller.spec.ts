import { ConfigService } from '@nestjs/config';
import { ClientProxy } from '@nestjs/microservices';
import { NEVER, Observable, of, throwError } from 'rxjs';
import type { AiStatusResponse } from '@app/common';
import {
  AI_STATUS_POLL_INTERVAL_MS,
  AI_STATUS_POLL_TIMEOUT_MS,
  AiStatusPoller,
} from './ai-status.poller';

/**
 * AiStatusPoller — gateway /health va ai-availability uchun AI holati keshi
 * (bVeyEuIR #2; HD5zOyBp #9). Soxta RMQ mijozi bilan.
 */
describe('AiStatusPoller', () => {
  const status = (
    over: Partial<AiStatusResponse> & {
      cap_state?: AiStatusResponse['cap']['state'];
    } = {},
  ): AiStatusResponse => {
    const { cap_state, ...rest } = over;
    return {
      enabled: true,
      key_state: 'ok',
      models: {
        order: 'claude-sonnet-5',
        vision: 'claude-sonnet-5',
        classify: 'claude-haiku-4-5',
      },
      cap: {
        period_key: '2026-09-27',
        spent_usd: 1,
        cap_usd: 50,
        override_usd: 0,
        effective_cap_usd: 50,
        ratio: 0.02,
        state: cap_state ?? 'ok',
        reset_at: '2026-09-27T19:00:00.000Z',
      },
      usage_persist_failures: 0,
      ...rest,
    };
  };

  const makeClient = (
    reply: () => Observable<unknown> = () => of(status()),
  ) => {
    const send = jest.fn<Observable<unknown>, [unknown, unknown]>(() =>
      reply(),
    );
    return { send, client: { send } as unknown as ClientProxy };
  };

  // ⚠️ Sukut parametri YO'Q — `makeConfig(undefined)` haqiqatan kalit yo'q holat.
  const makeConfig = (flag: unknown) =>
    ({
      get: jest.fn((key: string) =>
        key === 'AI_ORDER_ENABLED' ? flag : undefined,
      ),
    }) as unknown as ConfigService;

  afterEach(() => {
    jest.useRealTimers();
  });

  it('birinchi so‘rovdan oldin unknown', () => {
    const { client } = makeClient();
    const poller = new AiStatusPoller(client, makeConfig(true));
    expect(poller.getState()).toBe('unknown');
  });

  it("ai.status ni {cmd:'ai.status'}, {} bilan so‘raydi; kalit ok + shift ochiq → enabled", async () => {
    const { client, send } = makeClient();
    const poller = new AiStatusPoller(client, makeConfig(true));

    await poller.poll();

    expect(send).toHaveBeenCalledWith({ cmd: 'ai.status' }, {});
    expect(poller.getState()).toBe('enabled');
  });

  it('80% ogohlantirish (warn) holatida ham enabled', async () => {
    const { client } = makeClient(() => of(status({ cap_state: 'warn' })));
    const poller = new AiStatusPoller(client, makeConfig(true));
    await poller.poll();
    expect(poller.getState()).toBe('enabled');
  });

  it.each([
    ['kalit yo‘q', status({ key_state: 'missing', enabled: false })],
    ['kalit noto‘g‘ri nomlangan', status({ key_state: 'misnamed' })],
    ['ai-service enabled:false', status({ enabled: false })],
  ])('%s → disabled', async (_title, reply) => {
    const { client } = makeClient(() => of(reply));
    const poller = new AiStatusPoller(client, makeConfig(true));
    await poller.poll();
    expect(poller.getState()).toBe('disabled');
  });

  it('shift urilgan → cap_exceeded ("o‘chiq" emas)', async () => {
    const { client } = makeClient(() => of(status({ cap_state: 'exceeded' })));
    const poller = new AiStatusPoller(client, makeConfig(true));
    await poller.poll();
    expect(poller.getState()).toBe('cap_exceeded');
  });

  it('ai-service shift holatini o‘qiy olmasa (cap.state unknown) → unknown', async () => {
    const { client } = makeClient(() => of(status({ cap_state: 'unknown' })));
    const poller = new AiStatusPoller(client, makeConfig(true));
    await poller.poll();
    expect(poller.getState()).toBe('unknown');
  });

  it.each([[true], ['true'], ['1']])(
    'AI_ORDER_ENABLED=%p — yoqilgan deb o‘qiladi',
    async (flag) => {
      const { client } = makeClient();
      const poller = new AiStatusPoller(client, makeConfig(flag));
      await poller.poll();
      expect(poller.getState()).toBe('enabled');
    },
  );

  it.each([[false], ['false'], [undefined], ['']])(
    'AI_ORDER_ENABLED=%p → har doim disabled (ai-service holatidan qat’i nazar)',
    async (flag) => {
      const { client } = makeClient();
      const poller = new AiStatusPoller(client, makeConfig(flag));
      expect(poller.getState()).toBe('disabled');
      await poller.poll();
      expect(poller.getState()).toBe('disabled');
    },
  );

  it('ConfigService bo‘lmasa (sukut false) → disabled', () => {
    const { client } = makeClient();
    expect(new AiStatusPoller(client).getState()).toBe('disabled');
  });

  it('RPC xatosi → unknown (oldin enabled bo‘lsa ham); poll throw qilmaydi', async () => {
    let fail = false;
    const { client } = makeClient(() =>
      fail ? throwError(() => new Error('connection lost')) : of(status()),
    );
    const poller = new AiStatusPoller(client, makeConfig(true));

    await poller.poll();
    expect(poller.getState()).toBe('enabled');

    fail = true;
    await expect(poller.poll()).resolves.toBeUndefined();
    expect(poller.getState()).toBe('unknown');

    // Tiklanadi.
    fail = false;
    await poller.poll();
    expect(poller.getState()).toBe('enabled');
  });

  it('timeout (1.5s) → unknown', async () => {
    jest.useFakeTimers();
    const { client } = makeClient(() => NEVER);
    const poller = new AiStatusPoller(client, makeConfig(true));

    const pending = poller.poll();
    await jest.advanceTimersByTimeAsync(AI_STATUS_POLL_TIMEOUT_MS - 1);
    expect(poller.getState()).toBe('unknown');
    await jest.advanceTimersByTimeAsync(1);
    await pending;
    expect(poller.getState()).toBe('unknown');
    expect(AI_STATUS_POLL_TIMEOUT_MS).toBe(1_500);
  });

  it('buzuq javob shakli → unknown; {data: status} o‘rami qabul qilinadi', async () => {
    let reply: unknown = { foo: 'bar' };
    const { client } = makeClient(() => of(reply));
    const poller = new AiStatusPoller(client, makeConfig(true));

    await poller.poll();
    expect(poller.getState()).toBe('unknown');

    reply = { statusCode: 200, message: 'success', data: status() };
    await poller.poll();
    expect(poller.getState()).toBe('enabled');
  });

  it('onModuleInit darhol so‘raydi va keyin har 30s da; taymer unref; onModuleDestroy to‘xtatadi', async () => {
    jest.useFakeTimers();
    const setIntervalSpy = jest.spyOn(global, 'setInterval');
    const { client, send } = makeClient();
    const poller = new AiStatusPoller(client, makeConfig(true));

    poller.onModuleInit();
    await jest.advanceTimersByTimeAsync(0);
    expect(send).toHaveBeenCalledTimes(1);
    expect(poller.getState()).toBe('enabled');
    expect(setIntervalSpy).toHaveBeenCalledWith(
      expect.any(Function),
      AI_STATUS_POLL_INTERVAL_MS,
    );
    // unref — taymer jarayonni tirik ushlab turmaydi.
    const timer = (poller as unknown as { timer: NodeJS.Timeout }).timer;
    expect(timer.hasRef()).toBe(false);

    await jest.advanceTimersByTimeAsync(AI_STATUS_POLL_INTERVAL_MS);
    expect(send).toHaveBeenCalledTimes(2);
    await jest.advanceTimersByTimeAsync(AI_STATUS_POLL_INTERVAL_MS);
    expect(send).toHaveBeenCalledTimes(3);

    // Ikkinchi onModuleInit ikkinchi taymer yaratmaydi. (rxjs `timeout` ham
    // setInterval ishlatadi — shu bois faqat 30s li chaqiruvlar sanaladi.)
    poller.onModuleInit();
    expect(
      setIntervalSpy.mock.calls.filter(
        ([, ms]) => ms === AI_STATUS_POLL_INTERVAL_MS,
      ),
    ).toHaveLength(1);

    poller.onModuleDestroy();
    await jest.advanceTimersByTimeAsync(AI_STATUS_POLL_INTERVAL_MS * 3);
    expect(send).toHaveBeenCalledTimes(3);
    setIntervalSpy.mockRestore();
  });

  it('oldingi so‘rov tugamagan bo‘lsa yangisi yuborilmaydi (ustma-ust so‘rov yo‘q)', async () => {
    jest.useFakeTimers();
    const { client, send } = makeClient(() => NEVER);
    const poller = new AiStatusPoller(client, makeConfig(true));

    const first = poller.poll();
    await poller.poll();
    expect(send).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(AI_STATUS_POLL_TIMEOUT_MS);
    await first;

    const second = poller.poll();
    expect(send).toHaveBeenCalledTimes(2);
    await jest.advanceTimersByTimeAsync(AI_STATUS_POLL_TIMEOUT_MS);
    await second;
    expect(poller.getState()).toBe('unknown');
  });

  it('AI mijozi yo‘q bo‘lsa taymer ham, so‘rov ham yo‘q; holat unknown', async () => {
    const poller = new AiStatusPoller(undefined, makeConfig(true));
    poller.onModuleInit();
    await poller.poll();
    expect((poller as unknown as { timer: unknown }).timer).toBeNull();
    expect(poller.getState()).toBe('unknown');
    poller.onModuleDestroy();
  });
});
