import { NotificationCategory, NotificationPriority } from '@app/common';
import { ChannelPlannerService } from './channel-planner.service';

/**
 * (7Ec56EIw #2d/#3, Jht84wGp TC3) Kanal imkoniyati — BULK: bitta obuna
 * so'rovi, bitta identity chaqiruvi; imkoniyati yo'q kanal `delivery` da.
 */
describe('ChannelPlannerService', () => {
  let preferences: any;
  let subsQb: any;
  let subscriptions: any;
  let webPush: any;
  let smsConfig: any;
  let smsDispatch: any;
  let planner: ChannelPlannerService;

  beforeEach(() => {
    preferences = { mutesFor: jest.fn().mockResolvedValue(new Map()) };
    subsQb = {
      select: jest.fn(() => subsQb),
      where: jest.fn(() => subsQb),
      getRawMany: jest.fn().mockResolvedValue([{ user_id: '1' }]),
    };
    subscriptions = { createQueryBuilder: jest.fn(() => subsQb) };
    webPush = { enabled: true };
    smsConfig = { enabled: true };
    smsDispatch = {
      contacts: jest.fn().mockResolvedValue(
        new Map([
          ['1', { id: '1', phone_number: '+998901234567' }],
          ['2', { id: '2', phone_number: null }],
        ]),
      ),
    };
    planner = new ChannelPlannerService(
      preferences,
      subscriptions,
      webPush,
      smsConfig,
      smsDispatch,
    );
  });

  const plan = (requested: string[], ids = ['1', '2']) =>
    planner.plan({
      type: 'order.manual',
      category: NotificationCategory.ORDER,
      priority: NotificationPriority.NORMAL,
      requested,
      recipientIds: ids,
    });

  it('Jht84wGp TC3: obunasi yo‘q foydalanuvchi — delivery.push = no_subscription (DB qatorida)', async () => {
    const res = await plan(['in_app', 'push']);
    expect(res.byRecipient.get('1')?.delivery).toEqual({
      in_app: 'sent',
      push: 'queued',
    });
    expect(res.byRecipient.get('2')?.delivery).toEqual({
      in_app: 'sent',
      push: 'no_subscription',
    });
    // 2 ta qabul qiluvchi — BITTA obuna so'rovi.
    expect(subsQb.getRawMany).toHaveBeenCalledTimes(1);
  });

  it('VAPID yo‘q (prod hozircha) — push `no_provider`, obuna so‘rovi ham yo‘q; boshqa kanallar ishlaydi', async () => {
    webPush.enabled = false;
    const res = await plan(['in_app', 'realtime', 'push']);
    expect(res.byRecipient.get('1')?.active).toEqual(['in_app', 'realtime']);
    expect(res.byRecipient.get('1')?.delivery).toEqual({
      in_app: 'sent',
      realtime: 'pending',
      push: 'no_provider',
      push_reason: 'push_disabled',
    });
    expect(subscriptions.createQueryBuilder).not.toHaveBeenCalled();
  });

  it('7Ec56EIw TC7: telefoni yo‘q — delivery.sms = not_eligible (bitta identity chaqiruvi)', async () => {
    const res = await plan(['in_app', 'sms']);
    expect(res.byRecipient.get('1')?.delivery.sms).toBe('pending');
    expect(res.byRecipient.get('2')?.delivery).toEqual({
      in_app: 'sent',
      sms: 'not_eligible',
      sms_reason: 'no_phone',
    });
    expect(smsDispatch.contacts).toHaveBeenCalledTimes(1);
  });

  it('SMS o‘chiq — telefon tekshirilmaydi (SMS servisi `no_provider` yozadi)', async () => {
    smsConfig.enabled = false;
    const res = await plan(['in_app', 'sms']);
    expect(smsDispatch.contacts).not.toHaveBeenCalled();
    expect(res.byRecipient.get('2')?.delivery.sms).toBe('pending');
  });

  it('identity javob bermasa — avvalgi xulq (SMS servisi o‘zi hal qiladi)', async () => {
    smsDispatch.contacts.mockRejectedValue(new Error('down'));
    const res = await plan(['in_app', 'sms']);
    expect(res.byRecipient.get('2')?.delivery.sms).toBe('pending');
  });

  it('mP1WGG1W: hamma kanalni o‘chirganlar `skippedByPreference`; push o‘chirgan — push so‘rovi faqat qolganlar uchun', async () => {
    preferences.mutesFor.mockResolvedValue(
      new Map<string, unknown>([
        ['1', 'all'],
        ['2', new Set(['push'])],
      ]),
    );
    const res = await plan(['in_app', 'push']);
    expect(res.skippedByPreference).toEqual(['1']);
    expect(res.byRecipient.get('2')?.delivery).toEqual({
      in_app: 'sent',
      push: 'skipped',
      push_reason: 'muted',
    });
    // Push'ni hech kim kutmaydi — obuna so'rovi yo'q.
    expect(subscriptions.createQueryBuilder).not.toHaveBeenCalled();
  });

  it('7Ec56EIw TC4: katalogda yo‘q kanal rejaga kirmaydi', async () => {
    const res = await planner.plan({
      type: 'order.sold',
      category: NotificationCategory.ORDER,
      priority: NotificationPriority.NORMAL,
      requested: ['in_app', 'sms', 'push'],
      recipientIds: ['1'],
    });
    expect(res.channels).toEqual(['in_app']);
    expect(smsDispatch.contacts).not.toHaveBeenCalled();
    expect(subscriptions.createQueryBuilder).not.toHaveBeenCalled();
  });
});
