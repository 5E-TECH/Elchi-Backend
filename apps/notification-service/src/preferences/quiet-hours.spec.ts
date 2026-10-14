import {
  parseQuietWindow,
  quietWindowEnd,
  quietWindowFromContact,
  tashkentMinuteOfDay,
} from './quiet-hours';

/** (mP1WGG1W TC9) Tinch soat hisobi — Toshkent vaqti (UTC emas). */
describe('quiet-hours (mP1WGG1W)', () => {
  const night = parseQuietWindow({ from: '22:00', to: '08:00' })!;

  it('parse: noto‘g‘ri / bo‘sh / from===to → null', () => {
    expect(night).toEqual({ start: 22 * 60, end: 8 * 60 });
    expect(parseQuietWindow(null)).toBeNull();
    expect(parseQuietWindow({ from: '25:00', to: '08:00' })).toBeNull();
    expect(parseQuietWindow({ from: '08:00', to: '08:00' })).toBeNull();
    expect(parseQuietWindow('22:00-08:00')).toBeNull();
  });

  it('frontend sozlamasi { enabled, from, to }: enabled=false → tinch soat yo‘q; true / yo‘q → oyna', () => {
    expect(
      parseQuietWindow({ enabled: false, from: '22:00', to: '08:00' }),
    ).toBeNull();
    expect(
      parseQuietWindow({ enabled: true, from: '22:00', to: '08:00' }),
    ).toEqual(night);
    expect(
      quietWindowFromContact({
        settings: {
          notifications: {
            quiet_hours: { enabled: false, from: '22:00', to: '08:00' },
          },
        },
      }),
    ).toBeNull();
  });

  it('kontaktdan o‘qiladi: quiet_hours | notifications.quiet_hours | settings.notifications.quiet_hours', () => {
    const qh = { from: '22:00', to: '08:00' };
    expect(quietWindowFromContact({ quiet_hours: qh })).toEqual(night);
    expect(
      quietWindowFromContact({ notifications: { quiet_hours: qh } }),
    ).toEqual(night);
    expect(
      quietWindowFromContact({
        settings: { notifications: { quiet_hours: qh } },
      }),
    ).toEqual(night);
    expect(
      quietWindowFromContact({ phone_number: '+998901234567' }),
    ).toBeNull();
  });

  it('TC9: 23:00 Toshkent (= 18:00 UTC) — oyna ichida, tugashi ertangi 08:00 Toshkent (03:00 UTC)', () => {
    const now = new Date('2026-10-14T18:00:00.000Z');
    expect(tashkentMinuteOfDay(now)).toBe(23 * 60);
    expect(quietWindowEnd(now, night)?.toISOString()).toBe(
      '2026-10-15T03:00:00.000Z',
    );
  });

  it('TC9: UTC bo‘yicha hisoblansa xato bo‘lardi — 18:00Z UTC’da 18:00 (oynadan tashqari), Toshkentda 23:00 (ichida)', () => {
    const now = new Date('2026-10-14T18:00:00.000Z');
    expect(now.getUTCHours()).toBe(18);
    expect(quietWindowEnd(now, night)).not.toBeNull();
    // 04:00Z = 09:00 Toshkent — tashqarida (UTC'da 04:00 "tun" bo'lardi).
    expect(
      quietWindowEnd(new Date('2026-10-15T04:00:00.000Z'), night),
    ).toBeNull();
  });

  it('yarim tundan keyin (02:00 Toshkent) — o‘sha kunning 08:00 i', () => {
    const now = new Date('2026-10-14T21:00:00.000Z'); // 02:00 Toshkent, 15-oktabr
    expect(quietWindowEnd(now, night)?.toISOString()).toBe(
      '2026-10-15T03:00:00.000Z',
    );
  });

  it('chegaralar: 08:00 Toshkent — oyna tugagan; 22:00 — boshlangan', () => {
    expect(
      quietWindowEnd(new Date('2026-10-15T03:00:00.000Z'), night),
    ).toBeNull();
    expect(
      quietWindowEnd(
        new Date('2026-10-14T17:00:00.000Z'),
        night,
      )?.toISOString(),
    ).toBe('2026-10-15T03:00:00.000Z');
  });

  it('yarim tundan o‘tmaydigan oyna (13:00–14:00)', () => {
    const lunch = parseQuietWindow({ from: '13:00', to: '14:00' })!;
    expect(
      quietWindowEnd(
        new Date('2026-10-14T08:30:00.000Z'),
        lunch,
      )?.toISOString(),
    ).toBe('2026-10-14T09:00:00.000Z');
    expect(
      quietWindowEnd(new Date('2026-10-14T09:00:00.000Z'), lunch),
    ).toBeNull();
  });
});
