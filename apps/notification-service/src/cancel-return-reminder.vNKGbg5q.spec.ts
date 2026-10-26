/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access */
import { Logger } from '@nestjs/common';
import { of } from 'rxjs';
import { Group_type } from '@app/common';
import { telegramBotApiStub } from '@app/common/notification/telegram-html-kit-spec';
import {
  buildCancelReturnEscalationPayload,
  buildCancelReturnReminderPayload,
} from '../../order-service/src/cancel-return/cancel-return-reminder';
import { BotOutboxService } from './bot/bot-outbox.service';
import { BotTransportService } from './bot/bot-transport.service';
import { NotificationServiceService } from './notification-service.service';
import { makeInbox, makeMemoryDedup } from './testing/inbox-kit-spec';

/**
 * vNKGbg5q (BG7) — order-service outbox'ga yozgan payload'ning oxirgi qadami:
 * `notification.dispatch` → market «bekor» guruhiga (`parse_mode: HTML`) va
 * admin navbatiga (rollar). Zanjir haqiqiy (`dispatch` → `relayTelegram` →
 * `sendNotification` → telegram_outbox → `BotTransportService`); faqat
 * `fetch` o'rnida Telegram Bot API emulyatori — HAQIQIY xabar YUBORILMAYDI.
 */
const MARKET = '37';
const CREATE_GROUP = '-1003700000001';
const CANCEL_GROUP = '-1003700000002';
const NOW = new Date('2026-10-26T05:00:00Z');
const DAY = 24 * 60 * 60 * 1000;

beforeEach(() => {
  jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());

function makeChain(
  options: { dedup?: object; identityClient?: { send: jest.Mock } } = {},
) {
  const api = telegramBotApiStub();
  const groups = [
    {
      id: '1',
      market_id: MARKET,
      group_type: Group_type.CREATE,
      group_id: CREATE_GROUP,
    },
    {
      id: '2',
      market_id: MARKET,
      group_type: Group_type.CANCEL,
      group_id: CANCEL_GROUP,
    },
  ];
  const tgMarketRepo = {
    find: jest.fn(({ where }: { where: Record<string, unknown> }) =>
      Promise.resolve(
        groups.filter(
          (group) =>
            group.market_id === where.market_id &&
            (!where.group_type || group.group_type === where.group_type),
        ),
      ),
    ),
  };
  const outboxRows: Array<Record<string, any>> = [];
  const outboxRepo = {
    insert: jest.fn((row: Record<string, unknown>) => {
      outboxRows.push({ ...row, id: String(outboxRows.length + 1) });
      return Promise.resolve({
        identifiers: [{ id: String(outboxRows.length) }],
      });
    }),
    update: jest.fn(
      ({ id }: { id: string }, patch: Record<string, unknown>) => {
        Object.assign(outboxRows[Number(id) - 1], patch);
        return Promise.resolve({ affected: 1 });
      },
    ),
  };
  const config = {
    get: (key: string) =>
      ({ TELEGRAM_BOT_TOKEN: '123456:TEST-bot-token' })[key],
  };
  const transport = new BotTransportService(config as never);
  transport.fetchImpl = api.fetchImpl;
  transport.sleep = () => Promise.resolve();
  const botOutbox = new BotOutboxService(
    outboxRepo as never,
    transport,
    { markInactive: jest.fn().mockResolvedValue(undefined) } as never,
    config as never,
  );
  const telegram = new NotificationServiceService(
    tgMarketRepo as never,
    {} as never,
    { log: jest.fn().mockResolvedValue(undefined) } as never,
    botOutbox,
    {} as never,
  );
  const relay = {
    sendNotification: jest.fn(
      (dto: Parameters<NotificationServiceService['sendNotification']>[0]) =>
        telegram.sendNotification(dto),
    ),
  };
  const inbox = makeInbox({ telegramService: relay, ...options });
  return { api, relay, outboxRows, ...inbox };
}

const order = (
  id: string,
  days: number,
  extra: Record<string, unknown> = {},
) => ({
  id,
  market_id: MARKET,
  stage: 'hq' as const,
  place_id: '1',
  place_name: 'Toshkent HQ',
  received_at: new Date(NOW.getTime() - days * DAY),
  ...extra,
});

describe('vNKGbg5q — D+3 eslatma marketning «bekor» guruhiga yetadi', () => {
  it('BITTA sendMessage CANCEL guruhiga (create emas), parse_mode=HTML, Telegram HTML qoidasiga mos; market inbox qatori', async () => {
    const chain = makeChain();
    const payload = buildCancelReturnReminderPayload(
      MARKET,
      [
        order('36', 9),
        order('41', 4),
        order('50', 3.2, {
          stage: 'branch',
          place_id: '10',
          place_name: 'Urgut <filiali> & Co',
        }),
      ],
      NOW,
    )!;

    const res: any = await chain.service.dispatch(payload as never);

    expect(chain.relay.sendNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        market_id: MARKET,
        group_type: Group_type.CANCEL,
        parse_mode: 'HTML',
        message: payload.telegram!.text,
      }),
    );
    expect(chain.api.calls).toHaveLength(1);
    const [call] = chain.api.calls;
    expect(call).toEqual(
      expect.objectContaining({ method: 'sendMessage', ok: true }),
    );
    expect(call.body).toEqual({
      chat_id: CANCEL_GROUP,
      text: payload.telegram!.text,
      parse_mode: 'HTML',
    });
    expect(call.plain).toContain('⏳ Qaytarishlaringiz markazda kutmoqda');
    expect(call.plain).toContain('• Urgut <filiali> & Co — 1 ta');
    expect(call.plain).toContain('posilkalarni olib keting.');
    expect(res.data.by_channel.telegram).toBe(1);

    const rows = [...chain.store.values()];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual(
      expect.objectContaining({
        recipient_id: MARKET,
        type: 'order.cancel_return_reminder',
        group_key: 'cancel_return:reminder:37',
        link: '/new-orders/cancelled/37',
      }),
    );
  });

  it('outbox qayta yetkazsa (ayni client_request_id) — ikkinchi xabar YO‘Q', async () => {
    const chain = makeChain({ dedup: makeMemoryDedup() });
    const payload = buildCancelReturnReminderPayload(
      MARKET,
      [order('36', 4)],
      NOW,
    )!;
    await chain.service.dispatch({ ...payload } as never);
    const again: any = await chain.service.dispatch({ ...payload } as never);
    expect(again.data.duplicate).toBe(true);
    expect(chain.api.calls).toHaveLength(1);
    expect(chain.store.size).toBe(1);
  });
});

describe('vNKGbg5q — D+7 eskalatsiya admin navbatiga', () => {
  it('admin + superadmin inbox qatori (kartadagi matn), Telegram guruhiga hech narsa ketmaydi', async () => {
    const identityClient = {
      send: jest.fn(() =>
        of({
          data: {
            items: [
              { id: '1', role: 'superadmin' },
              { id: '2', role: 'admin' },
            ],
            next_after_id: null,
          },
        }),
      ),
    };
    const chain = makeChain({ identityClient });
    const payload = buildCancelReturnEscalationPayload(order('36', 7.2), NOW)!;

    await chain.service.dispatch(payload as never);

    expect(identityClient.send).toHaveBeenCalledWith(
      expect.objectContaining({ cmd: 'identity.audience.resolve' }),
      expect.objectContaining({ roles: ['admin', 'superadmin'] }),
    );
    const rows = [...chain.store.values()];
    expect(rows.map((row) => row.recipient_id).sort()).toEqual(['1', '2']);
    for (const row of rows) {
      expect(row).toEqual(
        expect.objectContaining({
          type: 'order.cancel_return_escalated',
          priority: 'high',
          body: 'Buyurtma #EL-100036 markazda 7 kundan beri turibdi — market olib ketmadi',
          link: '/orders/edit/36',
          group_key: 'cancel_return:escalated:36',
        }),
      );
    }
    expect(chain.relay.sendNotification).not.toHaveBeenCalled();
    expect(chain.api.calls).toHaveLength(0);
  });
});
