import type { AiAdvisorCandidate } from '@app/common';
import {
  advisorLinks,
  advisorTitle,
  formatDay,
  formatSom,
  withEvidenceHrefs,
} from './advisor-text';
import { AdvisorScheduler } from './advisor.scheduler';

/** BE-5 — server matnlari va havolalar (§5.6, §9.3, §10). */
const base = (over: Partial<AiAdvisorCandidate>): AiAdvisorCandidate => ({
  rule_key: 'R1',
  dedup_key: 'x',
  fact_keys: [],
  branch: null,
  subject: { kind: 'system', id: null, name: null },
  headline_amount: null,
  facts: {},
  evidence: {},
  ...over,
});

describe('advisor-text (BE-5)', () => {
  it('pul: guruhlar bo‘sh joy bilan, minus U+2212, so‘mgacha yaxlit; sana dd.mm.yyyy', () => {
    expect(formatSom(1024000)).toBe('1 024 000');
    expect(formatSom(-18000.4)).toBe('−18 000');
    expect(formatSom(0)).toBe('0');
    expect(formatDay('2026-10-20')).toBe('20.10.2026');
  });

  it('R1 sarlavha: streak va bitta smena; ism yo‘q — #id', () => {
    const facts = {
      cashbox: {
        type: 'branch',
        owner_id: '7',
        name: 'Samarqand filiali kassasi',
      },
      trigger: 'consecutive_negative',
      shifts_count: 3,
      total_difference: -445000,
      last_difference: -240000,
      last_shift_id: '818',
    };
    expect(advisorTitle(base({ facts }))).toBe(
      "Samarqand filiali kassasi: 3 smena ketma-ket kamomad, jami −445 000 so'm",
    );
    expect(
      advisorTitle(
        base({
          facts: {
            ...facts,
            trigger: 'single_shortage',
            cashbox: { owner_id: '7', name: null, id: '7' },
          },
        }),
      ),
    ).toBe("#7: smena kamomadi −240 000 so'm");
  });

  it('R3 sarlavha va operation havolasi (filial / asosiy kassa), dalil href', () => {
    const c = base({
      rule_key: 'R3',
      facts: {
        history_id: '5521',
        amount: 1450000,
        ratio_to_median: 3.4,
        category: { id: '3', name: 'Yoqilg‘i' },
        branch: { id: '9', name: 'Farg‘ona filiali' },
        cashbox: {
          type: 'branch',
          owner_id: '9',
          name: 'Farg‘ona filiali kassasi',
        },
      },
      evidence: {
        kind: 'expense_stats',
        rows: [{ history_id: '5521' }, { history_id: '10' }],
      },
    });
    expect(advisorTitle(c)).toBe(
      "Farg‘ona filiali · Yoqilg‘i: 1 450 000 so'm — odatdagidan 3,4 barobar",
    );
    expect(advisorLinks(c)).toEqual([
      {
        kind: 'operation',
        href: '/payments/cash-detail/9?type=branch&history=5521',
        entity_id: '5521',
        primary: true,
      },
    ]);
    expect(
      (withEvidenceHrefs(c).rows as Array<{ href: string }>).map((r) => r.href),
    ).toEqual([
      '/payments/cash-detail/9?type=branch&history=5521',
      '/payments/cash-detail/9?type=branch&history=10',
    ]);
    const main = base({
      ...c,
      facts: {
        ...c.facts,
        branch: null,
        cashbox: { type: 'main', owner_id: '0', name: 'Asosiy kassa' },
      },
    });
    expect(advisorLinks(main)[0].href).toBe(
      '/payments/main-cashbox?history=5521',
    );
  });

  it('R6: kun/hafta sarlavhasi va financial_balance havolasi; R1 MAIN — main_cashbox', () => {
    const week = base({
      rule_key: 'R6',
      facts: {
        period: 'week',
        from: '2026-10-12',
        to: '2026-10-18',
        net: -1200000,
      },
    });
    expect(advisorTitle(week)).toBe(
      "12.10.2026–18.10.2026 haftasida sof foyda −1 200 000 so'm",
    );
    expect(advisorLinks(week)).toEqual([
      {
        kind: 'financial_balance',
        href: '/financial-balance?tab=history&financialBalanceHistoryFrom=2026-10-12&financialBalanceHistoryTo=2026-10-18',
        entity_id: null,
        primary: true,
      },
    ]);
    const main = base({
      facts: { cashbox: { type: 'main', owner_id: '0' }, last_shift_id: '5' },
    });
    expect(advisorLinks(main).map((l) => l.kind)).toEqual([
      'shift_report',
      'main_cashbox',
    ]);
  });

  it('R2/R4/R5: sarlavha (§9.3) va kassa havolasi; R5 o‘tkazma href', () => {
    const r2 = base({
      rule_key: 'R2',
      subject: { kind: 'courier', id: '55', name: 'Jasur Tursunov' },
      facts: {
        trigger: 'both',
        courier: { id: '55', name: 'Jasur Tursunov' },
        balance: 2840000,
        days_without_handover: 4,
      },
    });
    expect(advisorTitle(r2)).toBe(
      "Jasur Tursunov: 2 840 000 so'm, 4 kundan beri topshirilmagan",
    );
    expect(
      advisorTitle(
        base({
          ...r2,
          facts: { ...r2.facts, trigger: 'growth', growth_days: 3 },
        }),
      ),
    ).toBe("Jasur Tursunov: 2 840 000 so'm — qarz 3 kun ketma-ket o'sgan");
    expect(advisorLinks(r2)).toEqual([
      {
        kind: 'courier_cashbox',
        href: '/payments/cash-detail/55?type=courier',
        entity_id: '55',
        primary: true,
      },
    ]);
    const r4 = base({
      rule_key: 'R4',
      subject: { kind: 'market', id: '70', name: 'Nur Elektronika' },
      facts: {
        market: { id: '70', name: 'Nur Elektronika' },
        debt: 3120000,
        days_without_payout: 9,
      },
    });
    expect(advisorTitle(r4)).toBe(
      "Nur Elektronika: 9 kundan beri to'lov yo'q, qarz 3 120 000 so'm",
    );
    expect(advisorLinks(r4)[0].href).toBe(
      '/payments/cash-detail/70?type=market',
    );
    const r5 = base({
      rule_key: 'R5',
      subject: { kind: 'branch', id: '12', name: 'Urgut filiali' },
      facts: {
        branch: { id: '12', name: 'Urgut filiali' },
        balance: 6400000,
        days_without_transfer: 4,
      },
      evidence: {
        kind: 'branch_transfers',
        transfers: [{ history_id: '77', amount: 1 }],
      },
    });
    expect(advisorTitle(r5)).toBe(
      "Urgut filiali kassasida 6 400 000 so'm — HQ'ga 4 kundan beri o'tkazma yo'q",
    );
    expect(advisorLinks(r5)[0].href).toBe(
      '/payments/cash-detail/12?type=branch',
    );
    expect(
      (withEvidenceHrefs(r5).transfers as Array<{ href: string }>)[0].href,
    ).toBe('/payments/cash-detail/12?type=branch&history=77');
  });

  it('R7: chek (summa + karta), faqat karta, karta qoldig‘i; R8 sarlavha va havolalar', () => {
    const receipt = base({
      rule_key: 'R7',
      facts: {
        source: 'receipt',
        mismatch: ['amount', 'card'],
        branch: { id: '9', name: 'Farg‘ona filiali' },
        cashbox: { type: 'branch', owner_id: '9' },
        entered_amount: 350000,
        read_amount: 332000,
        difference: -18000,
        operation: {
          history_id: '5521',
          kind: 'manual_expense',
          category_name: 'Yoqilg‘i',
        },
      },
    });
    expect(advisorTitle(receipt)).toBe(
      "Farg‘ona filiali · Yoqilg‘i: kiritilgan 350 000 so'm, chekda 332 000 so'm (\u221218 000 so'm). To'lov filial kartasidan emas",
    );
    expect(advisorLinks(receipt)[0]).toMatchObject({
      kind: 'operation',
      href: '/payments/cash-detail/9?type=branch&history=5521',
    });
    expect(
      advisorTitle(
        base({ ...receipt, facts: { ...receipt.facts, mismatch: ['card'] } }),
      ),
    ).toBe("Farg‘ona filiali · Yoqilg‘i: To'lov filial kartasidan emas");
    const card = base({
      rule_key: 'R7',
      facts: {
        source: 'card_balance',
        cashbox: { type: 'main', owner_id: '0', name: 'Asosiy kassa' },
        card: { id: '3', name: 'Humo virtual' },
        entered_amount: 1540000,
        read_amount: 1522000,
        difference: -18000,
        shift: { id: '818', date: '2026-10-21' },
      },
    });
    expect(advisorTitle(card)).toBe(
      "Asosiy kassa · Humo virtual: kiritilgan 1 540 000 so'm, AI o'qigan 1 522 000 so'm (\u221218 000 so'm)",
    );
    expect(advisorLinks(card)).toEqual([
      {
        kind: 'shift_report',
        href: '/payments/shifts/818',
        entity_id: '818',
        primary: true,
      },
    ]);
    const r8 = base({
      rule_key: 'R8',
      facts: { from: '2026-10-12', to: '2026-10-18', count: 14, ratio: 2.3 },
    });
    expect(advisorTitle(r8)).toBe(
      "12.10.2026–18.10.2026: 14 ta tuzatish — 30 kunlik o'rtachadan 2,3 barobar",
    );
    expect(advisorLinks(r8)).toEqual([
      {
        kind: 'corrections',
        href: '/payments/main-cashbox',
        entity_id: null,
        primary: true,
      },
    ]);
  });

  it('sarlavha ≤ 200 belgi', () => {
    const long = base({
      facts: { cashbox: { name: 'x'.repeat(300) }, last_difference: -1 },
    });
    expect(advisorTitle(long).length).toBeLessThanOrEqual(200);
  });
});

describe('AdvisorScheduler env (BE-5)', () => {
  it.each(['off', 'false', '0', 'OFF'])(
    'AI_ADVISOR_RULES=%s — cron yo‘q',
    (v) => {
      const registry = { addCronJob: jest.fn() };
      const s = new AdvisorScheduler(
        {} as never,
        {} as never,
        { get: () => v } as never,
        registry as never,
      );
      expect(s.enabled()).toBe(false);
      s.onModuleInit();
      expect(registry.addCronJob).not.toHaveBeenCalled();
    },
  );

  it('sukut — yoqiq: ikki cron (30 daq va 02:30 Toshkent)', () => {
    const registry = { addCronJob: jest.fn() };
    const s = new AdvisorScheduler(
      {} as never,
      {} as never,
      { get: () => undefined } as never,
      registry as never,
    );
    s.onModuleInit();
    try {
      expect(
        registry.addCronJob.mock.calls.map((c: unknown[]) => c[0]),
      ).toEqual(['ai-advisor-rules-frequent', 'ai-advisor-rules-daily']);
    } finally {
      s.onModuleDestroy();
    }
  });
});
