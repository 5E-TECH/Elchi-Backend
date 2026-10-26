import { of } from 'rxjs';
import { SmsCampaignService } from './sms-campaign.service';
import { SmsConfigService } from './sms-config.service';
import { SmsConsentService } from './sms-consent.service';

/**
 * sdNGqCBa — SMS kampaniya: `max_orders` («gacha») va saqlangan segment
 * (`audience_segment_id`, push bilan bitta jadval). Preview va yuborish
 * soni bitta resolverdan. Haqiqiy SMS yo'q — outbox mock.
 */
const rmqSendMock = jest.fn();
jest.mock('@app/common', () => ({
  ...jest.requireActual('@app/common'),
  rmqSend: (...args: unknown[]) => rmqSendMock(...args),
}));

const ENV: Record<string, unknown> = {
  SMS_ENABLED: 'true',
  SMS_MAX_FANOUT: '10',
  SMS_TARIFF_PROMO: '175',
  SMS_DLR_SECRET: 'e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0',
  SMS_OPT_OUT_BASE_URL: 'https://api.elchipochta.uz/sms/stop',
};

describe('sdNGqCBa SMS kampaniya segmentlari', () => {
  let repo: Record<string, jest.Mock>;
  let consentRepo: { find: jest.Mock };
  let outbox: { enqueue: jest.Mock; countByCampaign: jest.Mock };
  let savedSegments: { findOne: jest.Mock };
  let dispatch: { contacts: jest.Mock };
  const make = (withSaved = true) => {
    const get = (key: string) => ENV[key];
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
      withSaved ? (savedSegments as never) : undefined,
    );
  };

  beforeEach(() => {
    repo = {
      findOne: jest.fn().mockResolvedValue(null),
      save: jest.fn((v) => Promise.resolve({ id: '7', ...v })),
      create: jest.fn((v) => v),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
      find: jest.fn().mockResolvedValue([]),
    };
    // Ikkala mijoz ham rozi.
    consentRepo = {
      find: jest.fn().mockResolvedValue(
        ['+998901111111', '+998902222222'].map((phone) => ({
          phone,
          customer_id: null,
          granted: true,
          revoked_at: null,
          granted_at: new Date(),
        })),
      ),
    };
    outbox = {
      enqueue: jest.fn((items: unknown[]) =>
        Promise.resolve({
          queued: items.map((_, i) => ({
            id: String(i),
            scheduled_at: new Date(),
          })),
          skipped: [],
          estimated_cost: 350,
        }),
      ),
      countByCampaign: jest.fn().mockResolvedValue(new Map()),
    };
    savedSegments = { findOne: jest.fn().mockResolvedValue(null) };
    dispatch = {
      contacts: jest.fn().mockResolvedValue(
        new Map([
          ['11', { id: '11', phone_number: '+998901111111' }],
          ['12', { id: '12', phone_number: '+998902222222' }],
        ]),
      ),
    };
    rmqSendMock.mockReset();
    rmqSendMock.mockResolvedValue({
      data: { items: [{ customer_id: '11' }, { customer_id: '12' }] },
    });
  });

  it("TC1: max_orders order-service'ga uzatiladi (min_orders bilan)", async () => {
    await make().preview({
      text: 'Aksiya',
      segment: { region_id: '5', min_orders: 2, max_orders: 10 },
    });
    expect(rmqSendMock).toHaveBeenCalledWith(
      expect.anything(),
      { cmd: 'order.customer.segment' },
      { region_id: '5', min_orders: 2, max_orders: 10, limit: 10 },
    );
  });

  it('TC1: teskari oraliq (min > max) — 400, resolver bilan bir xil matn; hech narsa so‘ralmaydi', async () => {
    await expect(
      make().preview({
        text: 'Aksiya',
        segment: { min_orders: 5, max_orders: 2 },
      }),
    ).rejects.toMatchObject({
      error: expect.objectContaining({
        statusCode: 400,
        message:
          "segment: min_orders max_orders dan katta bo'lmasligi kerak (teskari oraliq)",
      }),
    });
    await expect(
      make().preview({ text: 'Aksiya', segment: { max_orders: 0 } }),
    ).rejects.toMatchObject({
      error: expect.objectContaining({ statusCode: 400 }),
    });
    expect(rmqSendMock).not.toHaveBeenCalled();
  });

  it('TC2: audience_segment_id — saqlangan mijoz segmenti sharti ishlatiladi (bitta jadval)', async () => {
    savedSegments.findOne.mockResolvedValue({
      id: '3',
      audience: {
        include_customers: true,
        segment: { district_id: '41', min_orders: 3, max_orders: 10 },
      },
    });
    const preview = await make().preview({
      text: 'Aksiya',
      audience_segment_id: '3',
    });
    expect(savedSegments.findOne).toHaveBeenCalledWith({
      where: { id: '3', isDeleted: false },
    });
    expect(rmqSendMock).toHaveBeenCalledWith(
      expect.anything(),
      { cmd: 'order.customer.segment' },
      { district_id: '41', min_orders: 3, max_orders: 10, limit: 10 },
    );
    // TC3: preview soni == yuborish soni (bitta resolver).
    const sent = await make().send(
      { text: 'Aksiya', audience_segment_id: '3' },
      'k-seg',
      '1',
    );
    expect(preview).toMatchObject({ recipients: 2 });
    expect(sent).toMatchObject({ queued: 2 });
    expect(outbox.enqueue.mock.calls[0][0]).toHaveLength(2);
    // Saqlangan shart kampaniya qatoriga yoziladi (rejalashtirilgan ham shu bilan).
    expect(repo.save).toHaveBeenCalledWith(
      expect.objectContaining({
        segment: {
          district_id: '41',
          min_orders: 3,
          max_orders: 10,
          audience_segment_id: '3',
        },
      }),
    );
  });

  it('TC2: xodim rollari / broadcast / mijozsiz saqlangan segment — 400 segment_not_customer_only; topilmasa — 404', async () => {
    for (const audience of [
      { roles: ['courier'] },
      { broadcast: true },
      { roles: ['customer'] },
    ]) {
      savedSegments.findOne.mockResolvedValue({ id: '4', audience });
      await expect(
        make().preview({ text: 'Aksiya', audience_segment_id: '4' }),
      ).rejects.toMatchObject({
        error: expect.objectContaining({
          statusCode: 400,
          reason: 'segment_not_customer_only',
        }),
      });
    }
    savedSegments.findOne.mockResolvedValue(null);
    await expect(
      make().preview({ text: 'Aksiya', audience_segment_id: '99' }),
    ).rejects.toMatchObject({
      error: expect.objectContaining({ statusCode: 404 }),
    });
    expect(rmqSendMock).not.toHaveBeenCalled();
  });

  it('TC2: audience_segment_id + segment birga — 400', async () => {
    await expect(
      make().preview({
        text: 'Aksiya',
        audience_segment_id: '3',
        segment: { region_id: '5' },
      }),
    ).rejects.toMatchObject({
      error: expect.objectContaining({ statusCode: 400 }),
    });
    expect(savedSegments.findOne).not.toHaveBeenCalled();
  });

  it('confirm_all_customers saqlangan segment (filtrsiz) — barcha mijozlar, fan-out chegarasi bilan', async () => {
    savedSegments.findOne.mockResolvedValue({
      id: '5',
      audience: { include_customers: true, confirm_all_customers: true },
    });
    await make().preview({ text: 'Aksiya', audience_segment_id: '5' });
    expect(rmqSendMock).toHaveBeenCalledWith(
      expect.anything(),
      { cmd: 'order.customer.segment' },
      { limit: 10 },
    );
  });
});
