import { readFileSync } from 'fs';
import { join } from 'path';
import { AI_MIN_BUDGET_MS } from '@app/common';
import {
  AI_DLQ_DRAIN_PREFETCH,
  describeDeadLetter,
  runAiHandler,
  startAiDlqDrain,
  type DlqDrainChannel,
  type DlqDrainConnection,
  type DlqDrainMessage,
} from './run-ai-handler';

describe('runAiHandler (Gy8Lt6KT — eskirgan xabar, throw yo‘q)', () => {
  const NOW = 1_800_000_000_000;
  let warn: jest.Mock<void, [string]>;
  let error: jest.Mock<void, [string]>;

  beforeEach(() => {
    jest.spyOn(Date, 'now').mockReturnValue(NOW);
    warn = jest.fn<void, [string]>();
    error = jest.fn<void, [string]>();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('eskirgan deadline_at: fn CHAQIRILMAYDI va network qaytadi', async () => {
    const fn = jest.fn().mockResolvedValue({ ok: true });
    const res = await runAiHandler(
      { deadline_at: NOW + AI_MIN_BUDGET_MS - 1 },
      fn,
      { warn, error },
      'ai.order.extract',
    );
    expect(res).toEqual({ ok: false, reason: 'network' });
    expect(fn).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain('ai.order.extract');
  });

  it('muddati allaqachon o‘tgan xabar ham fn’ni chaqirmaydi', async () => {
    const fn = jest.fn().mockResolvedValue({ ok: true });
    const res = await runAiHandler({ deadline_at: NOW - 5_000 }, fn, {
      warn,
      error,
    });
    expect(res).toEqual({ ok: false, reason: 'network' });
    expect(fn).not.toHaveBeenCalled();
  });

  it('yetarli vaqt qolgan bo‘lsa fn deadlineAt bilan chaqiriladi', async () => {
    const deadline = NOW + AI_MIN_BUDGET_MS + 1;
    const fn = jest.fn().mockResolvedValue({ ok: true, orders: [] });
    const res = await runAiHandler({ deadline_at: deadline }, fn, {
      warn,
      error,
    });
    expect(res).toEqual({ ok: true, orders: [] });
    expect(fn).toHaveBeenCalledWith(deadline);
    expect(warn).not.toHaveBeenCalled();
  });

  it('deadline_at berilmasa (yoki son emas) fn undefined bilan chaqiriladi', async () => {
    const fn = jest
      .fn<Promise<string>, [number | undefined]>()
      .mockResolvedValue('x');
    await runAiHandler({}, fn, { warn, error });
    await runAiHandler({ deadline_at: 'abc' as unknown as number }, fn, {
      warn,
      error,
    });
    await runAiHandler(null, fn, { warn, error });
    expect(fn).toHaveBeenCalledTimes(3);
    for (const call of fn.mock.calls) expect(call[0]).toBeUndefined();
  });

  it('fn throw qilsa (reject) → {ok:false, reason:network}, throw YO‘Q', async () => {
    const fn = jest.fn().mockRejectedValue(new Error('db down'));
    await expect(
      runAiHandler({ deadline_at: NOW + 60_000 }, fn, { warn, error }),
    ).resolves.toEqual({ ok: false, reason: 'network' });
    expect(error).toHaveBeenCalledTimes(1);
  });

  it('fn sinxron throw qilsa ham natija network', async () => {
    const fn = jest.fn(() => {
      throw new TypeError('boom');
    });
    await expect(runAiHandler({}, fn, { warn, error })).resolves.toEqual({
      ok: false,
      reason: 'network',
    });
  });

  it('ERROR logida payload (matn/telefon) YO‘Q', async () => {
    const payload = {
      deadline_at: NOW + 60_000,
      text: 'Ali +998901234567 Andijon Asaka 3 ta atir',
    };
    const fn = jest
      .fn()
      .mockRejectedValue(new Error('parse failed near +998901234567'));
    await runAiHandler(payload, fn, { warn, error }, 'ai.order.extract');
    const line = String(error.mock.calls[0][0]);
    expect(line).toContain('ai.order.extract');
    expect(line).not.toContain('Andijon Asaka');
    expect(line).not.toContain('901234567');
  });

  it('logger o‘zi throw qilsa ham runAiHandler throw qilmaydi', async () => {
    const badLogger = {
      warn: () => {
        throw new Error('logger down');
      },
      error: () => {
        throw new Error('logger down');
      },
    };
    await expect(
      runAiHandler({ deadline_at: NOW }, jest.fn(), badLogger),
    ).resolves.toEqual({ ok: false, reason: 'network' });
    await expect(
      runAiHandler({}, jest.fn().mockRejectedValue(new Error('x')), badLogger),
    ).resolves.toEqual({ ok: false, reason: 'network' });
  });
});

// ─────────────────────────────────────────────────────────────────────────
// ai_queue_dlq drain (HD5zOyBp #11/#16 — muddati o'tgan AI xabari
// (xom matn + base64 rasm) RabbitMQ diskida qolmaydi)
// ─────────────────────────────────────────────────────────────────────────

const PHONE = '+998901234567';
const BASE64 = 'QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo'.repeat(40);

/** Nest ClientRMQ yuboradigan paket bilan bir xil shakl. */
function nestPacket(cmd: string, data: unknown): Buffer {
  return Buffer.from(
    JSON.stringify({
      pattern: JSON.stringify({ cmd }),
      data,
      id: 'corr-1',
    }),
  );
}

function deadLetter(
  cmd: string,
  reason: string | null,
  data: unknown = {},
): DlqDrainMessage {
  return {
    content: nestPacket(cmd, data),
    properties: {
      headers:
        reason === null
          ? {}
          : {
              'x-first-death-reason': reason,
              'x-death': [{ reason, queue: 'ai_queue', count: 1 }],
            },
    },
  };
}

const extractPayload = {
  text: `Ali ${PHONE} Andijon Asaka 3 ta atir`,
  images: [{ media_type: 'image/jpeg', data_base64: BASE64 }],
  market_id: 'm-1',
  deadline_at: 1,
};

describe('describeDeadLetter — faqat cmd va sabab, payload YO‘Q', () => {
  it('Nest paketidan cmd va x-first-death-reason olinadi', () => {
    expect(
      describeDeadLetter(
        deadLetter('ai.order.extract', 'expired', extractPayload),
      ),
    ).toEqual({ cmd: 'ai.order.extract', reason: 'expired' });
  });

  it('x-first-death-reason bo‘lmasa x-death[0].reason ishlatiladi', () => {
    const msg: DlqDrainMessage = {
      content: nestPacket('ai.cap.raise', {}),
      properties: { headers: { 'x-death': [{ reason: 'rejected' }] } },
    };
    expect(describeDeadLetter(msg)).toEqual({
      cmd: 'ai.cap.raise',
      reason: 'rejected',
    });
  });

  it('noma’lum shakl → unknown (throw yo‘q, matn chiqmaydi)', () => {
    const garbage: DlqDrainMessage = {
      content: Buffer.from(`${PHONE} Andijon ${BASE64}`),
      properties: {
        headers: { 'x-first-death-reason': `bad ${PHONE}`, 'x-death': 5 },
      },
    };
    expect(describeDeadLetter(garbage)).toEqual({
      cmd: 'unknown',
      reason: 'unknown',
    });
    expect(describeDeadLetter({ content: null as unknown as Buffer })).toEqual({
      cmd: 'unknown',
      reason: 'unknown',
    });
  });
});

type Listener = (err?: unknown) => void;

class FakeChannel implements DlqDrainChannel {
  listeners: Record<string, Listener[]> = {};
  onMessage: ((msg: DlqDrainMessage | null) => void) | null = null;
  acked: DlqDrainMessage[] = [];
  prefetch = jest.fn((count: number) => Promise.resolve(count));
  consume = jest.fn(
    (_queue: string, cb: (msg: DlqDrainMessage | null) => void) => {
      this.onMessage = cb;
      return Promise.resolve({ consumerTag: 't1' });
    },
  );
  ack = jest.fn((msg: DlqDrainMessage) => {
    this.acked.push(msg);
  });
  on(event: 'error' | 'close', listener: Listener) {
    (this.listeners[event] ??= []).push(listener);
    return this;
  }
  emit(event: string, err?: unknown) {
    for (const l of this.listeners[event] ?? []) l(err);
  }
}

class FakeConnection implements DlqDrainConnection {
  listeners: Record<string, Listener[]> = {};
  channel = new FakeChannel();
  createChannel = jest.fn(() => Promise.resolve(this.channel));
  close = jest.fn(() => {
    this.emit('close');
    return Promise.resolve();
  });
  on(event: 'error' | 'close', listener: Listener) {
    (this.listeners[event] ??= []).push(listener);
    return this;
  }
  emit(event: string, err?: unknown) {
    for (const l of this.listeners[event] ?? []) l(err);
  }
}

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
}

describe('startAiDlqDrain — ai_queue_dlq xabarlari darhol tashlanadi', () => {
  let logs: string[];
  let logger: {
    warn: jest.Mock<void, [string]>;
    error: jest.Mock<void, [string]>;
    log: jest.Mock<void, [string]>;
  };

  beforeEach(() => {
    jest.useFakeTimers();
    logs = [];
    const push = (m: string) => {
      logs.push(m);
    };
    logger = {
      warn: jest.fn<void, [string]>(push),
      error: jest.fn<void, [string]>(push),
      log: jest.fn<void, [string]>(push),
    };
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('DLQ’ga noAck:false + prefetch 1 bilan ulanadi va har xabarni ack qiladi', async () => {
    const conn = new FakeConnection();
    const drain = startAiDlqDrain({
      connect: () => Promise.resolve(conn),
      queue: 'ai_queue_dlq',
      logger,
    });
    await flushMicrotasks();

    expect(conn.channel.prefetch).toHaveBeenCalledWith(AI_DLQ_DRAIN_PREFETCH);
    expect(AI_DLQ_DRAIN_PREFETCH).toBe(1);
    expect(conn.channel.consume).toHaveBeenCalledWith(
      'ai_queue_dlq',
      expect.any(Function),
      { noAck: false },
    );

    const m1 = deadLetter('ai.order.extract', 'expired', extractPayload);
    const m2 = deadLetter('ai.order.extract', 'expired', extractPayload);
    const m3 = deadLetter('ai.cap.raise', 'rejected', { extra_usd: 5 });
    conn.channel.onMessage!(m1);
    conn.channel.onMessage!(m2);
    conn.channel.onMessage!(m3);
    expect(conn.channel.acked).toEqual([m1, m2, m3]);

    await drain.stop();
  });

  it('hisobot bitta WARN qatori: cmd/sabab/son — matn, telefon, base64 YO‘Q', async () => {
    const conn = new FakeConnection();
    const drain = startAiDlqDrain({
      connect: () => Promise.resolve(conn),
      queue: 'ai_queue_dlq',
      logger,
      flushMs: 1_000,
    });
    await flushMicrotasks();
    conn.channel.onMessage!(
      deadLetter('ai.order.extract', 'expired', extractPayload),
    );
    conn.channel.onMessage!(
      deadLetter('ai.order.extract', 'expired', extractPayload),
    );
    conn.channel.onMessage!(deadLetter('ai.usage.summary', null));

    expect(logger.warn).not.toHaveBeenCalled();
    jest.advanceTimersByTime(1_000);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    const line = String(logger.warn.mock.calls[0][0]);
    expect(line).toContain('ai_dlq_dropped');
    expect(line).toContain('ai.order.extract/expired=2');
    expect(line).toContain('ai.usage.summary/unknown=1');
    expect(line).toContain('total=3');

    const all = logs.join('\n');
    expect(all).not.toContain('Andijon');
    expect(all).not.toContain('901234567');
    expect(all).not.toContain(BASE64.slice(0, 20));

    await drain.stop();
  });

  it('ack throw qilsa ham drain throw qilmaydi (xabar navbatda qoladi)', async () => {
    const conn = new FakeConnection();
    conn.channel.ack.mockImplementation(() => {
      throw new Error('Channel closed');
    });
    const drain = startAiDlqDrain({
      connect: () => Promise.resolve(conn),
      queue: 'ai_queue_dlq',
      logger,
    });
    await flushMicrotasks();
    expect(() =>
      conn.channel.onMessage!(deadLetter('ai.order.extract', 'expired')),
    ).not.toThrow();
    await drain.stop();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('connect xatosi boot’ni yiqitmaydi — backoff bilan qayta ulanadi', async () => {
    const conn = new FakeConnection();
    const connect = jest
      .fn<Promise<DlqDrainConnection>, []>()
      .mockRejectedValueOnce(new Error('connect ECONNREFUSED 127.0.0.1:5672'))
      .mockResolvedValueOnce(conn);

    const drain = startAiDlqDrain({
      connect,
      queue: 'ai_queue_dlq',
      logger,
      retryBaseMs: 100,
    });
    await flushMicrotasks();
    expect(connect).toHaveBeenCalledTimes(1);
    expect(String(logger.warn.mock.calls[0][0])).toContain(
      'ai_dlq_drain_unavailable',
    );

    jest.advanceTimersByTime(100);
    await flushMicrotasks();
    expect(connect).toHaveBeenCalledTimes(2);
    expect(conn.channel.consume).toHaveBeenCalledTimes(1);
    await drain.stop();
  });

  it('ulanish uzilsa (RabbitMQ restart) qayta ulanadi; consumer bekor qilinsa ham', async () => {
    const c1 = new FakeConnection();
    const c2 = new FakeConnection();
    const c3 = new FakeConnection();
    const connect = jest
      .fn<Promise<DlqDrainConnection>, []>()
      .mockResolvedValueOnce(c1)
      .mockResolvedValueOnce(c2)
      .mockResolvedValueOnce(c3);
    const drain = startAiDlqDrain({
      connect,
      queue: 'ai_queue_dlq',
      logger,
      retryBaseMs: 50,
    });
    await flushMicrotasks();

    c1.emit('error', new Error('Connection closed: 320'));
    c1.emit('close');
    jest.advanceTimersByTime(50);
    await flushMicrotasks();
    expect(connect).toHaveBeenCalledTimes(2);
    expect(c2.channel.consume).toHaveBeenCalledTimes(1);

    // Broker consumer'ni bekor qildi (null xabar) → yangi ulanish.
    c2.channel.onMessage!(null);
    expect(c2.close).toHaveBeenCalled();
    jest.advanceTimersByTime(50);
    await flushMicrotasks();
    expect(connect).toHaveBeenCalledTimes(3);
    expect(c3.channel.consume).toHaveBeenCalledTimes(1);

    await drain.stop();
  });

  it('DLQ yo‘q bo‘lsa (consume 404) ham throw yo‘q, keyin qayta urinadi', async () => {
    const c1 = new FakeConnection();
    c1.channel.consume.mockRejectedValueOnce(
      new Error(
        "Operation failed: BasicConsume; 404 (NOT-FOUND) no queue 'ai_queue_dlq'",
      ),
    );
    const c2 = new FakeConnection();
    const connect = jest
      .fn<Promise<DlqDrainConnection>, []>()
      .mockResolvedValueOnce(c1)
      .mockResolvedValueOnce(c2);
    const drain = startAiDlqDrain({
      connect,
      queue: 'ai_queue_dlq',
      logger,
      retryBaseMs: 10,
    });
    await flushMicrotasks();
    expect(c1.close).toHaveBeenCalled();
    jest.advanceTimersByTime(10);
    await flushMicrotasks();
    expect(c2.channel.consume).toHaveBeenCalledTimes(1);
    await drain.stop();
  });

  it('stop(): ulanish yopiladi, qayta ulanish YO‘Q, qolgan hisobot yoziladi', async () => {
    const conn = new FakeConnection();
    const connect = jest
      .fn<Promise<DlqDrainConnection>, []>()
      .mockResolvedValue(conn);
    const drain = startAiDlqDrain({
      connect,
      queue: 'ai_queue_dlq',
      logger,
      retryBaseMs: 10,
    });
    await flushMicrotasks();
    conn.channel.onMessage!(deadLetter('ai.order.extract', 'expired'));

    await drain.stop();
    expect(conn.close).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(String(logger.warn.mock.calls[0][0])).toContain(
      'ai.order.extract/expired=1',
    );

    jest.advanceTimersByTime(60_000);
    await flushMicrotasks();
    expect(connect).toHaveBeenCalledTimes(1);
  });

  it('main.ts drain’ni setupDlqTopology(AI) dan KEYIN ishga tushiradi va to‘xtatadi', () => {
    const main = readFileSync(join(__dirname, '..', 'main.ts'), 'utf8');
    const topology = main.indexOf("setupDlqTopology('AI')");
    const drain = main.indexOf('startAiDlqDrain(');
    expect(topology).toBeGreaterThan(-1);
    expect(drain).toBeGreaterThan(topology);
    expect(main).toMatch(/queue:\s*`\$\{opts\.options!\.queue\}_dlq`/);
    expect(main.match(/await dlqDrain\?\.stop\(\)/g)?.length).toBe(2);
  });
});
