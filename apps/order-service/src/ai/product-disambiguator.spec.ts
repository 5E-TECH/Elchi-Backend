/**
 * `rmqSend` spy bilan o'raladi (haqiqiy implementatsiya ishlaydi) — AI
 * chaqiruvining opsiyalarini (`retries: 0`, muddatga bog'liq timeout)
 * tekshirish uchun.
 */
jest.mock('@app/common', () => {
  const actual =
    jest.requireActual<typeof import('@app/common')>('@app/common');
  return { ...actual, rmqSend: jest.fn(actual.rmqSend) };
});

import { readFileSync } from 'fs';
import { join } from 'path';
import { Logger } from '@nestjs/common';
import { RpcException, type ClientProxy } from '@nestjs/microservices';
import { Observable, of, throwError } from 'rxjs';
import {
  AI_MIN_BUDGET_MS,
  rmqSend as rmqSendFn,
  type AiProductDisambiguateRequest,
} from '@app/common';
import {
  NoopProductDisambiguator,
  PRODUCT_DISAMBIGUATOR,
  RmqProductDisambiguator,
} from './product-disambiguator';

const rmqSend = jest.mocked(rmqSendFn);

/**
 * luv25zlI — LLM disambiguation porti va RMQ adapteri.
 *
 * ⚠️ AI RPC qayta yuborilmaydi (`retries: 0`) va muddat yetmasa umuman
 * yuborilmaydi — har urinish Anthropic'dan pul yechadi.
 */

const request = (deadlineInMs: number): AiProductDisambiguateRequest => ({
  market_id: '121',
  requester: { id: '7', roles: ['market'] },
  trace_id: 'trace-1',
  draft_id: 'draft-1',
  deadline_at: Date.now() + deadlineInMs,
  items: [{ item_index: 0, name: 'atir sepgch', quantity: 2 }],
  catalog: [
    { index: 1, name: 'Atir sepgich' },
    { index: 2, name: 'Atir' },
    { index: 3, name: 'Blender' },
  ],
});

function client(reply: () => Observable<unknown>) {
  return { send: jest.fn(reply) };
}

let warn: jest.SpyInstance;

beforeEach(() => {
  rmqSend.mockClear();
  warn = jest
    .spyOn(Logger.prototype, 'warn')
    .mockImplementation(() => undefined);
});

afterEach(() => {
  warn.mockRestore();
});

describe('RmqProductDisambiguator', () => {
  it("{ok:true} → picks; 'ai.product.disambiguate' retries:0 va timeout <= 15s bilan", async () => {
    const aiClient = client(() =>
      of({ ok: true, picks: [{ item_index: 0, choice: 1 }] }),
    );
    const adapter = new RmqProductDisambiguator(
      aiClient as unknown as ClientProxy,
    );
    const req = request(60_000);

    await expect(adapter.pick(req)).resolves.toEqual({
      picks: [{ item_index: 0, choice: 1 }],
    });

    expect(aiClient.send).toHaveBeenCalledTimes(1);
    expect(aiClient.send).toHaveBeenCalledWith(
      { cmd: 'ai.product.disambiguate' },
      expect.objectContaining({
        market_id: '121',
        requester: { id: '7', roles: ['market'] },
        trace_id: 'trace-1',
        draft_id: 'draft-1',
        deadline_at: req.deadline_at,
        items: req.items,
        catalog: req.catalog,
      }),
    );
    expect(rmqSend).toHaveBeenCalledTimes(1);
    const opts = rmqSend.mock.calls[0][3] as {
      timeoutMs: number;
      retries: number;
    };
    expect(opts.retries).toBe(0);
    expect(opts.timeoutMs).toBe(15_000);
  });

  it("muddat qisqa bo'lsa timeout deadline-now-1000 ga tushadi", async () => {
    const aiClient = client(() => of({ ok: true, picks: [] }));
    const adapter = new RmqProductDisambiguator(
      aiClient as unknown as ClientProxy,
    );
    await adapter.pick(request(12_000));
    const opts = rmqSend.mock.calls[0][3] as {
      timeoutMs: number;
      retries: number;
    };
    expect(opts.retries).toBe(0);
    expect(opts.timeoutMs).toBeLessThanOrEqual(11_000);
    expect(opts.timeoutMs).toBeGreaterThan(10_500);
  });

  it.each([
    ['AI_MIN_BUDGET_MS dan kam qoldi', AI_MIN_BUDGET_MS - 1],
    ["muddat o'tib ketgan", -5_000],
  ])('%s → null, AI chaqirilmaydi', async (_name, left) => {
    const aiClient = client(() => of({ ok: true, picks: [] }));
    const adapter = new RmqProductDisambiguator(
      aiClient as unknown as ClientProxy,
    );
    await expect(adapter.pick(request(left))).resolves.toBeNull();
    expect(aiClient.send).not.toHaveBeenCalled();
    expect(rmqSend).not.toHaveBeenCalled();
  });

  it('deadline_at son emas — null, AI chaqirilmaydi', async () => {
    const aiClient = client(() => of({ ok: true, picks: [] }));
    const adapter = new RmqProductDisambiguator(
      aiClient as unknown as ClientProxy,
    );
    const req = { ...request(60_000), deadline_at: Number.NaN };
    await expect(adapter.pick(req)).resolves.toBeNull();
    expect(aiClient.send).not.toHaveBeenCalled();
  });

  it.each([
    ['{ok:false, reason}', { ok: false, reason: 'cap_exceeded' }],
    ['picks massiv emas', { ok: true, picks: null }],
    ['null javob', null],
  ])('%s → null', async (_name, reply) => {
    const aiClient = client(() => of(reply));
    const adapter = new RmqProductDisambiguator(
      aiClient as unknown as ClientProxy,
    );
    await expect(adapter.pick(request(60_000))).resolves.toBeNull();
  });

  it('RPC xatosi — null, xato tashlanmaydi', async () => {
    const aiClient = {
      send: jest.fn(() => throwError(() => new RpcException('ai down'))),
    };
    const adapter = new RmqProductDisambiguator(
      aiClient as unknown as ClientProxy,
    );
    await expect(adapter.pick(request(60_000))).resolves.toBeNull();
    expect(aiClient.send).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalled();
  });

  it('manbada chaqiruv ICHIDA literal naqsh va `retries: 0` bor (statik guard)', () => {
    const src = readFileSync(
      join(__dirname, 'product-disambiguator.ts'),
      'utf8',
    );
    const call = src.slice(src.indexOf('rmqSend<'));
    const args = call.slice(0, call.indexOf(');') + 2);
    expect(args).toMatch(/\{\s*cmd:\s*'ai\.product\.disambiguate'\s*\}/);
    expect(args).toMatch(/\bretries:\s*0(?![\d.])/);
    expect(args).not.toMatch(/\bretries:\s*[1-9]/);
  });
});

describe('NoopProductDisambiguator', () => {
  it('hech qachon AI chaqirmaydi — null', async () => {
    await expect(new NoopProductDisambiguator().pick()).resolves.toBeNull();
  });

  it('port tokeni Symbol', () => {
    expect(typeof PRODUCT_DISAMBIGUATOR).toBe('symbol');
  });
});
