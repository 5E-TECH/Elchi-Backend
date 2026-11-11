import { RpcException } from '@nestjs/microservices';
import {
  ORDER_INTAKE_CLOSED,
  ORDER_RECEIVE_CLOSED,
  cutoffInstant,
  formatClockTime,
  formatTashkentDateTime,
  orderIntakeClosedError,
  orderIntakeClosedPartnerMessage,
  orderReceiveClosedError,
  parseClockTime,
  readOrderIntakeClosed,
  resolveOrderIntakeState,
  resolveOrderIntakeWindow,
  storedCutoffTime,
} from './order-intake';

/** Toshkent devor soati → UTC lahza (UTC+5, yozgi vaqt yo'q). */
const tashkent = (iso: string) => new Date(`${iso}+05:00`);

describe('order-intake — «Kun tartibi»: chegaralar va kun almashish soati', () => {
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

  describe('resolveOrderIntakeState — doimiy (har kungi) chegaralar', () => {
    const cutoff = (time: string | null) => ({ cutoff_time: time });

    it('sozlama yo`q — cheklovsiz, kun 00:00 (avvalgi xulq)', () => {
      const now = tashkent('2026-11-09T15:00:00');
      const state = resolveOrderIntakeState({ now });
      expect(state).toEqual({
        cutoff_time: null,
        date: '2026-11-09',
        is_open: true,
        closes_at: null,
        reopens_at: null,
        receive_cutoff_time: null,
        receive_is_open: true,
        receive_closes_at: null,
        receive_reopens_at: null,
        day_change_time: '00:00',
        day_started_at: tashkent('2026-11-09T00:00:00').toISOString(),
        next_day_change_at: tashkent('2026-11-10T00:00:00').toISOString(),
      });
    });

    it('10:00 gacha: 09:59 ochiq, 10:00 dan kun almashguncha yopiq', () => {
      const before = resolveOrderIntakeState({
        now: tashkent('2026-11-09T09:59:59'),
        cutoff: cutoff('10:00'),
      });
      expect(before.is_open).toBe(true);
      expect(before.cutoff_time).toBe('10:00');
      expect(before.closes_at).toBe(
        tashkent('2026-11-09T10:00:00').toISOString(),
      );
      expect(before.reopens_at).toBe(
        tashkent('2026-11-10T00:00:00').toISOString(),
      );
      for (const at of ['2026-11-09T10:00:00', '2026-11-09T23:59:59']) {
        expect(
          resolveOrderIntakeState({
            now: tashkent(at),
            cutoff: cutoff('10:00'),
          }).is_open,
        ).toBe(false);
      }
    });

    it('⭐ HAR KUNI takrorlanadi: ertasi kuni 00:00 da ochiladi, 10:00 da yana yopiladi', () => {
      const stored = cutoff('10:00');
      const midnight = resolveOrderIntakeState({
        now: tashkent('2026-11-10T00:00:00'),
        cutoff: stored,
      });
      expect(midnight).toMatchObject({
        is_open: true,
        cutoff_time: '10:00',
        date: '2026-11-10',
        closes_at: tashkent('2026-11-10T10:00:00').toISOString(),
      });
      expect(
        resolveOrderIntakeState({
          now: tashkent('2026-11-10T10:30:00'),
          cutoff: stored,
        }).is_open,
      ).toBe(false);
      // Bir hafta keyin ham — o'sha chegara.
      expect(
        resolveOrderIntakeState({
          now: tashkent('2026-11-17T11:00:00'),
          cutoff: stored,
        }),
      ).toMatchObject({ is_open: false, cutoff_time: '10:00' });
    });

    it('eski (2026-11-09) shakl — `window_start` e`tiborsiz, chegara har kungi', () => {
      const legacy = {
        window_start: tashkent('2026-11-09T00:00:00').toISOString(),
        date: '2026-11-09',
        cutoff_time: '10:00',
      };
      expect(storedCutoffTime(legacy)).toBe('10:00');
      expect(
        resolveOrderIntakeState({
          now: tashkent('2026-11-12T11:00:00'),
          cutoff: legacy,
        }),
      ).toMatchObject({ is_open: false, cutoff_time: '10:00' });
    });

    it('qabul qilish chegarasi — o`z oynasi, yaratish chegarasidan mustaqil', () => {
      const at = (iso: string) =>
        resolveOrderIntakeState({
          now: tashkent(iso),
          cutoff: cutoff('10:00'),
          receiveCutoff: cutoff('16:00'),
        });
      expect(at('2026-11-09T12:00:00')).toMatchObject({
        is_open: false,
        receive_is_open: true,
        receive_cutoff_time: '16:00',
        receive_closes_at: tashkent('2026-11-09T16:00:00').toISOString(),
        receive_reopens_at: tashkent('2026-11-10T00:00:00').toISOString(),
      });
      expect(at('2026-11-09T16:00:00').receive_is_open).toBe(false);
      expect(at('2026-11-10T00:00:00')).toMatchObject({
        is_open: true,
        receive_is_open: true,
      });
      // Faqat qabul chegarasi — yaratish cheklovsiz.
      expect(
        resolveOrderIntakeState({
          now: tashkent('2026-11-09T17:00:00'),
          receiveCutoff: cutoff('16:00'),
        }),
      ).toMatchObject({
        cutoff_time: null,
        is_open: true,
        closes_at: null,
        receive_is_open: false,
      });
    });

    it('kun 18:00 da almashsa — 10:00 da yopilib, 18:00 da ochiladi', () => {
      const closed = resolveOrderIntakeState({
        now: tashkent('2026-11-09T12:00:00'),
        dayChangeTime: '18:00',
        cutoff: cutoff('10:00'),
        receiveCutoff: cutoff('16:00'),
      });
      expect(closed).toMatchObject({
        is_open: false,
        closes_at: tashkent('2026-11-09T10:00:00').toISOString(),
        reopens_at: tashkent('2026-11-09T18:00:00').toISOString(),
        receive_is_open: true,
        receive_closes_at: tashkent('2026-11-09T16:00:00').toISOString(),
        day_change_time: '18:00',
      });
      const reopened = resolveOrderIntakeState({
        now: tashkent('2026-11-09T18:00:00'),
        dayChangeTime: '18:00',
        cutoff: cutoff('10:00'),
      });
      expect(reopened).toMatchObject({
        is_open: true,
        date: '2026-11-10',
        closes_at: tashkent('2026-11-10T10:00:00').toISOString(),
      });
    });

    it('chegara = kun almashish soati — butun ish kuni yopiq', () => {
      const state = resolveOrderIntakeState({
        now: tashkent('2026-11-09T08:00:00'),
        cutoff: cutoff('00:00'),
      });
      expect(state.is_open).toBe(false);
      expect(state.closes_at).toBe(state.day_started_at);
    });

    it('buzilgan sozlama — e`tiborsiz (fail open, sukut 00:00)', () => {
      const state = resolveOrderIntakeState({
        now: tashkent('2026-11-09T12:00:00'),
        dayChangeTime: '25:00',
        cutoff: { cutoff_time: '99:99' },
        receiveCutoff: 'yaroqsiz',
      });
      expect(state).toMatchObject({
        is_open: true,
        cutoff_time: null,
        receive_is_open: true,
        receive_cutoff_time: null,
        day_change_time: '00:00',
      });
      expect(storedCutoffTime(null)).toBeNull();
      expect(storedCutoffTime({ cutoff_time: 600 })).toBeNull();
    });

    it('cutoffInstant — ish kuni ichidagi birinchi shu soat', () => {
      const window = resolveOrderIntakeWindow(
        tashkent('2026-11-09T20:00:00'),
        18 * 60,
      );
      expect(cutoffInstant(window, 10 * 60, 18 * 60).toISOString()).toBe(
        tashkent('2026-11-10T10:00:00').toISOString(),
      );
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

    it('409 ORDER_RECEIVE_CLOSED — qabul qilish chegarasi bilan', () => {
      const error = orderReceiveClosedError({
        receive_cutoff_time: '16:00',
        receive_reopens_at: tashkent('2026-11-10T00:00:00').toISOString(),
      });
      expect(error).toMatchObject({
        statusCode: 409,
        code: ORDER_RECEIVE_CLOSED,
        receive_cutoff_time: '16:00',
        reopens_at: tashkent('2026-11-10T00:00:00').toISOString(),
      });
      expect(error.message).toContain('qabul qilish vaqti tugagan');
      expect(error.message).toContain('16:00 gacha edi');
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
