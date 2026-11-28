import { Logger } from '@nestjs/common';
import {
  MARKET_AI_ORDER_HINT,
  STAFF_AI_ORDER_TEXT,
} from './ai-order/ai-order.handler';
import { unknownTextReply } from './bot-router.service';
import {
  STAFF_UNKNOWN_COMMAND_TEXT,
  UNKNOWN_COMMAND_TEXT,
} from './handlers/market.handler';
import { makeRouter, marketActor, textUpdate } from './testing/bot-kit-spec';

/**
 * Bot orqali AI buyurtma — kim yarata olishi aytiladi (ega 2026-11-27: admin
 * akkauntiga ulangan Telegram'dan sinab «Tushunarsiz buyruq … /status» olgan,
 * market esa imkoniyatni hech qayerda ko'rmagan).
 */
const staff = (role: string) => ({
  user_id: '9',
  role,
  status: 'active',
  market_id: null,
  region_id: null,
});
const ORDER_TEXT =
  'Ali Valiyev +998 90 123 45 67 Buxoro, Kogon. Krossovka 350 000';

const sent = (ctx: ReturnType<typeof makeRouter>) =>
  (ctx.outbox.send.mock.calls as unknown as Array<[{ text: string }]>).map(
    ([call]) => call.text,
  );

const photoUpdate = () => ({
  update_id: 7,
  message: {
    message_id: 1,
    chat: { id: 111, type: 'private' },
    from: { id: 111 },
    photo: [
      {
        file_id: 'p1',
        file_unique_id: 'u1',
        width: 800,
        height: 600,
        file_size: 90_000,
      },
    ],
  },
});

describe('bot: AI buyurtma ko‘rsatmalari', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('unknownTextReply: market — /status; xodim — kim yaratishi yoki umumiy menyu; kuryer — umumiy', () => {
    expect(unknownTextReply('market', '/nimadir')).toBe(UNKNOWN_COMMAND_TEXT);
    expect(unknownTextReply('market_operator', '/x')).toBe(
      UNKNOWN_COMMAND_TEXT,
    );
    for (const role of ['superadmin', 'admin', 'registrator', 'manager']) {
      expect(unknownTextReply(role, ORDER_TEXT)).toBe(STAFF_AI_ORDER_TEXT);
      expect(unknownTextReply(role, 'salom dunyo')).toBe(
        STAFF_UNKNOWN_COMMAND_TEXT,
      );
      expect(unknownTextReply(role, '/buyruq 1234567')).toBe(
        STAFF_UNKNOWN_COMMAND_TEXT,
      );
    }
    expect(unknownTextReply('courier', ORDER_TEXT)).toBe(
      STAFF_UNKNOWN_COMMAND_TEXT,
    );
    expect(STAFF_UNKNOWN_COMMAND_TEXT).not.toContain('/status');
  });

  it('⭐ admin akkauntiga ulangan Telegram buyurtma matni yuborsa — «faqat market yaratadi», AI chaqirilmaydi', async () => {
    const gateway = jest.fn();
    const ctx = makeRouter({ actor: staff('admin'), aiOrder: true, gateway });
    await ctx.router.dispatch('elchi', textUpdate(ORDER_TEXT));
    expect(sent(ctx)).toEqual([STAFF_AI_ORDER_TEXT]);
    expect(STAFF_AI_ORDER_TEXT).toContain("Telegram'ni ulash");
    expect(gateway).not.toHaveBeenCalled();
  });

  it('admin buyurtma rasmini yuborsa — o‘sha ko‘rsatma (ilgari jim edi)', async () => {
    const gateway = jest.fn();
    const ctx = makeRouter({
      actor: staff('superadmin'),
      aiOrder: true,
      gateway,
    });
    await ctx.router.dispatch('elchi', photoUpdate());
    expect(sent(ctx)).toEqual([STAFF_AI_ORDER_TEXT]);
    expect(gateway).not.toHaveBeenCalled();
  });

  it('kuryer rasmi — buyurtma ko‘rsatmasi emas', async () => {
    const ctx = makeRouter({ actor: { ...staff('courier') }, aiOrder: true });
    await ctx.router.dispatch('elchi', photoUpdate());
    expect(sent(ctx)).not.toContain(STAFF_AI_ORDER_TEXT);
  });

  it('⭐ market menyusi (/start) — bot orqali buyurtma ko‘rsatmasi', async () => {
    const ctx = makeRouter({ actor: marketActor('37') });
    await ctx.router.dispatch('elchi', textUpdate('/start'));
    expect(sent(ctx).at(-1)).toContain(MARKET_AI_ORDER_HINT);
    expect(sent(ctx).at(-1)).toContain('/status');
  });

  it('xodim menyusida buyurtma ko‘rsatmasi yo‘q', async () => {
    const ctx = makeRouter({ actor: staff('admin') });
    await ctx.router.dispatch('elchi', textUpdate('/start'));
    expect(sent(ctx).at(-1)).not.toContain(MARKET_AI_ORDER_HINT);
  });

  it("⭐ market Telegram'ni ulagan zahoti — «ulandi» va menyu (ko‘rsatma bilan)", async () => {
    const dm = {
      bindFromStart: jest.fn(() =>
        Promise.resolve({ ok: true, message: 'Telegram ulandi ✅' }),
      ),
      unbind: jest.fn(),
    };
    const ctx = makeRouter({ actor: marketActor('37'), dm });
    await ctx.router.dispatch('elchi', textUpdate('/start labc_x_y'));
    const texts = sent(ctx);
    expect(texts[0]).toBe('Telegram ulandi ✅');
    expect(texts[1]).toContain(MARKET_AI_ORDER_HINT);
  });

  it('xodim ulaganda — faqat «ulandi»; ulash xato bo‘lsa — menyu yo‘q', async () => {
    const ok = {
      bindFromStart: jest.fn(() =>
        Promise.resolve({ ok: true, message: 'Telegram ulandi ✅' }),
      ),
      unbind: jest.fn(),
    };
    const admin = makeRouter({ actor: staff('admin'), dm: ok });
    await admin.router.dispatch('elchi', textUpdate('/start labc_x_y'));
    expect(sent(admin)).toEqual(['Telegram ulandi ✅']);

    const failed = {
      bindFromStart: jest.fn(() =>
        Promise.resolve({ ok: false, message: 'Havola eskirgan' }),
      ),
      unbind: jest.fn(),
    };
    const market = makeRouter({ actor: marketActor('37'), dm: failed });
    await market.router.dispatch('elchi', textUpdate('/start labc_x_y'));
    expect(sent(market)).toEqual(['Havola eskirgan']);
  });
});
