import Anthropic, {
  APIConnectionError,
  APIConnectionTimeoutError,
  APIError,
} from '@anthropic-ai/sdk';
import {
  AiKeyVerifierService,
  classifyVerifyError,
  defaultVerifierClientFactory,
  normalizeModel,
  type AiModelsListClient,
} from './ai-key-verifier.service';
import { FAKE_KEY } from './ai-config-test-helpers';

/** be-brief D7 / §12 ai-key-verifier.spec — tarmoqsiz. */
function apiError(
  status: number,
  type?: string,
  headers?: Record<string, string>,
) {
  return APIError.generate(
    status,
    { type: 'error', error: { type: type ?? 'x', message: 'm' } },
    'm',
    new Headers(headers ?? {}),
  );
}

describe('AiKeyVerifierService', () => {
  it.each([
    [
      new APIConnectionTimeoutError(),
      'AI_KEY_VERIFY_UNAVAILABLE',
      'unavailable',
    ],
    [
      new APIConnectionError({ message: 'x' }),
      'AI_KEY_VERIFY_UNAVAILABLE',
      'unavailable',
    ],
    [apiError(401, 'authentication_error'), 'AI_KEY_REJECTED', 'rejected'],
    [apiError(403, 'permission_error'), 'AI_KEY_FORBIDDEN', 'forbidden'],
    [
      apiError(400, 'invalid_request_error'),
      'AI_KEY_BAD_REQUEST',
      'bad_request',
    ],
    [apiError(402, 'billing_error'), 'AI_KEY_BILLING', 'billing'],
    [apiError(400, 'billing_error'), 'AI_KEY_BILLING', 'billing'],
    [
      apiError(429, 'rate_limit_error', { 'retry-after': '12' }),
      'AI_KEY_UPSTREAM_RATE_LIMITED',
      'unavailable',
    ],
    [apiError(500), 'AI_KEY_VERIFY_UNAVAILABLE', 'unavailable'],
    [
      apiError(529, 'overloaded_error'),
      'AI_KEY_VERIFY_UNAVAILABLE',
      'unavailable',
    ],
    [new Error('random'), 'AI_KEY_VERIFY_UNAVAILABLE', 'unavailable'],
  ])('%p → %s', (err, code, state) => {
    const r = classifyVerifyError(err);
    expect(r.code).toBe(code);
    expect(r.state).toBe(state);
    if (code === 'AI_KEY_UPSTREAM_RATE_LIMITED')
      expect(r.retry_after_seconds).toBe(12);
  });

  it('sukut mijoz: maxRetries 0, manzil mahkam, logLevel warn, timeout', () => {
    const c = defaultVerifierClientFactory({
      apiKey: FAKE_KEY,
      timeout: 4000,
    }) as unknown as Anthropic & {
      logLevel: string;
    };
    expect(c.maxRetries).toBe(0);
    expect(c.baseURL).toBe('https://api.anthropic.com');
    expect(c.logLevel).toBe('warn');
    expect(c.timeout).toBe(4000);
  });

  it('faqat models.list chaqiriladi (messages.* yo‘q), katalog normallashadi', async () => {
    const list = jest.fn(async function* () {
      await Promise.resolve();
      yield {
        id: 'claude-sonnet-5-5',
        display_name: 'Claude Sonnet 5.5',
        created_at: '2026-01-01T00:00:00Z',
        max_input_tokens: 200000,
        max_tokens: 64000,
        capabilities: {
          image_input: { supported: true },
          structured_outputs: { supported: true },
          effort: {
            supported: true,
            low: { supported: true },
            high: { supported: true },
          },
          thinking: { supported: true },
        },
      };
      yield { id: 'claude-haiku-4-5' };
      yield { id: '../bad' };
    });
    const messages = { create: jest.fn(), stream: jest.fn() };
    const factory = jest.fn(
      () => ({ models: { list }, messages }) as unknown as AiModelsListClient,
    );
    const svc = new AiKeyVerifierService(factory);
    const r = await svc.verify(FAKE_KEY, 7000);
    expect(factory).toHaveBeenCalledWith({ apiKey: FAKE_KEY, timeout: 5000 });
    expect(list).toHaveBeenCalledWith({ limit: 1000 }, { timeout: 5000 });
    expect(messages.create).not.toHaveBeenCalled();
    expect(messages.stream).not.toHaveBeenCalled();
    if (!r.ok) throw new Error('ok kutilgan');
    expect(r.models.map((m) => m.id)).toEqual([
      'claude-sonnet-5-5',
      'claude-haiku-4-5',
    ]);
    expect(r.models[0].capabilities).toEqual({
      image_input: true,
      structured_outputs: true,
      effort: true,
      effort_levels: ['low', 'high'],
      thinking: true,
    });
    expect(r.models[1].capabilities).toBeNull();
  });

  it('deadline o‘tgan — tarmoqqa chiqmaydi', async () => {
    const factory = jest.fn();
    const r = await new AiKeyVerifierService(factory).verify(FAKE_KEY, 0);
    expect(factory).not.toHaveBeenCalled();
    expect(r).toMatchObject({ ok: false, code: 'AI_KEY_VERIFY_UNAVAILABLE' });
  });

  it('xato natijasida kalit/xabar matni yo‘q', async () => {
    const factory = () =>
      ({
        models: {
          list: () => {
            throw apiError(401, 'authentication_error');
          },
        },
      }) as unknown as AiModelsListClient;
    const r = await new AiKeyVerifierService(factory).verify(FAKE_KEY, 3000);
    expect(JSON.stringify(r)).not.toContain(FAKE_KEY);
    expect(r).toEqual({
      ok: false,
      code: 'AI_KEY_REJECTED',
      state: 'rejected',
    });
  });

  it('normalizeModel: noto‘g‘ri id rad', () => {
    expect(normalizeModel({ id: 'Claude Sonnet' })).toBeNull();
    expect(normalizeModel(null)).toBeNull();
  });
});
