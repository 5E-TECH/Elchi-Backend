import { of } from 'rxjs';
import { SmsDispatchService } from './sms-dispatch.service';
import { SmsConfigService } from './sms-config.service';
import { SmsBlockedError } from './sms-gate.service';

const rmqSendMock = jest.fn();
jest.mock('@app/common', () => ({
  ...jest.requireActual('@app/common'),
  rmqSend: (...args: unknown[]) => rmqSendMock(...args),
}));

const row = (id: string, recipient: string) =>
  ({
    id,
    recipient_id: recipient,
    title: 'Buyurtma #EL-1',
    body: 'yetkazildi',
  }) as never;

describe('SmsDispatchService', () => {
  let outbox: { enqueue: jest.Mock; patchNotifications: jest.Mock };
  let registry: { hasAccount: jest.Mock };
  let patches: Array<{ ids: string[]; patch: Record<string, unknown> }>;
  let manager: { getRepository: () => unknown };
  let notifications: { query: jest.Mock };
  const make = (env: Record<string, unknown> = { SMS_ENABLED: 'true' }) =>
    new SmsDispatchService(
      notifications as never,
      { send: jest.fn(() => of(null)) } as never,
      new SmsConfigService({ get: (key: string) => env[key] } as never),
      outbox as never,
      registry as never,
    );

  beforeEach(() => {
    patches = [];
    rmqSendMock.mockReset().mockResolvedValue({
      data: [
        {
          id: '42',
          phone_number: '+998901111111',
          role: 'courier',
          language: 'uz',
        },
        { id: '43', phone_number: null, role: 'courier', language: 'uz' },
      ],
    });
    outbox = {
      enqueue: jest.fn().mockResolvedValue({
        queued: [{ id: '1' }],
        skipped: [],
        estimated_cost: null,
      }),
      patchNotifications: jest.fn(),
    };
    registry = { hasAccount: jest.fn().mockResolvedValue(true) };
    const builder: Record<string, jest.Mock> = {};
    let current: { ids: string[]; patch: Record<string, unknown> };
    Object.assign(builder, {
      update: jest.fn(() => builder),
      set: jest.fn(() => builder),
      setParameter: jest.fn((_: string, value: string) => {
        current = { ids: [], patch: JSON.parse(value) };
        return builder;
      }),
      whereInIds: jest.fn((ids: string[]) => {
        current.ids = ids;
        return builder;
      }),
      execute: jest.fn(() => {
        patches.push(current);
        return Promise.resolve({});
      }),
    });
    manager = { getRepository: () => ({ createQueryBuilder: () => builder }) };
    notifications = { query: jest.fn() };
  });

  it('SMS_ENABLED=false → no sms_outbox row, delivery.sms = no_provider in DB, reason returned (uFmUS86e)', async () => {
    const res = await make({}).queueForNotifications(
      [row('1', '42')],
      manager as never,
    );
    expect(res).toEqual({
      sms: 0,
      sms_status: 'no_provider',
      sms_reason: 'sms_disabled',
    });
    expect(outbox.enqueue).not.toHaveBeenCalled();
    expect(patches[0]).toEqual({
      ids: ['1'],
      patch: { sms: 'no_provider', sms_reason: 'sms_disabled' },
    });
  });

  it('no provider account → no_provider in DB (not a fake "sent", not a silent "skipped") (uFmUS86e TC1)', async () => {
    registry.hasAccount.mockResolvedValue(false);
    const res = await make().queueForNotifications(
      [row('1', '42')],
      manager as never,
    );
    expect(res.sms_status).toBe('no_provider');
    expect(res.sms_reason).toBe('provider_not_configured');
    expect(outbox.enqueue).not.toHaveBeenCalled();
    expect(patches[0]).toEqual({
      ids: ['1'],
      patch: { sms: 'no_provider', sms_reason: 'provider_not_configured' },
    });
  });

  it('queues recipients with a phone (client id notif-<id>) and marks those without one skipped', async () => {
    const res = await make().queueForNotifications(
      [row('1', '42'), row('2', '43')],
      manager as never,
    );
    expect(outbox.enqueue.mock.calls[0][0]).toEqual([
      expect.objectContaining({
        to: '+998901111111',
        clientMessageId: 'notif-1',
        messageClass: 'transactional',
        text: 'Buyurtma #EL-1: yetkazildi',
      }),
    ]);
    expect(res).toEqual({ sms: 1, sms_status: 'partial', sms_skipped: 1 });
    expect(patches).toEqual(
      expect.arrayContaining([
        { ids: ['2'], patch: { sms: 'skipped', sms_reason: 'no_phone' } },
        { ids: ['1'], patch: { sms: 'queued' } },
      ]),
    );
  });

  it('daily cap reached → blocked with the reason (fail-closed, in-app still delivered)', async () => {
    outbox.enqueue.mockRejectedValue(
      new SmsBlockedError('daily_cap_exceeded', 'kvota'),
    );
    const res = await make().queueForNotifications(
      [row('1', '42')],
      manager as never,
    );
    expect(res).toEqual({
      sms: 0,
      sms_status: 'blocked',
      sms_reason: 'daily_cap_exceeded',
    });
    expect(patches).toContainEqual({
      ids: ['1'],
      patch: { sms: 'blocked', sms_reason: 'daily_cap_exceeded' },
    });
  });

  it('escalation sends SMS only for rows it atomically claimed (escalated_at was empty)', async () => {
    notifications.query.mockResolvedValue([
      [{ id: '7', recipient_id: '42', title: 'Kritik', body: null }],
      1,
    ]);
    const queued = await make().escalate(['7', '8']);
    expect(notifications.query.mock.calls[0][0]).toMatch(
      /escalated_at'\) IS NULL/,
    );
    expect(outbox.enqueue.mock.calls[0][0]).toEqual([
      expect.objectContaining({
        clientMessageId: 'esc-7',
        to: '+998901111111',
      }),
    ]);
    expect(queued).toBe(1);

    notifications.query.mockResolvedValue([[], 0]);
    outbox.enqueue.mockClear();
    expect(await make().escalate(['7'])).toBe(0);
    expect(outbox.enqueue).not.toHaveBeenCalled();
  });

  it('fan-out guard', () => {
    expect(() =>
      make({ SMS_ENABLED: 'true', SMS_MAX_FANOUT: '2' }).assertFanout(3),
    ).toThrow(/SMS_MAX_FANOUT/);
  });
});
