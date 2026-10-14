import { Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import {
  ClaudeService,
  type AnthropicClientFactory,
  type ClaudeUsageRecord,
  type ClaudeUsageSink,
} from '@app/common';
import { OrderExtractService } from './order-extract.service';

/**
 * LP3RKvXY TC7 — prompt keshi URADI: ikki ketma-ket parse'da ikkinchisi
 * `cache_read_tokens > 0`.
 *
 * ⚠️ Real Anthropic CHAQIRILMAYDI. Soxta mijoz Anthropic prompt keshini
 * taqlid qiladi: `cache_control` belgilangan system bloki (model + matn)
 * oldingi chaqiruvdagi bilan BAYTMA-BAYT bir xil bo'lsa — `cache_read`,
 * aks holda `cache_creation`. Ya'ni system'ga sana / market / tuman ro'yxati
 * kabi dinamik qiymat qo'shilsa (yoki cache_control tushib qolsa) bu test
 * qizaradi. Haqiqiy `cache_read_input_tokens` — faqat prodda (⏳).
 */
interface SentBody {
  model: string;
  system: Array<{ text: string; cache_control?: { type: string } }>;
}

const SYSTEM_TOKENS = 4072;

function fakeCachingClient(): AnthropicClientFactory {
  const cache = new Set<string>();
  return () => ({
    messages: {
      create: (body: unknown) => {
        const b = body as SentBody;
        const block = b.system?.[0];
        const key =
          block?.cache_control?.type === 'ephemeral'
            ? `${b.model}\u0000${block.text}`
            : null;
        const hit = key !== null && cache.has(key);
        if (key) cache.add(key);
        return Promise.resolve({
          stop_reason: 'end_turn',
          content: [{ type: 'text', text: '{"orders":[]}' }],
          usage: {
            input_tokens: 120,
            output_tokens: 10,
            cache_creation_input_tokens: hit || !key ? 0 : SYSTEM_TOKENS,
            cache_read_input_tokens: hit ? SYSTEM_TOKENS : 0,
          },
        });
      },
    },
  });
}

describe('prompt keshi — ikki ketma-ket parse (LP3RKvXY TC7)', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
  });
  afterEach(() => jest.restoreAllMocks());

  it('ikkinchi chaqiruvda cache_read_tokens > 0 (matnlar har xil bo‘lsa ham)', async () => {
    const values: Record<string, unknown> = {
      ANTHROPIC_API_KEY: 'sk-ant-test',
      AI_ORDER_MODEL: 'claude-sonnet-5',
    };
    const config = {
      get: (k: string) => values[k],
    } as unknown as ConfigService;
    const records: ClaudeUsageRecord[] = [];
    const sink: ClaudeUsageSink = { record: (r) => void records.push(r) };
    const claude = new ClaudeService(config, fakeCachingClient(), sink);
    const service = new OrderExtractService(claude, config);

    const base = {
      market_id: '121',
      requester: { id: '7', roles: ['market'] },
      trace_id: 't',
      draft_id: '0b9f7c3e-1d2a-4b5c-8d6e-7f8091a2b3c4',
      deadline_at: Date.now() + 60_000,
    };
    await service.extract({ ...base, text: 'Ali 901234567 Asaka atir' });
    await service.extract({
      ...base,
      market_id: '999',
      text: 'Vali 931112233 Urgut choynak 180 ming',
    });

    expect(records).toHaveLength(2);
    expect(records[0].cacheCreationTokens).toBeGreaterThan(0);
    expect(records[0].cacheReadTokens).toBe(0);
    expect(records[1].cacheReadTokens).toBeGreaterThan(0);
    expect(records[1].cacheCreationTokens).toBe(0);
  });
});
