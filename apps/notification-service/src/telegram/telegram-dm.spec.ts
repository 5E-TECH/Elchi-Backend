/* eslint-disable @typescript-eslint/require-await -- spec mock'lari: async soxta implementatsiyalar */
import { Logger } from '@nestjs/common';
import { RpcException } from '@nestjs/microservices';
import { of } from 'rxjs';
import { NotificationChannel } from '@app/common';
import { DispatchNotificationDto } from '../dto/dispatch-notification.dto';
import { StartHandler } from '../bot/handlers/start.handler';
import { makeCtx } from '../bot/testing/bot-kit-spec';
import { NotificationInboxService } from '../notification-inbox.service';
import {
  TELEGRAM_DM_DELIVER_PATTERN,
  TelegramDmService,
} from './telegram-dm.service';
import { makeLinks } from '../bot/testing/bot-kit-spec';
import { withGroupRelay } from '../testing/inbox-kit-spec';

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
describe('rCFZAmOz — TelegramDmService', () => {
  let contacts: { contacts: jest.Mock };
  let telegram: { sendDirectToGroup: jest.Mock };
  let outbox: { enqueue: jest.Mock };
  let notifications: { query: jest.Mock; createQueryBuilder: jest.Mock };
  let patches: Array<{ ids: string[]; patch: Record<string, string> }>;
  let conditions: string[];
  let env: Record<string, string>;
  let links: ReturnType<typeof makeLinks>;

  const make = () =>
    new TelegramDmService(
      notifications as never,
      outbox as never,
      contacts as never,
      telegram as never,
      { get: (key: string) => env[key] } as never,
      {} as never,
      links as never,
    );

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    // (TgYRqaTk #1) DM manzili — `identity.telegram.resolve_many` (user_ids):
    // spec'da `contacts.contacts` xaritasidan javob beriladi.
    rmqSendMock
      .mockReset()
      .mockImplementation(
        async (
          _client: unknown,
          pattern: { cmd?: string },
          payload: { user_ids?: string[] },
        ) => {
          if (pattern?.cmd !== 'identity.telegram.resolve_many') {
            return { data: { bound: true } };
          }
          const ids = payload.user_ids ?? [];
          const map = (await contacts.contacts(ids)) as Map<
            string,
            { telegram_id?: string | null }
          >;
          return {
            data: Object.fromEntries(
              ids.map((id) => [id, map.get(id)?.telegram_id ?? null]),
            ),
          };
        },
      );
    env = { TELEGRAM_BOT_TOKEN: 'bot-token' };
    links = makeLinks({
      ['U'.repeat(43)]: { owner_id: '7', purpose: 'user' },
      ['G'.repeat(43)]: { owner_id: '5', group_type: 'create' },
    });
    patches = [];
    conditions = [];
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
        qb.andWhere = jest.fn((condition: string) => {
          conditions.push(condition);
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

  it('(4BirMSVp / 9HIaV80X) botni bloklagan chat — skipped (bot_blocked), qayta urinilmaydi', async () => {
    notifications.query.mockResolvedValueOnce([{ chat_id: '5550011' }]);
    const plan = await make().plan(['11']);
    expect(plan.get('11')).toEqual({
      telegram: 'skipped',
      telegram_reason: 'bot_blocked',
    });
    // (BOT-3c) Blok belgisi muddatsiz jadvalda (24 soatlik sessiyada emas).
    expect(String(notifications.query.mock.calls[0][0])).toContain(
      '"telegram_blocked_chats"',
    );
  });

  it('DM tugmalari: data.telegram_buttons → url (faqat https) va bot amali (egasi = qabul qiluvchi)', async () => {
    const actions = {
      create: jest.fn().mockResolvedValue('a:ack0000000000001'),
    };
    const svc = new TelegramDmService(
      notifications as never,
      outbox as never,
      contacts as never,
      telegram as never,
      { get: (key: string) => env[key] } as never,
      {} as never,
      links as never,
      actions as never,
    );
    notifications.query.mockResolvedValueOnce([
      {
        id: '1',
        recipient_id: '11',
        title: 'Kvitansiya',
        body: null,
        data: {
          telegram_buttons: [
            [
              {
                text: '👍 Tasdiqlayman',
                action: 'pay.ack',
                payload: { payment_id: '9', ack: 'confirmed' },
              },
              { text: 'evil', url: 'http://phish.example' },
            ],
            [
              {
                text: '🌐 Kabinetda ochish',
                url: 'https://admin.elchi.test/cash-box',
              },
            ],
          ],
        },
      },
    ]);
    await svc.deliver({ notification_ids: ['1'] });
    expect(actions.create).toHaveBeenCalledWith(
      expect.objectContaining({
        chatId: '5550011',
        action: 'pay.ack',
        actorUserId: '11',
        payload: { payment_id: '9', ack: 'confirmed' },
        oneShot: true,
      }),
    );
    expect(telegram.sendDirectToGroup).toHaveBeenCalledWith(
      expect.objectContaining({
        reply_markup: {
          inline_keyboard: [
            [{ text: '👍 Tasdiqlayman', callback_data: 'a:ack0000000000001' }],
            [
              {
                text: '🌐 Kabinetda ochish',
                url: 'https://admin.elchi.test/cash-box',
              },
            ],
          ],
        },
      }),
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
      source: 'notification.dm',
      // (BOT-3c) 429 bo'lsa yakuniy holatni outbox shu qatorga yozadi.
      notification_ids: ['1'],
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

  it('⭐ BOT-3c: 429 (outbox navbatida) → delivery.telegram = retrying, `sent` EMAS; yakunni outbox yozadi', async () => {
    notifications.query.mockResolvedValueOnce([
      { id: '1', recipient_id: '11', title: 'A', body: null },
    ]);
    telegram.sendDirectToGroup.mockResolvedValue({
      success: true,
      status: 'queued',
      result: null,
    });
    expect(await make().deliver({ notification_ids: ['1'] })).toEqual({
      processed: 1,
      sent: 0,
      failed: 0,
    });
    expect(patches.at(-1)).toEqual({
      ids: ['1'],
      patch: { telegram: 'retrying' },
    });
    // Outbox ishchisi allaqachon yakunlagan bo'lsa bosib ketilmaydi.
    expect(conditions).toContain(`"delivery"->>'telegram' = 'sending'`);
    expect(telegram.sendDirectToGroup).toHaveBeenCalledWith(
      expect.objectContaining({ notification_ids: ['1'] }),
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

  const rpcStatus = (promise: Promise<unknown>) =>
    promise.then(
      () => null,
      (error: unknown) =>
        (error as RpcException).getError() as { statusCode: number },
    );

  it('⭐ linkToken: user_id yo‘q → 401; bot yo‘q → 503; BIR MARTALIK kod, username bo‘lsa deep link', async () => {
    expect(await rpcStatus(make().linkToken({}))).toEqual(
      expect.objectContaining({ statusCode: 401 }),
    );
    env = {};
    expect(
      await rpcStatus(make().linkToken({ user_id: '7', roles: ['courier'] })),
    ).toEqual(expect.objectContaining({ statusCode: 503 }));
    env = {
      TELEGRAM_BOT_TOKEN: 'bot-token',
      TELEGRAM_BOT_USERNAME: '@ElchiBot',
    };
    const res = await make().linkToken({ user_id: '7', roles: ['courier'] });
    expect(res.data.deep_link).toBe(
      `https://t.me/ElchiBot?start=${res.data.token}`,
    );
    expect(res.data.command).toBe(`/start ${res.data.token}`);
    expect(links.issued[0]).toEqual(
      expect.objectContaining({
        purpose: 'user',
        owner_type: 'courier',
        owner_id: '7',
        created_by: '7',
      }),
    );
  });

  it.each([['customer'], ['investor']])(
    '%s — kod olmaydi (403)',
    async (role) => {
      expect(
        await rpcStatus(
          make().issueLinkCode({ requester: { id: '9', roles: [role] } }),
        ),
      ).toEqual(expect.objectContaining({ statusCode: 403 }));
      expect(links.issue).not.toHaveBeenCalled();
    },
  );

  it('⭐ market_group: market — o‘zi; operator — 403 (BOT-2 Q2 = A); admin — market_id majburiy; kuryer — 403', async () => {
    env = {
      TELEGRAM_BOT_TOKEN: 'bot-token',
      TELEGRAM_BOT_USERNAME: 'ElchiBot',
    };
    const market = await make().issueLinkCode({
      purpose: 'market_group',
      group_type: 'cancel',
      requester: { id: '37', roles: ['market'] },
    });
    expect(market.data.deep_link).toMatch(/\?startgroup=/);
    expect(links.issued.at(-1)).toEqual(
      expect.objectContaining({
        purpose: 'market_group',
        owner_id: '37',
        group_type: 'cancel',
      }),
    );

    // (BOT-2 #5, ega qarori Q2 = A) operator o'z marketi guruhini ham
    // ulay olmaydi — faqat ega yoki admin.
    const issuedBefore = links.issued.length;
    expect(
      await rpcStatus(
        make().issueLinkCode({
          purpose: 'market_group',
          requester: { id: '40', roles: ['market_operator'] },
        }),
      ),
    ).toEqual(expect.objectContaining({ statusCode: 403 }));
    expect(links.issued).toHaveLength(issuedBefore);

    expect(
      await rpcStatus(
        make().issueLinkCode({
          purpose: 'market_group',
          market_id: '38',
          requester: { id: '40', roles: ['market_operator'] },
        }),
      ),
    ).toEqual(expect.objectContaining({ statusCode: 403 }));

    expect(
      await rpcStatus(
        make().issueLinkCode({
          purpose: 'market_group',
          requester: { id: '1', roles: ['admin'] },
        }),
      ),
    ).toEqual(expect.objectContaining({ statusCode: 400 }));
    await make().issueLinkCode({
      purpose: 'market_group',
      market_id: '37',
      requester: { id: '1', roles: ['admin'] },
    });
    expect(links.issued.at(-1)).toEqual(
      expect.objectContaining({ owner_id: '37', created_by: '1' }),
    );

    expect(
      await rpcStatus(
        make().issueLinkCode({
          purpose: 'market_group',
          requester: { id: '25', roles: ['courier'] },
        }),
      ),
    ).toEqual(expect.objectContaining({ statusCode: 403 }));
  });

  it('⭐ bindFromStart — kod band qilinadi → identity.telegram.link (user_id KODDAN); ikkinchi marta — "eskirgan"', async () => {
    const code = 'U'.repeat(43);
    const ok = await make().bindFromStart(code, '5550007', 'ali');
    expect(ok.ok).toBe(true);
    expect(links.claim).toHaveBeenCalledWith(code, 'private', '5550007');
    expect(rmqSendMock).toHaveBeenCalledWith(
      {},
      { cmd: 'identity.telegram.link' },
      { user_id: '7', telegram_id: '5550007', telegram_username: 'ali' },
    );
    rmqSendMock.mockClear();
    const again = await make().bindFromStart(code, '5550007');
    expect(again.ok).toBe(false);
    expect(again.message).toContain('eskirgan');
    const bad = await make().bindFromStart('nope', '5550007');
    expect(bad.ok).toBe(false);
    const groupCode = await make().bindFromStart('G'.repeat(43), '5550007');
    expect(groupCode.message).toContain('guruh');
    expect(rmqSendMock).not.toHaveBeenCalled();
  });

  it('band telegram_id (409) — aniq xabar, ulanmaydi', async () => {
    rmqSendMock.mockRejectedValueOnce({
      statusCode: 409,
      message: 'Bu Telegram akkaunt boshqa xodimga ulangan',
    });
    const res = await make().bindFromStart('U'.repeat(43), '5550007');
    expect(res).toEqual({
      ok: false,
      message: '❌ Bu Telegram akkaunt boshqa xodimga ulangan',
    });
  });
});

describe('rCFZAmOz — bot /start <token> va /stop (bot/ yadrosi StartHandler)', () => {
  let dm: { bindFromStart: jest.Mock; unbind: jest.Mock };
  let activityLog: { log: jest.Mock };
  let handler: StartHandler;
  const run = async (text: string, chatType = 'private') => {
    const made = makeCtx({ text, chatId: '5550007', chatType });
    await handler.handle(made.ctx as never);
    return made;
  };

  beforeEach(() => {
    dm = {
      bindFromStart: jest
        .fn()
        .mockResolvedValue({ ok: true, message: 'Telegram ulandi' }),
      unbind: jest.fn().mockResolvedValue({ ok: true, message: 'uzildi' }),
    };
    activityLog = { log: jest.fn().mockResolvedValue(undefined) };
    handler = new StartHandler(
      {
        linkAttempt: jest.fn(() =>
          Promise.resolve({ allowed: true, blocked: false, hits: 1 }),
        ),
      } as never,
      activityLog as never,
      { get: jest.fn() } as never,
      dm as never,
    );
  });

  it('shaxsiy chatda /start <token> → bindFromStart(token, chat_id), javob va audit', async () => {
    const { replies } = await run('/start labc_def_0123456789abcdefghijkl');
    expect(dm.bindFromStart).toHaveBeenCalledWith(
      'labc_def_0123456789abcdefghijkl',
      '5550007',
      null,
    );
    expect(replies[0].text).toBe('Telegram ulandi');
    // (9HIaV80X #7) ulash activity_log'ga yoziladi.
    expect(activityLog.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'notification.tg_linked',
        entity_id: '5550007',
      }),
    );
  });

  it('guruhda /start <kod> — shaxsiy ulash EMAS: StartHandler o‘tkazadi (guruhni GroupHandler ulaydi)', async () => {
    const made = makeCtx({
      text: '/start labc_def_x',
      chatId: '-100555',
      chatType: 'group',
    });
    expect(await handler.handle(made.ctx as never)).toBe(false);
    expect(dm.bindFromStart).not.toHaveBeenCalled();
    expect(made.replies).toEqual([]);
    // /stop guruhda — faqat shaxsiy chatda ishlashi aytiladi.
    const stop = makeCtx({
      text: '/stop',
      chatId: '-100555',
      chatType: 'group',
    });
    await handler.handle(stop.ctx as never);
    expect(stop.replies[0].text).toContain('SHAXSIY chatda');
  });

  it('/stop va /uzish — unbind + audit; oddiy /start (ulanmagan) — ulash ko‘rsatmasi', async () => {
    await run('/stop');
    await run('/uzish');
    expect(dm.unbind).toHaveBeenCalledTimes(2);
    expect(dm.unbind).toHaveBeenCalledWith('5550007');
    expect(activityLog.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'notification.tg_unlinked' }),
    );
    const { replies } = await run('/start');
    expect(dm.bindFromStart).not.toHaveBeenCalled();
    expect(replies[0].text).toContain("Telegram'ni ulash");
    expect(replies[0].text).not.toMatch(/group_token/);
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
    const manager = {
      getRepository: () => txRepo,
      query: jest.fn().mockResolvedValue([]),
    };
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
    telegramService = withGroupRelay({ sendNotification: jest.fn() });
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
    expect(dm.plan).toHaveBeenCalledWith(['11', '12'], 'system.manual');
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
