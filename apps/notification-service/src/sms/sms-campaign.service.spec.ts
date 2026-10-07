import { of } from 'rxjs';
import { SmsCampaignService } from './sms-campaign.service';
import { SmsConfigService } from './sms-config.service';
import { SmsConsentService } from './sms-consent.service';

const rmqSendMock = jest.fn();
jest.mock('@app/common', () => ({
  ...jest.requireActual('@app/common'),
  rmqSend: (...args: unknown[]) => rmqSendMock(...args),
}));

const SECRET = 'e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0';
const ENV: Record<string, unknown> = {
  SMS_ENABLED: 'true',
  SMS_MAX_FANOUT: '3',
  SMS_TARIFF_PROMO: '175',
  SMS_TARIFF_TRANSACTIONAL: '95',
  SMS_DLR_SECRET: SECRET,
  SMS_OPT_OUT_BASE_URL: 'https://api.elchipochta.uz/sms/stop',
};

describe('SmsCampaignService', () => {
  let repo: {
    findOne: jest.Mock;
    save: jest.Mock;
    create: jest.Mock;
    update: jest.Mock;
    find: jest.Mock;
  };
  let consentRepo: { find: jest.Mock };
  let outbox: { enqueue: jest.Mock; countByCampaign: jest.Mock };
  let dispatch: { contacts: jest.Mock };
  const make = (env = ENV) => {
    const get = (key: string) => env[key];
    const config = new SmsConfigService({ get } as never);
    const consent = new SmsConsentService(consentRepo as never, config, {
      get,
    } as never);
    return new SmsCampaignService(
      repo as never,
      { send: jest.fn(() => of(null)) } as never,
      config,
      consent,
      dispatch as never,
      { scheduleFor: (_: string, now = new Date()) => now } as never,
      outbox as never,
      { resolve: jest.fn() } as never,
    );
  };

  beforeEach(() => {
    repo = {
      findOne: jest.fn().mockResolvedValue(null),
      save: jest.fn((v) => Promise.resolve({ id: '5', ...v })),
      create: jest.fn((v) => v),
      update: jest.fn(),
      find: jest.fn().mockResolvedValue([]),
    };
    consentRepo = { find: jest.fn().mockResolvedValue([]) };
    outbox = {
      enqueue: jest.fn((items: unknown[]) =>
        Promise.resolve({
          queued: items.map((_, i) => ({
            id: String(i),
            scheduled_at: new Date(),
          })),
          skipped: [],
          estimated_cost: 0,
        }),
      ),
      countByCampaign: jest.fn().mockResolvedValue(new Map()),
    };
    dispatch = { contacts: jest.fn().mockResolvedValue(new Map()) };
    rmqSendMock.mockReset();
  });

  const phones = (list: string[]) => ({
    message_class: 'promo',
    text: 'Kuzgi chegirma 20%',
    segment: { phones: list },
  });

  it('preview: exact recipients, blocked (no consent), invalid numbers and forecast (opt-out counted)', async () => {
    consentRepo.find.mockResolvedValue([
      {
        phone: '+998901111111',
        customer_id: null,
        granted: true,
        revoked_at: null,
        granted_at: new Date(),
      },
    ]);
    const preview = await make().preview(
      phones(['901111111', '902222222', 'xyz']),
    );
    expect(preview).toMatchObject({
      total: 3,
      recipients: 1,
      blocked_no_consent: 1,
      skipped_invalid_phone: 1,
      tariff: 175,
    });
    expect(preview.sample_text).toContain(
      'Rad etish: https://api.elchipochta.uz/sms/stop/',
    );
    expect(preview.estimated_cost).toBe(175 * preview.parts);
  });

  it('send requires an Idempotency-Key and a repeat with the same key is rejected (409)', async () => {
    await expect(
      make().send(phones(['901111111']), null, '1'),
    ).rejects.toMatchObject({
      error: expect.objectContaining({ statusCode: 400 }),
    });
    repo.findOne.mockResolvedValue({ id: '5', idempotency_key: 'k1' });
    await expect(
      make().send(phones(['901111111']), 'k1', '1'),
    ).rejects.toMatchObject({
      error: expect.objectContaining({ statusCode: 409 }),
    });
    expect(outbox.enqueue).not.toHaveBeenCalled();
  });

  it('promo without consent for anyone → error, nothing queued', async () => {
    await expect(
      make().send(phones(['901111111']), 'k2', '1'),
    ).rejects.toMatchObject({
      error: expect.objectContaining({
        statusCode: 400,
        blocked_no_consent: 1,
      }),
    });
    expect(outbox.enqueue).not.toHaveBeenCalled();
  });

  it('over SMS_MAX_FANOUT → ERROR (not a silent cut)', async () => {
    const list = ['901111111', '902222222', '903333333', '904444444'];
    await expect(
      make().send(
        {
          message_class: 'transactional',
          text: 'Xizmat yangilandi',
          segment: { phones: list },
        },
        'k3',
        '1',
      ),
    ).rejects.toMatchObject({
      error: expect.objectContaining({ statusCode: 400 }),
    });
  });

  it('transactional campaign queues with campaign id and a per-phone client id', async () => {
    const res = await make().send(
      {
        message_class: 'transactional',
        text: "Ish vaqti o'zgardi",
        segment: { phones: ['901111111', '901111111'] },
      },
      'k4',
      '1',
    );
    expect(outbox.enqueue.mock.calls[0][0]).toEqual([
      expect.objectContaining({
        campaignId: '5',
        clientMessageId: 'camp-5-998901111111',
        messageClass: 'transactional',
      }),
    ]);
    expect(res).toMatchObject({ campaign_id: '5', queued: 1 });
  });

  it('a leftover {{placeholder}} blocks sending', async () => {
    await expect(
      make().preview({
        message_class: 'transactional',
        text: 'Salom {{name}}',
        segment: { phones: ['901111111'] },
      }),
    ).rejects.toMatchObject({
      error: expect.objectContaining({ statusCode: 400, missing: ['name'] }),
    });
  });

  it('customer segment comes from order-service (identity find_all untouched) + contacts', async () => {
    rmqSendMock.mockResolvedValue({
      data: { items: [{ customer_id: '7' }], truncated: false },
    });
    dispatch.contacts.mockResolvedValue(
      new Map([['7', { id: '7', phone_number: '+998907777777' }]]),
    );
    const preview = await make().preview({
      message_class: 'transactional',
      text: 'x',
      segment: { market_id: '3' },
    });
    expect(rmqSendMock.mock.calls[0][1]).toEqual({
      cmd: 'order.customer.segment',
    });
    expect(rmqSendMock.mock.calls[0][2]).toMatchObject({
      market_id: '3',
      limit: 3,
    });
    expect(preview.recipients).toBe(1);
  });
});
