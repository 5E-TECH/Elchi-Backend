import { Logger } from '@nestjs/common';
import { botDmDeliveryTotal } from '../bot-metrics';
import {
  callbackUpdate,
  courierActor,
  makeRouter,
  sentTexts,
} from '../testing/bot-kit-spec';
import { TelegramDmService } from '../../telegram/telegram-dm.service';
import {
  PAYMENT_ACK_ALREADY_TEXT,
  PAYMENT_ACK_CONFIRMED_TEXT,
  PAYMENT_ACK_DISPUTED_TEXT,
  PAYMENT_ACK_FOREIGN_TEXT,
} from './payment-ack.actions';

const rmqSendMock = jest.fn();
jest.mock('@app/common', () => {
  const actual = jest.requireActual('@app/common');
  return { ...actual, rmqSend: (...args: unknown[]) => rmqSendMock(...args) };
});

/**
 * 2crjWf7v — kuryer kvitansiyasi (bot tomoni) va VICfJuoi #3 "Kabinetda ochish":
 *  - "👍 Tasdiqlayman" / "❗️ Noto'g'ri" → MAVJUD gateway endpointi kuryerning
 *    o'z JWT'si bilan (`POST /finance/cashbox/payment/courier/:id/ack`) —
 *    bot moliyaviy yozuv YARATMAYDI (faqat audit, finance tomonda);
 *  - begona odam bossa — rad; guruhda — rad;
 *  - kvitansiya faqat shaxsiy chatga; yetkazish metrikasi.
 * (Kassa o'zgarmasligi / bitta yozuv — courier-payment-ack.pg.spec.ts;
 *  /balans TC'lari — courier-report.4BirMSVp.spec.ts.)
 */
beforeEach(() => {
  jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  rmqSendMock.mockReset();
});
afterEach(() => jest.restoreAllMocks());

async function setup(response: { status: number; body: unknown }) {
  const gateway = jest.fn(() => Promise.resolve(response));
  const ctx = makeRouter({ actor: courierActor('44'), gateway });
  // DM deliver yaratgan tugmalar taqlidi (egasi = kuryer 44).
  const [ok, no] = await Promise.all(
    ['fp.ok', 'fp.no'].map((action) =>
      ctx.actions.create({
        chatId: '44',
        action,
        actorUserId: '44',
        payload: { payment_id: '701' },
        oneShot: false,
      }),
    ),
  );
  await ctx.actions.attachMessage([ok, no], 555);
  return { ctx, gateway, ok, no };
}
const press = (
  ctx: ReturnType<typeof makeRouter>,
  data: string,
  options: { fromId?: number; chatType?: string } = {},
) =>
  ctx.router.dispatch(
    'elchi',
    callbackUpdate(data, {
      chatId: 44,
      fromId: options.fromId ?? 44,
      chatType: options.chatType,
    }),
  );

describe('2crjWf7v — 👍 / ❗️ kvitansiya tugmalari', () => {
  it('⭐ 👍 → POST …/701/ack { confirmed } kuryer nomidan; tugmalar olinadi; "Tasdiqlandi"', async () => {
    const { ctx, gateway, ok } = await setup({
      status: 201,
      body: { data: { ack: 'confirmed', already: false } },
    });
    await press(ctx, ok);
    expect(gateway).toHaveBeenCalledWith(
      '44',
      'POST',
      '/finance/cashbox/payment/courier/701/ack',
      { ack: 'confirmed' },
    );
    expect(ctx.transport.editMessage).toHaveBeenCalledWith('44', '555', {
      reply_markup: { inline_keyboard: [] },
    });
    expect(sentTexts(ctx).at(-1)).toBe(PAYMENT_ACK_CONFIRMED_TEXT);
  });

  it('⭐ ❗️ → { disputed }; javobda "menejer va filial boshlig‘iga yuborildi, kassa o‘zgarmadi"', async () => {
    const { ctx, gateway, no } = await setup({
      status: 201,
      body: { data: { ack: 'disputed', already: false } },
    });
    await press(ctx, no);
    expect(gateway.mock.calls[0]).toEqual([
      '44',
      'POST',
      '/finance/cashbox/payment/courier/701/ack',
      { ack: 'disputed' },
    ]);
    expect(sentTexts(ctx).at(-1)).toBe(PAYMENT_ACK_DISPUTED_TEXT);
  });

  it('⭐ ikkinchi bosish — server `already: true` → "allaqachon javob berilgan"', async () => {
    const { ctx, ok } = await setup({
      status: 200,
      body: { data: { ack: 'confirmed', already: true } },
    });
    await press(ctx, ok);
    expect(sentTexts(ctx).at(-1)).toBe(PAYMENT_ACK_ALREADY_TEXT);
  });

  it('begona odam bosa — rad, gateway chaqirilmaydi', async () => {
    const { ctx, gateway, ok } = await setup({ status: 201, body: {} });
    ctx.actors.resolve.mockResolvedValue({
      ...courierActor('45'),
      user_id: '45',
    });
    await press(ctx, ok, { fromId: 45 });
    expect(ctx.transport.answerCallbackQuery).toHaveBeenLastCalledWith(
      'cb1',
      PAYMENT_ACK_FOREIGN_TEXT,
    );
    expect(gateway).not.toHaveBeenCalled();
  });

  it('boshqa kuryerning kvitansiyasi (server 404) — "faqat o‘sha kuryerga"', async () => {
    const { ctx, ok } = await setup({
      status: 404,
      body: { message: 'Kvitansiya topilmadi' },
    });
    await press(ctx, ok);
    expect(sentTexts(ctx).at(-1)).toBe(PAYMENT_ACK_FOREIGN_TEXT);
  });
});

describe('2crjWf7v / VICfJuoi — DM yetkazish (faqat shaxsiy chat, tugmalar, metrika)', () => {
  const makeDm = (chat: string) => {
    rmqSendMock.mockImplementation((_c: unknown, pattern: { cmd?: string }) =>
      Promise.resolve(
        pattern?.cmd === 'identity.telegram.resolve_many'
          ? { data: { '44': chat } }
          : { data: null },
      ),
    );
    const notifications = {
      query: jest.fn(),
      createQueryBuilder: jest.fn(() => {
        const qb: Record<string, jest.Mock> = {};
        for (const key of ['update', 'set', 'setParameter', 'whereInIds'])
          qb[key] = jest.fn(() => qb);
        qb.execute = jest.fn().mockResolvedValue({ affected: 1 });
        return qb;
      }),
    };
    const telegram = {
      sendDirectToGroup: jest
        .fn()
        .mockResolvedValue({ result: { message_id: 900 } }),
    };
    const actions = {
      create: jest.fn((input: { action: string }) =>
        Promise.resolve(`a:${input.action.replace('.', '')}000000000000`),
      ),
      attachMessage: jest.fn().mockResolvedValue(undefined),
    };
    const dm = new TelegramDmService(
      notifications as never,
      { enqueue: jest.fn() } as never,
      { contacts: jest.fn() } as never,
      telegram as never,
      {
        get: (key: string) =>
          ({
            TELEGRAM_BOT_TOKEN: 'x:y',
            ELCHI_CABINET_URL: 'https://admin.elchi.test/',
          })[key],
      } as never,
      {} as never,
      {} as never,
      actions as never,
    );
    return { dm, notifications, telegram, actions };
  };
  const receiptRow = {
    id: '1',
    recipient_id: '44',
    type: 'finance.payment_received',
    link: '/cash-box',
    title: 'Pul qabul qilindi',
    body: "✅ 400 000 so'm qabul qilindi (to'lov #701).\nQabul qildi: Ali.\nQoldiq: 500 000 so'm.",
    data: {
      kind: 'courier_payment',
      payment_id: '701',
      telegram_buttons: [
        [
          {
            text: '👍 Tasdiqlayman',
            action: 'fp.ok',
            payload: { payment_id: '701' },
            one_shot: false,
          },
          {
            text: "❗️ Noto'g'ri",
            action: 'fp.no',
            payload: { payment_id: '701' },
            one_shot: false,
          },
        ],
      ],
    },
  };

  it('⭐ kvitansiya shaxsiy chatga 👍/❗️ bilan; tugmalar egasi — kuryer; xabarga bog‘lanadi', async () => {
    const { dm, notifications, telegram, actions } = makeDm('5550044');
    notifications.query.mockResolvedValueOnce([receiptRow]);
    expect(await dm.deliver({ notification_ids: ['1'] })).toEqual({
      processed: 1,
      sent: 1,
      failed: 0,
    });
    expect(actions.create).toHaveBeenCalledWith(
      expect.objectContaining({
        chatId: '5550044',
        actorUserId: '44',
        action: 'fp.ok',
        payload: { payment_id: '701' },
        oneShot: false,
      }),
    );
    expect(telegram.sendDirectToGroup).toHaveBeenCalledWith(
      expect.objectContaining({
        group_id: '5550044',
        reply_markup: {
          inline_keyboard: [
            [
              { text: '👍 Tasdiqlayman', callback_data: 'a:fpok000000000000' },
              { text: "❗️ Noto'g'ri", callback_data: 'a:fpno000000000000' },
            ],
          ],
        },
      }),
    );
  });

  it('⭐ kvitansiya GURUH chatiga hech qachon: manfiy chat id → skipped(not_private_chat), yuborilmaydi', async () => {
    const { dm, notifications, telegram } = makeDm('-1001234567890');
    notifications.query.mockResolvedValueOnce([receiptRow]);
    await dm.deliver({ notification_ids: ['1'] });
    expect(telegram.sendDirectToGroup).not.toHaveBeenCalled();
    const plan = await dm.plan(['44'], 'finance.payment_received');
    expect(plan.get('44')).toEqual({
      telegram: 'skipped',
      telegram_reason: 'not_private_chat',
    });
  });

  it('⭐ yetkazish metrikasi: planned va sent tur bo‘yicha (bot:dm_delivery_ratio uchun)', async () => {
    const value = async (status: string) =>
      (await botDmDeliveryTotal.get()).values.find(
        (v) =>
          v.labels.type === 'finance.payment_received' &&
          v.labels.status === status,
      )?.value ?? 0;
    const planned = await value('planned');
    const sent = await value('sent');
    const { dm, notifications } = makeDm('5550044');
    await dm.plan(['44'], 'finance.payment_received');
    notifications.query.mockResolvedValueOnce([receiptRow]);
    await dm.deliver({ notification_ids: ['1'] });
    expect(await value('planned')).toBe(planned + 1);
    expect(await value('sent')).toBe(sent + 1);
  });

  it('VICfJuoi #3: market to‘lovi DM’ida «🌐 Kabinetda ochish» (panel manzili + link)', async () => {
    const { dm, notifications, telegram } = makeDm('5550044');
    notifications.query.mockResolvedValueOnce([
      {
        id: '2',
        recipient_id: '44',
        type: 'finance.payment_received',
        link: '/cash-box',
        title: "💰 To'lov qabul qilindi",
        body: "Sizga 1 500 000 so'm to'landi.",
        data: { kind: 'market_payment', telegram_cabinet_link: true },
      },
    ]);
    await dm.deliver({ notification_ids: ['2'] });
    expect(telegram.sendDirectToGroup).toHaveBeenCalledWith(
      expect.objectContaining({
        reply_markup: {
          inline_keyboard: [
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
});
