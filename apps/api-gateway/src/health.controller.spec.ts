import { HttpStatus } from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import type { Response } from 'express';
import { NEVER, Observable, of, throwError } from 'rxjs';
import { AiStatusPoller } from './ai/ai-status.poller';
import { HealthController } from './health.controller';

/**
 * Gateway /health va /health/readiness (bVeyEuIR #2; PLAN C8).
 * `/health` dagi `ai` — AiStatusPoller keshidan, RMQ kutilmaydi.
 */
describe('HealthController', () => {
  const TOKENS = [
    'IDENTITY',
    'ORDER',
    'CATALOG',
    'LOGISTICS',
    'FINANCE',
    'NOTIFICATION',
    'INTEGRATION',
    'ANALYTICS',
    'BRANCH',
    'INVESTOR',
    'FILE',
    'C2C',
    'SEARCH',
  ];

  const client = (reply: () => Observable<unknown> = () => of({ ok: 1 })) => {
    const send = jest.fn<Observable<unknown>, [unknown, unknown]>(() =>
      reply(),
    );
    return { send, proxy: { send } as unknown as ClientProxy };
  };

  /** Mavjud 13 ta pozitsion mijoz + ixtiyoriy AI mijozi va poller. */
  const construct = (
    p: ClientProxy[],
    aiClient?: ClientProxy,
    poller?: AiStatusPoller,
  ) =>
    new HealthController(
      p[0],
      p[1],
      p[2],
      p[3],
      p[4],
      p[5],
      p[6],
      p[7],
      p[8],
      p[9],
      p[10],
      p[11],
      p[12],
      aiClient,
      poller,
    );

  const makeController = (
    opts: {
      ai?: ReturnType<typeof client> | null;
      poller?: Pick<AiStatusPoller, 'getState'> | null;
    } = {},
  ) => {
    const clients = TOKENS.map(() => client());
    const ai = opts.ai === undefined ? client() : opts.ai;
    const controller = construct(
      clients.map((c) => c.proxy),
      ai?.proxy,
      (opts.poller ?? undefined) as AiStatusPoller | undefined,
    );
    return { controller, clients, ai };
  };

  const fakeRes = () => {
    const res = { status: jest.fn() };
    res.status.mockReturnValue(res);
    return res as unknown as Response & { status: jest.Mock };
  };

  describe('GET /health (liveness)', () => {
    it.each(['enabled', 'disabled', 'cap_exceeded', 'unknown'] as const)(
      'bVeyEuIR #2: ai=%s poller keshidan chiqadi',
      (state) => {
        const poller = { getState: jest.fn(() => state) };
        const { controller } = makeController({ poller });

        expect(controller.check()).toEqual({
          status: 'ok',
          timestamp: expect.any(String) as unknown,
          service: 'api-gateway',
          ai: state,
        });
        expect(poller.getState).toHaveBeenCalledTimes(1);
      },
    );

    it('SINXRON — Promise qaytarmaydi va hech qanday RMQ so‘rovi yubormaydi', () => {
      const poller = { getState: jest.fn(() => 'enabled' as const) };
      const { controller, clients, ai } = makeController({ poller });

      const result: unknown = controller.check();

      expect(result).not.toBeInstanceOf(Promise);
      expect(typeof (result as { then?: unknown }).then).toBe('undefined');
      expect(ai?.send).not.toHaveBeenCalled();
      for (const c of clients) expect(c.send).not.toHaveBeenCalled();
    });

    it('poller yo‘q bo‘lsa ai=unknown', () => {
      const { controller } = makeController({ poller: null });
      expect(controller.check().ai).toBe('unknown');
    });

    it('eski pozitsion konstruktor (13 mijoz, AI’siz) ham ishlaydi', () => {
      const p = TOKENS.map(() => client().proxy);
      const controller = new HealthController(
        p[0],
        p[1],
        p[2],
        p[3],
        p[4],
        p[5],
        p[6],
        p[7],
        p[8],
        p[9],
        p[10],
        p[11],
        p[12],
      );
      expect(controller.check()).toMatchObject({ status: 'ok', ai: 'unknown' });
    });
  });

  describe('GET /health/readiness', () => {
    it("AI ro'yxatda — ai.health so'raladi", async () => {
      const { controller, ai } = makeController();
      const res = fakeRes();

      const body = await controller.readiness(res);

      expect(ai?.send).toHaveBeenCalledWith({ cmd: 'ai.health' }, {});
      expect(body.services.map((s) => s.service)).toEqual([...TOKENS, 'AI']);
      expect(body.services.find((s) => s.service === 'AI')).toMatchObject({
        status: 'ok',
      });
      expect(body.status).toBe('ok');
      expect(res.status).toHaveBeenCalledWith(HttpStatus.OK);
    });

    it('ai-service javob bermasa AI down va readiness 503 (liveness emas)', async () => {
      jest.useFakeTimers();
      try {
        const { controller } = makeController({ ai: client(() => NEVER) });
        const res = fakeRes();

        const pending = controller.readiness(res);
        await jest.advanceTimersByTimeAsync(1_500);
        const body = await pending;

        expect(body.services.find((s) => s.service === 'AI')).toMatchObject({
          status: 'down',
        });
        expect(body.status).toBe('degraded');
        expect(res.status).toHaveBeenCalledWith(HttpStatus.SERVICE_UNAVAILABLE);
      } finally {
        jest.useRealTimers();
      }
    });

    it('AI RPC xatosi → AI down', async () => {
      const { controller } = makeController({
        ai: client(() => throwError(() => new Error('no route'))),
      });
      const body = await controller.readiness(fakeRes());
      expect(body.services.find((s) => s.service === 'AI')).toMatchObject({
        status: 'down',
        error: 'no route',
      });
    });

    it('AI mijozi ro‘yxatdan o‘tmagan bo‘lsa AI unknown', async () => {
      const { controller } = makeController({ ai: null });
      const body = await controller.readiness(fakeRes());
      expect(body.services.find((s) => s.service === 'AI')).toMatchObject({
        status: 'unknown',
      });
    });
  });
});
