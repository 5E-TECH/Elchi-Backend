import { of } from 'rxjs';
import { RpcException } from '@nestjs/microservices';
import { CampaignService } from './campaign.service';
import { SmsDispatchService } from '../sms/sms-dispatch.service';
import { SmsConfigService } from '../sms/sms-config.service';
import { SmsConsentService } from '../sms/sms-consent.service';
import { SmsBlockedError } from '../sms/sms-gate.service';
import { AudiencePreviewService } from '../audience/audience-preview.service';

/**
 * 9D1Gl9MS (N7) — POST /notifications/campaigns da SMS kanali (doim reklama)
 * va preview'da rozilik bo'yicha son. Haqiqiy SMS yo'q: sms_outbox mock,
 * rozilik repo mock.
 */
const rmqSendMock = jest.fn();
jest.mock('@app/common', () => ({
  ...jest.requireActual('@app/common'),
  rmqSend: (...args: unknown[]): unknown => rmqSendMock(...args),
}));

const SMS_ENV: Record<string, unknown> = {
  SMS_ENABLED: 'true',
  SMS_MAX_FANOUT: '100',
  SMS_TARIFF_PROMO: '175',
  SMS_DLR_SECRET: 'e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0',
  SMS_OPT_OUT_BASE_URL: 'https://api.elchipochta.uz/sms/stop',
};
const smsConfig = (env = SMS_ENV) =>
  new SmsConfigService({ get: (key: string) => env[key] } as never);
const consentOf = (
  repo: { find: jest.Mock },
  env: Record<string, unknown> = SMS_ENV,
) =>
  new SmsConsentService(repo as never, smsConfig(env), {
    get: (key: string) => env[key],
  } as never);
const consentRows = (...phones: string[]) =>
  phones.map((phone) => ({
    phone,
    customer_id: null,
    granted: true,
    revoked_at: null,
    granted_at: new Date(),
  }));

const errorOf = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    if (error instanceof RpcException) return error.getError() as any;
    throw error;
  }
  throw new Error('expected RpcException');
};

describe('9D1Gl9MS — kampaniyada SMS kanali', () => {
  let campaigns: any;
  let repo: any;
  let outbox: any;
  let inbox: any;
  const make = (env = SMS_ENV) => {
    const consentRepo = { find: jest.fn().mockResolvedValue([]) };
    return new CampaignService(
      repo,
      { send: jest.fn() } as never,
      inbox,
      outbox,
      { log: jest.fn() } as never,
      { get: jest.fn(() => undefined) } as never,
      smsConfig(env),
      consentOf(consentRepo, env),
    );
  };
  const input = (over: Record<string, unknown> = {}) => ({
    type: 'marketing.manual',
    title: 'Aksiya',
    body: 'Chegirma 20%',
    channels: ['in_app', 'sms'],
    include_customers: true,
    segment: { region_id: '5' },
    idempotency_key: 'sms-k1',
    requester: { id: '25', roles: ['admin'] },
    ...over,
  });

  beforeEach(() => {
    rmqSendMock.mockReset();
    campaigns = {
      create: jest.fn((v) => ({ ...v })),
      save: jest.fn((v) => Promise.resolve({ id: '7', ...v })),
    };
    repo = {
      findOne: jest.fn().mockResolvedValue(null),
      query: jest.fn().mockResolvedValue([{ release_at: new Date() }]),
      manager: {
        transaction: jest.fn((work: (m: any) => Promise<unknown>) =>
          work({ getRepository: () => campaigns }),
        ),
        query: jest.fn().mockResolvedValue([{ release_at: new Date() }]),
      },
    };
    outbox = { enqueue: jest.fn().mockResolvedValue({ id: '1' }) };
    inbox = { dispatch: jest.fn() };
  });

  it('TC1: SMS kanali qabul qilinadi — kampaniya yaratiladi (202), kanallar saqlanadi', async () => {
    rmqSendMock.mockResolvedValueOnce({ data: { items: [], total: 40 } });
    const res: any = await make().create(input());
    expect(res.statusCode).toBe(202);
    expect(campaigns.save).toHaveBeenCalledWith(
      expect.objectContaining({ channels: ['in_app', 'sms'] }),
    );
  });

  it('TC: SMS o‘chiq — 409 (jimgina SMS’siz ketmaydi); opt-out sozlanmagan — 409', async () => {
    let err = await errorOf(
      make({ ...SMS_ENV, SMS_ENABLED: 'false' }).create(input()),
    );
    expect(err.statusCode).toBe(409);
    const { SMS_OPT_OUT_BASE_URL: _drop, ...noOptOut } = SMS_ENV;
    void _drop;
    err = await errorOf(make(noOptOut).create(input()));
    expect(err.statusCode).toBe(409);
    expect(err.message).toMatch(/opt_out_not_configured/);
    expect(campaigns.save).not.toHaveBeenCalled();
  });

  it('TC: auditoriya SMS_MAX_FANOUT dan katta — 400 (kesilmaydi)', async () => {
    rmqSendMock.mockResolvedValueOnce({ data: { items: [], total: 101 } });
    const err = await errorOf(make().create(input()));
    expect(err.statusCode).toBe(400);
    expect(err.message).toMatch(/SMS_MAX_FANOUT/);
    expect(campaigns.save).not.toHaveBeenCalled();
  });

  it('TC: partiya — inbox dispatch’ga smsMessageClass=promo (rozilik/taqiq/kvota yo‘li)', async () => {
    const campaign = {
      id: '7',
      status: 'running',
      batch_no: 0,
      batch_size: 200,
      sent: 0,
      failed: 0,
      skipped: 0,
      total: 1,
      category: 'system',
      channels: ['in_app', 'sms'],
      audience: { roles: ['courier'] },
      type: 'system.manual',
      title: 'E’lon',
      scheduled_at: null,
      cursor_after_id: null,
      isDeleted: false,
    };
    repo.findOne.mockResolvedValue(campaign);
    rmqSendMock.mockResolvedValueOnce({
      data: { items: [{ id: '42', role: 'courier' }] },
    });
    inbox.dispatch.mockResolvedValue({ data: { dispatched: 1 } });
    await make().runBatch({ campaign_id: '7', batch_no: 0 });
    expect(inbox.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ channels: ['in_app', 'sms'] }),
      expect.objectContaining({ smsMessageClass: 'promo' }),
    );
  });
});

describe('9D1Gl9MS — SmsDispatchService promo (kampaniya partiyasi)', () => {
  const row = (id: string, recipient: string, role = 'customer') =>
    ({
      id,
      recipient_id: recipient,
      recipient_role: role,
      title: 'Aksiya',
      body: 'Chegirma',
    }) as never;
  let patches: Array<{ ids: string[]; patch: Record<string, unknown> }>;
  let manager: any;
  let outbox: { enqueue: jest.Mock };
  const make = (consentRepo: { find: jest.Mock }) =>
    new SmsDispatchService(
      {} as never,
      { send: jest.fn(() => of(null)) } as never,
      smsConfig(),
      outbox as never,
      { hasAccount: jest.fn().mockResolvedValue(true) } as never,
      consentOf(consentRepo),
    );

  beforeEach(() => {
    patches = [];
    rmqSendMock.mockReset().mockResolvedValue({
      data: [
        { id: '42', phone_number: '+998901111111' },
        { id: '43', phone_number: '+998902222222' },
        { id: '44', phone_number: null },
      ],
    });
    outbox = {
      enqueue: jest.fn((items: unknown[]) =>
        Promise.resolve({
          queued: items.map((_, i) => ({ id: String(i) })),
          skipped: [],
          estimated_cost: 175,
        }),
      ),
    };
    const builder: any = {};
    let current: any;
    Object.assign(builder, {
      update: () => builder,
      set: () => builder,
      setParameter: (_: string, value: string) => {
        current = { ids: [], patch: JSON.parse(value) };
        return builder;
      },
      whereInIds: (ids: string[]) => {
        current.ids = ids;
        return builder;
      },
      execute: () => {
        patches.push(current);
        return Promise.resolve({});
      },
    });
    manager = { getRepository: () => ({ createQueryBuilder: () => builder }) };
  });

  it('TC: roziligi yo‘q — sms: skipped/no_consent (partiya yiqilmaydi); borlari promo sifatida navbatga', async () => {
    const consentRepo = {
      find: jest.fn().mockResolvedValue(consentRows('+998901111111')),
    };
    const res = await make(consentRepo).queueForNotifications(
      [row('1', '42'), row('2', '43'), row('3', '44')],
      manager,
      { messageClass: 'promo' },
    );
    expect(outbox.enqueue).toHaveBeenCalledTimes(1);
    expect(outbox.enqueue.mock.calls[0][0]).toEqual([
      expect.objectContaining({
        to: '+998901111111',
        messageClass: 'promo',
        customerId: '42',
        notificationId: '1',
        clientMessageId: 'notif-1',
      }),
    ]);
    expect(patches).toEqual(
      expect.arrayContaining([
        { ids: ['3'], patch: { sms: 'skipped', sms_reason: 'no_phone' } },
        { ids: ['2'], patch: { sms: 'skipped', sms_reason: 'no_consent' } },
        { ids: ['1'], patch: { sms: 'queued' } },
      ]),
    );
    expect(res).toEqual({ sms: 1, sms_status: 'partial', sms_skipped: 2 });
  });

  it('TC: hech kimda rozilik yo‘q — outbox chaqirilmaydi', async () => {
    const res = await make({
      find: jest.fn().mockResolvedValue([]),
    }).queueForNotifications([row('1', '42')], manager, {
      messageClass: 'promo',
    });
    expect(outbox.enqueue).not.toHaveBeenCalled();
    expect(res).toMatchObject({ sms: 0, sms_reason: 'no_consent' });
  });

  it('TC: kunlik kvota tugagan — roziligi borlar sms: blocked/daily_cap_exceeded', async () => {
    outbox.enqueue.mockRejectedValue(
      new SmsBlockedError('daily_cap_exceeded', 'Kunlik SMS kvotasi tugadi'),
    );
    const res = await make({
      find: jest.fn().mockResolvedValue(consentRows('+998901111111')),
    }).queueForNotifications([row('1', '42'), row('2', '43')], manager, {
      messageClass: 'promo',
    });
    expect(patches).toEqual(
      expect.arrayContaining([
        {
          ids: ['1'],
          patch: { sms: 'blocked', sms_reason: 'daily_cap_exceeded' },
        },
      ]),
    );
    expect(res).toMatchObject({ sms: 0, sms_status: 'blocked' });
  });

  it('oddiy dispatch (tizim hodisasi) — avvalgidek transactional', async () => {
    await make({ find: jest.fn() }).queueForNotifications(
      [row('1', '42', 'courier')],
      manager,
    );
    expect(outbox.enqueue.mock.calls[0][0]).toEqual([
      expect.objectContaining({
        messageClass: 'transactional',
        customerId: null,
      }),
    ]);
  });
});

describe('9D1Gl9MS — audience preview: rozilik bo‘yicha SMS son', () => {
  it('channels: [sms] — recipients / blocked_no_consent / invalid phone + narx (opt-out bilan)', async () => {
    rmqSendMock.mockReset();
    // identity sahifa: 3 ta, 2 tasida kanonik telefon.
    rmqSendMock.mockResolvedValueOnce({
      data: {
        items: [
          { id: '42', role: 'customer', phone_valid: true },
          { id: '43', role: 'courier', phone_valid: true },
          { id: '44', role: 'customer', phone_valid: false },
        ],
        total: 3,
        stats: { by_role: {}, with_valid_phone: 2 },
      },
    });
    const consentRepo = {
      find: jest.fn().mockResolvedValue(consentRows('+998901111111')),
    };
    const smsDispatch = {
      contacts: jest.fn().mockResolvedValue(
        new Map([
          ['42', { id: '42', phone_number: '+998901111111' }],
          ['43', { id: '43', phone_number: '+998902222222' }],
        ]),
      ),
    };
    const pushRepo = {
      createQueryBuilder: () => ({
        select: function () {
          return this;
        },
        where: function () {
          return this;
        },
        getRawOne: () => Promise.resolve({ count: 0 }),
      }),
    };
    const service = new AudiencePreviewService(
      { send: jest.fn() } as never,
      pushRepo as never,
      { get: jest.fn(() => undefined) } as never,
      undefined,
      smsConfig(),
      consentOf(consentRepo),
      smsDispatch as never,
    );
    const res: any = await service.preview({
      roles: ['courier', 'customer'],
      include_customers: true,
      confirm_all_customers: true,
      channels: ['in_app', 'sms'],
      title: 'Aksiya',
      body: 'Chegirma 20%',
    });
    expect(res.data.sms).toMatchObject({
      exact: true,
      message_class: 'promo',
      recipients: 1,
      blocked_no_consent: 1,
      skipped_invalid_phone: 1,
      with_valid_phone: 2,
      tariff: 175,
      opt_out_configured: true,
      sms_enabled: true,
    });
    expect(res.data.sms.estimated_cost).toBe(175 * res.data.sms.parts);
    expect(res.data.by_channel.sms).toBe(1);
    // Telefon javobga chiqmaydi.
    expect(JSON.stringify(res)).not.toMatch(/998901111111/);
  });
});
