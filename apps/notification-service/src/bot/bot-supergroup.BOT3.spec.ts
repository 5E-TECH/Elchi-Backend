import { Logger } from '@nestjs/common';
import {
  TelegramApiError,
  classifyTelegramError,
  migrateTargetOf,
} from './bot-transport.service';
import {
  makeFetch,
  makeOutbox,
  makeRouter,
  okResponse,
  telegramResponse,
} from './testing/bot-kit-spec';

/**
 * BOT-3 #6 — guruh supergroup'ga aylanganda (`migrate_to_chat_id` Telegram
 * javobida yoki kiruvchi servis xabarida) ulanish va navbat YANGI id'ga
 * ko'chadi, xabar qayta yuboriladi; «not enough rights» — guruh nofaol
 * (`blocked_on_send`); HTML xatosi guruhni o'chirmaydi.
 */
beforeEach(() => {
  jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());

describe('BOT-3 #6 — xato turlari', () => {
  it('«not enough rights» → blocked; HTML xatosi → bad_request (guruh faol qoladi)', () => {
    expect(
      classifyTelegramError(
        400,
        'Bad Request: not enough rights to send text messages to the chat',
      ),
    ).toBe('blocked');
    expect(
      classifyTelegramError(
        400,
        "Bad Request: can't parse entities: Unsupported start tag",
      ),
    ).toBe('bad_request');
  });

  it('migrate_to_chat_id → kind migrated; buzuq qiymat e`tiborsiz', () => {
    expect(migrateTargetOf({ migrate_to_chat_id: -1001234567890 })).toBe(
      '-1001234567890',
    );
    expect(migrateTargetOf({ migrate_to_chat_id: 'abc' })).toBeNull();
    expect(migrateTargetOf(null)).toBeNull();
    const error = new TelegramApiError(
      'sendMessage',
      400,
      'Bad Request: group chat was upgraded to a supergroup chat',
      null,
      '-1001234567890',
    );
    expect(error.kind).toBe('migrated');
  });
});

describe('BOT-3 #6 — outbox: supergroup', () => {
  it('⭐ 400 + migrate_to_chat_id → ulanish ko`chadi, xabar YANGI id`ga qayta yuboriladi (urinish hisoblanmaydi)', async () => {
    const fetchMock = makeFetch();
    fetchMock.mockResolvedValueOnce(
      telegramResponse(400, {
        ok: false,
        description:
          'Bad Request: group chat was upgraded to a supergroup chat',
        parameters: { migrate_to_chat_id: -1009999 },
      }),
    );
    const { outbox, repo, channels } = makeOutbox(fetchMock);
    const first = await outbox.send({
      chatId: '-100777',
      text: 'salom',
      source: 'test',
    });
    expect(first.status).toBe('queued');
    expect(channels.migrateChat).toHaveBeenCalledWith('-100777', '-1009999');
    expect(channels.markInactive).not.toHaveBeenCalled();
    const [row] = [...repo.rows.values()];
    expect(row).toEqual(
      expect.objectContaining({
        chat_id: '-1009999',
        status: 'pending',
        retry_count: 0,
      }),
    );
    fetchMock.mockResolvedValueOnce(okResponse());
    expect(await outbox.processDue()).toBe(1);
    const lastBody = JSON.parse(
      String(
        (fetchMock.mock.calls.at(-1)?.[1] as { body?: string } | undefined)
          ?.body ?? '{}',
      ),
    ) as { chat_id?: string };
    expect(String(lastBody.chat_id)).toBe('-1009999');
    expect(row.status).toBe('sent');
  });

  it('⭐ «not enough rights» → dead + guruh nofaol (blocked_on_send)', async () => {
    const fetchMock = makeFetch();
    fetchMock.mockResolvedValueOnce(
      telegramResponse(400, {
        ok: false,
        description:
          'Bad Request: not enough rights to send text messages to the chat',
      }),
    );
    const { outbox, channels } = makeOutbox(fetchMock);
    const res = await outbox.send({
      chatId: '-100777',
      text: 'x',
      source: 'test',
    });
    expect(res.status).toBe('dead');
    expect(channels.markInactive).toHaveBeenCalledWith(
      '-100777',
      expect.any(String),
      'blocked_on_send',
    );
  });

  it('HTML xatosi — faqat xabar dead, guruh nofaol QILINMAYDI', async () => {
    const fetchMock = makeFetch();
    fetchMock.mockResolvedValueOnce(
      telegramResponse(400, {
        ok: false,
        description: "Bad Request: can't parse entities",
      }),
    );
    const { outbox, channels } = makeOutbox(fetchMock);
    const res = await outbox.send({
      chatId: '-100777',
      text: '<b>',
      source: 'test',
    });
    expect(res.status).toBe('dead');
    expect(channels.markInactive).not.toHaveBeenCalled();
  });
});

describe('BOT-3 #6 — kiruvchi migrate_to_chat_id', () => {
  it('⭐ eski guruhdagi servis xabari → membership.migrate(eski, yangi)', async () => {
    const ctx = makeRouter({ actor: null });
    await ctx.router.dispatch('elchi', {
      update_id: 5,
      message: {
        message_id: 1,
        chat: { id: -100777, type: 'group' },
        migrate_to_chat_id: -1009999,
      },
    });
    expect(ctx.membership.migrate).toHaveBeenCalledWith('-100777', '-1009999');
  });
});
