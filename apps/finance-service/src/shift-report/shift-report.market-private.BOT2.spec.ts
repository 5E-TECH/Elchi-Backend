import { ShiftReportService } from './shift-report.service';
import {
  MARKET_GROUP_NOTICE_TITLE,
  buildMarketMessage,
} from './shift-report.builders';

/**
 * BOT-2 #3 (ega sukut qarori Q1 = A) — smena hisobotining PULI faqat market
 * egasining SHAXSIY chatiga. Egasi Telegram'ga ulanmagan (yoki holat
 * noma'lum) — guruhga faqat summasiz «Smena yakunlandi — kabinetda ko'ring».
 */
const snapshot = {
  shift_id: '42',
  round: 1,
  close_reason: 'manual',
  closed_at: new Date('2026-10-30T10:00:00Z'),
} as any;

const message = buildMarketMessage(snapshot, {
  market_id: '5',
  total: 1250000,
  balance: 300000,
  payments: [
    {
      amount: 1250000,
      payment_method: 'card',
      card_name: 'Uzcard 8600',
      reversed: false,
    },
  ],
} as any);

function run(linked: Map<string, boolean> | null) {
  const inserted: Array<Record<string, unknown>> = [];
  const qb: Record<string, jest.Mock> = {};
  for (const m of ['insert', 'into', 'orIgnore', 'returning']) {
    qb[m] = jest.fn(() => qb);
  }
  qb.values = jest.fn((v: Record<string, unknown>) => {
    inserted.push(v);
    return qb;
  });
  qb.execute = jest.fn(() => Promise.resolve({ raw: [{ id: '1' }] }));
  const notifications = { shiftReport: jest.fn().mockResolvedValue(undefined) };
  const svc = Object.create(ShiftReportService.prototype) as Record<
    string,
    any
  >;
  svc.notifications = notifications;
  return svc
    .enqueueRecipient(
      { createQueryBuilder: () => qb },
      snapshot,
      {
        kind: 'market',
        recipient_id: '5',
        message,
        channels: { telegram: true, in_app: false },
      },
      'finance.shift_closed',
      linked,
    )
    .then(() => ({
      inserted,
      payload: notifications.shiftReport.mock.calls[0]?.[0],
    }));
}

describe('BOT-2 #3 — market smena hisoboti: pul faqat shaxsiy chatga', () => {
  it('⭐ egasi ulangan → shaxsiy chat (guruh nishoni YO`Q), to`liq summa', async () => {
    const { inserted, payload } = await run(new Map([['5', true]]));
    expect(inserted.map((r) => r.channel)).toEqual(['telegram']);
    expect(payload.telegram).toBeUndefined();
    expect(payload.channels).toContain('telegram');
    expect(payload.body).toContain('1 250 000');
  });

  it.each([
    ['ulanmagan', new Map([['5', false]])],
    ['holat noma`lum', null],
  ])('⭐ egasi %s → guruhga SUMMASIZ xabar', async (_label, linked) => {
    const { inserted, payload } = await run(linked);
    expect(inserted.map((r) => r.channel)).toEqual(['telegram_group']);
    expect(payload.telegram).toEqual(
      expect.objectContaining({ market_id: '5', group_type: 'create' }),
    );
    const text: string = payload.telegram.text;
    expect(text).toContain(MARKET_GROUP_NOTICE_TITLE);
    for (const money of ['1 250 000', '300 000', 'Uzcard', 'Karta', 'karta']) {
      expect(text).not.toContain(money);
    }
  });
});
