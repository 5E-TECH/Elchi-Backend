/* eslint-disable @typescript-eslint/require-await -- spec mock'lari: async soxta implementatsiyalar */
import { Logger } from '@nestjs/common';
import { RpcException } from '@nestjs/microservices';
import { of } from 'rxjs';
import { NotificationChannel } from '@app/common';
import { DispatchNotificationDto } from '../dto/dispatch-notification.dto';
import { NotificationBotUpdateService } from '../notification-bot.update';
import { NotificationInboxService } from '../notification-inbox.service';
import {
  TELEGRAM_DM_DELIVER_PATTERN,
  TelegramDmService,
} from './telegram-dm.service';
import {
  createTelegramLinkToken,
  verifyTelegramLinkToken,
} from './telegram-link';

const rmqSendMock = jest.fn();
jest.mock('@app/common', () => {
  const actual = jest.requireActual('@app/common');
  return {
    ...actual,
    rmqSend: (...args: unknown[]) => rmqSendMock(...args),
  };
});

/**
 * rCFZAmOz — shaxsiy Telegram xabari (users.telegram_id). Real Telegram
 * YO'Q: `sendDirectToGroup` mock.
 */
const SECRET = 'test-link-secret-0123456789abcdefghijklmnop';

describe('rCFZAmOz — ulash tokeni (telegram-link)', () => {
  const now = new Date('2026-10-14T10:00:00Z');

  it('token /start parametriga sig‘adi (≤64, [A-Za-z0-9_-]) va user_id ni qaytaradi', () => {
    const { token, expires_at } = createTelegramLinkToken(
      '9223372036854775807',
      SECRET,
      now,
    );
    expect(token.length).toBeLessThanOrEqual(64);
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(expires_at.getTime() - now.getTime()).toBe(15 * 60 * 1000);
    expect(verifyTelegramLinkToken(token, SECRET, now)).toBe(
      '9223372036854775807',
    );
  });

  it('muddati o‘tgan, soxtalashtirilgan (boshqa user_id), boshqa kalit — rad', () => {
    const { token } = createTelegramLinkToken('42', SECRET, now);
    expect(
      verifyTelegramLinkToken(
        token,
        SECRET,
        new Date(now.getTime() + 16 * 60_000),
      ),
    ).toBeNull();
    const forged = token.replace(/^l[0-9a-z]+_/, `l${(43).toString(36)}_`);
    expect(verifyTelegramLinkToken(forged, SECRET, now)).toBeNull();
    expect(verifyTelegramLinkToken(token, `${SECRET}x`, now)).toBeNull();
    expect(verifyTelegramLinkToken('group_token-abc', SECRET, now)).toBeNull();
    expect(verifyTelegramLinkToken(token, '', now)).toBeNull();
  });
});

describe('rCFZAmOz — TelegramDmService', () => {
  let contacts: { contacts: jest.Mock };
  let telegram: { sendDirectToGroup: jest.Mock };
  let outbox: { enqueue: jest.Mock };
  let notifications: { query: jest.Mock; createQueryBuilder: jest.Mock };
  let patches: Array<{ ids: string[]; patch: Record<string, string> }>;
  let env: Record<string, string>;

  const make = () =>
    new TelegramDmService(
      notifications as never,
      outbox as never,
      contacts as never,
      telegram as never,
      { get: (key: string) => env[key] } as never,
      {} as never,
    );

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    rmqSendMock.mockReset().mockResolvedValue({ data: { bound: true } });
    env = { TELEGRAM_BOT_TOKEN: 'bot-token', TELEGRAM_LINK_SECRET: SECRET };
    patches = [];
    contacts = {
      contacts: jest.fn(
        (ids: string[]) =>
          new Map(
            ids.map((id) => [
              id,
              { id, telegram_id: id === '11' ? '5550011' : null },
            ]),
          ),
      ),
    };
    telegram = { sendDirectToGroup: jest.fn().mockResolvedValue({}) };
    outbox = { enqueue: jest.fn().mockResolvedValue({}) };
    notifications = {
      query: jest.fn(),
      createQueryBuilder: jest.fn(() => {
        const qb: Record<string, jest.Mock> = {};
        let patch: Record<string, string> = {};
        qb.update = jest.fn(() => qb);
        qb.set = jest.fn(() => qb);
        qb.setParameter = jest.fn((_: string, value: string) => {
          patch = JSON.parse(value) as Record<string, string>;
          return qb;
        });
        qb.whereInIds = jest.fn((ids: string[]) => {
          patches.push({ ids, patch });
          return qb;
        });
        qb.execute = jest.fn().mockResolvedValue({ affected: 1 });
        return qb;
      }),
    };
  });

  it('plan: chat ulangan → queued; telegram_id null → skipped (no_telegram_id), YIQILMAYDI', async () => {
    const plan = await make().plan(['11', '12']);
    expect(plan.get('11')).toEqual({ telegram: 'queued' });
    expect(plan.get('12')).toEqual({
      telegram: 'skipped',
      telegram_reason: 'no_telegram_id',
    });
  });

  it('plan: bot tokeni yo‘q → no_provider (identity chaqirilmaydi); identity xatosi → failed', async () => {
    env = {};
    expect((await make().plan(['11'])).get('11')).toEqual({
      telegram: 'no_provider',
    });
    expect(contacts.contacts).not.toHaveBeenCalled();
    env = { TELEGRAM_BOT_TOKEN: 'bot-token' };
    contacts.contacts.mockRejectedValue(new Error('timeout'));
    expect((await make().plan(['11'])).get('11')).toEqual({
      telegram: 'failed',
      telegram_error: 'contacts_unavailable',
    });
  });

  it('enqueue: outbox hodisasi shu tranzaksiya manager’ida, 25 tadan', async () => {
    const manager = {};
    const ids = Array.from({ length: 30 }, (_, i) => String(i + 1));
    await make().enqueue(manager as never, ids);
    expect(outbox.enqueue).toHaveBeenCalledTimes(2);
    expect(outbox.enqueue).toHaveBeenCalledWith(
      'NOTIFICATION',
      TELEGRAM_DM_DELIVER_PATTERN,
      { notification_ids: ids.slice(0, 25) },
      { manager },
    );
  });

  it('TC2: deliver — shaxsiy sendMessage(chat_id = telegram_id), HTML-escape, natija delivery.telegram ga', async () => {
    notifications.query.mockResolvedValue([
      { id: '1', recipient_id: '11', title: 'A <b>', body: 'x & y' },
      { id: '2', recipient_id: '12', title: 'B', body: null },
    ]);
    const result = await make().deliver({ notification_ids: ['1', '2'] });
    expect(result).toEqual({ processed: 2, sent: 1, failed: 0 });
    // Da'vo: faqat queued qatorlar (qayta yetkazishda takror yo'q).
    expect(String(notifications.query.mock.calls[0][0])).toMatch(
      /"delivery"->>'telegram' = 'queued'/,
    );
    expect(telegram.sendDirectToGroup).toHaveBeenCalledTimes(1);
    expect(telegram.sendDirectToGroup).toHaveBeenCalledWith({
      group_id: '5550011',
      message: 'A &lt;b&gt;\n\nx &amp; y',
      parse_mode: 'HTML',
    });
    expect(patches).toEqual(
      expect.arrayContaining([
        { ids: ['1'], patch: { telegram: 'sent' } },
        {
          ids: ['2'],
          patch: { telegram: 'skipped', telegram_reason: 'no_telegram_id' },
        },
      ]),
    );
  });

  it('deliver: bot bloklangan (403) → failed + blocked_by_user; da’vo qilinmagan qator yuborilmaydi', async () => {
    notifications.query.mockResolvedValueOnce([
      { id: '1', recipient_id: '11', title: 'A', body: null },
    ]);
    telegram.sendDirectToGroup.mockRejectedValue(
      new Error('Forbidden: bot was blocked by the user'),
    );
    expect(await make().deliver({ notification_ids: ['1'] })).toEqual({
      processed: 1,
      sent: 0,
      failed: 1,
    });
    expect(patches.at(-1)?.patch).toMatchObject({
      telegram: 'failed',
      telegram_error: expect.stringMatching(/^blocked_by_user/),
    });
    // Qayta yetkazish: qator endi `queued` emas — da'vo bo'sh, xabar ketmaydi.
    notifications.query.mockResolvedValueOnce([]);
    telegram.sendDirectToGroup.mockClear();
    expect(await make().deliver({ notification_ids: ['1'] })).toEqual({
      processed: 0,
      sent: 0,
      failed: 0,
    });
    expect(telegram.sendDirectToGroup).not.toHaveBeenCalled();
  });

  it('linkToken: user_id yo‘q → 401; kalit yo‘q → 503; username bo‘lsa deep link', () => {
    expect(() => make().linkToken({})).toThrow(RpcException);
    env = {};
    expect(() => make().linkToken({ user_id: '7' })).toThrow(RpcException);
    env = {
      TELEGRAM_BOT_TOKEN: 'bot-token',
      TELEGRAM_LINK_SECRET: SECRET,
      TELEGRAM_BOT_USERNAME: '@ElchiBot',
    };
    const res = make().linkToken({ user_id: '7' });
    expect(res.data.deep_link).toBe(
      `https://t.me/ElchiBot?start=${res.data.token}`,
    );
    expect(res.data.command).toBe(`/start ${res.data.token}`);
    expect(verifyTelegramLinkToken(res.data.token, SECRET)).toBe('7');
  });

  it('TC1: bindFromStart — to‘g‘ri token → identity.user.telegram_bind (user_id TOKENDAN); noto‘g‘ri → identity chaqirilmaydi', async () => {
    const { token } = createTelegramLinkToken('7', SECRET);
    const ok = await make().bindFromStart(token, '5550007');
    expect(ok.ok).toBe(true);
    expect(rmqSendMock).toHaveBeenCalledWith(
      {},
      { cmd: 'identity.user.telegram_bind' },
      { user_id: '7', telegram_id: '5550007' },
    );
    rmqSendMock.mockClear();
    const bad = await make().bindFromStart(`${token}x`, '5550007');
    expect(bad.ok).toBe(false);
    expect(rmqSendMock).not.toHaveBeenCalled();
  });
});

describe('rCFZAmOz — bot /start <token> va /stop', () => {
  const update = (text: string, type = 'private') => ({
    update_id: 1,
    message: { chat: { id: 5550007, type }, text },
  });
  let notificationService: { sendDirectToGroup: jest.Mock };
  let dm: { bindFromStart: jest.Mock; unbind: jest.Mock };
  let bot: { processUpdate: (u: unknown) => Promise<void> };

  beforeEach(() => {
    notificationService = { sendDirectToGroup: jest.fn() };
    dm = {
      bindFromStart: jest
        .fn()
        .mockResolvedValue({ ok: true, message: 'Telegram ulandi' }),
      unbind: jest.fn().mockResolvedValue({ ok: true, message: 'uzildi' }),
    };
    bot = new NotificationBotUpdateService(
      notificationService as never,
      dm as never,
    ) as unknown as typeof bot;
  });

  it('shaxsiy chatda /start <token> → bindFromStart(token, chat_id) va javob', async () => {
    await bot.processUpdate(update('/start labc_def_0123456789abcdefghijkl'));
    expect(dm.bindFromStart).toHaveBeenCalledWith(
      'labc_def_0123456789abcdefghijkl',
      '5550007',
    );
    expect(notificationService.sendDirectToGroup).toHaveBeenCalledWith({
      group_id: '5550007',
      message: 'Telegram ulandi',
    });
  });

  it('guruhda /start <token> — ULANMAYDI (faqat shaxsiy chat)', async () => {
    await bot.processUpdate(update('/start labc_def_x', 'group'));
    expect(dm.bindFromStart).not.toHaveBeenCalled();
  });

  it('/stop — unbind; oddiy /start avvalgidek (guruh ko‘rsatmasi)', async () => {
    await bot.processUpdate(update('/stop'));
    expect(dm.unbind).toHaveBeenCalledWith('5550007');
    await bot.processUpdate(update('/start'));
    expect(dm.bindFromStart).not.toHaveBeenCalled();
    expect(
      notificationService.sendDirectToGroup.mock.calls.at(-1)?.[0].message,
    ).toMatch(/group_token/);
  });
});

describe('rCFZAmOz — dispatch TELEGRAM kanali (guruh nishonisiz → shaxsiy DM)', () => {
  let store: Map<string, Record<string, unknown>>;
  let dm: { plan: jest.Mock; enqueue: jest.Mock };
  let telegramService: { sendNotification: jest.Mock };
  let service: NotificationInboxService;

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    let nextId = 1;
    store = new Map();
    const txRepo = {
      create: jest.fn((v: Record<string, unknown>) => ({ ...v })),
      insert: jest.fn((rows: Array<Record<string, unknown>>) =>
        Promise.resolve({
          identifiers: rows.map((row) => {
            const id = String(nextId++);
            store.set(id, { id, ...row });
            return { id };
          }),
        }),
      ),
      find: jest.fn(({ where }: { where: { id: { value: string[] } } }) =>
        Promise.resolve((where.id?.value ?? []).map((id) => store.get(id))),
      ),
    };
    const manager = { getRepository: () => txRepo };
    const repo = {
      manager: {
        transaction: (work: (m: unknown) => Promise<unknown>) => work(manager),
      },
      createQueryBuilder: () => {
        const qb: Record<string, jest.Mock> = {};
        for (const key of ['update', 'set', 'setParameter', 'whereInIds'])
          qb[key] = jest.fn(() => qb);
        qb.execute = jest.fn().mockResolvedValue({ affected: 1 });
        return qb;
      },
    };
    dm = {
      plan: jest.fn(
        async (ids: string[]) =>
          new Map(
            ids.map((id) => [
              id,
              id === '11'
                ? { telegram: 'queued' }
                : { telegram: 'skipped', telegram_reason: 'no_telegram_id' },
            ]),
          ),
      ),
      enqueue: jest.fn().mockResolvedValue(undefined),
    };
    telegramService = { sendNotification: jest.fn() };
    service = new NotificationInboxService(
      repo as never,
      { send: jest.fn() } as never,
      { emit: jest.fn(() => of(null)) } as never,
      telegramService as never,
      { log: jest.fn().mockResolvedValue(undefined) } as never,
      { enqueue: jest.fn() } as never,
      { assertFanout: jest.fn(), queueForNotifications: jest.fn() } as never,
      undefined,
      undefined,
      undefined,
      dm as unknown as TelegramDmService,
    );
  });

  const dto = (extra: Partial<DispatchNotificationDto> = {}) =>
    ({
      type: 'system.manual',
      title: 'E’lon',
      recipient_ids: ['11', '12'],
      channels: [NotificationChannel.IN_APP, NotificationChannel.TELEGRAM],
      ...extra,
    }) as DispatchNotificationDto;

  it('TC2/TC3: telegram_id bor → queued + outbox; null → skipped, dispatch YIQILMAYDI; guruh relay chaqirilmaydi', async () => {
    const res = (await service.dispatch(dto())) as {
      data: Record<string, any>;
      message: string;
    };
    expect(dm.plan).toHaveBeenCalledWith(['11', '12']);
    const byRecipient = Object.fromEntries(
      [...store.values()].map((row) => [row.recipient_id, row.delivery]),
    );
    expect(byRecipient['11']).toMatchObject({ telegram: 'queued' });
    expect(byRecipient['12']).toMatchObject({
      telegram: 'skipped',
      telegram_reason: 'no_telegram_id',
    });
    expect(dm.enqueue).toHaveBeenCalledWith(expect.anything(), ['1']);
    expect(telegramService.sendNotification).not.toHaveBeenCalled();
    expect(res.data.dispatched).toBe(2);
    expect(res.data.by_channel.telegram).toBe(1);
  });

  it('guruh nishoni (market_id) berilsa — avvalgidek guruh relay, DM yo‘q', async () => {
    telegramService.sendNotification.mockResolvedValue({
      data: { success: 1, failed: 0 },
    });
    await service.dispatch(dto({ telegram: { market_id: '5' } }));
    expect(dm.plan).not.toHaveBeenCalled();
    expect(telegramService.sendNotification).toHaveBeenCalled();
  });

  it('hech kim ulanmagan — 400 emas, telegram 0, "dispatched" deb aytmaydi', async () => {
    dm.plan.mockImplementation(
      async (ids: string[]) =>
        new Map(
          ids.map((id) => [
            id,
            { telegram: 'skipped', telegram_reason: 'no_telegram_id' },
          ]),
        ),
    );
    const res = (await service.dispatch(dto())) as {
      data: Record<string, any>;
      message: string;
    };
    expect(res.data.by_channel.telegram).toBe(0);
    expect(dm.enqueue).not.toHaveBeenCalled();
    expect(res.message).toBe(
      'Saved to inbox only — no external channel delivered',
    );
  });
});
