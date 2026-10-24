import { Logger } from '@nestjs/common';
import { RpcException } from '@nestjs/microservices';
import { of } from 'rxjs';
import { NotificationChannel } from '@app/common';
import { NotificationInboxService } from '../notification-inbox.service';
import { DispatchNotificationDto } from '../dto/dispatch-notification.dto';
import {
  DispatchHistoryService,
  UNDELIVERED_STATUSES,
  historyStatusFor,
} from './dispatch-history.service';

/**
 * 7Vozou5x — yuborilgan xabarlar tarixi (unit): dispatch ↔ tarix ulanishi.
 * Haqiqiy SQL (kanal × holat, yetkazilmaganlar) — dispatch-history.pg.spec.ts.
 */
describe('7Vozou5x — dispatch tarixi (unit)', () => {
  const CLIENT_ID = '0b7f6f5e-3c1a-4c6e-9b1d-2f0a6c1e9d42';
  let store: Map<string, Record<string, unknown>>;
  let txRepo: Record<string, jest.Mock>;
  let history: {
    begin: jest.Mock;
    finish: jest.Mock;
    fail: jest.Mock;
  };
  let activityLog: { log: jest.Mock };
  let service: NotificationInboxService;

  const make = (withHistory = true) => {
    let nextId = 1;
    store = new Map();
    txRepo = {
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
        Promise.resolve(
          (where.id?.value ?? []).map((id) => store.get(String(id))),
        ),
      ),
    };
    const manager = { getRepository: () => txRepo };
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
    activityLog = { log: jest.fn().mockResolvedValue(undefined) };
    history = {
      begin: jest.fn().mockResolvedValue({ duplicate: null }),
      finish: jest
        .fn()
        .mockResolvedValue({ in_app: { sent: 2 }, email: { no_provider: 2 } }),
      fail: jest.fn().mockResolvedValue(undefined),
    };
    service = new NotificationInboxService(
      repo as never,
      { send: jest.fn() } as never,
      { emit: jest.fn(() => of(null)) } as never,
      { sendNotification: jest.fn() } as never,
      activityLog as never,
      { enqueue: jest.fn() } as never,
      { assertFanout: jest.fn(), queueForNotifications: jest.fn() } as never,
      undefined,
      undefined,
      withHistory ? (history as unknown as DispatchHistoryService) : undefined,
    );
  };

  const dto = (extra: Partial<DispatchNotificationDto> = {}) =>
    ({
      type: 'system.manual',
      title: 'E’lon',
      body: 'Ertaga ish kuni',
      recipient_ids: ['11', '12'],
      channels: [NotificationChannel.IN_APP, NotificationChannel.EMAIL],
      requester: { id: '1', roles: ['superadmin'] },
      ...extra,
    }) as DispatchNotificationDto;

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    make();
  });

  it('client_request_id → dispatch_id: tarix OLDINDAN ochiladi, qatorlarga dispatch_id yoziladi, audit BITTA va entity_id = shu id', async () => {
    const res = (await service.dispatch(
      dto({ client_request_id: CLIENT_ID.toUpperCase() }),
    )) as { data: Record<string, unknown> };
    expect(history.begin).toHaveBeenCalledWith(
      expect.objectContaining({
        dispatch_id: CLIENT_ID,
        created_by: '1',
        title: 'E’lon',
        body: 'Ertaga ish kuni',
        channels: ['in_app', 'email'],
        audience: { recipient_ids: 2 },
      }),
    );
    expect(res.data.dispatch_id).toBe(CLIENT_ID);
    for (const row of store.values()) expect(row.dispatch_id).toBe(CLIENT_ID);
    expect(activityLog.log).toHaveBeenCalledTimes(1);
    expect(activityLog.log.mock.calls[0][0].entity_id).toBe(CLIENT_ID);
    expect(activityLog.log.mock.calls[0][0].entity_id).not.toBe('dispatch');
  });

  it('(NwlmrcMf) bitta qabul qiluvchi — audience.recipient_id saqlanadi (ism/telefon YO‘Q)', async () => {
    await service.dispatch(dto({ recipient_ids: ['11'] }));
    expect(history.begin.mock.calls[0][0].audience).toEqual({
      recipient_ids: 1,
      recipient_id: '11',
    });
  });

  it('finish: holat (provayder yo‘q → inbox_only, "sent" EMAS) va kanal × holat javobga ham qaytadi', async () => {
    const res = (await service.dispatch(dto())) as {
      data: Record<string, unknown>;
      message: string;
    };
    const [id, result] = history.finish.mock.calls[0];
    expect(id).toBe(res.data.dispatch_id);
    expect(result).toMatchObject({
      status: 'inbox_only',
      recipients: 2,
      dispatched: 2,
      no_provider: ['email'],
    });
    expect(res.data.channel_status).toEqual({
      in_app: { sent: 2 },
      email: { no_provider: 2 },
    });
    expect(res.message).not.toMatch(/dispatched$/);
    expect(JSON.stringify(res.data.by_channel)).not.toContain('sent');
  });

  it('ayni client_request_id takror (504 dan keyin) — QAYTA yuborilmaydi, saqlangan natija + duplicate', async () => {
    history.begin.mockResolvedValue({
      duplicate: {
        dispatch_id: CLIENT_ID,
        status: 'sent',
        dispatched: 2,
        channels: ['in_app'],
        by_channel: { in_app: 2 },
        channel_status: { in_app: { sent: 2 } },
        no_provider: [],
        skipped_by_preference: 0,
      },
    });
    const res = (await service.dispatch(
      dto({ client_request_id: CLIENT_ID }),
    )) as { data: Record<string, unknown>; statusCode: number };
    expect(res.data).toMatchObject({
      dispatch_id: CLIENT_ID,
      duplicate: true,
      status: 'sent',
      dispatched: 2,
    });
    expect(txRepo.insert).not.toHaveBeenCalled();
    expect(activityLog.log).not.toHaveBeenCalled();
    expect(history.finish).not.toHaveBeenCalled();
  });

  it('dispatch xato bilan tugasa (400) — tarix `failed` + sabab', async () => {
    const error = await service
      .dispatch(dto({ recipient_ids: undefined, roles: undefined }))
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RpcException);
    expect(history.fail).toHaveBeenCalledWith(
      expect.any(String),
      expect.anything(),
    );
    expect(history.finish).not.toHaveBeenCalled();
  });

  it('tizim hodisasi (aktor yo‘q) va kampaniya partiyasi (internal) — tarixga YOZILMAYDI', async () => {
    await service.dispatch(dto({ requester: undefined } as never));
    await service.dispatch(dto(), {
      recipients: [{ id: '11', role: 'market' }],
    });
    expect(history.begin).not.toHaveBeenCalled();
    // dispatch_id baribir har qatorda (tafsilot uchun).
    for (const row of store.values()) expect(row.dispatch_id).toBeTruthy();
  });

  it('tarix servisi yo‘q (eski modul/spec) — dispatch avvalgidek ishlaydi', async () => {
    make(false);
    const res = (await service.dispatch(dto())) as {
      data: Record<string, unknown>;
    };
    expect(res.data.dispatched).toBe(2);
    expect(res.data.channel_status).toBeUndefined();
  });

  it('historyStatusFor — xabar matni bilan bir xil qoida', () => {
    expect(historyStatusFor('Notification dispatched', 3, 0)).toBe('sent');
    expect(historyStatusFor('Partially dispatched', 3, 0)).toBe('partial');
    expect(
      historyStatusFor(
        'Saved to inbox only — no external channel delivered',
        3,
        0,
      ),
    ).toBe('inbox_only');
    expect(historyStatusFor('whatever', 0, 4)).toBe('skipped');
  });

  it('"yetkazilmadi" holatlari: failed/no_provider/not_eligible/skipped/no_subscription/blocked — queued/emitted/sent EMAS', () => {
    expect([...UNDELIVERED_STATUSES].sort()).toEqual(
      [
        'blocked',
        'failed',
        'no_provider',
        'no_subscription',
        'not_eligible',
        'skipped',
      ].sort(),
    );
  });
});
