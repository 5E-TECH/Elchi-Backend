import { getMetadataArgsStorage } from 'typeorm';
import { SyncQueue } from '../../../integration-service/src/entities/sync-queue.entity';
import { SmsOutbox } from '../entities/sms-outbox.entity';
import {
  SMS_QUOTA_LOCK_NAME,
  SmsOutboxService,
  smsReportRange,
} from './sms-outbox.service';
import { SmsConfigService } from './sms-config.service';
import { SmsBlockedError, SmsGateService } from './sms-gate.service';

/**
 * SmsOutboxService — 3fRbyadQ (kvota qulfi, TC10 terminal holat, TC11
 * shutdown) va 8auPBa1O (TC5/TC6/TC8 DLR, TC9/TC10 narx, TC12 5xx qayta
 * urinish). Real SMS yo'q: provayder umuman chaqirilmaydi, DB — mock.
 */
const env = (extra: Record<string, unknown> = {}) =>
  new SmsConfigService({
    get: (key: string) =>
      ({
        SMS_ENABLED: 'true',
        SMS_DAILY_CAP: '500',
        SMS_MAX_FANOUT: '200',
        SMS_TARIFF_TRANSACTIONAL: '95',
        SMS_TARIFF_PROMO: '175',
        ...extra,
      })[key],
  } as never);

describe('3fRbyadQ TC2 — sms_outbox qayta urinish ustunlari sync_queue bilan AYNAN bir xil', () => {
  const columns = (target: unknown) =>
    Object.fromEntries(
      getMetadataArgsStorage()
        .columns.filter((column) => column.target === target)
        .map((column) => [
          column.propertyName,
          {
            type: String(column.options.type).replace(/^int$/, 'integer'),
            nullable: Boolean(column.options.nullable),
            default: column.options.default as unknown,
          },
        ]),
    );

  it.each([
    'status',
    'attempts',
    'retry_count',
    'max_attempts',
    'last_error',
    'last_response',
    'next_retry_at',
  ])('%s — nomi, turi, nullable va sukuti mos', (name) => {
    const sms = columns(SmsOutbox)[name];
    const sync = columns(SyncQueue)[name];
    expect(sync).toBeDefined();
    expect(sms).toBeDefined();
    expect({ ...sms, type: sms.type.replace(/^varchar$/, 'string') }).toEqual({
      ...sync,
      type: sync.type.replace(/^varchar$/, 'string'),
    });
  });
});

describe('SmsOutboxService', () => {
  let calls: string[];
  let insert: jest.Mock;
  let count: jest.Mock;
  let manager: { query: jest.Mock; getRepository: jest.Mock };
  let transaction: jest.Mock;
  let repo: { update: jest.Mock; findOne: jest.Mock };
  let deliveryPatches: Array<{ ids: unknown; patch: unknown }>;
  let consent: { partition: jest.Mock; appendOptOut: jest.Mock };

  const notifications = () => {
    const qb: Record<string, jest.Mock> = {};
    let patch: unknown;
    qb.update = jest.fn(() => qb);
    qb.set = jest.fn(() => qb);
    qb.setParameter = jest.fn((_: string, value: string) => {
      patch = JSON.parse(value);
      return qb;
    });
    qb.whereInIds = jest.fn((ids: unknown) => {
      deliveryPatches.push({ ids, patch });
      return qb;
    });
    qb.execute = jest.fn().mockResolvedValue({ affected: 1 });
    return { createQueryBuilder: () => qb };
  };

  const make = (config = env()) => {
    const gate = new SmsGateService(config, {
      count: jest.fn(() => {
        throw new Error('kvota qulfsiz (repo orqali) sanalmasin');
      }),
    } as never);
    return new SmsOutboxService(
      repo as never,
      notifications() as never,
      { transaction, query: jest.fn().mockResolvedValue([[], 0]) } as never,
      config,
      gate,
      consent as never,
    );
  };

  beforeEach(() => {
    calls = [];
    deliveryPatches = [];
    insert = jest.fn((rows: unknown[]) => {
      calls.push('insert');
      return Promise.resolve({
        identifiers: rows.map((_, index) => ({ id: String(index + 1) })),
      });
    });
    count = jest.fn(() => {
      calls.push('count');
      return Promise.resolve(0);
    });
    manager = {
      query: jest.fn((sql: string) => {
        if (sql.includes('pg_advisory_xact_lock')) calls.push('lock');
        return Promise.resolve([]);
      }),
      getRepository: jest.fn(() => ({ insert, count })),
    };
    transaction = jest.fn((work: (m: unknown) => Promise<unknown>) => {
      calls.push('begin');
      return work(manager);
    });
    repo = {
      update: jest.fn().mockResolvedValue({ affected: 1 }),
      findOne: jest.fn(),
    };
    consent = {
      partition: jest.fn(<T>(recipients: T[]) =>
        Promise.resolve({ allowed: recipients, blocked: [] }),
      ),
      appendOptOut: jest.fn(
        (text: string) => `${text}\nRad etish: https://e.uz/s/x`,
      ),
    };
  });

  // ==================== 3fRbyadQ #5 — kvota qulfi ====================

  describe('kunlik kvota (3fRbyadQ #5, TC6)', () => {
    const one = {
      to: '+998901234567',
      text: 'Buyurtma yetkazildi',
      messageClass: 'transactional' as const,
    };

    it('sanash va INSERT bitta tranzaksiyada, global advisory xact-lock OSTIDA (poyga yo‘q)', async () => {
      await make().enqueue([one]);
      expect(calls).toEqual(['begin', 'lock', 'count', 'insert']);
      expect(manager.query).toHaveBeenCalledWith(
        'SELECT pg_advisory_xact_lock(hashtext($1))',
        [SMS_QUOTA_LOCK_NAME],
      );
      // Scheduler qulfi bilan ham, integration bilan ham urushmaydi.
      expect(SMS_QUOTA_LOCK_NAME).not.toBe('notification.sms-outbox.tick');
      expect(SMS_QUOTA_LOCK_NAME).not.toMatch(/integration/);
    });

    it('chaqiruvchi tranzaksiyasi berilsa — YANGI tranzaksiya ochilmaydi, qulf o‘sha manager’da', async () => {
      await make().enqueue([one], { manager: manager as never });
      expect(transaction).not.toHaveBeenCalled();
      expect(calls).toEqual(['lock', 'count', 'insert']);
    });

    it('qulf ichidagi sanash kvotaga yetganini ko‘rsa — FAIL-CLOSED, qator yozilmaydi', async () => {
      count.mockImplementation(() => {
        calls.push('count');
        return Promise.resolve(500);
      });
      const error = await make()
        .enqueue([one])
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(SmsBlockedError);
      expect(error).toMatchObject({ reason: 'daily_cap_exceeded' });
      expect(insert).not.toHaveBeenCalled();
    });

    it('SMS_ENABLED=false — qulf ham, sanash ham, INSERT ham yo‘q (TC5)', async () => {
      const error = await make(env({ SMS_ENABLED: 'false' }))
        .enqueue([one])
        .catch((e: unknown) => e);
      expect(error).toMatchObject({ reason: 'sms_disabled' });
      expect(calls).toEqual([]);
    });

    it('takror client_message_id (23505) → SmsDuplicateError (TC8)', async () => {
      insert.mockRejectedValueOnce(
        Object.assign(new Error('duplicate'), { code: '23505' }),
      );
      await expect(
        make().enqueue([{ ...one, clientMessageId: 'notif-1' }]),
      ).rejects.toMatchObject({
        name: 'SmsDuplicateError',
        clientMessageIds: ['notif-1'],
      });
    });
  });

  // ==================== 8auPBa1O #5 — narx ====================

  describe('narx (8auPBa1O #5, TC9/TC10)', () => {
    const latin200 = 'a'.repeat(200);

    it('TC9: lotin 200 belgi → parts=2, cost = 2 × tarif', async () => {
      const result = await make().enqueue([
        { to: '+998901234567', text: latin200, messageClass: 'transactional' },
      ]);
      const row = insert.mock.calls[0][0][0];
      expect(row).toMatchObject({
        parts: 2,
        encoding: 'GSM-7',
        cost: '190.00',
      });
      expect(result.queued[0]).toMatchObject({ parts: 2, cost: 190 });
      expect(result.estimated_cost).toBe(190);
    });

    it('TC10: promo — reklama tarifi, transactional/security — oddiy tarif', async () => {
      await make().enqueue([
        { to: '+998901111111', text: 'Aksiya', messageClass: 'promo' },
        { to: '+998902222222', text: 'Holat', messageClass: 'transactional' },
        { to: '+998903333333', text: 'Kod 1234', messageClass: 'security' },
      ]);
      const [promo, transactional, security] = insert.mock.calls[0][0];
      expect(promo).toMatchObject({ parts: 1, cost: '175.00' });
      expect(transactional).toMatchObject({ parts: 1, cost: '95.00' });
      expect(security).toMatchObject({ parts: 1, cost: '95.00' });
    });

    it('tarif sozlanmagan → cost NULL ("tarif sozlanmagan"), 0 yoki taxmin EMAS', async () => {
      const result = await make(
        env({ SMS_TARIFF_TRANSACTIONAL: '', SMS_TARIFF_PROMO: '' }),
      ).enqueue([
        { to: '+998901234567', text: 'Holat', messageClass: 'transactional' },
      ]);
      expect(insert.mock.calls[0][0][0].cost).toBeNull();
      expect(result.estimated_cost).toBeNull();
    });
  });

  // ==================== markFailed — TC10 / TC12 ====================

  describe('qayta urinish (3fRbyadQ TC10, 8auPBa1O TC12)', () => {
    const row = (attempts: number, extra: Record<string, unknown> = {}) =>
      ({
        id: '9',
        attempts,
        retry_count: attempts,
        max_attempts: 3,
        message_class: 'transactional',
        text: 'Holat',
        notification_id: '77',
        ...extra,
      }) as never;
    const now = new Date('2026-10-14T10:00:00Z');

    it('TC12: provayder 5xx (retryable) → qator YO‘QOLMAYDI: pending + next_retry_at (backoff)', async () => {
      const terminal = await make().markFailed(
        row(0),
        'Eskiz: HTTP 503',
        true,
        null,
        now,
      );
      expect(terminal).toBe(false);
      expect(repo.update).toHaveBeenCalledWith(
        { id: '9' },
        expect.objectContaining({
          status: 'pending',
          attempts: 1,
          retry_count: 1,
          next_retry_at: new Date(now.getTime() + 30_000),
          last_error: 'Eskiz: HTTP 503',
        }),
      );
      // Oraliq xatoda inbox'ga "failed" yozilmaydi.
      expect(deliveryPatches).toEqual([]);
    });

    it('backoff o‘sib boradi: 2-urinishdan keyin 60 s', async () => {
      await make().markFailed(row(1), 'HTTP 502', true, null, now);
      expect(repo.update.mock.calls[0][1]).toMatchObject({
        status: 'pending',
        attempts: 2,
        next_retry_at: new Date(now.getTime() + 60_000),
      });
    });

    it('TC10: 3-muvaffaqiyatsiz urinish → TERMINAL failed, next_retry_at=NULL, delivery.sms=failed', async () => {
      const terminal = await make().markFailed(
        row(2),
        'HTTP 500',
        true,
        null,
        now,
      );
      expect(terminal).toBe(true);
      expect(repo.update.mock.calls[0][1]).toMatchObject({
        status: 'failed',
        attempts: 3,
        retry_count: 2,
        next_retry_at: null,
      });
      expect(deliveryPatches).toEqual([
        { ids: ['77'], patch: { sms: 'failed', sms_error: 'HTTP 500' } },
      ]);
    });

    it('qayta urinib bo‘lmas xato (4xx) → birinchi urinishdayoq terminal', async () => {
      expect(
        await make().markFailed(row(0), 'invalid phone', false, null, now),
      ).toBe(true);
      expect(repo.update.mock.calls[0][1]).toMatchObject({
        status: 'failed',
        next_retry_at: null,
      });
    });

    it('terminal OTP qatorida kod DB’da qolmaydi', async () => {
      await make().markFailed(
        row(2, { message_class: 'security', text: 'Kod: 123456' }),
        'HTTP 500',
        true,
        null,
        now,
      );
      expect(repo.update.mock.calls[0][1]).toMatchObject({
        text: 'Kod: ******',
      });
    });
  });

  // ==================== DLR — 8auPBa1O TC5/TC6/TC8 ====================

  describe('DLR (8auPBa1O #4)', () => {
    const outboxRow = {
      id: '5',
      client_message_id: 'notif-42',
      // Provayder id'si boshqacha — moslashga ta'sir qilmasligi kerak (TC8).
      provider_message_id: 'eskiz-OLD-ID',
      notification_id: '42',
      status: 'sent',
    };
    const report = (status: string, providerStatus: string) => ({
      clientMessageId: 'notif-42',
      status: status as never,
      providerStatus,
      at: new Date('2026-10-14T05:00:00Z'),
    });

    it('TC8: moslash BIZNING client_message_id bo‘yicha (provider id ishlatilmaydi)', async () => {
      repo.findOne.mockResolvedValue(outboxRow);
      await make().applyDeliveryReport(report('delivered', 'DELIVRD'));
      expect(repo.findOne).toHaveBeenCalledWith({
        where: { client_message_id: 'notif-42' },
      });
      expect(JSON.stringify(repo.findOne.mock.calls)).not.toContain(
        'provider_message_id',
      );
    });

    it("TC5: Delivered → dlr_status='delivered', status='delivered', delivery.sms='sent'", async () => {
      repo.findOne.mockResolvedValue(outboxRow);
      expect(
        await make().applyDeliveryReport(report('delivered', 'DELIVRD')),
      ).toBe(true);
      expect(repo.update).toHaveBeenCalledWith(
        { id: '5' },
        expect.objectContaining({
          dlr_status: 'delivered',
          status: 'delivered',
        }),
      );
      expect(deliveryPatches).toEqual([
        { ids: ['42'], patch: { sms: 'sent' } },
      ]);
    });

    it("TC6: NotDelivered → qator 'failed', delivery.sms='failed' ('sent' bo‘lib QOLMAYDI)", async () => {
      repo.findOne.mockResolvedValue(outboxRow);
      await make().applyDeliveryReport(report('not_delivered', 'UNDELIV'));
      expect(repo.update.mock.calls[0][1]).toMatchObject({
        dlr_status: 'not_delivered',
        status: 'failed',
        last_error: 'DLR: UNDELIV',
      });
      expect(deliveryPatches).toEqual([
        { ids: ['42'], patch: { sms: 'failed', sms_error: 'DLR: UNDELIV' } },
      ]);
    });

    it('oraliq holat (transmitted) yakuniy holatni o‘zgartirmaydi', async () => {
      repo.findOne.mockResolvedValue(outboxRow);
      await make().applyDeliveryReport(report('transmitted', 'TRANSMTD'));
      expect(repo.update.mock.calls[0][1]).not.toHaveProperty('status');
      expect(deliveryPatches).toEqual([]);
    });

    it('noma’lum client_message_id → hech narsa o‘zgarmaydi', async () => {
      repo.findOne.mockResolvedValue(null);
      expect(
        await make().applyDeliveryReport(report('delivered', 'DELIVRD')),
      ).toBe(false);
      expect(repo.update).not.toHaveBeenCalled();
    });
  });
});

describe('smsReportRange — xarajat hisoboti oralig‘i Toshkent kuni bo‘yicha (8auPBa1O TC11)', () => {
  it("'YYYY-MM-DD' → Toshkent kuni boshi va (to) kun OXIRIGACHA — UTC yarim tuni emas", () => {
    expect(smsReportRange('2026-10-01', '2026-10-01')).toEqual({
      from: new Date('2026-09-30T19:00:00.000Z'),
      to: new Date('2026-10-01T19:00:00.000Z'),
    });
  });

  it('to‘liq ISO (zona bilan) o‘zgarishsiz', () => {
    expect(
      smsReportRange('2026-10-01T00:00:00+05:00', '2026-11-01T00:00:00+05:00'),
    ).toEqual({
      from: new Date('2026-09-30T19:00:00.000Z'),
      to: new Date('2026-10-31T19:00:00.000Z'),
    });
  });

  it('berilmasa — bugungi Toshkent kuni bilan tugaydigan oxirgi 30 to‘liq kun', () => {
    // Toshkent 14-okt 01:00 (= 13-okt 20:00Z) — "bugun" 14-oktabr.
    const range = smsReportRange(
      undefined,
      undefined,
      new Date('2026-10-13T20:00:00Z'),
    );
    expect(range).toEqual({
      from: new Date('2026-09-14T19:00:00.000Z'),
      to: new Date('2026-10-14T19:00:00.000Z'),
    });
  });

  it('yaroqsiz yoki teskari oraliq → null (400)', () => {
    expect(smsReportRange('garbage', undefined)).toBeNull();
    expect(smsReportRange('2026-10-05', '2026-10-01')).toBeNull();
  });
});
