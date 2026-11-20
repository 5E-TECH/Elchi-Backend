import { Logger } from '@nestjs/common';
import { NotificationDeliveryStatus } from '@app/common';
import { NotificationInboxService } from '../notification-inbox.service';
import {
  MEDIA_CAPTION_SAFE_CHARS,
  TelegramDmService,
  telegramFileName,
} from './telegram-dm.service';

const rmqSendMock = jest.fn();
jest.mock('@app/common', () => {
  const actual = jest.requireActual('@app/common');
  return { ...actual, rmqSend: (...args: unknown[]) => rmqSendMock(...args) };
});

const XLSX =
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/**
 * Smena hisoboti: XABAR + EXCEL. Uzun matn (filial hisoboti) Telegram izohiga
 * (1024) sig'maydi — avval to'liq matn, keyin fayl qisqa izoh bilan; qisqa
 * matn (market) — fayl + izoh bitta postda. Filial guruhiga fayl — faqat
 * ichki dispatch'da.
 */
beforeEach(() => {
  jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  rmqSendMock.mockReset();
});
afterEach(() => jest.restoreAllMocks());

const makeDm = (body: string, data: Record<string, unknown>) => {
  const notifications = {
    query: jest.fn((sql: string) =>
      Promise.resolve(
        String(sql).includes('UPDATE')
          ? [{ id: '1', recipient_id: '501', title: 'Hisobot', body, data }]
          : [],
      ),
    ),
    createQueryBuilder: jest.fn(() => {
      const qb: Record<string, jest.Mock> = {};
      for (const name of ['update', 'set', 'setParameter', 'whereInIds']) {
        qb[name] = jest.fn(() => qb);
      }
      qb.execute = jest.fn().mockResolvedValue({});
      return qb;
    }),
  };
  const order: string[] = [];
  const telegram = {
    sendDirectToGroup: jest.fn(() => {
      order.push('text');
      return Promise.resolve({ result: { message_id: 900 } });
    }),
  };
  const transport = {
    sendMedia: jest.fn(() => {
      order.push('file');
      return Promise.resolve(777);
    }),
  };
  rmqSendMock.mockImplementation(
    (_client: unknown, pattern: { cmd?: string }) =>
      Promise.resolve(
        pattern?.cmd === 'identity.telegram.resolve_many'
          ? { data: { '501': '5550501' } }
          : {
              data: {
                body_base64: Buffer.from('xlsx').toString('base64'),
                mime_type: XLSX,
              },
            },
      ),
  );
  const dm = new TelegramDmService(
    notifications as never,
    { enqueue: jest.fn() } as never,
    {
      contacts: jest.fn(() => new Map([['501', { telegram_id: '5550501' }]])),
    } as never,
    telegram as never,
    { get: (key: string) => ({ TELEGRAM_BOT_TOKEN: 'x:y' })[key] } as never,
    {} as never,
    {} as never,
    { create: jest.fn(), attachMessage: jest.fn() } as never,
    transport as never,
    {} as never,
  );
  return { dm, telegram, transport, order };
};

const KEY =
  'shift-report-1763650000000-0f8fad5b-d9cb-469f-a165-70867728950e-smena-77-hisobot.xlsx';

describe('smena hisoboti — xabar + Excel (shaxsiy chat)', () => {
  it('⭐ uzun matn: avval TO‘LIQ matn, keyin Excel qisqa izoh bilan', async () => {
    const body = 'x'.repeat(MEDIA_CAPTION_SAFE_CHARS + 200);
    const { dm, telegram, transport, order } = makeDm(body, {
      telegram_media: [KEY],
      telegram_media_caption: "📎 To'liq hisobot (Excel)",
    });
    await dm.deliver({ notification_ids: ['1'] });
    expect(order).toEqual(['text', 'file']);
    expect(telegram.sendDirectToGroup).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining(body) }),
    );
    expect(transport.sendMedia).toHaveBeenCalledWith(
      '5550501',
      [expect.objectContaining({ mime: XLSX, name: 'smena-77-hisobot.xlsx' })],
      expect.objectContaining({ caption: "📎 To'liq hisobot (Excel)" }),
    );
  });

  it('qisqa matn (market): Excel + matn izohda BITTA postda', async () => {
    const { dm, telegram, transport } = makeDm("Sizga to'lovlar: 100 000", {
      telegram_media: [KEY],
    });
    await dm.deliver({ notification_ids: ['1'] });
    expect(telegram.sendDirectToGroup).not.toHaveBeenCalled();
    expect(transport.sendMedia).toHaveBeenCalledWith(
      '5550501',
      [expect.objectContaining({ mime: XLSX })],
      expect.objectContaining({
        caption: expect.stringContaining("Sizga to'lovlar"),
      }),
    );
  });

  it('telegramFileName — file-service prefiksi olib tashlanadi', () => {
    expect(telegramFileName(KEY)).toBe('smena-77-hisobot.xlsx');
    expect(telegramFileName('proof-1')).toBe('proof-1');
  });
});

describe('smena hisoboti — filial guruhiga Excel (relay)', () => {
  const setup = () => {
    const service = Object.create(NotificationInboxService.prototype) as Record<
      string,
      unknown
    >;
    const sendFiles = jest.fn().mockResolvedValue(true);
    const activeBranchGroupChats = jest.fn().mockResolvedValue(['-100777']);
    Object.assign(service, {
      telegramDm: { sendFiles },
      telegramService: { activeBranchGroupChats },
      repo: { manager: {} },
      logger: { warn: jest.fn() },
    });
    const relay = (dto: Record<string, unknown>, status: string) =>
      (
        service as unknown as {
          relayGroupFiles: (d: unknown, o: unknown) => Promise<void>;
        }
      ).relayGroupFiles(dto, { telegram: status });
    return { relay, sendFiles, activeBranchGroupChats };
  };
  const dto = {
    telegram: { branch_id: '12', text: 'hisobot' },
    data: {
      telegram_media: [KEY],
      telegram_media_caption: "📎 To'liq hisobot (Excel)",
    },
  };

  it('⭐ ichki dispatch (finance), matn yuborilgan — Excel guruhga', async () => {
    const fx = setup();
    await fx.relay(dto, NotificationDeliveryStatus.SENT);
    expect(fx.activeBranchGroupChats).toHaveBeenCalledWith({}, '12');
    expect(fx.sendFiles).toHaveBeenCalledWith(
      '-100777',
      [KEY],
      "📎 To'liq hisobot (Excel)",
    );
  });

  it('HTTP (requester bor), market guruhi yoki matn yuborilmagan — fayl YO‘Q', async () => {
    const fx = setup();
    await fx.relay(
      { ...dto, requester: { id: '1' } },
      NotificationDeliveryStatus.SENT,
    );
    await fx.relay(
      { ...dto, telegram: { market_id: '601', text: 'x' } },
      NotificationDeliveryStatus.SENT,
    );
    await fx.relay(dto, NotificationDeliveryStatus.FAILED);
    expect(fx.sendFiles).not.toHaveBeenCalled();
  });
});
