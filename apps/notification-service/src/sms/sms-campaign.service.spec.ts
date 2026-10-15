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
  let templates: { resolve: jest.Mock };
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
      templates as never,
    );
  };

  /** Amaldagi reklama roziligi (sVByLMnt) — berilgan raqamlarga. */
  const grant = (...list: string[]) =>
    consentRepo.find.mockResolvedValue(
      list.map((phone) => ({
        phone,
        customer_id: null,
        granted: true,
        revoked_at: null,
        granted_at: new Date(),
      })),
    );

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
    templates = { resolve: jest.fn().mockResolvedValue(null) };
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
    grant(...list.map((p) => `+998${p}`));
    await expect(make().send(phones(list), 'k3', '1')).rejects.toMatchObject({
      error: expect.objectContaining({
        statusCode: 400,
        message: expect.stringContaining('SMS_MAX_FANOUT'),
      }),
    });
    expect(outbox.enqueue).not.toHaveBeenCalled();
  });

  it('promo campaign queues with campaign id and a per-phone client id', async () => {
    grant('+998901111111');
    const res = await make().send(
      phones(['901111111', '901111111']),
      'k4',
      '1',
    );
    expect(outbox.enqueue.mock.calls[0][0]).toEqual([
      expect.objectContaining({
        campaignId: '5',
        clientMessageId: 'camp-5-998901111111',
        messageClass: 'promo',
      }),
    ]);
    expect(res).toMatchObject({ campaign_id: '5', queued: 1 });
  });

  describe("(sVByLMnt) kampaniya FAQAT reklama — 'Xizmat xabari' darvozalarni chetlab o'tmaydi", () => {
    const night = {
      message_class: 'transactional',
      text: 'Kuzgi chegirma 20%! Faqat bugun',
      segment: { phones: ['901111111', '902222222'] },
    };

    it("message_class='transactional' (yoki 'security') → 400 campaign_promo_only: preview ham, send ham; hech narsa saqlanmaydi/navbatga tushmaydi", async () => {
      for (const messageClass of ['transactional', 'security']) {
        const input = { ...night, message_class: messageClass };
        await expect(make().preview(input)).rejects.toMatchObject({
          error: expect.objectContaining({
            statusCode: 400,
            reason: 'campaign_promo_only',
            message_class: messageClass,
          }),
        });
        await expect(
          make().send(input, `k-${messageClass}`, '1'),
        ).rejects.toMatchObject({
          error: expect.objectContaining({
            statusCode: 400,
            reason: 'campaign_promo_only',
          }),
        });
      }
      expect(repo.save).not.toHaveBeenCalled();
      expect(outbox.enqueue).not.toHaveBeenCalled();
      // Rozilik/segment so'ralmaydi — rad etish matnni ko'rishdan oldin.
      expect(consentRepo.find).not.toHaveBeenCalled();
    });

    it('tranzaksion/OTP SHABLONI kampaniyada ham rad etiladi (shablon orqali aylanib o‘tish yo‘q)', async () => {
      for (const messageClass of ['transactional', 'security']) {
        templates.resolve.mockResolvedValue({
          code: 'order.delivered',
          message_class: messageClass,
          text: 'Buyurtma #{{order_number}} yetkazildi',
          required_vars: ['order_number'],
        });
        await expect(
          make().send(
            {
              template_code: 'order.delivered',
              vars: { order_number: '1' },
              segment: { phones: ['901111111'] },
            },
            `kt-${messageClass}`,
            '1',
          ),
        ).rejects.toMatchObject({
          error: expect.objectContaining({
            statusCode: 400,
            reason: 'campaign_promo_only',
            message_class: messageClass,
          }),
        });
      }
      expect(repo.save).not.toHaveBeenCalled();
      expect(outbox.enqueue).not.toHaveBeenCalled();
    });

    it('promo shablon + aniq message_class=transactional → baribir rad (aralash so‘rov ham)', async () => {
      templates.resolve.mockResolvedValue({
        code: 'promo.autumn',
        message_class: 'promo',
        text: 'Chegirma {{discount}}',
        required_vars: ['discount'],
      });
      await expect(
        make().preview({
          message_class: 'transactional',
          template_code: 'promo.autumn',
          vars: { discount: '20%' },
          segment: { phones: ['901111111'] },
        }),
      ).rejects.toMatchObject({
        error: expect.objectContaining({ reason: 'campaign_promo_only' }),
      });
    });

    it('message_class berilmasa — reklama: rozilik darvozasi va opt-out havolasi qo‘llanadi', async () => {
      grant('+998901111111');
      const preview = await make().preview({
        text: 'Kuzgi chegirma 20%',
        segment: { phones: ['901111111', '902222222'] },
      });
      expect(preview).toMatchObject({
        message_class: 'promo',
        recipients: 1,
        blocked_no_consent: 1,
        tariff: 175,
      });
      expect(preview.sample_text).toContain('Rad etish:');
    });

    it('promo shablon ruxsat — reklama sifatida (rozilik bilan) navbatga', async () => {
      grant('+998901111111');
      templates.resolve.mockResolvedValue({
        code: 'promo.autumn',
        message_class: 'promo',
        text: 'Chegirma {{discount}}',
        required_vars: ['discount'],
      });
      await make().send(
        {
          template_code: 'promo.autumn',
          vars: { discount: '20%' },
          segment: { phones: ['901111111', '902222222'] },
        },
        'kp',
        '1',
      );
      expect(outbox.enqueue.mock.calls[0][0]).toEqual([
        expect.objectContaining({
          to: '+998901111111',
          messageClass: 'promo',
          text: 'Chegirma 20%',
        }),
      ]);
      expect(repo.save).toHaveBeenCalledWith(
        expect.objectContaining({ message_class: 'promo', blocked: 1 }),
      );
    });
  });

  it('a leftover {{placeholder}} blocks sending', async () => {
    await expect(
      make().preview({
        message_class: 'promo',
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
    grant('+998907777777');
    const preview = await make().preview({
      message_class: 'promo',
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

  it('(sVByLMnt TC14) history keeps queued/blocked/skipped and derives sent/failed/pending from sms_outbox', async () => {
    repo.find.mockResolvedValue([
      {
        id: '5',
        idempotency_key: 'k',
        status: 'queued',
        total: 6,
        queued: 4,
        blocked: 1,
        skipped: 1,
      },
    ]);
    outbox.countByCampaign.mockResolvedValue(
      new Map([['5', { delivered: 2, sent: 1, failed: 1 }]]),
    );
    const [row] = await make().history();
    expect(outbox.countByCampaign).toHaveBeenCalledWith(['5']);
    expect(row).toMatchObject({
      total: 6,
      queued: 4,
      blocked: 1,
      skipped: 1,
      sent: 3,
      delivered: 2,
      failed: 1,
      pending: 0,
    });
  });

  it('(sVByLMnt TC14 / 3fRbyadQ TC6) a campaign the gate rejected (daily cap) stays in history as failed — 409 with the reason, not a silent success', async () => {
    const { SmsBlockedError } = jest.requireActual('./sms-gate.service');
    grant('+998901111111');
    outbox.enqueue.mockRejectedValue(
      new SmsBlockedError('daily_cap_exceeded', 'Kunlik SMS kvotasi tugadi', {
        used: 3,
        requested: 1,
        cap: 3,
        stream: 'general',
      }),
    );
    await expect(
      make().send(
        {
          message_class: 'promo',
          text: 'Kuzgi chegirma 20%',
          segment: { phones: ['+998901111111', '+998902222222'] },
        },
        'key-cap',
        '1',
      ),
    ).rejects.toMatchObject({
      error: expect.objectContaining({
        statusCode: 409,
        reason: 'daily_cap_exceeded',
        cap: 3,
        stream: 'general',
      }),
    });
    expect(repo.save).toHaveBeenCalledWith(
      expect.objectContaining({
        idempotency_key: 'key-cap',
        message_class: 'promo',
        total: 2,
        blocked: 1,
      }),
    );
    expect(repo.update).toHaveBeenCalledWith({ id: '5' }, { status: 'failed' });
    // "queued" hech qachon yozilmaydi — tarix muvaffaqiyat ko'rsatmaydi.
    expect(repo.update).not.toHaveBeenCalledWith(
      { id: '5' },
      expect.objectContaining({ queued: expect.anything() }),
    );
  });
});
