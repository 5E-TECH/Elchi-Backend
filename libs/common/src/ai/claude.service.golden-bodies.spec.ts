import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ClaudeService } from './claude.service';
import type {
  AnthropicClientFactory,
  ClaudeToolLoopOptions,
  ExtractJsonOptions,
} from './claude.types';

/**
 * «AI kalit va modellar» BE-1c — GOLDEN BODIES (be-brief §12, AC14).
 *
 * Snapshot ClaudeService refaktoridan OLDIN (`dev` + #648) olingan. Flag
 * o'chiq (sukut) holatda HAR Anthropic so'rovi (model, max_tokens,
 * system/cache_control, output_config, messages, tools, timeout, retry
 * tanasi) refaktordan keyin BAYT-ANIQ bir xil bo'lishi shart. Snapshot
 * o'zgarsa — bu xulq o'zgarishi, ataylab ko'rib chiqing.
 */
const T0 = 1_790_000_000_000;
const SCHEMA = {
  type: 'object',
  properties: { orders: { type: 'array', items: { type: 'object' } } },
  required: ['orders'],
  additionalProperties: false,
};
const META = {
  feature: 'order_extract_multi',
  requestArea: 'order',
  marketId: '12',
  userId: '34',
  traceId: 't',
} as const;
const USAGE = {
  input_tokens: 10,
  output_tokens: 5,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
};

function recorder() {
  const calls: Array<{ kind: string; body: unknown; opts: unknown }> = [];
  let queue: unknown[] = [];
  const next = () => queue.shift();
  const factoryArgs: unknown[] = [];
  const factory: AnthropicClientFactory = (o) => {
    // Kalit qiymati snapshot'ga YOZILMAYDI — faqat iz.
    factoryArgs.push({ ...o, apiKey: o.apiKey ? `len:${o.apiKey.length}` : null });
    return {
      messages: {
        create: (body: unknown, opts: unknown) => {
          calls.push({ kind: 'create', body: JSON.parse(JSON.stringify(body)), opts });
          const r = next();
          return r instanceof Error ? Promise.reject(r) : Promise.resolve(r);
        },
        stream: (body: unknown, opts: unknown) => {
          calls.push({ kind: 'stream', body: JSON.parse(JSON.stringify(body)), opts });
          const r = next();
          return {
            on: () => undefined,
            finalMessage: () =>
              r instanceof Error ? Promise.reject(r) : Promise.resolve(r),
          };
        },
      },
    } as never;
  };
  return {
    factory,
    calls,
    factoryArgs,
    push: (...r: unknown[]) => {
      queue = [...queue, ...r];
    },
  };
}

const ok = (json: unknown = { orders: [] }) => ({
  stop_reason: 'end_turn',
  content: [{ type: 'text', text: JSON.stringify(json) }],
  usage: USAGE,
});
const truncated = () => ({
  stop_reason: 'max_tokens',
  content: [{ type: 'text', text: '{"orders":[' }],
  usage: USAGE,
});

function service(f: AnthropicClientFactory, extra: Record<string, unknown> = {}) {
  const env: Record<string, unknown> = {
    ANTHROPIC_API_KEY: 'sk-ant-api03-' + 'g'.repeat(40),
    ...extra,
  };
  return new ClaudeService(
    { get: (k: string) => env[k] } as unknown as ConfigService,
    f,
  );
}

describe('ClaudeService golden bodies (flag o‘chiq — bugungi xulq)', () => {
  beforeAll(() => {
    jest.spyOn(Date, 'now').mockReturnValue(T0);
    for (const m of ['log', 'warn', 'error', 'debug'] as const)
      jest.spyOn(Logger.prototype, m).mockImplementation();
  });
  afterAll(() => jest.restoreAllMocks());

  const base = (o: Partial<ExtractJsonOptions> = {}): ExtractJsonOptions => ({
    system: 'SYS',
    userText: 'Ali, 3 ta atir',
    schema: SCHEMA,
    meta: META,
    ...o,
  });

  it.each([
    ['sukut', {}],
    ['model + effort low', { model: 'claude-sonnet-5-5', effort: 'low' }],
    ['cacheTtl 1h', { cacheTtl: '1h' }],
    ['maxTokens 32000', { maxTokens: 32_000 }],
    ['deadline', { deadlineAt: T0 + 12_000 }],
    [
      'rasm',
      {
        images: [{ mediaType: 'image/jpeg', dataBase64: 'QUJD' }],
        model: 'claude-sonnet-5',
      },
    ],
  ] as const)('extractJson: %s', async (_n, o) => {
    const r = recorder();
    r.push(ok());
    await service(r.factory).extractJson(base(o as Partial<ExtractJsonOptions>));
    expect({ factory: r.factoryArgs, calls: r.calls }).toMatchSnapshot();
  });

  it('extractJson: kesilgan → retry tanasi', async () => {
    const r = recorder();
    r.push(truncated(), ok());
    await service(r.factory).extractJson(base());
    expect(r.calls).toMatchSnapshot();
  });

  it('runToolLoop: tool → javob (stream)', async () => {
    const r = recorder();
    r.push(
      {
        stop_reason: 'tool_use',
        content: [{ type: 'tool_use', id: 't1', name: 'get_cash_position', input: {} }],
        usage: USAGE,
      },
      { stop_reason: 'end_turn', content: [{ type: 'text', text: 'ok' }], usage: USAGE },
    );
    const o: ClaudeToolLoopOptions = {
      system: 'SYS',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'savol' }] }],
      tools: [
        {
          name: 'get_cash_position',
          description: 'd',
          input_schema: { type: 'object', properties: {} },
        },
      ],
      executeTool: () => Promise.resolve({ content: '{"ok":1}', isError: false }),
      meta: { ...META, feature: 'assistant', requestArea: 'internal' },
      inputText: 'savol',
      model: 'claude-sonnet-5',
      maxSteps: 6,
      maxTokens: 8000,
      effort: 'medium',
      cacheTtl: '1h',
    };
    await service(r.factory).runToolLoop(o);
    expect(r.calls).toMatchSnapshot();
  });

  it('kalitsiz / staging o‘chiq — mijoz qurilmaydi, so‘rov yo‘q', async () => {
    const r = recorder();
    const s = new ClaudeService(
      { get: () => undefined } as unknown as ConfigService,
      r.factory,
    );
    expect(s.isEnabled()).toBe(false);
    await expect(s.extractJson(base())).resolves.toMatchObject({ ok: false, reason: 'disabled' });
    expect(r.factoryArgs).toEqual([]);
    expect(r.calls).toEqual([]);
  });
});
