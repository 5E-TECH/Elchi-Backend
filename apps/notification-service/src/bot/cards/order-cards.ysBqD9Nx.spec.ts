import { Logger } from '@nestjs/common';
import {
  callbackUpdate,
  courierActor,
  makeRouter,
} from '../testing/bot-kit-spec';
import { ACTION_FOREIGN_TEXT } from '../bot-router.service';
import { BotPasswordChangeRequiredError } from '../bot-gateway.client';
import { TelegramChat } from '../../entities/telegram-chat.entity';
import { TelegramOrderCard } from '../../entities/telegram-order-card.entity';
import { NotificationServiceService } from '../../notification-service.service';
import { GroupCardData, groupCardKeyboard, groupCardText } from './group-card';
import { OrderCardSyncService } from './order-card-sync.service';
import {
  CourierService,
  ORDER_NOT_YOURS_NOTE,
} from '../courier/courier.service';

const rmqSendMock = jest.fn();
jest.mock('@app/common', () => {
  const actual = jest.requireActual('@app/common');
  return { ...actual, rmqSend: (...args: unknown[]) => rmqSendMock(...args) };
});

/**
 * ysBqD9Nx — guruh chati KO'RINISH joyi (qaror joyi emas) va h9newLsd #5 —
 * holat o'zgarganda karta TAHRIRLANADI:
 *  - guruh kartasi: raqam, holat, tuman, summa, operator; mijoz PII —
 *    market bayrog'iga qarab (EGA QARORI: sukut yoqiq; o'chiq — niqob);
 *    ✅/❌ tasdiq tugmalari YO'Q, faqat "Kabinetda ochish";
 *  - holat o'zgarishi → yangi xabar EMAS, editMessageText;
 *  - guruhga yuborib bo'lmasa — oqim yiqilmaydi;
 *  - guruhdagi begona a'zo tugma bossa — rad (odam tekshiriladi);
 *  - yangi a'zo — marketga ogohlantirish.
 * (telegram_markets → telegram_chats migratsiyasi, my_chat_member →
 *  is_active=false, parallel hodisalar — telegram-chats.pg.spec.ts.)
 */
beforeEach(() => {
  jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  rmqSendMock.mockReset();
});
afterEach(() => jest.restoreAllMocks());

const cardData = (extra: Partial<GroupCardData> = {}): GroupCardData => ({
  id: '81',
  order_number: 'EL-100081',
  market_id: '5',
  status: 'new',
  total_price: 150000,
  district_name: 'Asaka',
  operator: 'Operator <Olim>',
  show_customer_pii: true,
  customer_name: 'Ali Valiyev',
  customer_phone: '+998901234512',
  ...extra,
});

describe('ysBqD9Nx #3 — guruh kartasi shabloni (snapshot)', () => {
  it('⭐ bayroq yoqiq (ega qarori, sukut): ism va telefon to‘liq; HTML escape', () => {
    expect(groupCardText(cardData())).toMatchInlineSnapshot(`
"🟢 <b>Buyurtma #EL-100081</b>
Holati: <b>Yangi</b>
📍 Tuman: Asaka
💰 Summa: 150 000 so'm
👨‍💼 Operator: Operator &lt;Olim&gt;
👤 Mijoz: Ali Valiyev
📞 Telefon: +998901234512"
`);
  });

  it('⭐ bayroq o‘chiq: mijoz ismi YO‘Q, telefon faqat niqoblangan', () => {
    const text = groupCardText(
      cardData({
        show_customer_pii: false,
        customer_name: null,
        customer_phone: '+998 90 *** ** 12',
      }),
    );
    expect(text).toMatchInlineSnapshot(`
"🟢 <b>Buyurtma #EL-100081</b>
Holati: <b>Yangi</b>
📍 Tuman: Asaka
💰 Summa: 150 000 so'm
👨‍💼 Operator: Operator &lt;Olim&gt;
📞 Telefon: +998 90 *** ** 12"
`);
    expect(text).not.toContain('Ali');
    expect(text).not.toContain('1234512');
  });

  it('⭐ ✅/❌ tasdiq tugmalari YO‘Q — faqat "Kabinetda ochish" (url, callback emas)', () => {
    expect(groupCardKeyboard('https://admin.elchi.test', '81')).toEqual([
      [
        {
          text: '🌐 Kabinetda ochish',
          url: 'https://admin.elchi.test/orders?search=81',
        },
      ],
    ]);
  });
});

/** Xotiradagi karta / chat jadvallari + tranzaksiya (advisory lock so'rovi yoziladi). */
function makeSync(
  options: {
    cards?: Array<Partial<TelegramOrderCard>>;
    groups?: Array<Partial<TelegramChat>>;
    send?: jest.Mock;
    card?: GroupCardData | null;
  } = {},
) {
  const cards = new Map<string, Partial<TelegramOrderCard>>(
    (options.cards ?? []).map((row) => [`${row.order_id}:${row.chat_id}`, row]),
  );
  const cardRepo = {
    find: jest.fn(({ where }: { where: { order_id: string } }) =>
      Promise.resolve(
        [...cards.values()].filter((row) => row.order_id === where.order_id),
      ),
    ),
    upsert: jest.fn((row: Partial<TelegramOrderCard>) => {
      cards.set(`${row.order_id}:${row.chat_id}`, row);
      return Promise.resolve();
    }),
    update: jest.fn(
      (
        where: { order_id: string; chat_id: string },
        patch: Partial<TelegramOrderCard>,
      ) => {
        const row = cards.get(`${where.order_id}:${where.chat_id}`);
        if (row) Object.assign(row, patch);
        return Promise.resolve();
      },
    ),
  };
  /**
   * `where` hurmat qilinadi (BOT-2 #591 ko'rib chiqish): egasi, faolligi,
   * scope va `chat_id IN (...)`. Berilmagan maydon — mos deb hisoblanadi.
   */
  const chatRepo = {
    find: jest.fn(({ where }: { where: Record<string, unknown> }) =>
      Promise.resolve(
        (options.groups ?? []).filter((group) =>
          Object.entries(where).every(([key, expected]) => {
            const actual = (group as Record<string, unknown>)[key];
            if (actual === undefined) return true;
            const operator = expected as { type?: string; value?: unknown };
            if (operator && typeof operator === 'object' && operator.type) {
              return operator.type === 'in'
                ? (operator.value as unknown[]).includes(actual)
                : true;
            }
            const text = (value: unknown) =>
              typeof value === 'string' || typeof value === 'number'
                ? String(value)
                : JSON.stringify(value);
            return text(actual) === text(expected);
          }),
        ),
      ),
    ),
  };
  const queries: string[] = [];
  /**
   * (BOT-3 #4) Tranzaksiyada faqat qulf + band qilish (`INSERT … message_id
   * NULL … ON CONFLICT DO NOTHING`); tarmoq — tashqarida (`dataSource`).
   */
  let inTransaction = false;
  const sqlQuery = jest.fn((sql: string, params: unknown[] = []) => {
    queries.push(sql);
    if (/INSERT INTO "notification_schema"."telegram_order_cards"/.test(sql)) {
      const [orderId, chatId] = params as [string, string];
      const key = `${orderId}:${chatId}`;
      if (cards.has(key)) return Promise.resolve([]);
      cards.set(key, {
        order_id: orderId,
        chat_id: chatId,
        message_id: null,
        kind: 'group',
      });
      return Promise.resolve([{ chat_id: chatId }]);
    }
    if (/SET "resync_pending" = true/.test(sql)) {
      const [orderId, chatId] = params as [string, string];
      const row = cards.get(`${orderId}:${chatId}`);
      if (!row || row.message_id != null) return Promise.resolve([]);
      row.resync_pending = true;
      return Promise.resolve([{ chat_id: chatId }]);
    }
    if (/DELETE FROM "notification_schema"."telegram_order_cards"/.test(sql)) {
      const [orderId, chatId] = params as [string, string];
      const key = `${orderId}:${chatId}`;
      if (cards.get(key)?.message_id == null) cards.delete(key);
      return Promise.resolve([[], 1]);
    }
    return Promise.resolve([]);
  });
  const manager = {
    query: sqlQuery,
    getRepository: (entity: unknown) =>
      entity === TelegramOrderCard ? cardRepo : chatRepo,
  };
  const dataSource = {
    transaction: async (work: (m: unknown) => Promise<unknown>) => {
      inTransaction = true;
      try {
        return await work(manager);
      } finally {
        inTransaction = false;
      }
    },
    query: sqlQuery,
    getRepository: (entity: unknown) =>
      entity === TelegramOrderCard ? cardRepo : chatRepo,
  };
  let seq = 900;
  const networkInTransaction: string[] = [];
  let cardSent: ((orderId: string) => Promise<unknown>) | undefined;
  const outbox = {
    onCardSent: jest.fn((listener: (orderId: string) => Promise<unknown>) => {
      cardSent = listener;
    }),
    send:
      options.send ??
      jest.fn(() => {
        if (inTransaction) networkInTransaction.push('send');
        return Promise.resolve({
          id: '1',
          status: 'sent',
          result: { message_id: ++seq },
        });
      }),
  };
  const transport = {
    editMessage: jest.fn(() => {
      if (inTransaction) networkInTransaction.push('edit');
      return Promise.resolve(true);
    }),
    describe: (error: unknown) =>
      error instanceof Error ? error.message : String(error),
  };
  const courier = {
    refreshCardForChat: jest.fn(() => {
      if (inTransaction) networkInTransaction.push('courier');
      return Promise.resolve('edited');
    }),
  };
  const activityLog = { log: jest.fn(() => Promise.resolve()) };
  rmqSendMock.mockImplementation(() => {
    // (BOT-3 #4) order-service RPC ham tranzaksiyadan TASHQARIDA.
    if (inTransaction) networkInTransaction.push('rpc');
    return Promise.resolve({
      data: options.card === undefined ? cardData() : options.card,
    });
  });
  const service = new OrderCardSyncService(
    dataSource as never,
    {} as never,
    outbox as never,
    transport as never,
    courier as never,
    activityLog as never,
    { get: () => 'https://admin.elchi.test' } as never,
  );
  return {
    service,
    cards,
    cardRepo,
    chatRepo,
    outbox,
    transport,
    courier,
    activityLog,
    queries,
    networkInTransaction,
    /** Outbox navbatdagi kartani yubordi (recordCard → onCardSent). */
    cardSent: (orderId: string) => cardSent?.(orderId),
  };
}

const group = (chatId: string): Partial<TelegramChat> => ({
  chat_id: chatId,
  chat_type: 'group',
  owner_type: 'market',
  owner_id: '5',
  scope: 'create',
  is_active: true,
});

describe('ysBqD9Nx #4 / h9newLsd #5 — karta sinxroni', () => {
  it('⭐ yaratilish — market "create" guruhlariga karta, message_id saqlanadi, audit izi', async () => {
    const env = makeSync({ groups: [group('-1001'), group('-1002')] });
    const result = await env.service.sync({
      order_id: '81',
      from_status: null,
      to_status: 'new',
      market_id: '5',
    });
    expect(result).toEqual({ sent: 2, edited: 0, revoked: 0 });
    expect(env.queries[0]).toContain('pg_advisory_xact_lock');
    expect(env.chatRepo.find).toHaveBeenCalledWith({
      where: expect.objectContaining({
        owner_type: 'market',
        owner_id: '5',
        scope: 'create',
        is_active: true,
      }),
    });
    expect(env.outbox.send).toHaveBeenCalledWith(
      expect.objectContaining({
        chatId: '-1001',
        parse_mode: 'HTML',
        source: 'bot.group_card',
        text: expect.stringContaining('Buyurtma #EL-100081'),
      }),
    );
    expect(
      [...env.cards.values()].map((row) => [
        row.chat_id,
        row.kind,
        row.message_id,
      ]),
    ).toEqual([
      ['-1001', 'group', '901'],
      ['-1002', 'group', '902'],
    ]);
    expect(env.activityLog.log).toHaveBeenCalledWith(
      expect.objectContaining({
        entity_type: 'Order',
        entity_id: '81',
        action: 'notification.tg_group_card',
        metadata: expect.objectContaining({
          op: 'sent',
          chat_id: '-1001',
          market_id: '5',
        }),
      }),
    );
  });

  it('⭐ holat o‘zgardi — YANGI xabar emas, mavjud karta editMessageText bilan', async () => {
    const env = makeSync({
      cards: [
        { order_id: '81', chat_id: '-1001', message_id: '901', kind: 'group' },
      ],
      // (BOT-2 #5) guruh hamon faol.
      groups: [{ chat_id: '-1001' }],
      card: cardData({ status: 'cancelled' }),
    });
    const result = await env.service.sync({
      order_id: '81',
      from_status: 'waiting',
      to_status: 'cancelled',
    });
    expect(result.edited).toBe(1);
    expect(env.outbox.send).not.toHaveBeenCalled();
    expect(env.transport.editMessage).toHaveBeenCalledWith(
      '-1001',
      '901',
      expect.objectContaining({
        text: expect.stringContaining('Bekor qilindi'),
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: '🌐 Kabinetda ochish',
                url: 'https://admin.elchi.test/orders?search=81',
              },
            ],
          ],
        },
      }),
    );
  });

  it('⭐ BOT-2 #5: uzilgan / nofaol guruhdagi eski karta TAHRIRLANMAYDI', async () => {
    const env = makeSync({
      cards: [
        { order_id: '81', chat_id: '-1001', message_id: '901', kind: 'group' },
      ],
      // telegram_chats da faol qator yo'q.
      groups: [],
      card: cardData({ status: 'cancelled' }),
    });
    const result = await env.service.sync({
      order_id: '81',
      from_status: 'waiting',
      to_status: 'cancelled',
    });
    expect(result.edited).toBe(0);
    expect(env.transport.editMessage).not.toHaveBeenCalled();
  });

  it('⭐ BOT-2: chat hamon faol, lekin BOSHQA marketga ulangan — eski karta tahrirlanmaydi (market_id hodisada yo`q)', async () => {
    const env = makeSync({
      cards: [
        { order_id: '81', chat_id: '-1001', message_id: '901', kind: 'group' },
      ],
      // Guruh A (5) dan uzilib B (7) ga ulangan; kartaning buyurtmasi A niki.
      groups: [
        {
          chat_id: '-1001',
          owner_type: 'market',
          owner_id: '7',
          scope: 'create',
          is_active: true,
        },
      ],
      card: cardData({ status: 'cancelled', market_id: '5' }),
    });
    const result = await env.service.sync({
      order_id: '81',
      from_status: 'waiting',
      to_status: 'cancelled',
    });
    expect(result.edited).toBe(0);
    expect(env.transport.editMessage).not.toHaveBeenCalled();
  });

  it('BOT-2: o`z marketining create guruhi — tahrirlanadi (market_id kartadan)', async () => {
    const env = makeSync({
      cards: [
        { order_id: '81', chat_id: '-1001', message_id: '901', kind: 'group' },
      ],
      groups: [
        {
          chat_id: '-1001',
          owner_type: 'market',
          owner_id: '5',
          scope: 'create',
          is_active: true,
        },
      ],
      card: cardData({ status: 'cancelled', market_id: '5' }),
    });
    const result = await env.service.sync({
      order_id: '81',
      from_status: 'waiting',
      to_status: 'cancelled',
    });
    expect(result.edited).toBe(1);
  });

  it('created → new ketma-ket — guruhda allaqachon karta bor: ikkinchi karta YUBORILMAYDI', async () => {
    const env = makeSync({ groups: [group('-1001')] });
    await env.service.sync({
      order_id: '81',
      from_status: null,
      to_status: 'created',
      market_id: '5',
    });
    await env.service.sync({
      order_id: '81',
      from_status: 'created',
      to_status: 'new',
      market_id: '5',
    });
    expect(env.outbox.send).toHaveBeenCalledTimes(1);
    expect(env.transport.editMessage).toHaveBeenCalledTimes(1);
  });

  it('⭐ BOT-3 #6: guruh supergroup`ga aylandi (outbox yangi id`ga yubordi) — karta YANGI id ostida; created → new — Telegram`ga bitta xabar', async () => {
    const groups = [group('-1001')];
    const holder: { cards?: Map<string, Partial<TelegramOrderCard>> } = {};
    const send = jest.fn(() => {
      // migrateChat (outbox ichida) band qilish qatorini yangi id'ga ko'chiradi.
      const claim = holder.cards?.get('81:-1001');
      if (claim) {
        holder.cards!.delete('81:-1001');
        holder.cards!.set('81:-1009999', { ...claim, chat_id: '-1009999' });
      }
      return Promise.resolve({
        id: '1',
        status: 'sent',
        result: { message_id: 4242 },
        chat_id: '-1009999',
      });
    });
    const env = makeSync({ groups, send });
    holder.cards = env.cards;
    await env.service.sync({
      order_id: '81',
      from_status: null,
      to_status: 'created',
      market_id: '5',
    });
    expect([...env.cards.keys()]).toEqual(['81:-1009999']);
    expect(env.cards.get('81:-1009999')).toEqual(
      expect.objectContaining({ message_id: '4242' }),
    );
    // migrateChat telegram_chats ni ham yangiladi.
    groups[0] = group('-1009999');
    await env.service.sync({
      order_id: '81',
      from_status: 'created',
      to_status: 'new',
      market_id: '5',
    });
    expect(send).toHaveBeenCalledTimes(1);
    expect(env.transport.editMessage).toHaveBeenCalledWith(
      '-1009999',
      '4242',
      expect.anything(),
    );
  });

  it('⭐ guruhga yuborib bo‘lmasa (bot chiqarilgan) — sync YIQILMAYDI (buyurtma oqimiga ta’sir yo‘q)', async () => {
    const env = makeSync({
      groups: [group('-1001')],
      send: jest.fn(() =>
        Promise.reject(new Error('Forbidden: bot was kicked')),
      ),
    });
    await expect(
      env.service.sync({
        order_id: '81',
        from_status: null,
        to_status: 'new',
        market_id: '5',
      }),
    ).resolves.toEqual({ sent: 0, edited: 0, revoked: 0 });
  });

  it('⭐ h9newLsd: paneldan bekor qilindi — kuryer kartasi kuryerning o‘z JWT’si bilan yangilanadi', async () => {
    const env = makeSync({
      cards: [
        {
          order_id: '81',
          chat_id: '5550025',
          message_id: '77',
          kind: 'courier',
          actor_user_id: '25',
        },
      ],
    });
    const result = await env.service.sync({
      order_id: '81',
      from_status: 'waiting',
      to_status: 'cancelled',
    });
    expect(env.courier.refreshCardForChat).toHaveBeenCalledWith(
      '5550025',
      '81',
      '25',
    );
    expect(result.edited).toBe(1);
    // Guruh kartasi yo'q — order-service RPC'si umuman chaqirilmaydi.
    expect(rmqSendMock).not.toHaveBeenCalled();
  });

  it('kartasi yo‘q buyurtma — hech narsa (so‘rovsiz)', async () => {
    const env = makeSync();
    expect(
      await env.service.sync({
        order_id: '81',
        from_status: 'received',
        to_status: 'on the road',
      }),
    ).toEqual({ sent: 0, edited: 0, revoked: 0 });
    expect(rmqSendMock).not.toHaveBeenCalled();
    expect(env.chatRepo.find).not.toHaveBeenCalled();
  });

  it('yaroqsiz hodisa — e’tiborsiz', async () => {
    const env = makeSync();
    expect(await env.service.sync({ order_id: 'x', to_status: 'new' })).toEqual(
      {
        sent: 0,
        edited: 0,
        revoked: 0,
      },
    );
  });
});

describe('ysBqD9Nx #1 — guruhda huquq ODAM bo‘yicha (chat bo‘yicha emas)', () => {
  it('⭐ guruhdagi begona a’zo boshqaning tugmasini bossa — "siz uchun emas", amal bajarilmaydi', async () => {
    const gateway = jest.fn();
    const ctx = makeRouter({
      actor: { ...courierActor('26'), user_id: '26' },
      gateway,
    });
    const data = await ctx.actions.create({
      chatId: '-1001',
      action: 'c.op',
      actorUserId: '25',
      orderId: '81',
      payload: { op: 'sell' },
      oneShot: false,
    });
    await ctx.router.dispatch(
      'elchi',
      callbackUpdate(data, { chatId: -1001, fromId: 26, chatType: 'group' }),
    );
    expect(ctx.transport.answerCallbackQuery).toHaveBeenLastCalledWith(
      'cb1',
      ACTION_FOREIGN_TEXT,
    );
    expect(gateway).not.toHaveBeenCalled();
  });
});

describe('ysBqD9Nx DIQQAT — guruhga yangi a’zo → market ogohlantiriladi', () => {
  it('⭐ router: new_chat_members (odamlar) → warnGroupNewMembers; botlar hisobga olinmaydi; guruhga javob yo‘q', async () => {
    const ctx = makeRouter();
    await ctx.router.dispatch('elchi', {
      update_id: 5,
      message: {
        message_id: 3,
        chat: { id: -1001, type: 'supergroup', title: 'Market buyurtmalar' },
        from: { id: 40 },
        new_chat_members: [
          { id: 41, first_name: 'Yangi xodim' },
          { id: 42, first_name: 'Boshqa bot', is_bot: true },
        ],
      },
    });
    expect(ctx.notifications.warnGroupNewMembers).toHaveBeenCalledWith(
      '-1001',
      'Market buyurtmalar',
      [{ id: 41, first_name: 'Yangi xodim' }],
    );
    expect(ctx.outbox.send).not.toHaveBeenCalled();
  });

  it('⭐ warnGroupNewMembers: guruh egasi marketga in-app + Telegram DM, audit izi', async () => {
    const inbox = { dispatch: jest.fn(() => Promise.resolve({})) };
    const activityLog = { log: jest.fn(() => Promise.resolve()) };
    const repo = {
      find: jest.fn(() =>
        Promise.resolve([{ market_id: '5' }, { market_id: '5' }]),
      ),
    };
    const svc = new NotificationServiceService(
      repo as never,
      {} as never,
      activityLog as never,
      {} as never,
      {} as never,
      { get: () => inbox } as never,
    );
    expect(
      await svc.warnGroupNewMembers('-1001', 'Market buyurtmalar', [
        { id: 41, first_name: 'Yangi xodim' },
      ]),
    ).toEqual({ markets: 1 });
    expect(repo.find).toHaveBeenCalledWith({
      where: { group_id: '-1001', is_active: true, isDeleted: false },
    });
    expect(inbox.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'telegram.group_member_joined',
        recipient_ids: ['5'],
        channels: ['in_app', 'realtime', 'telegram'],
        body: expect.stringContaining('Yangi xodim'),
      }),
    );
    expect(activityLog.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'notification.tg_group_member_joined',
      }),
    );
  });

  it('hech bir marketga ulanmagan guruh — jim', async () => {
    const inbox = { dispatch: jest.fn() };
    const svc = new NotificationServiceService(
      { find: jest.fn(() => Promise.resolve([])) } as never,
      {} as never,
      { log: jest.fn() } as never,
      {} as never,
      {} as never,
      { get: () => inbox } as never,
    );
    expect(await svc.warnGroupNewMembers('-1009', null, [{ id: 1 }])).toEqual({
      markets: 0,
    });
    expect(inbox.dispatch).not.toHaveBeenCalled();
  });
});

describe('h9newLsd #5 — CourierService.refreshCardForChat', () => {
  const make = (response: { status: number; body: unknown }) => {
    const gateway = { request: jest.fn(() => Promise.resolve(response)) };
    const transport = { editMessage: jest.fn(() => Promise.resolve(true)) };
    const cards = {
      findOne: jest.fn(() =>
        Promise.resolve({
          order_id: '81',
          chat_id: '5550025',
          message_id: '77',
        }),
      ),
      update: jest.fn(() => Promise.resolve()),
    };
    const actions = {
      create: jest.fn(() => Promise.resolve('a:op0000000000001')),
    };
    const courier = new CourierService(
      gateway as never,
      actions as never,
      {} as never,
      transport as never,
      cards as never,
      { get: () => 'https://admin.elchi.test' } as never,
    );
    return { courier, gateway, transport, cards };
  };

  it('⭐ panelda bekor qilindi — karta yangi holat bilan, faqat o‘sha holatdagi tugmalar', async () => {
    const env = make({
      status: 200,
      body: {
        data: { id: '81', status: 'cancelled', total_price: 1000, market: {} },
      },
    });
    expect(await env.courier.refreshCardForChat('5550025', '81', '25')).toBe(
      'edited',
    );
    expect(env.gateway.request).toHaveBeenCalledWith(
      '5550025',
      'GET',
      '/orders/81',
    );
    expect(env.transport.editMessage).toHaveBeenCalledWith(
      '5550025',
      '77',
      expect.objectContaining({
        text: expect.stringContaining('Bekor qilindi'),
      }),
    );
  });

  it('⭐ BOT-2 + BOT-3: refreshCard — parol almashtirish xatosi JIM yutilmaydi (router aniq ko‘rsatma beradi), karta tegilmaydi', async () => {
    const env = make({ status: 200, body: {} });
    env.gateway.request.mockImplementation(() =>
      Promise.reject(new BotPasswordChangeRequiredError()),
    );
    await expect(
      env.courier.refreshCard(
        { chatId: '5550025' } as never,
        '5550025',
        '81',
        '25',
      ),
    ).rejects.toBeInstanceOf(BotPasswordChangeRequiredError);
    expect(env.transport.editMessage).not.toHaveBeenCalled();
  });

  it('refreshCard — karta hali yuborilmagan (message_id NULL) — so‘rovsiz qaytadi', async () => {
    const env = make({ status: 200, body: {} });
    env.cards.findOne.mockResolvedValue({
      order_id: '81',
      chat_id: '5550025',
      message_id: null as unknown as string,
    });
    await env.courier.refreshCard(
      { chatId: '5550025' } as never,
      '5550025',
      '81',
      '25',
    );
    expect(env.gateway.request).not.toHaveBeenCalled();
  });

  it('⭐ buyurtma boshqa kuryerga o‘tdi (404) — tugmalar olinadi, izoh', async () => {
    const env = make({ status: 404, body: { message: 'topilmadi' } });
    expect(await env.courier.refreshCardForChat('5550025', '81', '25')).toBe(
      'revoked',
    );
    expect(env.transport.editMessage).toHaveBeenCalledWith('5550025', '77', {
      text: expect.stringContaining(ORDER_NOT_YOURS_NOTE),
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: [] },
    });
  });

  it('tarmoq/5xx — karta tegilmaydi', async () => {
    const env = make({ status: 502, body: null });
    expect(await env.courier.refreshCardForChat('5550025', '81', '25')).toBe(
      'skipped',
    );
    expect(env.transport.editMessage).not.toHaveBeenCalled();
  });

  describe('BOT-3 #4 — tarmoq tranzaksiyadan tashqarida, kechikkan karta', () => {
    const creationEvent = {
      order_id: '81',
      from_status: 'created',
      to_status: 'new',
      market_id: '5',
    };

    it('⭐ yaratish va tahrir — Telegram, order RPC va kuryer kartasi tranzaksiya ICHIDA emas', async () => {
      const env = makeSync({
        groups: [group('-1001'), group('-1009')],
        cards: [
          { order_id: '81', chat_id: '-1009', message_id: '5', kind: 'group' },
          {
            order_id: '81',
            chat_id: '5550025',
            message_id: '6',
            kind: 'courier',
            actor_user_id: '25',
          },
        ],
      });
      const result = await env.service.sync(creationEvent);
      expect(result.sent).toBe(1);
      expect(result.edited).toBe(2);
      expect(env.transport.editMessage).toHaveBeenCalledWith(
        '-1009',
        '5',
        expect.anything(),
      );
      expect(rmqSendMock).toHaveBeenCalled();
      expect(env.courier.refreshCardForChat).toHaveBeenCalled();
      expect(env.networkInTransaction).toEqual([]);
      // band qilish qatori message_id bilan to'ldirildi
      expect(env.cards.get('81:-1001')).toEqual(
        expect.objectContaining({ message_id: '901' }),
      );
    });

    it('⭐ 429 (navbatda) — band qilish qoladi, takror hodisada ikkinchi karta yo`q; holat o`zgarishi TASHLANMAYDI (resync_pending), outbox yuborgach karta oxirgi holatga tahrirlanadi', async () => {
      const send = jest.fn(() =>
        Promise.resolve({ id: '7', status: 'queued', result: null }),
      );
      const env = makeSync({ groups: [group('-1001')], send });
      env.service.onModuleInit();
      await env.service.sync(creationEvent);
      expect(env.cards.get('81:-1001')).toEqual(
        expect.objectContaining({ message_id: null }),
      );
      expect(send).toHaveBeenCalledWith(
        expect.objectContaining({ cardOrderId: '81' }),
      );
      await env.service.sync(creationEvent);
      await env.service.sync({
        order_id: '81',
        from_status: 'new',
        to_status: 'received',
      });
      expect(send).toHaveBeenCalledTimes(1);
      expect(env.transport.editMessage).not.toHaveBeenCalled();
      expect(env.cards.get('81:-1001')?.resync_pending).toBe(true);
      // Worker kartani yubordi (recordCard message_id yozdi) → qayta sinxron.
      env.cards.get('81:-1001')!.message_id = '777';
      rmqSendMock.mockResolvedValue({ data: cardData({ status: 'sold' }) });
      await env.cardSent('81');
      expect(env.transport.editMessage).toHaveBeenCalledTimes(1);
      expect(env.transport.editMessage).toHaveBeenCalledWith(
        '-1001',
        '777',
        expect.anything(),
      );
      expect(env.cards.get('81:-1001')).toEqual(
        expect.objectContaining({ status: 'sold', resync_pending: false }),
      );
    });

    it('⭐ oddiy holat hodisasi (market_id YO`Q — ega kartadan RPC orqali) — RPC va tahrir tranzaksiya ICHIDA emas', async () => {
      const env = makeSync({
        groups: [group('-1009')],
        cards: [
          { order_id: '81', chat_id: '-1009', message_id: '5', kind: 'group' },
        ],
      });
      const result = await env.service.sync({
        order_id: '81',
        from_status: 'new',
        to_status: 'received',
      });
      expect(result.edited).toBe(1);
      expect(rmqSendMock).toHaveBeenCalled();
      expect(env.networkInTransaction).toEqual([]);
    });

    it('⭐ tahrir o`tmadi (editMessage false) — holat / resync_pending yozilmaydi, audit `edited` yo`q', async () => {
      const env = makeSync({
        groups: [group('-1009')],
        cards: [
          {
            order_id: '81',
            chat_id: '-1009',
            message_id: '5',
            kind: 'group',
            status: 'new',
            resync_pending: true,
          },
        ],
      });
      env.transport.editMessage.mockResolvedValue(false);
      const result = await env.service.sync({
        order_id: '81',
        from_status: 'new',
        to_status: 'received',
      });
      expect(result.edited).toBe(0);
      expect(env.cards.get('81:-1009')).toEqual(
        expect.objectContaining({ status: 'new', resync_pending: true }),
      );
      expect(env.activityLog.log).not.toHaveBeenCalled();
    });

    it('⭐ navbatdagi karta + order RPC yiqildi — resync belgisi baribir qo`yiladi', async () => {
      const env = makeSync({
        groups: [group('-1001')],
        cards: [
          { order_id: '81', chat_id: '-1001', message_id: null, kind: 'group' },
        ],
      });
      rmqSendMock.mockRejectedValue(new Error('order-service down'));
      await env.service.sync({
        order_id: '81',
        from_status: 'new',
        to_status: 'received',
      });
      expect(env.cards.get('81:-1001')?.resync_pending).toBe(true);
    });

    it('⭐ bir buyurtmaning ikki parallel hodisasi — kechroq tugagan ERTA o`qish yangi holatni bosib ketmaydi', async () => {
      const env = makeSync({
        groups: [group('-1009')],
        cards: [
          { order_id: '81', chat_id: '-1009', message_id: '5', kind: 'group' },
        ],
      });
      let releaseFirst: () => void = () => undefined;
      rmqSendMock
        .mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              releaseFirst = () =>
                resolve({ data: cardData({ status: 'waiting' }) });
            }),
        )
        .mockImplementation(() =>
          Promise.resolve({ data: cardData({ status: 'sold' }) }),
        );
      const first = env.service.sync({
        order_id: '81',
        from_status: 'on the road',
        to_status: 'waiting',
      });
      const second = env.service.sync({
        order_id: '81',
        from_status: 'waiting',
        to_status: 'sold',
      });
      await new Promise((resolve) => setImmediate(resolve));
      releaseFirst();
      await Promise.all([first, second]);
      // Ketma-ket: oxirgi tahrir — oxirgi holat.
      expect(env.cards.get('81:-1009')?.status).toBe('sold');
      expect(env.transport.editMessage).toHaveBeenCalledTimes(2);
    });

    it('yuborib bo`lmadi (dead / xato) — band qilish bo`shatiladi', async () => {
      const send = jest.fn(() =>
        Promise.resolve({ id: '7', status: 'dead', error: 'blocked' }),
      );
      const env = makeSync({ groups: [{ chat_id: '-1001' }], send });
      await env.service.sync(creationEvent);
      expect(env.cards.has('81:-1001')).toBe(false);
    });
  });
});
