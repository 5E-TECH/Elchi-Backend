import { Logger } from '@nestjs/common';
import {
  MAX_CHAT_BUCKETS,
  TELEGRAM_LIMITS,
  splitHtmlMessage,
} from './bot-transport.service';
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

describe('BOT-3d — splitHtmlMessage chegaraviy holatlar', () => {
  it('⭐ max dan uzun havola tegi — cheksiz tsikl YO‘Q, har bo‘lak oldinga siljiydi va ≤ max', () => {
    const text = `<b><a href="https://x/?q=${'a'.repeat(4080)}">x</a></b>`;
    const chunks = splitHtmlMessage(text);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.length).toBeLessThan(5);
    expect(
      chunks.every((c) => c.length <= TELEGRAM_LIMITS.MESSAGE_MAX_CHARS),
    ).toBe(true);
    expect(chunks.join('').replace(/<\/?b>/g, '')).toContain('a'.repeat(4000));
  });

  it('surrogat jufti (emoji) bo‘linmaydi', () => {
    const text = '😀'.repeat(300);
    const chunks = splitHtmlMessage(text, 101);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(101);
      expect(chunk).not.toMatch(/^[\udc00-\udfff]|[\ud800-\udbff]$/);
    }
    expect(chunks.join('')).toBe(text);
  });

  it('faqat bo‘shliq / teglardan iborat oxirgi bo‘lak yuborilmaydi', () => {
    const text = `${'x'.repeat(90)}${' '.repeat(20)}`;
    const chunks = splitHtmlMessage(text, 100);
    expect(chunks.length).toBe(1);
    expect(chunks.every((c) => c.replace(/<[^>]*>/g, '').trim() !== '')).toBe(
      true,
    );
  });

  it('⭐ >4096 HTML xabar (ko‘p teg) — har bo‘lak teg balansli', () => {
    const line =
      '<b>Buyurtma</b> <i>#1</i> <a href="https://x.uz/o/1">ochish</a>';
    const text = `<u>${Array(200).fill(line).join('\n')}</u>`;
    expect(text.length).toBeGreaterThan(TELEGRAM_LIMITS.MESSAGE_MAX_CHARS);
    const chunks = splitHtmlMessage(text);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every(balanced)).toBe(true);
  });
});

describe('BOT-3d — bucket LRU', () => {
  it('⭐ to‘lganda faqat eng eski bucket o‘chadi — faol chat limiti nolga tushmaydi', async () => {
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
    const internals = transport as unknown as {
      throttle: (chatId?: string) => Promise<void>;
      privateBuckets: Map<string, unknown>;
    };
    const throttle = internals.throttle.bind(transport);
    await throttle('5550044');
    const active = internals.privateBuckets.get('5550044');
    for (let i = 0; i < MAX_CHAT_BUCKETS; i += 1) {
      await throttle(String(7_000_000 + i));
      // Faol chat oradan qayta ishlatiladi (LRU oxiriga ko'chadi).
      if (i === MAX_CHAT_BUCKETS / 2) await throttle('5550044');
    }
    expect(internals.privateBuckets.size).toBeLessThanOrEqual(MAX_CHAT_BUCKETS);
    // Faol chat bucket'i AYNAN o'sha (nolga tushmagan); eng eski chiqarildi.
    expect(internals.privateBuckets.get('5550044')).toBe(active);
    expect(internals.privateBuckets.has('7000000')).toBe(false);
    expect(
      internals.privateBuckets.has(String(7_000_000 + MAX_CHAT_BUCKETS - 1)),
    ).toBe(true);
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
