import { RpcException } from '@nestjs/microservices';
import { Logger } from '@nestjs/common';
import { of, throwError, TimeoutError } from 'rxjs';
import { NotificationInboxService } from './notification-inbox.service';

const rmqSendMock = jest.fn();

jest.mock('@app/common', () => {
  const actual = jest.requireActual('@app/common');
  return {
    ...actual,
    rmqSend: (...args: any[]) => rmqSendMock(...args),
  };
});

/**
 * uFmUS86e — kanal natijasi `delivery` ga (jim muvaffaqiyat yo'q);
 * QFoRULeu — bulk INSERT + rol/broadcast uchun BITTA realtime emit;
 * Eh8y21Ha — `type` reyestr validatsiyasi va katalog sukutlari (servis qatlami).
 */
describe('NotificationInboxService — delivery, fan-out, types', () => {
  let service: NotificationInboxService;
  let store: Map<string, any>;
  let txRepo: any;
  let repo: any;
  let gatewayClient: any;
  let telegramService: any;
  let activityLog: any;
  let pushDelivery: any;
  let smsDispatch: any;
  /** recordDelivery'ning har UPDATE'i: { patch, ids }. */
  let deliveryUpdates: Array<{ patch: Record<string, unknown>; ids: string[] }>;

  const valuesOf = (operator: any): string[] =>
    (operator?.value ?? operator ?? []).map(String);

  const identityPage = (ids: string[], role?: string) => ({
    data: {
      items: ids.map((id) => ({ id, ...(role ? { role } : {}) })),
      meta: { total: ids.length },
    },
  });

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    rmqSendMock.mockReset();
    store = new Map();
    deliveryUpdates = [];
    let nextId = 100;
    txRepo = {
      create: jest.fn((v) => ({ ...v })),
      insert: jest.fn((rows: any[]) =>
        Promise.resolve({
          identifiers: rows.map((row) => {
            const id = String(nextId++);
            store.set(id, { id, isDeleted: false, ...row });
            return { id };
          }),
        }),
      ),
      update: jest.fn((where: any, patch: any) => {
        for (const id of valuesOf(where.id)) {
          store.set(id, { ...store.get(id), ...patch });
        }
        return Promise.resolve({ affected: valuesOf(where.id).length });
      }),
      find: jest.fn(({ where }: any) => {
        const rows = [...store.values()];
        if (where.id) {
          const ids = valuesOf(where.id);
          return Promise.resolve(
            rows.filter((row) => ids.includes(String(row.id))),
          );
        }
        const recipients = valuesOf(where.recipient_id);
        return Promise.resolve(
          rows.filter(
            (row) =>
              recipients.includes(String(row.recipient_id)) &&
              row.group_key === where.group_key &&
              !row.isDeleted,
          ),
        );
      }),
      findOne: jest.fn(),
    };
    const manager = { getRepository: jest.fn(() => txRepo) };
    repo = {
      findOne: jest.fn(),
      findAndCount: jest.fn(),
      count: jest.fn(),
      update: jest.fn(),
      save: jest.fn(),
      create: jest.fn((v) => v),
      createQueryBuilder: jest.fn(() => {
        const current: { patch: Record<string, unknown>; ids: string[] } = {
          patch: {},
          ids: [],
        };
        const qb: any = {
          update: jest.fn(() => qb),
          set: jest.fn(() => qb),
          setParameter: jest.fn((_: string, value: string) => {
            current.patch = JSON.parse(value);
            return qb;
          }),
          whereInIds: jest.fn((ids: string[]) => {
            current.ids = ids;
            return qb;
          }),
          execute: jest.fn(() => {
            deliveryUpdates.push(current);
            for (const id of current.ids) {
              const row = store.get(id);
              if (row)
                row.delivery = { ...(row.delivery ?? {}), ...current.patch };
            }
            return Promise.resolve({ affected: current.ids.length });
          }),
        };
        return qb;
      }),
      manager: {
        transaction: jest.fn((work: (m: any) => Promise<unknown>) =>
          work(manager),
        ),
      },
    };
    gatewayClient = { emit: jest.fn(() => of(null)) };
    telegramService = { sendNotification: jest.fn() };
    activityLog = { log: jest.fn().mockResolvedValue(undefined) };
    pushDelivery = { enqueue: jest.fn().mockResolvedValue(undefined) };
    smsDispatch = {
      assertFanout: jest.fn(),
      queueForNotifications: jest.fn(),
    };
    service = new NotificationInboxService(
      repo,
      { send: jest.fn() } as any,
      gatewayClient,
      telegramService,
      activityLog,
      pushDelivery,
      smsDispatch,
    );
  });

  afterEach(() => jest.restoreAllMocks());

  const rows = () => [...store.values()];
  const errorOf = async (promise: Promise<unknown>) =>
    promise.then(
      () => null,
      (err: unknown) => (err as RpcException).getError() as any,
    );

  // ==================== uFmUS86e ====================

  describe('uFmUS86e — kanal natijasi delivery ustunida', () => {
    it('boshlang‘ich delivery: in_app=sent, so‘ralgan kanal pending, email=no_provider (logda emas, DBda)', async () => {
      telegramService.sendNotification.mockResolvedValue({
        data: { success: 1, failed: 0, results: [{ ok: true }] },
      });
      await service.dispatch({
        recipient_id: '42',
        type: 'x.test',
        title: 't',
        channels: ['in_app', 'realtime', 'telegram', 'email'],
        telegram: { market_id: '5' },
      } as any);
      const inserted = txRepo.insert.mock.calls[0][0][0];
      expect(inserted.delivery).toEqual({
        in_app: 'sent',
        realtime: 'pending',
        telegram: 'pending',
        email: 'no_provider',
      });
    });

    it('TC1/TC5/TC6/TC7: faqat sms, provayder yo‘q → no_provider ro‘yxati, by_channel, javobda "dispatched"/"sent" YO‘Q', async () => {
      smsDispatch.queueForNotifications.mockResolvedValue({
        sms: 0,
        sms_status: 'no_provider',
        sms_reason: 'provider_not_configured',
      });
      const res = await service.dispatch({
        recipient_ids: ['42', '43'],
        type: 'x.otp',
        title: 'Kod',
        channels: ['sms'],
      } as any);

      expect(res.statusCode).toBe(201);
      expect(res.data.by_channel).toEqual({ in_app: 2, sms: 0 });
      expect(res.data.no_provider).toEqual(['sms']);
      expect(res.message).not.toMatch(/dispatched/i);
      expect(JSON.stringify(res)).not.toMatch(/\bsent\b/i);
      // SMS natijasi qatorga SmsDispatchService orqali shu tranzaksiyada yoziladi.
      expect(smsDispatch.queueForNotifications).toHaveBeenCalledWith(
        expect.any(Array),
        expect.objectContaining({ getRepository: expect.any(Function) }),
      );
      expect(txRepo.insert.mock.calls[0][0][0].delivery).toEqual({
        in_app: 'sent',
        sms: 'pending',
      });
    });

    it('TC2/TC9: in_app+realtime → delivery.realtime "emitted" (ack yo‘q — "sent" EMAS), hech qachon pending qolmaydi; 40 qator = BITTA UPDATE', async () => {
      const recipient_ids = Array.from({ length: 40 }, (_, i) => String(i + 1));
      const res = await service.dispatch({
        recipient_ids,
        type: 'order.sold',
        title: 'Sotildi',
      } as any);

      expect(deliveryUpdates).toHaveLength(1);
      expect(deliveryUpdates[0].patch).toEqual({ realtime: 'emitted' });
      expect(deliveryUpdates[0].ids).toHaveLength(40);
      rows().forEach((row) => {
        expect(row.delivery.realtime).toBe('emitted');
        expect(row.delivery.realtime).not.toBe('pending');
      });
      expect(res.data.by_channel).toEqual({ in_app: 40, realtime: 40 });
      expect(res.message).toBe('Notification dispatched');
      // sikl ichida save YO'Q
      expect(repo.save).not.toHaveBeenCalled();
    });

    it('TC3: realtime emit 2 s timeoutga tushsa delivery.realtime=failed + qisqa realtime_error', async () => {
      gatewayClient.emit.mockReturnValue(throwError(() => new TimeoutError()));
      const res = await service.dispatch({
        recipient_id: '42',
        type: 'order.sold',
        title: 'Sotildi',
      } as any);

      expect(deliveryUpdates).toHaveLength(1);
      expect(deliveryUpdates[0].patch.realtime).toBe('failed');
      expect(String(deliveryUpdates[0].patch.realtime_error)).toMatch(
        /timeout/i,
      );
      expect(
        String(deliveryUpdates[0].patch.realtime_error).length,
      ).toBeLessThanOrEqual(200);
      expect(res.message).toBe(
        'Saved to inbox only — no external channel delivered',
      );
    });

    it('TC4/TC8: Telegram relay yiqilsa delivery.telegram=failed + sabab ≤200 belgi, telefon maskalangan, xom javob yo‘q', async () => {
      const longError = `Bad Request: chat not found for +998901234567 ${'x'.repeat(400)}`;
      telegramService.sendNotification.mockResolvedValue({
        data: {
          total: 1,
          success: 0,
          failed: 1,
          results: [{ ok: false, error: longError }],
        },
      });
      const res = await service.dispatch({
        recipient_id: '42',
        type: 'order.cancelled',
        title: 'Bekor',
        channels: ['in_app', 'telegram'],
        telegram: { market_id: '5', group_type: 'cancel' },
      } as any);

      const patch = deliveryUpdates[0].patch;
      expect(patch.telegram).toBe('failed');
      const reason = String(patch.telegram_error);
      expect(reason.length).toBeLessThanOrEqual(200);
      expect(reason).not.toContain('901234567');
      expect(reason).toContain('chat not found');
      expect(res.data.by_channel.telegram).toBe(0);
    });

    it('Telegram: marketda guruh yo‘q (404) → not_eligible; nishon berilmasa → not_eligible', async () => {
      telegramService.sendNotification.mockRejectedValue(
        new RpcException({
          statusCode: 404,
          message: 'Telegram target group not found for market',
        }),
      );
      await service.dispatch({
        recipient_id: '42',
        type: 'order.cancelled',
        title: 'Bekor',
        channels: ['in_app', 'telegram'],
        telegram: { market_id: '5' },
      } as any);
      expect(deliveryUpdates[0].patch).toEqual({
        telegram: 'not_eligible',
        telegram_error: 'no_telegram_group',
      });

      deliveryUpdates = [];
      await service.dispatch({
        recipient_id: '43',
        type: 'order.cancelled',
        title: 'Bekor',
        channels: ['in_app', 'telegram'],
      } as any);
      expect(deliveryUpdates[0].patch).toEqual({
        telegram: 'not_eligible',
        telegram_error: 'telegram_target_missing',
      });
      expect(telegramService.sendNotification).toHaveBeenCalledTimes(1);
    });

    it('Telegram muvaffaqiyat → sent; token payload’dan uzatilmaydi; matn HTML-escape (n0kLbx3d / OA16fdSq)', async () => {
      telegramService.sendNotification.mockResolvedValue({
        data: { success: 1, failed: 0, results: [{ ok: true }] },
      });
      const res = await service.dispatch({
        recipient_id: '42',
        type: 'x.test',
        title: 'A & <B>',
        body: 'c < d',
        channels: ['in_app', 'telegram'],
        telegram: { market_id: '5', token: 'EVIL:TOKEN' },
      } as any);

      const arg = telegramService.sendNotification.mock.calls[0][0];
      expect(arg).not.toHaveProperty('token');
      expect(arg.parse_mode).toBe('HTML');
      expect(arg.message).toBe('A &amp; &lt;B&gt;\n\nc &lt; d');
      expect(deliveryUpdates[0].patch).toEqual({
        telegram: 'sent',
        telegram_sent: 1,
      });
      expect(res.data.by_channel.telegram).toBe(1);
    });

    it('Qisman: realtime ketdi, email provayderi yo‘q → "Partially dispatched", no_provider=[email]', async () => {
      const res = await service.dispatch({
        recipient_id: '42',
        type: 'system.announcement',
        title: 'E’lon',
        channels: ['in_app', 'realtime', 'email'],
      } as any);
      expect(res.message).toBe('Partially dispatched');
      expect(res.data.no_provider).toEqual(['email']);
      expect(res.data.by_channel).toEqual({ in_app: 1, realtime: 1, email: 0 });
    });

    it('TC12: inbox javobida `delivery` maydoni (qo‘shimcha) — eski maydonlar o‘zgarmagan', async () => {
      repo.findAndCount.mockResolvedValue([
        [
          {
            id: '1',
            recipient_id: '42',
            type: 'order.sold',
            title: 't',
            is_read: false,
            createdAt: new Date(0),
            delivery: { in_app: 'sent', realtime: 'emitted' },
          },
        ],
        1,
      ]);
      repo.count.mockResolvedValue(1);
      const res = await service.list({ recipient_id: '42' } as any);
      const item = res.data.items[0];
      expect(item.delivery).toEqual({ in_app: 'sent', realtime: 'emitted' });
      expect(Object.keys(item)).toEqual(
        expect.arrayContaining([
          'id',
          'recipient_id',
          'type',
          'category',
          'priority',
          'title',
          'body',
          'data',
          'link',
          'is_read',
          'read_at',
          'created_at',
        ]),
      );
      expect(res.data).toEqual(
        expect.objectContaining({ unread: 1, meta: expect.any(Object) }),
      );
    });

    it('delivery yozuvi yiqilsa ham dispatch javobi qaytadi (best-effort)', async () => {
      repo.createQueryBuilder.mockImplementation(() => {
        throw new Error('db down');
      });
      const res = await service.dispatch({
        recipient_id: '42',
        type: 'order.sold',
        title: 'Sotildi',
      } as any);
      expect(res.statusCode).toBe(201);
    });
  });

  // ==================== QFoRULeu ====================

  describe('QFoRULeu — bulk INSERT va bitta realtime emit', () => {
    it('TC2: 1000 qabul qiluvchi — INSERT chunk soni (2 ta × 500), 1000 ta emas', async () => {
      const recipient_ids = Array.from({ length: 1000 }, (_, i) =>
        String(i + 1),
      );
      const res = await service.dispatch({
        recipient_ids,
        type: 'system.announcement',
        title: 'E’lon',
        channels: ['in_app'],
      } as any);
      expect(res.data.dispatched).toBe(1000);
      expect(txRepo.insert).toHaveBeenCalledTimes(2);
      expect(txRepo.insert.mock.calls[0][0]).toHaveLength(500);
    });

    it('TC3/TC4: group_key bilan sikl ichida findOne YO‘Q (bitta IN so‘rovi); ikkinchi dispatch qator sonini oshirmaydi', async () => {
      const recipient_ids = ['1', '2', '3'];
      const payload = {
        recipient_ids,
        type: 'order.accepted',
        title: 'Qabul qilindi',
        data: { order_id: '81' },
        channels: ['in_app'],
      };
      await service.dispatch({ ...payload } as any);
      expect(rows()).toHaveLength(3);
      expect(rows()[0].group_key).toBe('order:81:status'); // katalogdan

      await service.dispatch({
        ...payload,
        type: 'order.sold',
        title: 'Sotildi',
      } as any);
      expect(rows()).toHaveLength(3);
      expect(rows().every((row) => row.type === 'order.sold')).toBe(true);
      expect(txRepo.findOne).not.toHaveBeenCalled();
      // har dispatch'da group_key qidiruvi — BITTA `find` (IN), qabul qiluvchi boshiga emas
      const groupLookups = txRepo.find.mock.calls.filter(
        ([opts]: any[]) => opts.where.group_key,
      );
      expect(groupLookups).toHaveLength(2);
      expect(valuesOf(groupLookups[0][0].where.recipient_id)).toEqual(
        recipient_ids,
      );
    });

    it('TC5: roles:["logist"] → BITTA realtime.notify emit `role` maydoni bilan (qabul qiluvchi boshiga emas)', async () => {
      rmqSendMock.mockResolvedValueOnce(
        identityPage(['101', '102', '103', '104']),
      );
      await service.dispatch({
        roles: ['logist'],
        type: 'system.announcement',
        title: 'E’lon',
      } as any);

      expect(gatewayClient.emit).toHaveBeenCalledTimes(1);
      expect(gatewayClient.emit).toHaveBeenCalledWith(
        { cmd: 'realtime.notify' },
        {
          event: 'notification:new',
          role: 'logist',
          payload: {
            type: 'system.announcement',
            category: 'system',
            priority: 'normal',
          },
        },
      );
      expect(deliveryUpdates).toHaveLength(1);
      expect(deliveryUpdates[0].ids).toHaveLength(4);
    });

    it('TC6: broadcast:true → BITTA emit `broadcast: true` bilan', async () => {
      rmqSendMock.mockResolvedValueOnce(
        identityPage(['101', '102', '103'], 'courier'),
      );
      await service.dispatch({
        broadcast: true,
        type: 'system.announcement',
        title: 'E’lon',
      } as any);
      expect(gatewayClient.emit).toHaveBeenCalledTimes(1);
      expect(gatewayClient.emit.mock.calls[0][1]).toEqual(
        expect.objectContaining({ event: 'notification:new', broadcast: true }),
      );
      expect(gatewayClient.emit.mock.calls[0][1]).not.toHaveProperty('user_id');
    });

    it('TC7: aniq recipient_ids — eski `user_id` emiti (to‘liq qator payload) saqlangan', async () => {
      await service.dispatch({
        recipient_ids: ['42', '43'],
        type: 'order.sold',
        title: 'Sotildi',
      } as any);
      expect(gatewayClient.emit).toHaveBeenCalledTimes(2);
      const users = gatewayClient.emit.mock.calls.map((call: any[]) => [
        call[1].user_id,
        call[1].payload.title,
      ]);
      expect(users).toEqual([
        ['42', 'Sotildi'],
        ['43', 'Sotildi'],
      ]);
    });

    it('TC8: MAX_FANOUT (5000) dan oshgan so‘rov 400 — jimgina kesilmaydi, hech narsa yozilmaydi', async () => {
      const err = await errorOf(
        service.dispatch({
          recipient_ids: Array.from({ length: 5001 }, (_, i) => String(i + 1)),
          type: 'marketing.promo',
          title: 'Promo',
        } as any),
      );
      expect(err).toEqual(
        expect.objectContaining({
          statusCode: 400,
          message: expect.stringContaining('fan-out cap exceeded'),
        }),
      );
      expect(txRepo.insert).not.toHaveBeenCalled();

      // rol orqali ham: identity 5001+ qaytarsa — 400 (ilgari 5000 da jim to'xtardi)
      const pages = Array.from({ length: 51 }, (_, page) =>
        identityPage(
          Array.from({ length: 100 }, (_, i) => String(page * 100 + i + 1)),
          'courier',
        ),
      );
      pages.forEach((page) => {
        page.data.meta.total = 6000;
        rmqSendMock.mockResolvedValueOnce(page);
      });
      const roleErr = await errorOf(
        service.dispatch({
          roles: ['courier'],
          type: 'marketing.promo',
          title: 'Promo',
        } as any),
      );
      expect(roleErr.statusCode).toBe(400);
      expect(txRepo.insert).not.toHaveBeenCalled();
    });

    it('TC10: bitta dispatch = BITTA audit qatori (notification.dispatched), kategoriya katalogdan', async () => {
      await service.dispatch({
        recipient_ids: Array.from({ length: 30 }, (_, i) => String(i + 1)),
        type: 'order.cancelled',
        title: 'Bekor',
        channels: ['in_app'],
      } as any);
      expect(activityLog.log).toHaveBeenCalledTimes(1);
      expect(activityLog.log.mock.calls[0][0]).toEqual(
        expect.objectContaining({
          action: 'notification.dispatched',
          metadata: expect.objectContaining({
            dispatched_count: 30,
            category: 'order',
          }),
        }),
      );
    });

    it.each([1, 100, 1000, 5000])(
      'TC1/TC9 (lokal unit o‘lchov, DB/RMQ mock): %i qabul qiluvchi',
      async (n) => {
        const recipient_ids = Array.from({ length: n }, (_, i) =>
          String(i + 1),
        );
        const started = Date.now();
        const res = await service.dispatch({
          recipient_ids,
          type: 'system.announcement',
          title: 'E’lon',
        } as any);
        const elapsed = Date.now() - started;
        process.stdout.write(
          `[QFoRULeu bench] n=${n} → ${elapsed} ms (inserts=${txRepo.insert.mock.calls.length}, emits=${gatewayClient.emit.mock.calls.length}, delivery UPDATEs=${deliveryUpdates.length})\n`,
        );
        expect(res.data.dispatched).toBe(n);
        expect(deliveryUpdates).toHaveLength(1);
        if (n === 1000) expect(elapsed).toBeLessThan(2000);
        if (n === 5000) expect(elapsed).toBeLessThan(8000);
      },
    );
  });

  // ==================== Eh8y21Ha (servis qatlami) ====================

  describe('Eh8y21Ha — servisda type validatsiyasi va katalog sukutlari', () => {
    it('TC4: reyestrda yo‘q tur → 400, xatoda `x.` prefiksi tushuntiriladi, hech narsa yozilmaydi', async () => {
      const err = await errorOf(
        service.dispatch({
          recipient_id: '42',
          type: 'asdf',
          title: 't',
        } as any),
      );
      expect(err.statusCode).toBe(400);
      expect(err.message).toContain('"x."');
      expect(txRepo.insert).not.toHaveBeenCalled();
    });

    it('TC5: `x.` prefiksli tur o‘tadi', async () => {
      const res = await service.dispatch({
        recipient_id: '42',
        type: 'x.bench',
        title: 't',
      } as any);
      expect(res.statusCode).toBe(201);
    });

    it('TC6/TC7/TC8: category/priority/group_key katalogdan; qattiq SYSTEM sukuti ishlatilmaydi', async () => {
      await service.dispatch({
        recipient_id: '42',
        type: 'order.cancelled',
        title: 'Bekor',
        data: { order_id: '7' },
        channels: ['in_app'],
      } as any);
      const row = rows()[0];
      expect(row.category).toBe('order');
      expect(row.priority).toBe('high');
      expect(row.group_key).toBe('order:7:status');
    });

    it('TC8: pattern o‘zgaruvchisi yetishmasa group_key UMUMAN yo‘q (null, bo‘sh satr emas)', async () => {
      await service.dispatch({
        recipient_id: '42',
        type: 'order.cancelled',
        title: 'Bekor',
        channels: ['in_app'],
      } as any);
      expect(rows()[0].group_key).toBeNull();
    });

    it('channels berilmasa katalogning default_channels i (order.cancelled → telegram ham so‘raladi)', async () => {
      const res = await service.dispatch({
        recipient_id: '42',
        type: 'order.cancelled',
        title: 'Bekor',
      } as any);
      expect(res.data.channels).toEqual(['in_app', 'realtime', 'telegram']);
    });

    it('TC9 (servis): notification.types.list — to‘liq katalog', () => {
      const res = service.listTypes();
      expect(res.statusCode).toBe(200);
      expect(res.data.items.length).toBeGreaterThanOrEqual(20);
      expect(res.data.free_prefix).toBe('x.');
    });
  });
});
