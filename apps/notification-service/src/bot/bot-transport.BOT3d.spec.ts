import { Logger } from '@nestjs/common';
import { TELEGRAM_LIMITS, splitHtmlMessage } from './bot-transport.service';
import {
  makeFetch,
  makeOutbox,
  makeTransport,
  okResponse,
  telegramResponse,
} from './testing/bot-kit-spec';

/**
 * BOT-3d (NIMA 13):
 *  - uzun HTML xabar teg / entity ichida kesilmaydi, har bo'lak teglari
 *    yopilgan (Telegram «can't parse entities» bermaydi);
 *  - shaxsiy chatga ~1 xabar/s (3 tagacha portlash) — 429 yo'q;
 *  - outbox ko'p bo'lakli xabarda yetkazilgan bo'laklarni eslaydi — qayta
 *    urinishda takror bo'lak yo'q.
 */
beforeEach(() => {
  jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());

const balanced = (chunk: string) => {
  const stack: string[] = [];
  for (const match of chunk.matchAll(/<(\/?)([a-z-]+)[^>]*>/g)) {
    if (match[1]) {
      if (stack.pop() !== match[2]) return false;
    } else {
      stack.push(match[2]);
    }
  }
  return stack.length === 0;
};

describe('BOT-3d — splitHtmlMessage', () => {
  it('⭐ teg ichida kesilmaydi; har bo`lak ≤ max va teglari balansli; ochiq teg keyingi bo`lakda qayta ochiladi', () => {
    const line =
      'Mijoz &amp; buyurtma <a href="https://x.uz/o/1">#1</a> tafsiloti';
    const text = `<b>Ro'yxat:\n${Array(40).fill(line).join('\n')}</b>`;
    const chunks = splitHtmlMessage(text, 500);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(500);
      expect(balanced(chunk)).toBe(true);
      // Entity bo'linmagan.
      expect(chunk).not.toMatch(/&[a-z]{0,4}$/);
      expect(chunk).not.toMatch(/^[a-z]{1,4};/);
    }
    expect(chunks[1].startsWith('<b>')).toBe(true);
    // Teglarni olib tashlasak — matn yo'qolmagan (faqat qator ajratgichlar).
    const strip = (value: string) =>
      value.replace(/<[^>]+>/g, '').replace(/\n/g, '');
    expect(strip(chunks.join(''))).toBe(strip(text));
  });

  it('qisqa matn — bitta bo`lak, o`zgarishsiz; standart chegara 4096', () => {
    expect(splitHtmlMessage('<i>salom</i>')).toEqual(['<i>salom</i>']);
    const long = `<code>${'x'.repeat(9000)}</code>`;
    const chunks = splitHtmlMessage(long);
    expect(
      chunks.every((c) => c.length <= TELEGRAM_LIMITS.MESSAGE_MAX_CHARS),
    ).toBe(true);
    expect(chunks.every(balanced)).toBe(true);
  });
});

describe('BOT-3d — shaxsiy chat tezligi', () => {
  it('⭐ shaxsiy chatga 3 tadan keyin ~1 xabar/s kutiladi; guruh / boshqa chat bunga bog`liq emas', async () => {
    const fetchMock = makeFetch();
    const transport = makeTransport(fetchMock);
    let clock = Date.now();
    transport.now = () => clock;
    const sleeps: number[] = [];
    transport.sleep = jest.fn((ms: number) => {
      sleeps.push(ms);
      clock += ms;
      return Promise.resolve();
    });
    for (let i = 0; i < 3; i += 1) {
      await transport.sendMessage('5550044', `x${i}`);
    }
    expect(sleeps).toEqual([]);
    await transport.sendMessage('5550044', 'x3');
    expect(sleeps.reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(900);
    sleeps.length = 0;
    await transport.sendMessage('5550055', 'boshqa odam');
    expect(sleeps).toEqual([]);
  });
});

describe('BOT-3d — outbox bo`laklarni eslaydi', () => {
  it('⭐ 2-bo`lakda 429 — qayta urinish faqat 2-bo`lakni yuboradi (1-bo`lak takrorlanmaydi)', async () => {
    const fetchMock = makeFetch();
    fetchMock
      .mockResolvedValueOnce(okResponse({ message_id: 1 }))
      .mockResolvedValueOnce(
        telegramResponse(429, {
          ok: false,
          description: 'Too Many Requests: retry after 1',
          parameters: { retry_after: 1 },
        }),
      )
      .mockResolvedValue(okResponse({ message_id: 2 }));
    const { outbox, repo } = makeOutbox(fetchMock);
    const text = `${'a'.repeat(4000)}\n${'b'.repeat(500)}`;
    const first = await outbox.send({ chatId: '5550044', text, source: 't' });
    expect(first.status).toBe('queued');
    const [row] = [...repo.rows.values()];
    expect(row.parts_sent).toBe(1);
    row.next_attempt_at = new Date(0);
    expect(await outbox.processDue()).toBe(1);
    const texts = fetchMock.mock.calls.map(
      ([, init]) =>
        (
          JSON.parse(String((init as { body?: string }).body)) as {
            text: string;
          }
        ).text,
    );
    expect(texts.map((t) => t[0])).toEqual(['a', 'b', 'b']);
    expect(row.status).toBe('sent');
  });
});
