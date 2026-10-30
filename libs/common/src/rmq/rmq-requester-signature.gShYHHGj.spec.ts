import { CallHandler, ExecutionContext, Logger } from '@nestjs/common';
import { RmqRecordBuilder, RpcException } from '@nestjs/microservices';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { firstValueFrom, of } from 'rxjs';
import { RequestContextRmqSerializer } from '../context/rmq-context.serializer';
import { RmqTraceInterceptor } from '../context/rmq-trace.interceptor';
import {
  RMQ_REQUESTER_SIG_HEADER,
  RMQ_REQUESTER_SIG_SKEW_MS,
  RMQ_REQUESTER_SIG_TTL_MS,
  assertRmqRequesterSigConfig,
  hasRequesterClaim,
  resetRmqRequesterSigStateForTests,
  rmqCmdOf,
  rmqRequesterSigMode,
  setRmqSignerKind,
  signRmqRequester,
  verifyRmqRequester,
} from './rmq-requester-signature';

const SECRET = 'x'.repeat(40);
const SUPERADMIN = { id: '1', roles: ['superadmin'] };

/** Transport ko'rinishi: serializer chiqishi → JSON → qabul tomoni. */
function send(pattern: unknown, data: unknown) {
  const packet = new RequestContextRmqSerializer().serialize({
    pattern,
    data,
    id: 'p1',
  }) as {
    data: unknown;
    options?: { headers?: Record<string, string> };
  };
  return {
    data: JSON.parse(JSON.stringify({ data: packet.data })).data as unknown,
    headers: packet.options?.headers ?? {},
  };
}

function deliver(
  cmd: string,
  data: unknown,
  headers: Record<string, unknown> = {},
) {
  const nack = jest.fn();
  const message = { properties: { headers } };
  const handled = jest.fn(() => of('handler-result'));
  const rpcContext = {
    getPattern: () => JSON.stringify({ cmd }),
    getMessage: () => message,
    getChannelRef: () => ({ nack }),
  };
  const context = {
    getType: () => 'rpc',
    switchToRpc: () => ({ getData: () => data, getContext: () => rpcContext }),
  } as unknown as ExecutionContext;
  const next = { handle: handled } as unknown as CallHandler;
  const result = firstValueFrom(
    new RmqTraceInterceptor().intercept(context, next),
  );
  return { result, handled, nack, message };
}

describe('RMQ requester imzosi (gShYHHGj P2·B)', () => {
  let warn: jest.SpyInstance;

  beforeEach(() => {
    resetRmqRequesterSigStateForTests();
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    process.env.RMQ_REQUESTER_SIG_SECRET = SECRET;
    delete process.env.RMQ_REQUESTER_SIG_MODE;
  });

  afterEach(() => {
    jest.restoreAllMocks();
    delete process.env.RMQ_REQUESTER_SIG_SECRET;
    delete process.env.RMQ_REQUESTER_SIG_MODE;
  });

  describe('off (sukut) — xulq o`zgarmaydi', () => {
    it('imzo qo`yilmaydi, soxta requester handler`ga o`tadi, jurnal jim', async () => {
      const sent = send({ cmd: 'finance.x' }, { requester: SUPERADMIN });
      expect(sent.headers[RMQ_REQUESTER_SIG_HEADER]).toBeUndefined();

      const { result, handled } = deliver('finance.x', {
        requester: SUPERADMIN,
      });
      await expect(result).resolves.toBe('handler-result');
      expect(handled).toHaveBeenCalled();
      expect(warn).not.toHaveBeenCalled();
    });

    it('mode bo`sh/off — `off`', () => {
      expect(rmqRequesterSigMode()).toBe('off');
      process.env.RMQ_REQUESTER_SIG_MODE = ' OFF ';
      expect(rmqRequesterSigMode()).toBe('off');
    });
  });

  describe('enforce', () => {
    beforeEach(() => {
      process.env.RMQ_REQUESTER_SIG_MODE = 'enforce';
    });

    it('gateway imzolagan xabar serializer → sim → interceptor yo`lidan o`tadi', async () => {
      setRmqSignerKind('gateway');
      const data = {
        requester: SUPERADMIN,
        amount: 12_000,
        at: new Date('2026-10-30T10:00:00Z'),
        skipped: undefined,
        note: "ga'ayrioddiy matn ✓",
      };
      const sent = send({ cmd: 'finance.x' }, data);
      expect(sent.headers[RMQ_REQUESTER_SIG_HEADER]).toMatch(
        /^v1\.gateway\.\d+\.[0-9a-f]{64}$/,
      );

      const { result, handled, nack } = deliver(
        'finance.x',
        sent.data,
        sent.headers,
      );
      await expect(result).resolves.toBe('handler-result');
      expect(handled).toHaveBeenCalled();
      expect(nack).not.toHaveBeenCalled();
      expect(warn).not.toHaveBeenCalled();
    });

    it('imzosiz superadmin (buzilgan konteyner) rad etiladi: handler ishlamaydi, DLQ, 403', async () => {
      const { result, handled, nack, message } = deliver('finance.x', {
        requester: SUPERADMIN,
      });
      const error = await result.catch((e: unknown) => e);

      expect(error).toBeInstanceOf(RpcException);
      expect((error as RpcException).getError()).toEqual({
        statusCode: 403,
        message: "So'rov imzosi yaroqsiz",
      });
      expect(handled).not.toHaveBeenCalled();
      expect(nack).toHaveBeenCalledWith(message, false, false);
    });

    it.each([
      [
        'requester almashtirilgan',
        { requester: { id: '1', roles: ['superadmin'] } },
      ],
      ['pul maydoni almashtirilgan', { requester: { id: '7' }, amount: 9e6 }],
    ])('imzodan keyin %s — rad etiladi', async (_name, tampered) => {
      const sent = send(
        { cmd: 'finance.x' },
        { requester: { id: '7' }, amount: 1 },
      );
      const { result, handled } = deliver('finance.x', tampered, sent.headers);
      await expect(result).rejects.toBeInstanceOf(RpcException);
      expect(handled).not.toHaveBeenCalled();
    });

    it('imzo boshqa cmd`ga ko`chirilsa rad etiladi', async () => {
      const data = { requester: SUPERADMIN };
      const sent = send({ cmd: 'order.find_by_id' }, data);
      const { result, handled } = deliver('finance.x', data, sent.headers);
      await expect(result).rejects.toBeInstanceOf(RpcException);
      expect(handled).not.toHaveBeenCalled();
    });

    it('`kind` ni `internal` dan `gateway` ga almashtirib bo`lmaydi', async () => {
      const data = { requester: SUPERADMIN };
      const header = signRmqRequester({
        cmd: 'finance.x',
        data,
        secret: SECRET,
        kind: 'internal',
      }).replace('.internal.', '.gateway.');
      const { result } = deliver('finance.x', data, {
        [RMQ_REQUESTER_SIG_HEADER]: header,
      });
      await expect(result).rejects.toBeInstanceOf(RpcException);
    });

    it('boshqa sir bilan imzolangan xabar rad etiladi', async () => {
      const data = { requester: SUPERADMIN };
      const header = signRmqRequester({
        cmd: 'finance.x',
        data,
        secret: 'y'.repeat(40),
        kind: 'gateway',
      });
      const { result } = deliver('finance.x', data, {
        [RMQ_REQUESTER_SIG_HEADER]: header,
      });
      await expect(result).rejects.toBeInstanceOf(RpcException);
    });

    it('servis→servis: gateway deb belgilanmagan jarayon `internal` imzolaydi va o`tadi', async () => {
      const sent = send(
        { cmd: 'branch.user.find_by_user' },
        { user_id: '5', requester: { id: '5', roles: ['system'] } },
      );
      expect(sent.headers[RMQ_REQUESTER_SIG_HEADER]).toMatch(/^v1\.internal\./);
      const { result, handled } = deliver(
        'branch.user.find_by_user',
        sent.data,
        sent.headers,
      );
      await expect(result).resolves.toBe('handler-result');
      expect(handled).toHaveBeenCalled();
    });

    it('outbox relay: `emit` paketi (ALS yo`q) ham imzolanadi — imzo yuborish paytida', async () => {
      const payload = { order_id: 1, requester: { id: '9', roles: ['admin'] } };
      const sent = send({ cmd: 'finance.sale.legs' }, payload);
      const { result } = deliver('finance.sale.legs', sent.data, sent.headers);
      await expect(result).resolves.toBe('handler-result');
    });

    it('requester`siz tizim chaqiruvi imzosiz o`tadi', async () => {
      const sent = send({ cmd: 'notification.dispatch' }, { order_id: 1 });
      expect(sent.headers[RMQ_REQUESTER_SIG_HEADER]).toBeUndefined();

      const { result, handled, nack } = deliver('notification.dispatch', {
        order_id: 1,
        requester: null,
      });
      await expect(result).resolves.toBe('handler-result');
      expect(handled).toHaveBeenCalled();
      expect(nack).not.toHaveBeenCalled();
    });

    it('sirsiz enforce servisni boot`da yiqitadi', () => {
      delete process.env.RMQ_REQUESTER_SIG_SECRET;
      expect(() => new RmqTraceInterceptor()).toThrow(
        /RMQ_REQUESTER_SIG_SECRET/,
      );
      process.env.RMQ_REQUESTER_SIG_SECRET = 'qisqa';
      expect(() => assertRmqRequesterSigConfig()).toThrow();
    });
  });

  describe('log', () => {
    beforeEach(() => {
      process.env.RMQ_REQUESTER_SIG_MODE = 'log';
    });

    it('imzo yo`q yoki noto`g`ri — handler ishlaydi, faqat ogohlantirish', async () => {
      const missing = deliver('finance.x', { requester: SUPERADMIN });
      await expect(missing.result).resolves.toBe('handler-result');
      expect(missing.nack).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('cmd=finance.x reason=missing mode=log'),
      );

      const bad = deliver(
        'finance.x',
        { requester: SUPERADMIN },
        { [RMQ_REQUESTER_SIG_HEADER]: 'v1.gateway.1.abcd' },
      );
      await expect(bad.result).resolves.toBe('handler-result');
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('reason=bad_mac'),
      );
    });

    it('bir xil buzilish daqiqada bir marta yoziladi', async () => {
      for (let i = 0; i < 5; i += 1) {
        await deliver('finance.flood', { requester: SUPERADMIN }).result;
      }
      expect(warn).toHaveBeenCalledTimes(1);
    });

    it('sir yo`q: imzolanmaydi, trafik to`xtamaydi', async () => {
      delete process.env.RMQ_REQUESTER_SIG_SECRET;
      const sent = send({ cmd: 'finance.x' }, { requester: SUPERADMIN });
      expect(sent.headers[RMQ_REQUESTER_SIG_HEADER]).toBeUndefined();
      await expect(
        deliver('finance.x', sent.data, sent.headers).result,
      ).resolves.toBe('handler-result');
    });

    it('noma`lum rejim qiymati jim o`chib qolmaydi — `log`', () => {
      process.env.RMQ_REQUESTER_SIG_MODE = 'enforced';
      expect(rmqRequesterSigMode()).toBe('log');
      expect(warn).toHaveBeenCalledTimes(1);
    });
  });

  describe('sof tekshiruv', () => {
    const data = { requester: SUPERADMIN };
    const signedAt = 1_800_000_000_000;
    const header = signRmqRequester({
      cmd: 'finance.x',
      data,
      secret: SECRET,
      kind: 'gateway',
      now: signedAt,
    });
    const verify = (now: number, value: string | undefined = header) =>
      verifyRmqRequester({
        cmd: 'finance.x',
        data,
        header: value,
        secret: SECRET,
        now,
      });

    it('muddat chegaralari: TTL ichida yaroqli, keyin eskirgan', () => {
      expect(verify(signedAt + RMQ_REQUESTER_SIG_TTL_MS)).toEqual({
        ok: true,
        source: 'gateway',
      });
      expect(verify(signedAt + RMQ_REQUESTER_SIG_TTL_MS + 1)).toEqual({
        ok: false,
        reason: 'expired',
      });
      expect(verify(signedAt - RMQ_REQUESTER_SIG_SKEW_MS - 1)).toEqual({
        ok: false,
        reason: 'expired',
      });
    });

    it('TTL navbat kutish muddatidan (60 s) katta', () => {
      expect(RMQ_REQUESTER_SIG_TTL_MS).toBeGreaterThan(60_000);
    });

    it.each(['v2.gateway.1.aa', 'v1.root.1.aa', 'v1.gateway.x.aa', 'garbage'])(
      'buzuq sarlavha: %s',
      (value) => {
        expect(verify(signedAt, value)).toEqual({
          ok: false,
          reason: 'malformed',
        });
      },
    );

    it('rmqCmdOf: obyekt, JSON satr, oddiy satr', () => {
      expect(rmqCmdOf({ cmd: 'a.b' })).toBe('a.b');
      expect(rmqCmdOf('{"cmd":"a.b"}')).toBe('a.b');
      expect(rmqCmdOf('a.b')).toBe('a.b');
      expect(rmqCmdOf(undefined)).toBe('');
    });

    it.each([
      [{ requester: { id: '1' } }, true],
      [{ requester_id: '1', requester_roles: ['admin'] }, true],
      [{ actor: { id: '1' } }, true],
      [{ user: { sub: '1' } }, true],
      [{ requester: null, requester_id: null, user: '' }, false],
      [{ user_id: '1', created_by: '2' }, false],
      [[{ requester: { id: '1' } }], false],
      ['matn', false],
      [null, false],
    ])('da`vo aniqlash: %j → %s', (value, expected) => {
      expect(hasRequesterClaim(value)).toBe(expected);
    });
  });

  it('test serverda `log`, prod compose rejimni qo`ymaydi (sukut off)', () => {
    const root = join(__dirname, '../../../..');
    const staging = readFileSync(
      join(root, 'docker-compose.staging.yml'),
      'utf8',
    );
    const prod = readFileSync(join(root, 'docker-compose.prod.yml'), 'utf8');

    expect(staging).toMatch(
      /x-stg-env: &stg-env\n(?: {2}.*\n)*? {2}RMQ_REQUESTER_SIG_MODE: log\n/,
    );
    expect(prod).not.toContain('RMQ_REQUESTER_SIG_MODE');
  });

  it('chaqiruvchi RmqRecord bilan bergan sarlavha va opsiyalar saqlanadi', () => {
    process.env.RMQ_REQUESTER_SIG_MODE = 'enforce';
    const record = new RmqRecordBuilder({ requester: SUPERADMIN })
      .setOptions({ headers: { 'x-own': '1' }, priority: 3 })
      .build();
    const sent = new RequestContextRmqSerializer().serialize({
      pattern: { cmd: 'finance.x' },
      data: record,
    }) as {
      data: unknown;
      options: { priority: number; headers: Record<string, string> };
    };

    expect(sent.data).toEqual({ requester: SUPERADMIN });
    expect(sent.options.priority).toBe(3);
    expect(sent.options.headers['x-own']).toBe('1');
    expect(sent.options.headers[RMQ_REQUESTER_SIG_HEADER]).toMatch(/^v1\./);
  });
});
