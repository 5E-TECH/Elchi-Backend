import { aiAdvisorDefaultRules } from '@app/common';
import { of, throwError } from 'rxjs';
import {
  advisorNotifyBody,
  buildAdvisorDispatch,
  type AdvisorNotifyRow,
} from './advisor-notify';
import { AdvisorRealtime, ADVISOR_REALTIME_EVENT } from './advisor-realtime';

/** BE-5 §9 — bildirishnoma yuki: kanallar, nishon, matn (PII'siz). */
const rules = aiAdvisorDefaultRules();
const row = (over: Partial<AdvisorNotifyRow>): AdvisorNotifyRow => ({
  id: '1041',
  rule_key: 'R2',
  severity: 'critical',
  title: 'zaxira',
  facts: {
    trigger: 'no_handover',
    courier: { id: '55', name: 'Jasur Tursunov' },
    balance: 2840000,
    days_without_handover: 4,
  },
  subject: { kind: 'courier', id: '55', name: 'Jasur Tursunov' },
  branch: { id: '1', name: 'Toshkent HQ' },
  ...over,
});

describe('buildAdvisorDispatch (BE-5 §9.3)', () => {
  it('R2 critical: recipient_ids (roles EMAS), in_app+realtime+telegram, deep link, tugma, deterministik id', () => {
    const p = buildAdvisorDispatch(row({}), {
      recipients: ['1', '5', '1', 'x'],
      rules,
      telegramEnabled: true,
      cabinetUrl: 'https://admin.example.uz/',
    });
    expect(p).toEqual({
      type: 'ai.advisor_alert',
      category: 'finance',
      priority: 'critical',
      recipient_ids: ['1', '5'],
      channels: ['in_app', 'realtime', 'telegram'],
      title: "Jiddiy ogohlantirish · Kuryer qarzi o'smoqda",
      body: "Jasur Tursunov: 2 840 000 so'm, 4 kundan beri topshirilmagan.",
      link: '/ai-assistant?tab=alerts&alert=1041',
      group_key: 'ai.advisor_alert:1041',
      client_request_id: expect.stringMatching(/^[0-9a-f-]{36}$/) as unknown,
      data: {
        alert_id: '1041',
        rule_key: 'R2',
        severity: 'critical',
        variant: null,
        subject_name: 'Toshkent HQ',
        telegram_buttons: [
          [
            {
              text: 'Ogohlantirishni ochish',
              url: 'https://admin.example.uz/ai-assistant?tab=alerts&alert=1041',
            },
          ],
        ],
      },
    });
    expect(p).not.toHaveProperty('roles');
    expect(p?.data).not.toHaveProperty('telegram_cabinet_link');
    const again = buildAdvisorDispatch(row({}), {
      recipients: ['1'],
      rules,
      telegramEnabled: true,
    });
    expect(again?.client_request_id).toBe(p?.client_request_id);
  });

  it('⭐ R7 critical — ilova ichi + realtime, Telegram YO‘Q (Q2 c); sozlamada yoqilsa — bor', () => {
    const r7 = row({
      rule_key: 'R7',
      facts: {
        source: 'receipt',
        mismatch: ['amount', 'card'],
        branch: { id: '9', name: 'Farg‘ona filiali' },
        entered_amount: 350000,
        read_amount: 332000,
        difference: -18000,
        operation: { history_id: '5521', category_name: 'Yoqilg‘i' },
      },
      subject: { kind: 'cashbox', id: '9', name: 'Farg‘ona filiali kassasi' },
      branch: { id: '9', name: 'Farg‘ona filiali' },
    });
    const p = buildAdvisorDispatch(r7, {
      recipients: ['1'],
      rules,
      telegramEnabled: true,
    });
    expect(p?.channels).toEqual(['in_app', 'realtime']);
    expect(p?.title).toBe('Jiddiy ogohlantirish · Chekda farq bor');
    expect(p?.data.variant).toBe('receipt');
    expect(p?.body).toBe(
      "Farg‘ona filiali · Yoqilg‘i: kiritilgan 350 000 so'm, chekda 332 000 so'm (−18 000 so'm). To'lov filial kartasidan emas.",
    );
    const on = { ...rules, R7: { ...rules.R7, telegram: true } };
    expect(
      buildAdvisorDispatch(r7, {
        recipients: ['1'],
        rules: on,
        telegramEnabled: true,
      })?.channels,
    ).toContain('telegram');
    const card = buildAdvisorDispatch(
      row({ rule_key: 'R7', facts: { source: 'card_balance' } }),
      {
        recipients: ['1'],
        rules,
        telegramEnabled: true,
      },
    );
    expect(card?.title).toBe("Jiddiy ogohlantirish · Karta qoldig'ida farq");
    expect(card?.data.variant).toBe('card_balance');
  });

  it('settings.telegram.enabled=false — hech bir qoida Telegram’ga ketmaydi; oluvchi yo‘q — null', () => {
    expect(
      buildAdvisorDispatch(row({}), {
        recipients: ['1'],
        rules,
        telegramEnabled: false,
      })?.channels,
    ).toEqual(['in_app', 'realtime']);
    expect(
      buildAdvisorDispatch(row({}), {
        recipients: [],
        rules,
        telegramEnabled: true,
      }),
    ).toBeNull();
  });

  it('matnda PII yo‘q: chek oluvchi/to‘lovchi ismi, telefon kirmaydi; ≤ 600', () => {
    const body = advisorNotifyBody('R7', {
      source: 'receipt',
      mismatch: ['amount'],
      branch: { name: 'Filial' },
      entered_amount: 1,
      read_amount: 2,
      difference: 1,
      recipient: 'ALIYEV ANVAR',
      payer: 'VALIYEV',
      phone: '+998901234567',
    });
    expect(body).not.toMatch(/ALIYEV|VALIYEV|\+998/);
    expect(
      advisorNotifyBody('R1', {
        cashbox: { name: 'x'.repeat(900) },
        last_difference: -1,
      }).length,
    ).toBeLessThanOrEqual(600);
  });

  it.each([
    [
      'R1',
      {
        trigger: 'consecutive_negative',
        cashbox: { name: 'Asosiy kassa' },
        shifts_count: 3,
        total_difference: -445000,
      },
      "Asosiy kassa: 3 smena ketma-ket kamomad, jami −445 000 so'm.",
    ],
    [
      'R4',
      {
        market: { name: 'Nur Elektronika' },
        days_without_payout: 9,
        debt: 3120000,
      },
      "Nur Elektronika: 9 kundan beri to'lov yo'q, qarz 3 120 000 so'm.",
    ],
    [
      'R5',
      {
        branch: { name: 'Urgut filiali' },
        balance: 6400000,
        days_without_transfer: 4,
      },
      "Urgut filiali kassasida 6 400 000 so'm — HQ'ga 4 kundan beri o'tkazma yo'q.",
    ],
    [
      'R6',
      { period: 'day', from: '2026-10-20', net: -380000 },
      "20.10.2026 kuni sof foyda −380 000 so'm.",
    ],
    [
      'R8',
      { from: '2026-10-12', to: '2026-10-18', count: 14, ratio: 2.3 },
      "12.10.2026–18.10.2026: 14 ta tuzatish — 30 kunlik o'rtachadan 2,3 barobar.",
    ],
  ] as const)('%s body shabloni (§9.3)', (rule, facts, expected) => {
    expect(advisorNotifyBody(rule, facts as Record<string, unknown>)).toBe(
      expected,
    );
  });
});

describe('AdvisorRealtime (BE-5 §12)', () => {
  it('superadmin roliga `realtime.notify` emit; xato yutiladi; GATEWAY yo‘q — jim', () => {
    const emit = jest.fn().mockReturnValue(of(undefined));
    const payload = {
      alert_id: '1',
      rule_key: 'R1',
      severity: 'warning',
      status: 'seen',
      change: 'status' as const,
      explanation_status: 'none',
      at: '2026-10-22T09:00:00.000Z',
    };
    new AdvisorRealtime({ emit } as never).emit([payload]);
    expect(emit).toHaveBeenCalledWith(
      { cmd: 'realtime.notify' },
      {
        event: ADVISOR_REALTIME_EVENT,
        targets: [{ role: 'superadmin' }],
        payload,
      },
    );
    expect(JSON.stringify(emit.mock.calls[0])).not.toMatch(/amount|balance/);
    const failing = jest
      .fn()
      .mockReturnValue(throwError(() => new Error('down')));
    expect(() =>
      new AdvisorRealtime({ emit: failing } as never).emit([payload]),
    ).not.toThrow();
    expect(() => new AdvisorRealtime(undefined).emit([payload])).not.toThrow();
  });
});
