import { episodeOf } from './advisor-inputs.service';

/** v0.4 epizod chegarasi: eng kech lahza; teng bo'lsa qaytarish > topshirish > musbat qator. */
describe('episodeOf — chegara tanlovi (#702 review)', () => {
  const base = {
    cashbox_id: '1',
    owner: '9',
    balance: '1000',
    last_id: null,
    last_at: null,
    last_amount: null,
    qual_id: null,
    qual_at: null,
    run_id: null,
    run_at: null,
    rev_id: null,
    rev_orig_id: null,
    rev_at: null,
  };
  const at = new Date('2026-10-15T08:00:00.000Z');
  const today = '2026-10-22';

  it('teng vaqt: qaytarish > topshirish > musbat qator boshi', () => {
    const all = {
      ...base,
      qual_id: '5',
      qual_at: at,
      run_id: '3',
      run_at: at,
      rev_id: '8',
      rev_orig_id: '4',
      rev_at: at,
    };
    expect(episodeOf(all, today)?.key).toBe('ep:h:4:r8');
    expect(
      episodeOf(
        { ...all, rev_id: null, rev_orig_id: null, rev_at: null },
        today,
      )?.key,
    ).toBe('ep:h:5');
    expect(
      episodeOf(
        {
          ...all,
          rev_id: null,
          rev_orig_id: null,
          rev_at: null,
          qual_id: null,
          qual_at: null,
        },
        today,
      )?.key,
    ).toBe('ep:p:3');
  });

  it('qat’iy «>»: 1 ms keyinroq bo‘lgan chegara yutadi; kunlar o‘sha kundan', () => {
    const later = new Date(at.getTime() + 1);
    const ep = episodeOf(
      { ...base, qual_id: '5', qual_at: at, run_id: '3', run_at: later },
      today,
    );
    expect(ep).toMatchObject({ key: 'ep:p:3', days: 7 });
    expect(episodeOf(base, today)).toBeNull();
  });
});
