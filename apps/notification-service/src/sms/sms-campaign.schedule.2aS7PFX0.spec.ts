import { of } from 'rxjs';
import { SmsCampaignService } from './sms-campaign.service';
import { SmsConfigService } from './sms-config.service';
import { SmsConsentService } from './sms-consent.service';
import { SmsBlockedError, SmsGateService } from './sms-gate.service';

/**
 * 2aS7PFX0 (N8) — SmsCampaignDto.scheduled_at: rejalashtirilgan kampaniya
 * sms_outbox'ga HOZIR yozilmaydi; vaqti kelganda (SMS navbati tikida)
 * auditoriya, rozilik/opt-out va kunlik kvota O'SHA KUNI tekshiriladi.
 * Haqiqiy SMS yuborilmaydi — outbox/consent repo mock.
 */
const SECRET = 'e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0';
const ENV: Record<string, unknown> = {
  SMS_ENABLED: 'true',
  SMS_MAX_FANOUT: '3',
  SMS_TARIFF_PROMO: '175',
  SMS_DLR_SECRET: SECRET,
  SMS_OPT_OUT_BASE_URL: 'https://api.elchipochta.uz/sms/stop',
};

describe('2aS7PFX0 SMS kampaniya scheduled_at', () => {
  let repo: Record<string, jest.Mock>;
  let consentRepo: { find: jest.Mock };
  let outbox: { enqueue: jest.Mock; countByCampaign: jest.Mock };
  const make = () => {
    const get = (key: string) => ENV[key];
    const config = new SmsConfigService({ get } as never);
    const consent = new SmsConsentService(consentRepo as never, config, {
      get,
    } as never);
    const gate = new SmsGateService(config, {} as never);
    return new SmsCampaignService(
      repo as never,
      { send: jest.fn(() => of(null)) } as never,
      config,
      consent,
      { contacts: jest.fn().mockResolvedValue(new Map()) } as never,
      gate,
      outbox as never,
      { resolve: jest.fn() } as never,
    );
  };
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
  const input = (scheduled_at?: string) => ({
    text: 'Kuzgi chegirma 20%',
    segment: { phones: ['+998901111111', '+998902222222'] },
    ...(scheduled_at ? { scheduled_at } : {}),
  });
  /** Ertangi kun Toshkent soati bilan (+05:00). */
  const tomorrowAt = (hhmm: string) => {
    const day = new Date(Date.now() + 5 * 3600_000 + 86_400_000)
      .toISOString()
      .slice(0, 10);
    return `${day}T${hhmm}:00+05:00`;
  };

  beforeEach(() => {
    repo = {
      findOne: jest.fn().mockResolvedValue(null),
      save: jest.fn((v) => Promise.resolve({ id: '9', ...v })),
      create: jest.fn((v) => v),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
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
          estimated_cost: 175,
        }),
      ),
      countByCampaign: jest.fn().mockResolvedValue(new Map()),
    };
  });

  it('TC: kelajakdagi scheduled_at → status scheduled, sms_outbox ga HECH NARSA yozilmaydi', async () => {
    grant('+998901111111');
    const at = tomorrowAt('11:00');
    const res = await make().send(input(at), 'k-sched', '1');
    expect(outbox.enqueue).not.toHaveBeenCalled();
    expect(repo.save).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'scheduled',
        scheduled_at: new Date(at),
        requested_at: new Date(at),
        quiet_hours_shifted: false,
        started_at: null,
      }),
    );
    expect(res).toMatchObject({
      campaign_id: '9',
      status: 'scheduled',
      queued: 0,
      recipients: 1,
      blocked_no_consent: 1,
      scheduled_for: new Date(at),
      quiet_hours_shifted: false,
    });
  });

  it("TC: 18:00–09:00 oynasiga tushgan vaqt — oyna tugashiga (09:00) suriladi, 'quiet_hours_shifted'", async () => {
    grant('+998901111111');
    const at = tomorrowAt('20:30');
    const res = (await make().send(input(at), 'k-night', '1')) as {
      scheduled_for: Date;
      quiet_hours_shifted: boolean;
      scheduled_for_tashkent: string;
    };
    expect(res.quiet_hours_shifted).toBe(true);
    expect(res.scheduled_for_tashkent).toMatch(/T09:00:00\+05:00$/);
    expect(res.scheduled_for.getTime()).toBeGreaterThan(new Date(at).getTime());
  });

  it('TC: zonasiz vaqt va 90 kundan uzoq — 400, hech narsa saqlanmaydi', async () => {
    grant('+998901111111');
    await expect(
      make().send(input('2026-12-01T10:00:00'), 'k-zone', '1'),
    ).rejects.toMatchObject({
      error: expect.objectContaining({ statusCode: 400 }),
    });
    const far = new Date(Date.now() + 120 * 86_400_000).toISOString();
    await expect(make().send(input(far), 'k-far', '1')).rejects.toMatchObject({
      error: expect.objectContaining({
        statusCode: 400,
        reason: 'scheduled_at_too_far',
      }),
    });
    expect(repo.save).not.toHaveBeenCalled();
  });

  it("TC: o'tgan vaqt — darhol (queued) navbatga", async () => {
    grant('+998901111111');
    const res = await make().send(
      input(new Date(Date.now() - 60_000).toISOString()),
      'k-past',
      '1',
    );
    expect(outbox.enqueue).toHaveBeenCalledTimes(1);
    expect(res).toMatchObject({ status: 'queued', queued: 1 });
  });

  it('preview scheduled_at ni qaytaradi (hech narsa yozilmaydi)', async () => {
    grant('+998901111111');
    const at = tomorrowAt('12:15');
    const res = await make().preview(input(at));
    expect(res).toMatchObject({
      scheduled_for: new Date(at),
      requested_at: new Date(at),
      quiet_hours_shifted: false,
    });
    expect(repo.save).not.toHaveBeenCalled();
    expect(outbox.enqueue).not.toHaveBeenCalled();
  });

  it("TC: vaqti kelganda — scheduled→queued da'vo, rozilik O'SHA PAYTDA qayta (bekor qilingani ketmaydi), outbox darvozasi", async () => {
    const campaign = {
      id: '9',
      status: 'scheduled',
      text: 'Kuzgi chegirma 20%',
      template_code: null,
      segment: { phones: ['+998901111111', '+998902222222'] },
      scheduled_at: new Date(Date.now() - 1000),
    };
    repo.find.mockResolvedValue([campaign]);
    // Rejalashtirilganda ikkalasi rozi edi; endi faqat bittasi.
    grant('+998902222222');
    const released = await make().releaseDue(new Date());
    expect(released).toBe(1);
    expect(repo.update).toHaveBeenCalledWith(
      { id: '9', status: 'scheduled' },
      expect.objectContaining({ status: 'queued' }),
    );
    expect(outbox.enqueue).toHaveBeenCalledTimes(1);
    expect(outbox.enqueue.mock.calls[0][0]).toEqual([
      expect.objectContaining({
        to: '+998902222222',
        messageClass: 'promo',
        campaignId: '9',
      }),
    ]);
    expect(repo.update).toHaveBeenCalledWith(
      { id: '9' },
      expect.objectContaining({ blocked: 1, total: 2 }),
    );
  });

  it("TC: vaqti kelganda kunlik kvota tugagan — failed + last_error, 'muvaffaqiyat' yo'q", async () => {
    repo.find.mockResolvedValue([
      {
        id: '9',
        status: 'scheduled',
        text: 'Aksiya',
        template_code: null,
        segment: { phones: ['+998901111111'] },
        scheduled_at: new Date(Date.now() - 1000),
      },
    ]);
    grant('+998901111111');
    outbox.enqueue.mockRejectedValue(
      new SmsBlockedError('daily_cap_exceeded', 'Kunlik SMS kvotasi tugadi'),
    );
    expect(await make().releaseDue(new Date())).toBe(0);
    expect(repo.update).toHaveBeenCalledWith(
      { id: '9' },
      { status: 'failed', last_error: 'Kunlik SMS kvotasi tugadi' },
    );
  });

  it("da'vo yutqazilgan (boshqa tik / bekor qilingan) — hech narsa yuborilmaydi", async () => {
    repo.find.mockResolvedValue([
      {
        id: '9',
        status: 'scheduled',
        text: 'x',
        segment: {},
        scheduled_at: new Date(),
      },
    ]);
    repo.update.mockResolvedValue({ affected: 0 });
    expect(await make().releaseDue(new Date())).toBe(0);
    expect(outbox.enqueue).not.toHaveBeenCalled();
  });

  it('TC: bekor qilish — faqat scheduled; yuborilgani 409', async () => {
    repo.findOne.mockResolvedValue({ id: '9', status: 'cancelled' });
    await expect(make().cancel('9', '1')).resolves.toMatchObject({
      id: '9',
      can_cancel: false,
    });
    expect(repo.update).toHaveBeenCalledWith(
      { id: '9', status: 'scheduled' },
      expect.objectContaining({ status: 'cancelled', cancelled_by: '1' }),
    );
    repo.update.mockResolvedValue({ affected: 0 });
    repo.findOne.mockResolvedValue({ id: '9', status: 'queued' });
    await expect(make().cancel('9', '1')).rejects.toMatchObject({
      error: expect.objectContaining({ statusCode: 409, status: 'queued' }),
    });
    await expect(make().cancel('x', '1')).rejects.toMatchObject({
      error: expect.objectContaining({ statusCode: 400 }),
    });
  });

  it('tarix: scheduled_for va can_cancel', async () => {
    const at = new Date(Date.now() + 3600_000);
    repo.find.mockResolvedValue([
      { id: '9', status: 'scheduled', scheduled_at: at },
    ]);
    const rows = await make().history();
    expect(rows[0]).toMatchObject({
      scheduled_for: at,
      can_cancel: true,
      sent: 0,
    });
  });
});
