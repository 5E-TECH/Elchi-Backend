import { of } from 'rxjs';
import { NotificationCategory, NotificationPriority } from '@app/common';
import { ChannelPlannerService } from './channels/channel-planner.service';
import { DispatchNotificationDto } from './dto/dispatch-notification.dto';
import { NotificationEscalationService } from './escalation/notification-escalation.service';
import { NotificationInboxService } from './notification-inbox.service';
import { NotificationPreferencesService } from './preferences/notification-preferences.service';

const rmqSendMock = jest.fn();

jest.mock('@app/common', () => {
  const actual = jest.requireActual('@app/common');
  return {
    ...actual,
    rmqSend: (...args: unknown[]) => rmqSendMock(...args),
  };
});

/**
 * Dispatch ↔ sozlamalar / kanal rejasi / eskalatsiya (mP1WGG1W TC4/5/12,
 * 7Ec56EIw TC5/6/7/9/12, Jht84wGp TC2/TC3) — haqiqiy planner va sozlamalar
 * servisi, faqat repozitoriylar mock.
 */
describe('NotificationInboxService — sozlamalar va kanal rejasi', () => {
  let store: Map<string, any>;
  let prefRows: Array<Record<string, unknown>>;
  let prefQb: any;
  let subsRows: Array<{ user_id: string }>;
  let pushDelivery: any;
  let smsDispatch: any;
  let outbox: any;
  let gatewayClient: any;
  let telegramService: any;
  let txRepo: any;
  let service: NotificationInboxService;
  let transaction: jest.Mock;

  const valuesOf = (operator: any): string[] =>
    (operator?.value ?? operator ?? []).map(String);

  beforeEach(() => {
    rmqSendMock.mockReset();
    store = new Map();
    prefRows = [];
    subsRows = [];
    let nextId = 100;
    txRepo = {
      create: jest.fn((v) => ({ ...v })),
      insert: jest.fn((rows: any[]) =>
        Promise.resolve({
          identifiers: rows.map((row) => {
            const id = String(nextId++);
            store.set(id, { id, ...row });
            return { id };
          }),
        }),
      ),
      update: jest.fn(),
      find: jest.fn(({ where }: any) =>
        Promise.resolve(
          valuesOf(where.id)
            .map((id) => store.get(id))
            .filter(Boolean),
        ),
      ),
    };
    const manager = { getRepository: jest.fn(() => txRepo) };
    transaction = jest.fn((work: (m: unknown) => Promise<unknown>) =>
      work(manager),
    );
    const repo: any = {
      manager: { transaction },
      createQueryBuilder: jest.fn(() => {
        const qb: any = {
          update: jest.fn(() => qb),
          set: jest.fn(() => qb),
          setParameter: jest.fn(() => qb),
          whereInIds: jest.fn(() => qb),
          execute: jest.fn().mockResolvedValue({ affected: 1 }),
        };
        return qb;
      }),
    };

    prefQb = {
      select: jest.fn(() => prefQb),
      addSelect: jest.fn(() => prefQb),
      where: jest.fn(() => prefQb),
      andWhere: jest.fn(() => prefQb),
      getRawMany: jest.fn(() => Promise.resolve(prefRows)),
    };
    const preferences = new NotificationPreferencesService({
      createQueryBuilder: jest.fn(() => prefQb),
    } as any);
    const subsQb: any = {
      select: jest.fn(() => subsQb),
      where: jest.fn(() => subsQb),
      getRawMany: jest.fn(() => Promise.resolve(subsRows)),
    };
    smsDispatch = {
      assertFanout: jest.fn(),
      contacts: jest.fn().mockResolvedValue(
        new Map([
          ['42', { id: '42', phone_number: '+998901234567' }],
          ['43', { id: '43', phone_number: null }],
        ]),
      ),
      queueForNotifications: jest.fn((rows: any[]) =>
        Promise.resolve({ sms: rows.length, sms_status: 'queued' }),
      ),
    };
    const smsConfig = { enabled: true };
    const planner = new ChannelPlannerService(
      preferences,
      { createQueryBuilder: jest.fn(() => subsQb) } as any,
      { enabled: true } as any,
      smsConfig as any,
      smsDispatch,
    );
    outbox = { enqueue: jest.fn().mockResolvedValue({}) };
    const escalation = new NotificationEscalationService(
      { get: jest.fn(() => 10) } as any,
      outbox,
      {} as any,
      smsDispatch,
      smsConfig as any,
    );
    pushDelivery = { enqueue: jest.fn().mockResolvedValue(undefined) };
    gatewayClient = { emit: jest.fn(() => of(null)) };
    telegramService = {
      sendNotification: jest
        .fn()
        .mockResolvedValue({ data: { success: 1, failed: 0 } }),
    };
    service = new NotificationInboxService(
      repo,
      { send: jest.fn() } as any,
      gatewayClient,
      telegramService,
      { log: jest.fn().mockResolvedValue(undefined) } as any,
      pushDelivery,
      smsDispatch,
      planner,
      escalation,
    );
  });

  const dispatch = (dto: Partial<DispatchNotificationDto>) =>
    service.dispatch({ title: 'Sarlavha', ...dto } as DispatchNotificationDto);

  it('mP1WGG1W TC4/TC12: marketing — rozilik yo‘q → hech kim tushmaydi; 400 EMAS, skipped_by_preference', async () => {
    const res: any = await dispatch({
      recipient_ids: ['42', '43'],
      type: 'marketing.promo',
    });
    expect(res.statusCode).toBe(201);
    expect(res.data.dispatched).toBe(0);
    expect(res.data.skipped_by_preference).toBe(2);
    expect(res.message).toMatch(/preferences/);
    expect(transaction).not.toHaveBeenCalled();
    expect(gatewayClient.emit).not.toHaveBeenCalled();
  });

  it('mP1WGG1W TC4: marketing — rozilik bergani tushadi, bermagani yo‘q', async () => {
    prefRows = [
      { user_id: '43', scope: 'marketing', channel: 'all', enabled: true },
    ];
    const res: any = await dispatch({
      recipient_ids: ['42', '43'],
      type: 'marketing.promo',
    });
    expect(res.data.recipient_ids).toEqual(['43']);
    expect(res.data.skipped_by_preference).toBe(1);
  });

  it('mP1WGG1W TC5 + 7Ec56EIw TC5: xodim xabari default yoqiq; realtime o‘chirgan qatorga emit yo‘q, delivery.realtime=skipped', async () => {
    prefRows = [
      { user_id: '43', scope: 'order', channel: 'realtime', enabled: false },
    ];
    const res: any = await dispatch({
      recipient_ids: ['42', '43'],
      type: 'order.sold',
      data: { order_id: 1 },
    });
    expect(res.data.dispatched).toBe(2);
    const inserted = txRepo.insert.mock.calls[0][0];
    const by = (id: string) => inserted.find((r: any) => r.recipient_id === id);
    expect(by('42').delivery).toEqual({ in_app: 'sent', realtime: 'pending' });
    expect(by('43').delivery).toEqual({
      in_app: 'sent',
      realtime: 'skipped',
      realtime_reason: 'muted',
    });
    expect(gatewayClient.emit).toHaveBeenCalledTimes(1);
    expect(gatewayClient.emit.mock.calls[0][1]).toEqual(
      expect.objectContaining({ user_id: '42' }),
    );
    // Sozlama filtri — BITTA so'rov.
    expect(prefQb.getRawMany).toHaveBeenCalledTimes(1);
  });

  it('Jht84wGp TC2/TC3: push faqat obunasi borlarga navbatga; obunasiz → no_subscription (outbox hodisasi yo‘q)', async () => {
    subsRows = [{ user_id: '42' }];
    const res: any = await dispatch({
      recipient_ids: ['42', '43'],
      type: 'order.manual',
      channels: ['in_app', 'push'],
    } as any);
    const inserted = txRepo.insert.mock.calls[0][0];
    expect(inserted.map((r: any) => r.delivery.push)).toEqual([
      'queued',
      'no_subscription',
    ]);
    const [, ids] = pushDelivery.enqueue.mock.calls[0];
    expect(ids).toEqual(['100']);
    expect(res.data.by_channel.push).toBe(1);
  });

  it('7Ec56EIw TC7: telefoni yo‘q — delivery.sms=not_eligible va SMS servisiga bormaydi', async () => {
    const res: any = await dispatch({
      recipient_ids: ['42', '43'],
      type: 'order.manual',
      channels: ['in_app', 'sms'],
    } as any);
    const inserted = txRepo.insert.mock.calls[0][0];
    expect(inserted[1].delivery).toEqual({
      in_app: 'sent',
      sms: 'not_eligible',
      sms_reason: 'no_phone',
    });
    const [rows] = smsDispatch.queueForNotifications.mock.calls[0];
    expect(rows.map((r: any) => r.recipient_id)).toEqual(['42']);
    expect(res.data.delivery).toEqual(
      expect.objectContaining({
        sms: 1,
        sms_status: 'partial',
        sms_skipped: 1,
      }),
    );
  });

  it('7Ec56EIw TC6: telegram guruhi ulanmagan — delivery.telegram=not_eligible', async () => {
    const { RpcException } = jest.requireActual('@nestjs/microservices');
    telegramService.sendNotification.mockRejectedValue(
      new RpcException({ statusCode: 404, message: 'not found' }),
    );
    await dispatch({
      recipient_id: '42',
      type: 'order.cancelled',
      data: { order_id: 5 },
      telegram: { market_id: '5' },
    } as any);
    const recordQb = (service as any).repo.createQueryBuilder.mock.results
      .map((r: any) => r.value)
      .find((qb: any) => qb.setParameter.mock.calls.length);
    const patch = JSON.parse(recordQb.setParameter.mock.calls[0][1]);
    expect(patch).toEqual(
      expect.objectContaining({
        telegram: 'not_eligible',
        telegram_error: 'no_telegram_group',
      }),
    );
  });

  it('7Ec56EIw TC9/TC12: critical — eskalatsiya dispatch tranzaksiyasida outbox scheduledAt (now+N) bilan', async () => {
    const before = Date.now();
    await dispatch({
      recipient_id: '42',
      type: 'x.security.alert',
      priority: NotificationPriority.CRITICAL,
      category: NotificationCategory.ACCOUNT,
    });
    const inserted = txRepo.insert.mock.calls[0][0];
    expect(inserted[0].delivery).toEqual(
      expect.objectContaining({
        escalation: 'scheduled',
        escalation_due_at: expect.any(String),
      }),
    );
    const call = outbox.enqueue.mock.calls.find(
      (c: any[]) => c[1] === 'notification.escalate',
    );
    expect(call[2]).toEqual({ notification_ids: ['100'] });
    expect(call[3].manager).toBeDefined();
    expect(call[3].scheduledAt.getTime()).toBeGreaterThanOrEqual(
      before + 10 * 60_000,
    );
  });

  it('critical emas — eskalatsiya rejalashtirilmaydi', async () => {
    await dispatch({ recipient_id: '42', type: 'x.info' });
    expect(outbox.enqueue).not.toHaveBeenCalled();
    expect(
      txRepo.insert.mock.calls[0][0][0].delivery.escalation,
    ).toBeUndefined();
  });
});
