import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AuthenticationError, type APIError } from '@anthropic-ai/sdk';
import { ClaudeService } from './claude.service';
import {
  EnvAnthropicClientProvider,
  type AnthropicClientLease,
  type AnthropicClientProvider,
} from './anthropic-client.provider';
import type {
  AnthropicClientLike,
  ClaudeToolLoopOptions,
} from './claude.types';

/** BE-1c: lease semantikasi ClaudeService'da (be-brief §7, §12). */
const USAGE = {
  input_tokens: 1,
  output_tokens: 1,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
};
const META = { feature: 'assistant', requestArea: 'internal' } as const;

function client(
  tag: string,
  replies: unknown[],
  seen: string[],
): AnthropicClientLike {
  return {
    messages: {
      create: () => {
        seen.push(tag);
        const r = replies.shift();
        return r instanceof Error ? Promise.reject(r) : Promise.resolve(r);
      },
    },
  } as unknown as AnthropicClientLike;
}

function provider(leases: Array<AnthropicClientLease | null>) {
  let i = 0;
  const p: AnthropicClientProvider & {
    failures: unknown[];
    outcomes: string[];
  } = {
    failures: [],
    outcomes: [],
    acquire: () => leases[Math.min(i++, leases.length - 1)],
    keyState: () => ({ state: 'ok', misnamedKeys: [] }),
    reportCallFailure: (_l, feature, err) => p.failures.push([feature, err]),
    reportCallOutcome: (_l, _f, o) => p.outcomes.push(o),
  };
  return p;
}

const lease = (c: AnthropicClientLike, id: string): AnthropicClientLease => ({
  client: c,
  keyId: id,
  source: 'ui',
  fingerprint: 'aaaa bbbb cccc',
  configVersion: 3,
});

const svc = (p: AnthropicClientProvider) =>
  new ClaudeService(
    { get: () => undefined } as unknown as ConfigService,
    undefined,
    undefined,
    undefined,
    p,
  );

describe('ClaudeService + AnthropicClientProvider', () => {
  beforeAll(() => {
    for (const m of ['log', 'warn', 'error'] as const)
      jest.spyOn(Logger.prototype, m).mockImplementation();
  });
  afterAll(() => jest.restoreAllMocks());

  it('tool loop BITTA lease bilan tugaydi — o‘rtada kalit almashsa ham', async () => {
    const seen: string[] = [];
    const replies = [
      {
        stop_reason: 'tool_use',
        content: [{ type: 'tool_use', id: 't1', name: 'x', input: {} }],
        usage: USAGE,
      },
      {
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: 'ok' }],
        usage: USAGE,
      },
    ];
    const p = provider([
      lease(client('A', replies, seen), 'k-a'),
      lease(client('B', replies, seen), 'k-b'),
    ]);
    const records: unknown[] = [];
    const s = new ClaudeService(
      { get: () => undefined } as unknown as ConfigService,
      undefined,
      { record: (r) => records.push(r) },
      undefined,
      p,
    );
    const o: ClaudeToolLoopOptions = {
      system: 'S',
      messages: [{ role: 'user', content: 'q' }],
      tools: [
        { name: 'x', description: 'd', input_schema: { type: 'object' } },
      ],
      executeTool: () => Promise.resolve({ content: '{}', isError: false }),
      meta: META,
      inputText: 'q',
      model: 'claude-sonnet-5',
      maxSteps: 4,
      maxTokens: 1000,
    };
    await s.runToolLoop(o);
    expect(seen).toEqual(['A', 'A']);
    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({
      keyId: 'k-a',
      keySource: 'ui',
      keyFingerprint: 'aaaa bbbb cccc',
      configVersion: 3,
    });
    expect(p.outcomes).toEqual(['ok', 'ok']);
  });

  it('lease yo‘q → disabled, tarmoq yo‘q; xato → reportCallFailure (feature bilan)', async () => {
    await expect(
      svc(provider([null])).extractJson({
        system: 's',
        userText: 'u',
        schema: {},
        meta: META,
      }),
    ).resolves.toEqual({ ok: false, reason: 'disabled', attempts: 0 });

    const seen: string[] = [];
    const err = new AuthenticationError(
      401,
      { type: 'error' },
      'x',
      new Headers(),
    ) as APIError;
    const p = provider([lease(client('A', [err], seen), 'k')]);
    const r = await svc(p).extractJson({
      system: 's',
      userText: 'u',
      schema: {},
      meta: { feature: 'order_extract_multi', requestArea: 'order' },
    });
    expect(r.ok).toBe(false);
    expect(p.failures).toEqual([['order_extract_multi', err]]);
  });

  it('provayder throw qilsa ham ClaudeService yiqilmaydi', async () => {
    const p: AnthropicClientProvider = {
      acquire: () => {
        throw new Error('boom');
      },
      keyState: () => ({ state: 'ok', misnamedKeys: [] }),
      reportCallFailure: () => undefined,
      reportCallOutcome: () => undefined,
    };
    const s = svc(p);
    expect(s.isEnabled()).toBe(false);
    await expect(
      s.extractJson({ system: 's', userText: 'u', schema: {}, meta: META }),
    ).resolves.toMatchObject({ ok: false, reason: 'disabled' });
  });

  it('EnvAnthropicClientProvider: bugungi xulq — kalitsiz/o‘chiq bo‘lsa mijoz qurilmaydi', () => {
    const factory = jest.fn(
      () =>
        ({ messages: { create: jest.fn() } }) as unknown as AnthropicClientLike,
    );
    expect(
      new EnvAnthropicClientProvider('', factory, true).acquire(),
    ).toBeNull();
    expect(
      new EnvAnthropicClientProvider('sk-ant-x', factory, false).acquire(),
    ).toBeNull();
    expect(factory).not.toHaveBeenCalled();
    const l = new EnvAnthropicClientProvider(
      'sk-ant-api03-' + 'e'.repeat(40),
      factory,
      true,
    ).acquire();
    expect(l).toMatchObject({ keyId: null, source: 'env', configVersion: 0 });
    expect(l?.fingerprint).toMatch(/^[0-9a-f]{4} [0-9a-f]{4} [0-9a-f]{4}$/);
    expect(factory).toHaveBeenCalledTimes(1);
  });
});
