import { Logger } from '@nestjs/common';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { makeRouter, textUpdate } from './testing/bot-kit-spec';

/**
 * ZlpXb4Wh — mavjud 2 bot BITTA `bot/` yadrosiga birlashtirildi (ega qarori:
 * bitta bot, bitta token):
 *  - eski NotificationBotUpdateService / OrderBotUpdateService provider'lari
 *    va fayllari yo'q;
 *  - telegraf / nestjs-telegraf / node-telegram-bot-api / grammy QO'SHILMAGAN;
 *  - `api.telegram.org` satri FAQAT bot-transport.service.ts da;
 *  - noto'g'ri `botSlug` → jim tashlanadi (log + 0 chiquvchi chaqiruv).
 */
const ROOT = join(__dirname, '../../../..');
const SRC = join(__dirname, '..');

const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    if (
      ['node_modules', 'dist', '.git', '.claude', 'coverage'].includes(name)
    ) {
      return [];
    }
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return walk(path);
    return /\.(ts|js|mjs|cjs)$/.test(name) ? [path] : [];
  });

describe('ZlpXb4Wh — yagona bot yadrosi', () => {
  it('⭐ notification-service.module da eski bot provider’lari YO‘Q, fayllar o‘chirilgan', () => {
    const moduleSrc = readFileSync(
      join(SRC, 'notification-service.module.ts'),
      'utf8',
    );
    expect(moduleSrc).not.toMatch(/NotificationBotUpdateService/);
    expect(moduleSrc).not.toMatch(/OrderBotUpdateService/);
    expect(moduleSrc).toMatch(/BotRouterService/);
    expect(moduleSrc).toMatch(/BotTransportService/);
    expect(existsSync(join(SRC, 'notification-bot.update.ts'))).toBe(false);
    expect(existsSync(join(SRC, 'order-bot.update.ts'))).toBe(false);
  });

  it('⭐ package.json da telegraf / nestjs-telegraf / node-telegram-bot-api / grammy YO‘Q', () => {
    const pkg = JSON.parse(
      readFileSync(join(ROOT, 'package.json'), 'utf8'),
    ) as Record<string, Record<string, string> | undefined>;
    const deps = Object.keys({
      ...pkg.dependencies,
      ...pkg.devDependencies,
      ...pkg.peerDependencies,
      ...pkg.optionalDependencies,
    });
    expect(
      deps.filter((dep) =>
        /^(telegraf|nestjs-telegraf|node-telegram-bot-api|grammy)$/.test(dep),
      ),
    ).toEqual([]);
  });

  it('⭐ `api.telegram.org` satri FAQAT bot-transport.service.ts da (apps/libs/scripts)', () => {
    const files = ['apps', 'libs', 'scripts'].flatMap((dir) =>
      walk(join(ROOT, dir)),
    );
    expect(files.length).toBeGreaterThan(100);
    const offenders = files
      .filter((file) => readFileSync(file, 'utf8').includes('api.telegram.org'))
      .map((file) => relative(ROOT, file))
      .filter(
        (file) =>
          file !==
            'apps/notification-service/src/bot/bot-transport.service.ts' &&
          file !== relative(ROOT, __filename),
      );
    expect(offenders).toEqual([]);
  });

  describe('noto‘g‘ri botSlug', () => {
    beforeEach(() => {
      jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    });
    afterEach(() => jest.restoreAllMocks());

    it.each(['other', '', 'ELCHI2', '../elchi'])(
      '⭐ %p — jim tashlanadi: log bor, 0 ta chiquvchi chaqiruv',
      async (slug) => {
        const ctx = makeRouter();
        const warn = jest.spyOn(Logger.prototype, 'warn');

        const result = await ctx.router.dispatch(slug, textUpdate('/start'));

        expect(result).toBe('ignored');
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('botSlug'));
        expect(ctx.outbox.send).not.toHaveBeenCalled();
        expect(ctx.transport.answerCallbackQuery).not.toHaveBeenCalled();
        expect(ctx.limiter.inbound).not.toHaveBeenCalled();
        expect(ctx.actors.resolve).not.toHaveBeenCalled();
      },
    );

    it('to‘g‘ri slug (katta-kichik harf farqsiz) — ishlanadi', async () => {
      const ctx = makeRouter();
      expect(await ctx.router.dispatch('Elchi', textUpdate('/start'))).toBe(
        'done',
      );
      expect(ctx.outbox.send).toHaveBeenCalledTimes(1);
    });
  });

  describe('inventarizatsiya: eski ikki botning har funksiyasi yangi yadroda', () => {
    beforeEach(() => {
      jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    });
    afterEach(() => jest.restoreAllMocks());

    const replyOf = (ctx: ReturnType<typeof makeRouter>) =>
      (ctx.outbox.send.mock.calls.at(-1) as unknown as [{ text: string }])?.[0]
        ?.text;

    it('notification-bot: /id (guruh) → Group ID', async () => {
      const ctx = makeRouter();
      await ctx.router.dispatch(
        'elchi',
        textUpdate('/id', {
          chatId: -1001234,
          chatType: 'supergroup',
          fromId: 5,
        }),
      );
      expect(replyOf(ctx)).toBe('Group ID: -1001234');
    });

    it('notification-bot: group_token-… (guruh) → connectGroupByTokenText', async () => {
      const ctx = makeRouter();
      await ctx.router.dispatch(
        'elchi',
        textUpdate('group_token-0123456789abcdef', {
          chatId: -1001234,
          chatType: 'group',
          fromId: 5,
        }),
      );
      expect(ctx.notifications.connectGroupByTokenText).toHaveBeenCalledWith(
        'group_token-0123456789abcdef',
        '-1001234',
      );
    });

    it('notification-bot: /start <token> va /stop (shaxsiy) → DM ulash/uzish', async () => {
      const dm = {
        bindFromStart: jest.fn().mockResolvedValue({ ok: true, message: 'ok' }),
        unbind: jest.fn().mockResolvedValue({ ok: true, message: 'off' }),
      };
      const ctx = makeRouter({ dm });
      await ctx.router.dispatch('elchi', textUpdate('/start labc_x_y'));
      await ctx.router.dispatch('elchi', textUpdate('/stop'));
      expect(dm.bindFromStart).toHaveBeenCalledWith('labc_x_y', '111');
      expect(dm.unbind).toHaveBeenCalledWith('111');
    });

    it('notification-bot: salom → Valeykum assalom!', async () => {
      const ctx = makeRouter();
      await ctx.router.dispatch('elchi', textUpdate('salom'));
      expect(replyOf(ctx)).toBe('Valeykum assalom!');
    });

    it('order-bot: /start (ulangan market) → WebApp tugmasi (tokensiz URL)', async () => {
      const ctx = makeRouter({
        actor: {
          user_id: '37',
          role: 'market',
          status: 'active',
          market_id: '37',
          region_id: null,
        },
        env: { ORDER_BOT_WEBAPP_URL: 'https://app.elchi.uz/bot' },
      });
      await ctx.router.dispatch('elchi', textUpdate('/start'));
      const sent = ctx.outbox.send.mock.calls.at(-1) as unknown as [
        {
          reply_markup?: {
            inline_keyboard: Array<Array<{ web_app?: { url: string } }>>;
          };
        },
      ];
      const url = sent[0].reply_markup?.inline_keyboard[0][0].web_app?.url;
      expect(url).toBe('https://app.elchi.uz/bot');
      expect(url).not.toContain('token=');
    });

    it('order-bot: tushunarsiz buyruq (shaxsiy) → yordam matni', async () => {
      const ctx = makeRouter();
      await ctx.router.dispatch('elchi', textUpdate('nimadir'));
      expect(replyOf(ctx)).toContain('/status');
    });
  });
});
