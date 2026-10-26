import { NotificationChannel } from '@app/common';
import { NotificationInboxService } from '../notification-inbox.service';
import {
  DispatchHistoryService,
  historyStatusFor,
  liveHistoryStatus,
} from './dispatch-history.service';

/**
 * aNynHYU0 (N2) — tashqi kanal bir qismiga yetmagan bo'lsa `partial`.
 * Ilgari `by_channel[ch] > 0` yetardi (100 dan 1 kishiga SMS — «sent»).
 */
describe('aNynHYU0 — partial holat', () => {
  type Summary = {
    message: string;
    by_channel: Record<string, number>;
    channel_outcome: Record<string, string>;
  };
  const summarize = (...args: unknown[]): Summary =>
    (
      NotificationInboxService.prototype as unknown as {
        summarizeChannels: (...a: unknown[]) => Summary;
      }
    ).summarizeChannels(...args);
  const { IN_APP, SMS, PUSH, REALTIME, TELEGRAM } = NotificationChannel;
  const status = (s: Summary, dispatched = 10) =>
    historyStatusFor(s.message, dispatched, 0);

  it('TC1: SMS 10 dan 1 taga ketdi → partial (sent EMAS)', () => {
    const s = summarize([IN_APP, SMS], 10, null, null, {
      sms: 1,
      sms_status: 'partial',
    });
    expect(s.channel_outcome).toEqual({ sms: 'partial' });
    expect(s.message).toBe('Partially dispatched');
    expect(status(s)).toBe('partial');
  });

  it('TC2: har kanal hammaga ketdi → sent', () => {
    const s = summarize(
      [IN_APP, SMS, PUSH, REALTIME],
      10,
      { emitted: 10, outcomes: new Map() },
      null,
      { sms: 10, sms_status: 'queued' },
      10,
    );
    expect(s.channel_outcome).toEqual({
      sms: 'full',
      push: 'full',
      realtime: 'full',
    });
    expect(status(s)).toBe('sent');
  });

  it('TC3: push obunasi bir qismida (6/10) → partial; hech kimda — inbox_only', () => {
    expect(status(summarize([IN_APP, PUSH], 10, null, null, null, 6))).toBe(
      'partial',
    );
    expect(status(summarize([IN_APP, PUSH], 10, null, null, null, 0))).toBe(
      'inbox_only',
    );
  });

  it('provayder yo‘q kanal (no_provider) to‘liq hisoblanmaydi; faqat in_app — sent', () => {
    const s = summarize(
      [IN_APP, SMS, REALTIME],
      2,
      { emitted: 2, outcomes: new Map() },
      null,
      { sms: 0, sms_status: 'no_provider' },
    );
    expect(status(s, 2)).toBe('partial');
    expect(status(summarize([IN_APP], 3, null, null, null), 3)).toBe('sent');
  });

  it('Telegram guruh relay’i (DM emas) — qabul qiluvchi bo‘yicha emas: 1 xabar = to‘liq', () => {
    const s = summarize(
      [IN_APP, TELEGRAM],
      40,
      null,
      { telegram_sent: 1 },
      null,
    );
    expect(s.channel_outcome).toEqual({ telegram: 'full' });
    expect(status(s, 40)).toBe('sent');
    // DM: 40 dan 30 tasi ulangan → partial.
    const dm = summarize([IN_APP, TELEGRAM], 40, null, null, null, 40, false, {
      queued: 30,
      noProvider: false,
    });
    expect(status(dm, 40)).toBe('partial');
  });

  describe('TC4: keyingi yetkazish natijasi (DLR / push xatosi) — sent → partial', () => {
    it('liveHistoryStatus: yetkazilmagan paydo bo‘lsa pasayadi, ko‘tarilmaydi', () => {
      expect(
        liveHistoryStatus('sent', ['in_app', 'sms'], {
          in_app: { sent: 2 },
          sms: { sent: 1, failed: 1 },
        }),
      ).toBe('partial');
      expect(
        liveHistoryStatus('sent', ['in_app', 'sms'], {
          sms: { failed: 2 },
        }),
      ).toBe('inbox_only');
      expect(
        liveHistoryStatus('sent', ['in_app', 'sms', 'push'], {
          sms: { sent: 1, accepted: 1 },
          push: { queued: 2 },
        }),
      ).toBe('sent');
      // pasaytiradi, ko'tarmaydi.
      expect(liveHistoryStatus('partial', ['sms'], { sms: { sent: 2 } })).toBe(
        'partial',
      );
      // ma'lumot yo'q / boshqa holat — saqlangan.
      expect(liveHistoryStatus('sent', ['sms'], {})).toBe('sent');
      expect(
        liveHistoryStatus('skipped', ['sms'], { sms: { failed: 1 } }),
      ).toBe('skipped');
      expect(
        liveHistoryStatus('running', ['sms'], { sms: { failed: 1 } }),
      ).toBe('running');
    });

    it('GET /notifications/sent: jonli kanal holati bilan sent → partial va DB’ga yoziladi', async () => {
      const row = {
        id: '1',
        dispatch_id: 'd-1',
        status: 'sent',
        channels: ['in_app', 'sms'],
        channel_status: { in_app: { sent: 2 }, sms: { queued: 2 } },
        audience: null,
        created_by: null,
        createdAt: new Date(0),
      };
      const qb: Record<string, jest.Mock> = {};
      for (const key of [
        'where',
        'andWhere',
        'orderBy',
        'addOrderBy',
        'skip',
        'take',
      ])
        qb[key] = jest.fn(() => qb);
      qb.getManyAndCount = jest.fn(() => Promise.resolve([[row], 1]));
      const update = jest.fn().mockResolvedValue({ affected: 1 });
      const query = jest.fn().mockResolvedValue([
        { dispatch_id: 'd-1', channel: 'in_app', status: 'sent', n: 2 },
        { dispatch_id: 'd-1', channel: 'sms', status: 'sent', n: 1 },
        { dispatch_id: 'd-1', channel: 'sms', status: 'failed', n: 1 },
      ]);
      const service = new DispatchHistoryService(
        { createQueryBuilder: () => qb, update } as never,
        { query } as never,
        { send: jest.fn() } as never,
      );
      const res = (await service.list({})) as {
        data: { items: Array<Record<string, unknown>> };
      };
      expect(res.data.items[0]).toMatchObject({
        status: 'partial',
        channel_status: { in_app: { sent: 2 }, sms: { sent: 1, failed: 1 } },
      });
      expect(update).toHaveBeenCalledWith(
        { dispatch_id: 'd-1', status: 'sent' },
        { status: 'partial' },
      );
    });
  });
});
