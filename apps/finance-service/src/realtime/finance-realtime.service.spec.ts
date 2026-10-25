import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { Logger } from '@nestjs/common';
import { Roles } from '../../../../libs/common/enums';
import {
  BRANCH_SHIFT_ROLE,
  CASHBOX_CARD_ROLES,
  FINANCE_REALTIME_EVENTS,
  FinanceRealtimeService,
  GATEWAY_OUTBOX_TARGET,
  MAIN_SHIFT_ROLES,
  REALTIME_NOTIFY_PATTERN,
  buildCashboxCardChangedMessage,
  buildShiftAccountCheckedMessage,
  buildShiftClosedMessage,
} from './finance-realtime.service';

/**
 * rWdLuoP3 (2026-10-25) — smena / kassa kartasi realtime hodisalari:
 * frontend `FINANCE_SHIFT_EVENTS` nomlari, payload (`closed_at`) va NISHONLAR
 * (kassa doirasi — boshqa filial ma'lumoti chiqmaydi).
 */
describe('rWdLuoP3 — finance realtime hodisalari (nomlar, payload, nishonlar)', () => {
  const mainShift = {
    id: '31',
    cashbox_user_id: '0',
    opened_by: '5',
    closed_by: '7',
    closed_at: new Date('2026-10-25T13:00:00.000Z'),
  };
  const branchShift = { ...mainShift, id: '44', cashbox_user_id: '15' };

  it('nomlar frontend `FINANCE_SHIFT_EVENTS` bilan bir xil', () => {
    expect([
      FINANCE_REALTIME_EVENTS.shiftClosed,
      FINANCE_REALTIME_EVENTS.shiftAutoClosed,
      FINANCE_REALTIME_EVENTS.shiftAccountChecked,
    ]).toEqual([
      'finance.shift.closed',
      'finance.shift.auto_closed',
      'finance.shift.account_checked',
    ]);
  });

  it('rol nomlari `Roles` enum qiymatlari (gateway xonasi `role:<rol>` kichik harfda)', () => {
    expect([...MAIN_SHIFT_ROLES]).toEqual([
      Roles.SUPERADMIN,
      Roles.ADMIN,
      Roles.REGISTRATOR,
    ]);
    expect(BRANCH_SHIFT_ROLE).toBe(Roles.MANAGER);
    expect([...CASHBOX_CARD_ROLES]).toEqual([Roles.SUPERADMIN, Roles.ADMIN]);
  });

  it('MAIN smena qo`lda yopildi → `finance.shift.closed`, `closed_at` ISO; nishon — superadmin/admin/registrator + ochgan/yopgan xodim', () => {
    const message = buildShiftClosedMessage(mainShift, 'manual');
    expect(message.event).toBe('finance.shift.closed');
    expect(message.payload).toEqual({
      shift_id: '31',
      cashbox_user_id: '0',
      cashbox_type: 'main',
      branch_id: null,
      status: 'closed',
      close_reason: 'manual',
      closed_at: '2026-10-25T13:00:00.000Z',
      closed_by: '7',
      opened_by: '5',
    });
    expect(message.targets).toEqual([
      { role: 'superadmin' },
      { role: 'admin' },
      { role: 'registrator' },
      { user_id: '5' },
      { user_id: '7' },
    ]);
  });

  it('avtomatik yopish → `finance.shift.auto_closed`, `close_reason: auto`; yopgan xodim yo`q (tizim) — faqat ochgan kassir', () => {
    const message = buildShiftClosedMessage(
      { ...mainShift, closed_by: null },
      'auto',
    );
    expect(message.event).toBe('finance.shift.auto_closed');
    expect(message.payload).toMatchObject({
      close_reason: 'auto',
      closed_by: null,
      closed_at: '2026-10-25T13:00:00.000Z',
    });
    expect(message.targets).toContainEqual({ user_id: '5' });
    expect(message.targets).not.toContainEqual({ user_id: 'null' });
  });

  it('⭐ FILIAL smenasi → FAQAT shu filial menejerlari (`role: manager, branch_id: 15`) + kassir; superadmin/admin/registrator va boshqa filial — YO`Q', () => {
    const message = buildShiftClosedMessage(branchShift, 'auto');
    expect(message.payload).toMatchObject({
      cashbox_user_id: '15',
      cashbox_type: 'branch',
      branch_id: '15',
    });
    expect(message.targets).toEqual([
      { role: 'manager', branch_id: '15' },
      { user_id: '5' },
      { user_id: '7' },
    ]);
    // Rolning HAMMA filialiga (branch_id siz) nishon yo'q.
    expect(message.targets.filter((t) => t.role && !t.branch_id)).toEqual([]);
  });

  it('ochgan = yopgan xodim — bitta `user_id` nishoni; `cashbox_user_id` null — MAIN', () => {
    const message = buildShiftClosedMessage(
      { id: 9, cashbox_user_id: null, opened_by: 5, closed_by: '5' },
      'manual',
    );
    expect(message.payload).toMatchObject({
      shift_id: '9',
      cashbox_type: 'main',
    });
    expect(message.targets.filter((t) => t.user_id)).toEqual([
      { user_id: '5' },
    ]);
  });

  it('payload`da pul summasi yo`q (kutilgan/sanalgan qoldiq, kamomad) — faqat id va vaqt', () => {
    const message = buildShiftClosedMessage(
      {
        ...mainShift,
        expected_balance_cash: 1_000,
        discrepancy_cash: -5,
      } as never,
      'manual',
    );
    expect(JSON.stringify(message.payload)).not.toMatch(/balance|discrepancy/);
  });

  it('`finance.shift.account_checked` (kiZgTybn uchun) — shu smena kassasi doirasi', () => {
    const message = buildShiftAccountCheckedMessage({
      shift: branchShift,
      card_id: 3,
      ai_status: 'mismatch',
      checked_at: '2026-10-25T12:59:00.000Z',
    });
    expect(message.event).toBe('finance.shift.account_checked');
    expect(message.payload).toEqual({
      shift_id: '44',
      cashbox_user_id: '15',
      cashbox_type: 'branch',
      branch_id: '15',
      card_id: '3',
      ai_status: 'mismatch',
      checked_at: '2026-10-25T12:59:00.000Z',
    });
    expect(message.targets[0]).toEqual({ role: 'manager', branch_id: '15' });
  });

  it('`finance.cashbox.card_changed` — faqat superadmin/admin (kartalar MAIN kassada), takrorsiz karta id lari', () => {
    const message = buildCashboxCardChangedMessage({
      action: 'transfer',
      card_ids: ['3', 3, '4'],
      movement_id: 12,
      at: '2026-10-25T10:00:00.000Z',
    });
    expect(message).toEqual({
      event: 'finance.cashbox.card_changed',
      payload: {
        action: 'transfer',
        cashbox_type: 'main',
        card_ids: ['3', '4'],
        movement_id: '12',
        at: '2026-10-25T10:00:00.000Z',
      },
      targets: [{ role: 'superadmin' }, { role: 'admin' }],
    });
  });
});

describe('rWdLuoP3 — FinanceRealtimeService → outbox (`GATEWAY` / `realtime.notify`)', () => {
  const config = (queue: string | undefined) =>
    ({
      get: (key: string) =>
        key === 'RABBITMQ_GATEWAY_QUEUE' ? queue : undefined,
    }) as never;
  const shift = {
    id: '31',
    cashbox_user_id: '0',
    opened_by: '5',
    closed_by: '5',
    closed_at: new Date('2026-10-25T13:00:00.000Z'),
  };

  let warn: jest.SpyInstance;
  beforeEach(() => {
    warn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('tranzaksiya manager i bilan outbox`ga yozadi (rollback bo`lsa hodisa ham yo`q)', async () => {
    const outbox = { enqueue: jest.fn().mockResolvedValue(undefined) };
    const service = new FinanceRealtimeService(
      outbox as never,
      config('gateway_queue'),
    );
    const manager = { queryRunner: { isTransactionActive: true } };
    await service.shiftClosed(shift, 'manual', manager as never);
    expect(outbox.enqueue).toHaveBeenCalledTimes(1);
    expect(outbox.enqueue).toHaveBeenCalledWith(
      GATEWAY_OUTBOX_TARGET,
      REALTIME_NOTIFY_PATTERN,
      {
        event: 'finance.shift.closed',
        payload: expect.objectContaining({
          shift_id: '31',
          closed_at: '2026-10-25T13:00:00.000Z',
        }),
        targets: expect.arrayContaining([{ role: 'admin' }, { user_id: '5' }]),
      },
      { manager },
    );
    expect([GATEWAY_OUTBOX_TARGET, REALTIME_NOTIFY_PATTERN]).toEqual([
      'GATEWAY',
      'realtime.notify',
    ]);
  });

  it('`RABBITMQ_GATEWAY_QUEUE` sozlanmagan / bo`sh — hech narsa yozilmaydi', async () => {
    for (const queue of [undefined, '', '  ']) {
      const outbox = { enqueue: jest.fn() };
      const service = new FinanceRealtimeService(
        outbox as never,
        config(queue),
      );
      await service.shiftClosed(shift, 'auto');
      await service.cashboxCardChanged({ action: 'created', card_ids: ['1'] });
      expect(outbox.enqueue).not.toHaveBeenCalled();
    }
  });

  it('FAIL-OPEN: tranzaksiyasiz outbox xatosi — WARN, pul amali yiqilmaydi', async () => {
    const outbox = {
      enqueue: jest.fn().mockRejectedValue(new Error('db down')),
    };
    const service = new FinanceRealtimeService(
      outbox as never,
      config('gateway_queue'),
    );
    await expect(
      service.cashboxCardChanged({ action: 'renamed', card_ids: ['2'] }),
    ).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
  });

  it('tranzaksiya ichidagi DB xatosi qayta otiladi (Postgres tranzaksiyasi buzilgan — chaqiruvchi rollback qiladi)', async () => {
    const outbox = {
      enqueue: jest.fn().mockRejectedValue(new Error('aborted')),
    };
    const service = new FinanceRealtimeService(
      outbox as never,
      config('gateway_queue'),
    );
    await expect(
      service.shiftClosed(shift, 'manual', {
        queryRunner: { isTransactionActive: true },
      } as never),
    ).rejects.toThrow('aborted');
  });

  it('payload qurishdagi xato (yaroqsiz smena) — WARN, outbox`ga yozilmaydi, xato chiqmaydi', async () => {
    const outbox = { enqueue: jest.fn() };
    const service = new FinanceRealtimeService(
      outbox as never,
      config('gateway_queue'),
    );
    await expect(
      service.shiftClosed(null as never, 'manual'),
    ).resolves.toBeUndefined();
    expect(outbox.enqueue).not.toHaveBeenCalled();
  });
});

describe('rWdLuoP3 — `realtime.notify` finance`dan FAQAT outbox orqali', () => {
  const SRC = join(__dirname, '..');
  const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const full = join(dir, name);
      return statSync(full).isDirectory() ? walk(full) : [full];
    });
  const strip = (src: string) =>
    src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  it('grep bo`sh: GATEWAY mijozi inject qilinmaydi, `realtime.notify` to`g`ridan-to`g`ri yuborilmaydi (rollback bo`lsa ham hodisa ketardi)', () => {
    const offenders: string[] = [];
    for (const file of walk(SRC).filter(
      (f) => f.endsWith('.ts') && !f.endsWith('.spec.ts'),
    )) {
      const src = strip(readFileSync(file, 'utf8'));
      if (
        /@Inject\(\s*['"]GATEWAY['"]\s*\)/.test(src) ||
        /\.(send|emit)\(\s*\{\s*cmd:\s*['"]realtime\./.test(src)
      ) {
        offenders.push(file.replace(SRC, ''));
      }
    }
    expect(offenders).toEqual([]);
  });
});
