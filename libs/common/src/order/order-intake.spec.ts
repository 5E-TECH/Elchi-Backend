import { RpcException } from '@nestjs/microservices';
import {
  ORDER_INTAKE_CLOSED,
  activeOrderIntakeCutoff,
  formatClockTime,
  formatTashkentDateTime,
  orderIntakeClosedError,
  orderIntakeClosedPartnerMessage,
  parseClockTime,
  readOrderIntakeClosed,
  resolveOrderIntakeState,
  resolveOrderIntakeWindow,
} from './order-intake';

/** Toshkent devor soati → UTC lahza (UTC+5, yozgi vaqt yo'q). */
const tashkent = (iso: string) => new Date(`${iso}+05:00`);

describe('order-intake — bugungi qabul vaqti va kun almashish soati', () => {
  describe('parseClockTime / formatClockTime', () => {
    it.each([
      ['00:00', 0],
      ['10:00', 600],
      ['23:59', 1439],
      [' 09:30 ', 570],
    ])('%s → %d', (input, minutes) => {
      expect(parseClockTime(input)).toBe(minutes);
    });

    it.each(['9:00', '24:00', '10:60', '10:00:00', '', 'abc', null, 600, {}])(
      'yaroqsiz: %p → null',
      (input) => {
        expect(parseClockTime(input)).toBeNull();
      },
    );

    it('formatClockTime — ikki xonali, sutka ichida', () => {
      expect(formatClockTime(0)).toBe('00:00');
      expect(formatClockTime(605)).toBe('10:05');
      expect(formatClockTime(1440 + 60)).toBe('01:00');
      expect(formatClockTime(-60)).toBe('23:00');
    });
  });

  describe('resolveOrderIntakeWindow — ish kuni oynasi', () => {
    it('kun 00:00 da almashadi: oyna — Toshkent kalendar kuni', () => {
      const w = resolveOrderIntakeWindow(tashkent('2026-11-09T08:30:00'), 0);
      expect(w.start.toISOString()).toBe('2026-11-08T19:00:00.000Z');
      expect(w.end.toISOString()).toBe('2026-11-09T19:00:00.000Z');
      expect(w.date).toBe('2026-11-09');
    });

    it('server UTC yarim tunidan keyin ham (Toshkent 05:30) — to`g`ri kun', () => {
      const w = resolveOrderIntakeWindow(new Date('2026-11-09T00:30:00Z'), 0);
      expect(w.date).toBe('2026-11-09');
      expect(w.start.toISOString()).toBe('2026-11-08T19:00:00.000Z');
    });

    it('kun 18:00 da almashadi: 19:00 — ertangi ish kuni boshlangan', () => {
      const w = resolveOrderIntakeWindow(
        tashkent('2026-11-09T19:00:00'),
        18 * 60,
      );
      expect(w.start.toISOString()).toBe(
        tashkent('2026-11-09T18:00:00').toISOString(),
      );
      expect(w.end.toISOString()).toBe(
        tashkent('2026-11-10T18:00:00').toISOString(),
      );
      expect(w.date).toBe('2026-11-10');
    });

    it('kun 18:00 da almashadi: 17:59 — hali bugungi ish kuni', () => {
      const w = resolveOrderIntakeWindow(
        tashkent('2026-11-09T17:59:00'),
        18 * 60,
      );
      expect(w.start.toISOString()).toBe(
        tashkent('2026-11-08T18:00:00').toISOString(),
      );
      expect(w.date).toBe('2026-11-09');
    });

    it('aynan almashish daqiqasida — yangi oyna boshlanadi', () => {
      const now = tashkent('2026-11-10T00:00:00');
      const w = resolveOrderIntakeWindow(now, 0);
      expect(w.start.getTime()).toBe(now.getTime());
      expect(w.date).toBe('2026-11-10');
    });

    it('kun 05:00 da almashadi: 04:59 — kechagi ish kuni', () => {
      const w = resolveOrderIntakeWindow(tashkent('2026-11-09T04:59:00'), 300);
      expect(w.date).toBe('2026-11-08');
      expect(w.end.toISOString()).toBe(
        tashkent('2026-11-09T05:00:00').toISOString(),
      );
    });
  });

  describe('resolveOrderIntakeState', () => {
    const windowStart = (dayChange: number, now: Date) =>
      resolveOrderIntakeWindow(now, dayChange).start.toISOString();

    it('sozlama yo`q — cheklovsiz, kun 00:00 (avvalgi xulq)', () => {
      const now = tashkent('2026-11-09T15:00:00');
      const state = resolveOrderIntakeState({ now });
      expect(state).toEqual({
        cutoff_time: null,
        date: '2026-11-09',
        is_open: true,
        closes_at: null,
        reopens_at: null,
        day_change_time: '00:00',
        day_started_at: tashkent('2026-11-09T00:00:00').toISOString(),
        next_day_change_at: tashkent('2026-11-10T00:00:00').toISOString(),
      });
    });

    it('10:00 gacha: 09:59 ochiq, 10:00 dan kun almashguncha yopiq', () => {
      const cutoff = {
        window_start: windowStart(0, tashkent('2026-11-09T08:00:00')),
        date: '2026-11-09',
        cutoff_time: '10:00',
      };
      const before = resolveOrderIntakeState({
        now: tashkent('2026-11-09T09:59:59'),
        cutoff,
      });
      expect(before.is_open).toBe(true);
      expect(before.cutoff_time).toBe('10:00');
      expect(before.closes_at).toBe(
        tashkent('2026-11-09T10:00:00').toISOString(),
      );
      expect(before.reopens_at).toBe(
        tashkent('2026-11-10T00:00:00').toISOString(),
      );

      const at = resolveOrderIntakeState({
        now: tashkent('2026-11-09T10:00:00'),
        cutoff,
      });
      expect(at.is_open).toBe(false);

      const late = resolveOrderIntakeState({
        now: tashkent('2026-11-09T23:59:59'),
        cutoff,
      });
      expect(late.is_open).toBe(false);
    });

    it('kun almashganda cheklov o`zi bekor bo`ladi', () => {
      const cutoff = {
        window_start: windowStart(0, tashkent('2026-11-09T08:00:00')),
        date: '2026-11-09',
        cutoff_time: '10:00',
      };
      const nextDay = resolveOrderIntakeState({
        now: tashkent('2026-11-10T00:00:00'),
        cutoff,
      });
      expect(nextDay).toMatchObject({
        is_open: true,
        cutoff_time: null,
        closes_at: null,
        reopens_at: null,
        date: '2026-11-10',
      });
      // Ertasi kuni soat 10:00 dan keyin ham — ochiq (kechagi cheklov).
      expect(
        resolveOrderIntakeState({
          now: tashkent('2026-11-10T11:00:00'),
          cutoff,
        }).is_open,
      ).toBe(true);
    });

    it('kun 18:00 da almashsa — qabul 10:00 da yopilib, 18:00 da ochiladi', () => {
      const now = tashkent('2026-11-09T08:00:00');
      const cutoff = {
        window_start: windowStart(18 * 60, now),
        date: '2026-11-09',
        cutoff_time: '10:00',
      };
      const closed = resolveOrderIntakeState({
        now: tashkent('2026-11-09T12:00:00'),
        dayChangeTime: '18:00',
        cutoff,
      });
      expect(closed.is_open).toBe(false);
      expect(closed.closes_at).toBe(
        tashkent('2026-11-09T10:00:00').toISOString(),
      );
      expect(closed.reopens_at).toBe(
        tashkent('2026-11-09T18:00:00').toISOString(),
      );
      expect(closed.day_change_time).toBe('18:00');

      const reopened = resolveOrderIntakeState({
        now: tashkent('2026-11-09T18:00:00'),
        dayChangeTime: '18:00',
        cutoff,
      });
      expect(reopened.is_open).toBe(true);
      expect(reopened.date).toBe('2026-11-10');
    });

    it('kun 18:00 da almashsa, kechqurun qo`yilgan 10:00 — ertalabki 10:00', () => {
      const now = tashkent('2026-11-09T20:00:00');
      const state = resolveOrderIntakeState({
        now,
        dayChangeTime: '18:00',
        cutoff: {
          window_start: windowStart(18 * 60, now),
          date: '2026-11-10',
          cutoff_time: '10:00',
        },
      });
      expect(state.is_open).toBe(true);
      expect(state.closes_at).toBe(
        tashkent('2026-11-10T10:00:00').toISOString(),
      );
    });

    it('cheklov = kun almashish soati — butun ish kuni yopiq', () => {
      const now = tashkent('2026-11-09T08:00:00');
      const state = resolveOrderIntakeState({
        now,
        cutoff: {
          window_start: windowStart(0, now),
          date: '2026-11-09',
          cutoff_time: '00:00',
        },
      });
      expect(state.is_open).toBe(false);
      expect(state.closes_at).toBe(state.day_started_at);
    });

    it('buzilgan sozlama — e`tiborsiz (fail open, sukut 00:00)', () => {
      const now = tashkent('2026-11-09T12:00:00');
      const state = resolveOrderIntakeState({
        now,
        dayChangeTime: '25:00',
        cutoff: { window_start: 'yaroqsiz', cutoff_time: '10:00' },
      });
      expect(state.is_open).toBe(true);
      expect(state.day_change_time).toBe('00:00');
      expect(
        activeOrderIntakeCutoff(
          { window_start: windowStart(0, now), cutoff_time: '99:99' },
          resolveOrderIntakeWindow(now, 0),
        ),
      ).toBeNull();
    });
  });

  describe('xato shakli', () => {
    const state = {
      cutoff_time: '10:00',
      reopens_at: tashkent('2026-11-10T00:00:00').toISOString(),
    };

    it('409 ORDER_INTAKE_CLOSED — o`zbekcha matn, qachon ochilishi bilan', () => {
      const error = orderIntakeClosedError(state);
      expect(error).toMatchObject({
        statusCode: 409,
        code: ORDER_INTAKE_CLOSED,
        cutoff_time: '10:00',
        reopens_at: state.reopens_at,
      });
      expect(error.message).toContain('10:00 gacha edi');
      expect(error.message).toContain('10.11.2026 00:00');
    });

    it('hamkor matni — inglizcha', () => {
      const message = orderIntakeClosedPartnerMessage(state);
      expect(message).toContain('Order intake is closed for today');
      expect(message).toContain('cutoff 10:00 Asia/Tashkent');
      expect(message).toContain(state.reopens_at);
    });

    it('formatTashkentDateTime', () => {
      expect(formatTashkentDateTime(new Date('2026-11-09T19:00:00Z'))).toBe(
        '10.11.2026 00:00',
      );
    });

    it('readOrderIntakeClosed — RMQ obyekti, RpcException, ichki error', () => {
      const raw = orderIntakeClosedError(state);
      expect(readOrderIntakeClosed(raw)).toEqual({
        message: raw.message,
        reopens_at: raw.reopens_at,
        cutoff_time: '10:00',
      });
      expect(readOrderIntakeClosed(new RpcException(raw))?.cutoff_time).toBe(
        '10:00',
      );
      expect(readOrderIntakeClosed({ error: raw })?.reopens_at).toBe(
        raw.reopens_at,
      );
      expect(
        readOrderIntakeClosed({ statusCode: 409, message: 'x' }),
      ).toBeNull();
      expect(readOrderIntakeClosed(new Error('timeout'))).toBeNull();
      expect(readOrderIntakeClosed(null)).toBeNull();
    });
  });
});
