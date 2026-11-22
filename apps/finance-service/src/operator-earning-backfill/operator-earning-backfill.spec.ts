import {
  addCreated,
  addPlanned,
  formatCents,
  formatEarningBackfillReport,
  parseEarningBackfillArgs,
  sortGroups,
  toCents,
  type EarningBackfillGroup,
  type EarningBackfillReport,
  type EarningCandidate,
} from './operator-earning-backfill';

const candidate = (over: Partial<EarningCandidate> = {}): EarningCandidate => ({
  order_id: '1',
  market_id: '7',
  market_name: 'Market A',
  operator_id: '10',
  operator_name: 'Shahzoda',
  operator_deleted: false,
  commission_type: 'percent',
  commission_value: '5.00',
  total_price: '100000.00',
  amount: '5000.00',
  ...over,
});

describe('parseEarningBackfillArgs', () => {
  it('sukut — DRY-RUN', () => {
    expect(parseEarningBackfillArgs([])).toEqual({
      apply: false,
      batchSize: 1000,
      reportLimit: 100,
    });
  });

  it('--apply yozadi, --dry-run doim ustun', () => {
    expect(parseEarningBackfillArgs(['--apply']).apply).toBe(true);
    expect(parseEarningBackfillArgs(['--apply', '--dry-run']).apply).toBe(
      false,
    );
  });

  it('raqamli bayroqlar chegarada tekshiriladi', () => {
    expect(parseEarningBackfillArgs(['--batch=200']).batchSize).toBe(200);
    expect(() => parseEarningBackfillArgs(['--batch=0'])).toThrow('--batch');
    expect(() => parseEarningBackfillArgs(['--batch=5001'])).toThrow('--batch');
    expect(() => parseEarningBackfillArgs(['--report-limit=x'])).toThrow(
      '--report-limit',
    );
  });

  it("noma'lum bayroq (masalan `--aply`) — xato, jim DRY-RUN emas", () => {
    expect(() => parseEarningBackfillArgs(['--aply'])).toThrow(
      "noma'lum bayroq",
    );
  });
});

describe('pul yordamchilari', () => {
  it('toCents / formatCents', () => {
    expect(toCents('617.28')).toBe(61728);
    expect(toCents(null)).toBe(0);
    expect(toCents('abc')).toBe(0);
    expect(formatCents(1061728)).toBe('10 617.28');
    expect(formatCents(5)).toBe('0.05');
  });
});

describe('guruhlash va hisobot', () => {
  it("(market, operator) bo'yicha yig'adi va summa kamayishida saralaydi", () => {
    const groups = new Map<string, EarningBackfillGroup>();
    addPlanned(groups, [
      candidate({ order_id: '1', amount: '100.00' }),
      candidate({ order_id: '2', amount: '50.50' }),
      candidate({
        order_id: '3',
        operator_id: '11',
        operator_name: 'Dilnoza',
        commission_type: 'fixed',
        commission_value: '3000.00',
        amount: '3000.00',
      }),
    ]);
    addCreated(groups, [
      { market_id: '7', operator_id: '10', amount: '100.00' },
    ]);
    const sorted = sortGroups(groups.values());
    expect(
      sorted.map((g) => [g.operator_id, g.planned, g.planned_cents, g.created]),
    ).toEqual([
      ['11', 1, 300000, 0],
      ['10', 2, 15050, 1],
    ]);
  });

  const report = (over: Partial<EarningBackfillReport> = {}) => {
    const groups = new Map<string, EarningBackfillGroup>();
    addPlanned(groups, [
      candidate(),
      candidate({
        order_id: '2',
        operator_id: '13',
        operator_name: 'Ketgan',
        operator_deleted: true,
        amount: '2000.00',
      }),
    ]);
    return {
      apply: false,
      run_id: 'run-1',
      stats: {
        sold_with_operator: 9,
        already_recorded: 1,
        deleted_row_only: 1,
        operator_without_rate: 1,
        operator_other_role: 1,
        unlinked_text_only: 1,
      },
      zero_amount: 1,
      planned: 2,
      planned_cents: 700000,
      created: 0,
      created_cents: 0,
      groups: sortGroups(groups.values()),
      ...over,
    } satisfies EarningBackfillReport;
  };

  it("DRY-RUN matni: rejim, jami, o'chirilgan operator belgisi", () => {
    const text = formatEarningBackfillReport(report(), 10).join('\n');
    expect(text).toContain('DRY-RUN (faqat hisobot, hech narsa yozilmadi)');
    expect(text).toContain(
      'yoziladi (joriy stavka bilan):        2 ta, jami 7 000.00',
    );
    expect(text).toContain(
      'market #7 «Market A» · operator #10 «Shahzoda» · stavka 5%: 1 ta, 5 000.00',
    );
    expect(text).toContain("operator #13 «Ketgan» (o'chirilgan)");
    expect(text).toContain('«Biriktirish» qiladi: 1');
  });

  it("YOZISH matni: yozilgan va poygada o'tkazilganlar", () => {
    const text = formatEarningBackfillReport(
      report({ apply: true, created: 1, created_cents: 500000 }),
      10,
    ).join('\n');
    expect(text).toContain('— YOZISH ===');
    expect(text).toContain(
      'yozildi (joriy stavka bilan):        1 ta, jami 5 000.00',
    );
    expect(text).toContain(
      "shu orada boshqa yo'l bilan yozilgan (o'tkazildi): 1",
    );
  });

  it('--report-limit qatorlarni qisqartiradi', () => {
    const text = formatEarningBackfillReport(report(), 1).join('\n');
    expect(text).toContain('… yana 1 qator');
  });

  it("yoziladigan yo'q bo'lsa — aniq xabar", () => {
    const text = formatEarningBackfillReport(
      report({ planned: 0, planned_cents: 0, groups: [] }),
      10,
    ).join('\n');
    expect(text).toContain("Yoziladigan buyurtma yo'q.");
  });
});
