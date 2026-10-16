import { Logger } from '@nestjs/common';
import {
  BOT_MEDIA_LIMITS,
  MEDIA_SEND_AS_PHOTO_TEXT,
  MEDIA_TOO_LARGE_TEXT,
  checkIncomingMedia,
  pickPhotoSize,
} from './bot-media';
import {
  TELEGRAM_LIMITS,
  TokenBucket,
  splitMessage,
} from './bot-transport.service';
import { CHAT_QUEUE_MAX, ChatSequencer } from './chat-sequencer';
import { GroupHandler } from './handlers/group.handler';
import { LINK_BLOCKED_TEXT, StartHandler } from './handlers/start.handler';
import {
  makeCtx,
  makeFetch,
  makeRouter,
  makeTransport,
  okResponse,
  sentBodies,
  telegramResponse,
  textUpdate,
} from './testing/bot-kit-spec';

/**
 * GL2GgtEc — rate-limit, per-chat navbat va Telegram chegaralari.
 * Haqiqiy SQL hisoblagichlari — bot-core.pg.spec.ts.
 */
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('GL2GgtEc — kiruvchi cheklov', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('⭐ bitta chatdan 25 update → 20 tasi ishlanadi, 5 tasi JIM tashlanadi', async () => {
    const ctx = makeRouter();
    const results: string[] = [];
    for (let i = 0; i < 25; i += 1) {
      results.push(
        await ctx.router.dispatch(
          'elchi',
          textUpdate('salom', { updateId: i }),
        ),
      );
    }
    expect(results.filter((r) => r === 'done')).toHaveLength(20);
    expect(results.slice(20)).toEqual(Array(5).fill('dropped'));
    expect(ctx.outbox.send).toHaveBeenCalledTimes(20);
  });

  it('⭐ bog‘lash kodi 6-urinish — rad etiladi, blok xabari BIR marta, DM ulanmaydi', async () => {
    const dm = { bindFromStart: jest.fn(), unbind: jest.fn() };
    let hits = 5;
    const limiter = {
      linkAttempt: jest.fn(() => {
        hits += 1;
        return Promise.resolve({ allowed: false, blocked: true, hits });
      }),
    };
    const handler = new StartHandler(
      limiter as never,
      { log: jest.fn() } as never,
      { get: jest.fn() } as never,
      dm as never,
    );
    const sixth = makeCtx({ text: '/start labc_x_y', fromId: '777' });
    const seventh = makeCtx({ text: '/start labc_x_y', fromId: '777' });
    await handler.handle(sixth.ctx as never);
    await handler.handle(seventh.ctx as never);

    expect(limiter.linkAttempt).toHaveBeenCalledWith('777');
    expect(dm.bindFromStart).not.toHaveBeenCalled();
    expect(sixth.replies).toEqual([{ text: LINK_BLOCKED_TEXT }]);
    // 7-urinish — jim (amplifikator yo'q).
    expect(seventh.replies).toEqual([]);
  });

  it('guruhda group_token urinishlari ham shu cheklov ostida (odam bo‘yicha)', async () => {
    const notifications = { connectGroupByTokenText: jest.fn() };
    const handler = new GroupHandler(
      notifications as never,
      {
        linkAttempt: jest.fn(() =>
          Promise.resolve({ allowed: false, blocked: true, hits: 6 }),
        ),
      } as never,
    );
    const made = makeCtx({
      text: 'group_token-0123456789abcdef',
      chatId: '-100555',
      chatType: 'group',
      fromId: '42',
    });
    await handler.handle(made.ctx as never);
    expect(notifications.connectGroupByTokenText).not.toHaveBeenCalled();
    expect(made.replies[0].text).toBe(LINK_BLOCKED_TEXT);
  });
});

describe('GL2GgtEc — chiquvchi: 429, token-bucket, 4096', () => {
  it('⭐ 429 + retry_after: 3 → transport 3 s kutib qayta urinadi', async () => {
    const fetchMock = makeFetch();
    fetchMock
      .mockResolvedValueOnce(
        telegramResponse(429, {
          ok: false,
          description: 'Too Many Requests: retry after 3',
          parameters: { retry_after: 3 },
        }),
      )
      .mockResolvedValueOnce(okResponse());
    const transport = makeTransport(fetchMock);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

    await transport.sendMessage('-100555', 'salom');

    expect(transport.sleep).toHaveBeenCalledWith(3000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    jest.restoreAllMocks();
  });

  it('⭐ 4096 belgidan uzun xabar bo‘linadi; har bo‘lak ≤4096, tugmalar faqat oxirgisida', async () => {
    const fetchMock = makeFetch();
    const transport = makeTransport(fetchMock);
    const text = Array.from({ length: 300 }, (_, i) =>
      `qator ${i} `.repeat(4),
    ).join('\n');
    expect(text.length).toBeGreaterThan(TELEGRAM_LIMITS.MESSAGE_MAX_CHARS * 2);

    await transport.sendMessage('1', text, {
      reply_markup: {
        inline_keyboard: [
          [{ text: 'OK', callback_data: 'a:0123456789abcdef' }],
        ],
      },
    });

    const bodies = sentBodies(fetchMock);
    expect(bodies.length).toBeGreaterThanOrEqual(3);
    for (const body of bodies) {
      expect(String(body.text).length).toBeLessThanOrEqual(4096);
    }
    expect(bodies.map((b) => b.text).join('\n')).toBe(text);
    expect(bodies.slice(0, -1).every((b) => !b.reply_markup)).toBe(true);
    expect(bodies.at(-1)!.reply_markup).toBeDefined();
  });

  it('splitMessage — qator chegarasidan, juda uzun qatorni ham kesadi', () => {
    const single = 'x'.repeat(10_000);
    const parts = splitMessage(single);
    expect(parts.map((p) => p.length)).toEqual([4096, 4096, 1808]);
    expect(splitMessage('')).toEqual([]);
  });

  it('token-bucket: guruhga daqiqasiga 20; 21-chisi kutadi; vaqt o‘tgach tiklanadi', () => {
    let now = 0;
    const bucket = new TokenBucket(
      TELEGRAM_LIMITS.GROUP_SEND_PER_MIN,
      TELEGRAM_LIMITS.GROUP_SEND_PER_MIN / 60_000,
      () => now,
    );
    for (let i = 0; i < 20; i += 1) expect(bucket.take()).toBe(0);
    const wait = bucket.take();
    expect(wait).toBeGreaterThan(2_900);
    expect(wait).toBeLessThanOrEqual(3_000);
    now += 3_000;
    expect(bucket.take()).toBe(0);
  });

  it('transport guruh chatiga yuborishda kutadi (global ~25/s + guruh 20/daqiqa)', async () => {
    const fetchMock = makeFetch();
    const transport = makeTransport(fetchMock);
    let now = 0;
    transport.now = () => now;
    (transport as unknown as { sleep: jest.Mock }).sleep = jest.fn(
      (ms: number) => {
        now += ms;
        return Promise.resolve();
      },
    );
    for (let i = 0; i < 21; i += 1)
      await transport.sendMessage('-100555', `m${i}`);
    expect(fetchMock).toHaveBeenCalledTimes(21);
    expect(transport.sleep).toHaveBeenCalled();
  });
});

describe('GL2GgtEc — chat bo‘yicha ketma-ketlik', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('⭐ bitta chat uchun ikki parallel ish KETMA-KET (tartib saqlanadi)', async () => {
    const sequencer = new ChatSequencer(null);
    const events: string[] = [];
    const task = (name: string, ms: number) => async () => {
      events.push(`${name}:start`);
      await sleep(ms);
      events.push(`${name}:end`);
    };
    await Promise.all([
      sequencer.run('1', task('A', 30)),
      sequencer.run('1', task('B', 1)),
    ]);
    expect(events).toEqual(['A:start', 'A:end', 'B:start', 'B:end']);
  });

  it('boshqa chat to‘silmaydi (parallel)', async () => {
    const sequencer = new ChatSequencer(null);
    const events: string[] = [];
    await Promise.all([
      sequencer.run('1', async () => {
        events.push('slow:start');
        await sleep(40);
        events.push('slow:end');
      }),
      sequencer.run('2', async () => {
        events.push('fast');
        await Promise.resolve();
      }),
    ]);
    expect(events.indexOf('fast')).toBeLessThan(events.indexOf('slow:end'));
  });

  it('ish xatosi navbatni BUZMAYDI; navbat to‘lsa (12) jim tashlanadi', async () => {
    const sequencer = new ChatSequencer(null);
    const done: number[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const runs = [
      sequencer.run('1', async () => {
        await gate;
        throw new Error('boom');
      }),
    ];
    for (let i = 1; i < CHAT_QUEUE_MAX; i += 1) {
      runs.push(
        sequencer.run('1', () => {
          done.push(i);
          return Promise.resolve();
        }),
      );
    }
    expect(await sequencer.run('1', () => Promise.resolve())).toBe('dropped');
    release();
    const results = await Promise.all(runs);
    expect(results[0]).toBe('failed');
    expect(results.slice(1).every((r) => r === 'done')).toBe(true);
    expect(done).toEqual(
      Array.from({ length: CHAT_QUEUE_MAX - 1 }, (_, i) => i + 1),
    );
    expect(await sequencer.drain(100)).toBe(true);
  });
});

describe('GL2GgtEc — media chegaralari', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('⭐ 20MB dan katta fayl botda rad etiladi — aniq yo‘naltiruv matni', async () => {
    const ctx = makeRouter();
    await ctx.router.dispatch('elchi', {
      update_id: 5,
      message: {
        message_id: 1,
        chat: { id: 111, type: 'private' },
        from: { id: 111 },
        video: {
          file_id: 'v1',
          file_size: 25 * 1024 * 1024,
          mime_type: 'video/mp4',
        },
      },
    });
    const sent = ctx.outbox.send.mock.calls[0] as unknown as [{ text: string }];
    expect(sent[0].text).toBe(MEDIA_TOO_LARGE_TEXT);
    expect(MEDIA_TOO_LARGE_TEXT).toMatch(/20MB/);
    expect(MEDIA_TOO_LARGE_TEXT).toMatch(/50MB/);
  });

  it('HEIC / 5MB dan katta rasm hujjat sifatida → "📷 SURAT sifatida yuboring"', () => {
    expect(
      checkIncomingMedia({
        document: { file_id: 'd', mime_type: 'image/heic', file_size: 100 },
      }),
    ).toEqual(
      expect.objectContaining({ ok: false, reply: MEDIA_SEND_AS_PHOTO_TEXT }),
    );
    expect(
      checkIncomingMedia({
        document: {
          file_id: 'd',
          mime_type: 'image/png',
          file_size: 6 * 1024 * 1024,
        },
      }),
    ).toEqual(
      expect.objectContaining({ ok: false, reply: MEDIA_SEND_AS_PHOTO_TEXT }),
    );
    expect(
      checkIncomingMedia({
        document: { file_id: 'd', mime_type: 'image/webp', file_size: 100 },
      }),
    ).toEqual(expect.objectContaining({ ok: true, kind: 'image' }));
  });

  it('rasm: limit ostidagi ENG KATTA o‘lcham tanlanadi', () => {
    const sizes = [
      { file_id: 's', file_size: 50_000 },
      { file_id: 'm', file_size: 900_000 },
      { file_id: 'l', file_size: BOT_MEDIA_LIMITS.PHOTO_MAX_BYTES + 1 },
    ];
    expect(pickPhotoSize(sizes)?.file_id).toBe('m');
    expect(checkIncomingMedia({ photo: sizes })).toEqual(
      expect.objectContaining({ ok: true, kind: 'photo', file_id: 'm' }),
    );
    expect(
      checkIncomingMedia({
        photo: [{ file_id: 'xl', file_size: 9 * 1024 * 1024 }],
      }),
    ).toEqual(
      expect.objectContaining({ ok: false, reply: MEDIA_SEND_AS_PHOTO_TEXT }),
    );
  });
});
