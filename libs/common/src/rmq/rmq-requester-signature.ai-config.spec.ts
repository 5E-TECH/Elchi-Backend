import { ExecutionContext, Logger } from '@nestjs/common';
import { firstValueFrom, of } from 'rxjs';
import { RequestContextRmqSerializer } from '../context/rmq-context.serializer';
import { RmqTraceInterceptor } from '../context/rmq-trace.interceptor';
import {
  RMQ_REQUESTER_SIG_HEADER,
  isAiConfigCmd,
  resetRmqRequesterSigStateForTests,
  rmqRequesterSigSecret,
  setRmqSignerKind,
  verifyRmqRequester,
} from './rmq-requester-signature';

/**
 * be-brief D1: `ai.config.*` yozuvlari gateway imzosi bilan keladi —
 * `RMQ_REQUESTER_SIG_MODE` dan QAT'I NAZAR (sir bo'lsa). Global interceptor
 * ularni o'tkazib yuboradi: qaror ai-service handler'ida ({ok:false} + ack).
 */
const SECRET = 'y'.repeat(40);
const SUPERADMIN = { id: '7', roles: ['superadmin'] };

function headersOf(pattern: unknown, data: unknown): Record<string, string> {
  const packet = new RequestContextRmqSerializer().serialize({
    pattern,
    data,
    id: 'p1',
  }) as { options?: { headers?: Record<string, string> } };
  return packet.options?.headers ?? {};
}

describe('ai.config.* imzosi (D1)', () => {
  beforeEach(() => {
    resetRmqRequesterSigStateForTests();
    jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    process.env.RMQ_REQUESTER_SIG_SECRET = SECRET;
    delete process.env.RMQ_REQUESTER_SIG_MODE;
  });
  afterEach(() => {
    jest.restoreAllMocks();
    resetRmqRequesterSigStateForTests();
    delete process.env.RMQ_REQUESTER_SIG_SECRET;
    delete process.env.RMQ_REQUESTER_SIG_MODE;
  });

  it('isAiConfigCmd', () => {
    expect(isAiConfigCmd('ai.config.key.set')).toBe(true);
    expect(isAiConfigCmd('ai.config.get')).toBe(true);
    expect(isAiConfigCmd('ai.status')).toBe(false);
    expect(isAiConfigCmd('ai.configx')).toBe(false);
  });

  it('mode off: ai.config.* baribir imzolanadi (gateway kind), boshqalar — yo‘q', () => {
    setRmqSignerKind('gateway');
    const data = { requester: SUPERADMIN, sent_at: 1 };
    const h = headersOf({ cmd: 'ai.config.key.set' }, data);
    expect(h[RMQ_REQUESTER_SIG_HEADER]).toMatch(/^v1\.gateway\./);
    const verdict = verifyRmqRequester({
      cmd: 'ai.config.key.set',
      data: JSON.parse(JSON.stringify(data)),
      header: h[RMQ_REQUESTER_SIG_HEADER],
      secret: rmqRequesterSigSecret(),
    });
    expect(verdict).toEqual({ ok: true, source: 'gateway' });

    expect(
      headersOf({ cmd: 'ai.status' }, data)[RMQ_REQUESTER_SIG_HEADER],
    ).toBeUndefined();
  });

  it('sir yo‘q: imzo yo‘q (handler AI_CONFIG_UNSIGNED qaytaradi)', () => {
    delete process.env.RMQ_REQUESTER_SIG_SECRET;
    expect(rmqRequesterSigSecret()).toBeUndefined();
    expect(
      headersOf({ cmd: 'ai.config.key.set' }, { requester: SUPERADMIN })[
        RMQ_REQUESTER_SIG_HEADER
      ],
    ).toBeUndefined();
  });

  it('qisqa sir — yo‘q deb hisoblanadi', () => {
    process.env.RMQ_REQUESTER_SIG_SECRET = 'short';
    expect(rmqRequesterSigSecret()).toBeUndefined();
  });

  it('enforce: imzosiz ai.config.* interceptor’da nack/throw QILINMAYDI — handler’ga o‘tadi', async () => {
    process.env.RMQ_REQUESTER_SIG_MODE = 'enforce';
    const nack = jest.fn();
    const handle = jest.fn(() => of({ ok: false }));
    const rpcContext = {
      getPattern: () => JSON.stringify({ cmd: 'ai.config.key.set' }),
      getMessage: () => ({ properties: { headers: {} } }),
      getChannelRef: () => ({ nack }),
    };
    const context = {
      getType: () => 'rpc',
      switchToRpc: () => ({
        getData: () => ({ requester: SUPERADMIN }),
        getContext: () => rpcContext,
      }),
    } as unknown as ExecutionContext;
    await expect(
      firstValueFrom(
        new RmqTraceInterceptor().intercept(context, {
          handle,
        }),
      ),
    ).resolves.toEqual({ ok: false });
    expect(handle).toHaveBeenCalled();
    expect(nack).not.toHaveBeenCalled();
  });
});
