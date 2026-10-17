import { Logger } from '@nestjs/common';
import { COURIER_ACTIONS } from './courier-cards';
import {
  CourierScanSummaryService,
  SCAN_DONE_MAX_ORDERS,
} from './courier-scan-summary.service';
import {
  courierActor,
  fakeOrdersGateway,
  gatewayOrder,
  makeRouter,
  textUpdate,
} from '../testing/bot-kit-spec';

const rmqSendMock = jest.fn();
jest.mock('@app/common', () => {
  const actual = jest.requireActual<Record<string, unknown>>('@app/common');
  return {
    ...actual,
    rmqSend: (...args: unknown[]) => rmqSendMock(...args) as unknown,
  };
});

/**
 * MWYaqprw (backend qismi) — skan Mini App'i:
 *  - `/ishim` da "📷 Skaner" web_app tugmasi (URL'da token yo'q);
 *  - "✅ Tayyor" → botga "N ta buyurtma qabul qilindi" + "📋 Topshiriqlarim";
 *    son serverda: faqat shu kuryerda yo'lda turgan id'lar.
 */
beforeEach(() => {
  jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());

describe('MWYaqprw — "✅ Tayyor" xulosasi', () => {
  const make = () => {
    const dispatch = jest.fn().mockResolvedValue({});
    const moduleRef = { get: jest.fn(() => ({ dispatch })) };
    const service = new CourierScanSummaryService(
      {} as never,
      moduleRef as never,
    );
    return { service, dispatch };
  };

  beforeEach(() => {
    rmqSendMock.mockReset().mockResolvedValue({
      data: [{ id: '53' }, { id: '54' }],
      total: 2,
    });
  });

  it('⭐ faqat shu kuryerda yo‘lda turgan id’lar sanaladi; begona/o‘ylab topilgani hisobga kirmaydi', async () => {
    const { service, dispatch } = make();
    const res = await service.summarize({
      courier_id: '26',
      order_ids: ['53', '54', '54', '999'],
    });
    expect(rmqSendMock).toHaveBeenCalledWith(
      {},
      { cmd: 'order.find_all' },
      {
        query: {
          courier_ids: ['26'],
          status: ['on the road'],
          fetch_all: true,
        },
      },
      expect.any(Object),
    );
    expect(res).toEqual(
      expect.objectContaining({ data: { accepted: 2, ignored: 1 } }),
    );
    const [notification] = dispatch.mock.calls[0] as [Record<string, any>];
    expect(notification.recipient_id).toBe('26');
    expect(notification.channels).toEqual(['in_app', 'telegram']);
    expect(notification.body).toContain('✅ 2 ta buyurtma qabul qilindi.');
    expect(notification.body).toContain('1 tasi');
  });

  it('⭐ bildirishnoma turi katalogda (aks holda dispatch 400 qaytaradi)', async () => {
    const { service, dispatch } = make();
    await service.summarize({ courier_id: '26', order_ids: ['53'] });
    const [notification] = dispatch.mock.calls[0] as [Record<string, any>];
    const { isKnownNotificationType } =
      jest.requireActual<typeof import('@app/common')>('@app/common');
    expect(isKnownNotificationType(notification.type)).toBe(true);
  });

  it('⭐ xabarda "📋 Topshiriqlarim" — /ishim 1-sahifa (qayta bosiladigan) tugmasi', async () => {
    const { service, dispatch } = make();
    await service.summarize({ courier_id: '26', order_ids: ['53'] });
    const [notification] = dispatch.mock.calls[0] as [Record<string, any>];
    expect(notification.body).toBe('✅ 1 ta buyurtma qabul qilindi.');
    expect(notification.data.telegram_buttons).toEqual([
      [
        {
          text: '📋 Topshiriqlarim',
          action: COURIER_ACTIONS.page,
          payload: { page: 1 },
          one_shot: false,
        },
      ],
    ]);
  });

  it('kuryer id yo‘q → 401; id’lar bo‘sh yoki chegaradan ko‘p → 400 (order-service chaqirilmaydi)', async () => {
    const { service, dispatch } = make();
    await expect(
      service.summarize({ courier_id: '', order_ids: ['1'] }),
    ).rejects.toMatchObject({ error: { statusCode: 401 } });
    await expect(
      service.summarize({ courier_id: '26', order_ids: ['abc'] }),
    ).rejects.toMatchObject({ error: { statusCode: 400 } });
    const tooMany = Array.from({ length: SCAN_DONE_MAX_ORDERS + 1 }, (_, i) =>
      String(i + 1),
    );
    await expect(
      service.summarize({ courier_id: '26', order_ids: tooMany }),
    ).rejects.toMatchObject({ error: { statusCode: 400 } });
    expect(rmqSendMock).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
  });
});

describe('MWYaqprw — /ishim dagi "📷 Skaner" tugmasi', () => {
  const SCAN_URL = 'https://admin.elchi.test/tg/scan';

  type Sent = {
    text?: string;
    reply_markup?: {
      inline_keyboard: Array<
        Array<{ text: string; web_app?: { url: string } }>
      >;
    };
  };
  const sent = (ctx: { outbox: { send: jest.Mock } }) =>
    (ctx.outbox.send.mock.calls as unknown as Array<[Sent]>).map(([m]) => m);

  it('⭐ URL sozlangan: ro‘yxat sarlavhasida web_app tugmasi, URL’da token YO‘Q', async () => {
    const gateway = fakeOrdersGateway([gatewayOrder('101', 'waiting')]);
    const ctx = makeRouter({
      actor: courierActor('25'),
      gateway: gateway.request,
      env: { TELEGRAM_SCAN_WEBAPP_URL: SCAN_URL },
    });
    await ctx.router.dispatch('elchi', textUpdate('/ishim', { chatId: 25 }));
    const [summary] = sent(ctx);
    expect(summary.text).toContain('Topshiriqlar');
    expect(summary.reply_markup?.inline_keyboard).toEqual([
      [{ text: '📷 Skaner', web_app: { url: SCAN_URL } }],
    ]);
    expect(SCAN_URL).not.toMatch(/token|\?/);
  });

  it('faol topshiriq yo‘q bo‘lsa ham tugma bor (kun boshida skan qilinadi)', async () => {
    const gateway = fakeOrdersGateway([]);
    const ctx = makeRouter({
      actor: courierActor('25'),
      gateway: gateway.request,
      env: { TELEGRAM_SCAN_WEBAPP_URL: SCAN_URL },
    });
    await ctx.router.dispatch('elchi', textUpdate('/ishim', { chatId: 25 }));
    const [only] = sent(ctx);
    expect(only.text).toContain("faol topshiriq yo'q");
    expect(only.reply_markup?.inline_keyboard?.[0]?.[0]?.web_app?.url).toBe(
      SCAN_URL,
    );
  });

  it('URL sozlanmagan yoki https emas → tugma chiqmaydi', async () => {
    for (const env of [{}, { TELEGRAM_SCAN_WEBAPP_URL: 'http://x.test/tg' }]) {
      const gateway = fakeOrdersGateway([gatewayOrder('101', 'waiting')]);
      const ctx = makeRouter({
        actor: courierActor('25'),
        gateway: gateway.request,
        env,
      });
      await ctx.router.dispatch('elchi', textUpdate('/ishim', { chatId: 25 }));
      const webApps = sent(ctx).flatMap(
        (m) =>
          m.reply_markup?.inline_keyboard.flat().filter((b) => b.web_app) ?? [],
      );
      expect(webApps).toEqual([]);
    }
  });
});
