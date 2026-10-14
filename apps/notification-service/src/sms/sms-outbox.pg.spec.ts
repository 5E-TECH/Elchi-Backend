import { DataSource } from 'typeorm';
import { CreateSmsOutbox1716000000054 } from '../../../../migrations/1716000000054-CreateSmsOutbox';
import { CreateSmsProviderTemplatesConsent1716000000055 } from '../../../../migrations/1716000000055-CreateSmsProviderTemplatesConsent';
import { EncryptSmsSender1716000000068 } from '../../../../migrations/1716000000068-EncryptSmsSender';
import { SmsOutboxConsentIdentity1716000000069 } from '../../../../migrations/1716000000069-SmsOutboxConsentIdentity';
import { SmsOutbox } from '../entities/sms-outbox.entity';
import { Notification } from '../entities/notification.entity';
import { SmsConfigService } from './sms-config.service';
import { SmsBlockedError, SmsGateService } from './sms-gate.service';
import { SmsDuplicateError, SmsOutboxService } from './sms-outbox.service';
import { SmsOutboxScheduler } from './sms-outbox.scheduler';

/**
 * 3fRbyadQ / 8auPBa1O — HAQIQIY Postgres'da (faqat lokal test bazasi):
 * migratsiyalar (054/055/068/069 up+down), UNIQUE client_message_id, kvota
 * poygasi, FOR UPDATE SKIP LOCKED + advisory lock, terminal holat, xarajat
 * hisobotining Toshkent kuni. Real SMS YO'Q — adapter soxta.
 *
 *   SMS_PG_TEST_URI=postgres://postgres@127.0.0.1:55442/elchi_sms_test npx jest sms-outbox.pg
 */
const uri = process.env.SMS_PG_TEST_URI;
const localTestDatabase = (() => {
  if (!uri) return false;
  const url = new URL(uri);
  return (
    ['127.0.0.1', 'localhost'].includes(url.hostname) &&
    url.pathname === '/elchi_sms_test'
  );
})();

const MIGRATIONS = [
  new CreateSmsOutbox1716000000054(),
  new CreateSmsProviderTemplatesConsent1716000000055(),
  new EncryptSmsSender1716000000068(),
  new SmsOutboxConsentIdentity1716000000069(),
];

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

(localTestDatabase ? describe : describe.skip)(
  'sms_outbox — lokal Postgres (3fRbyadQ, 8auPBa1O)',
  () => {
    // To'liq jest parallel yukida migratsiyalar 5 s dan oshishi mumkin.
    jest.setTimeout(30_000);
    let db: DataSource;
    let env: Record<string, unknown>;
    const config = new SmsConfigService({
      get: (key: string) => env[key],
    } as never);
    const consent = {
      partition: <T>(recipients: T[]) =>
        Promise.resolve({ allowed: recipients, blocked: [] as T[] }),
      appendOptOut: (text: string) => `${text}\nRad etish: https://e.uz/s/x`,
    };
    let service: SmsOutboxService;

    const tx = {
      to: '+998901234567',
      text: 'Buyurtma yetkazildi',
      messageClass: 'transactional' as const,
    };
    const rows = (): Promise<Array<Record<string, any>>> =>
      db.query('SELECT * FROM notification_schema.sms_outbox ORDER BY id');

    beforeAll(async () => {
      db = new DataSource({
        type: 'postgres',
        url: uri,
        schema: 'notification_schema',
        entities: [SmsOutbox, Notification],
        extra: { max: 10 },
      });
      await db.initialize();
      await db.query('DROP SCHEMA IF EXISTS notification_schema CASCADE');
      const runner = db.createQueryRunner();
      try {
        for (const migration of MIGRATIONS) await migration.up(runner);
      } finally {
        await runner.release();
      }
      service = new SmsOutboxService(
        db.getRepository(SmsOutbox),
        db.getRepository(Notification),
        db,
        config,
        new SmsGateService(config, db.getRepository(SmsOutbox)),
        consent as never,
      );
    });

    afterAll(async () => {
      if (db?.isInitialized) {
        await db.query('DROP SCHEMA IF EXISTS notification_schema CASCADE');
        await db.destroy();
      }
    });

    beforeEach(async () => {
      env = {
        SMS_ENABLED: 'true',
        SMS_DAILY_CAP: '500',
        SMS_MAX_FANOUT: '200',
        SMS_TARIFF_TRANSACTIONAL: '95',
        SMS_TARIFF_PROMO: '175',
      };
      await db.query('TRUNCATE notification_schema.sms_outbox');
    });

    it('TC1: jadval yaratiladi, client_message_id UNIQUE indeks, (status, next_retry_at) indeks', async () => {
      const indexes: Array<{ indexname: string; indexdef: string }> =
        await db.query(
          `SELECT indexname, indexdef FROM pg_indexes
            WHERE schemaname = 'notification_schema' AND tablename = 'sms_outbox'`,
        );
      const byName = new Map(indexes.map((i) => [i.indexname, i.indexdef]));
      expect(byName.get('UQ_SMS_OUTBOX_CLIENT_MESSAGE_ID')).toMatch(
        /CREATE UNIQUE INDEX .*\(client_message_id\)/,
      );
      expect(byName.get('IDX_SMS_OUTBOX_RETRY')).toMatch(
        /\(status, next_retry_at\)/,
      );
    });

    it('TC2: qayta urinish ustunlari sync_queue bilan bir xil nom va turda', async () => {
      const columns: Array<{
        column_name: string;
        data_type: string;
        column_default: string | null;
      }> = await db.query(
        `SELECT column_name, data_type, column_default FROM information_schema.columns
          WHERE table_schema = 'notification_schema' AND table_name = 'sms_outbox'`,
      );
      const types = Object.fromEntries(
        columns.map((c) => [c.column_name, c.data_type]),
      );
      expect(types).toMatchObject({
        status: 'character varying',
        attempts: 'integer',
        retry_count: 'integer',
        max_attempts: 'integer',
        last_error: 'text',
        last_response: 'jsonb',
        next_retry_at: 'timestamp with time zone',
      });
      expect(
        columns.find((c) => c.column_name === 'max_attempts')?.column_default,
      ).toBe('3');
    });

    it('TC8: bir xil client_message_id ikkinchi marta — DB constraint rad etadi', async () => {
      await service.enqueue([{ ...tx, clientMessageId: 'notif-1' }]);
      await expect(
        service.enqueue([{ ...tx, clientMessageId: 'notif-1' }]),
      ).rejects.toBeInstanceOf(SmsDuplicateError);
      // Xom INSERT ham (servisni chetlab) — constraint darajasida.
      await expect(
        db.query(
          `INSERT INTO notification_schema.sms_outbox
             (to_phone, text, message_class, parts, encoding, provider, client_message_id)
           VALUES ('+998901234567', 't', 'transactional', 1, 'GSM-7', 'eskiz', 'notif-1')`,
        ),
      ).rejects.toMatchObject({ code: '23505' });
      expect(await rows()).toHaveLength(1);
    });

    it('TC6: kvota POYGASIZ — parallel 6 ta enqueue, chegara 4 → aniq 4 qator, qolgani daily_cap_exceeded', async () => {
      env.SMS_DAILY_CAP = '4';
      const results = await Promise.allSettled(
        Array.from({ length: 6 }, (_, index) =>
          service.enqueue([{ ...tx, clientMessageId: `race-${index}` }]),
        ),
      );
      const rejected = results.filter(
        (r): r is PromiseRejectedResult => r.status === 'rejected',
      );
      expect(rejected).toHaveLength(2);
      for (const r of rejected) {
        expect(r.reason).toBeInstanceOf(SmsBlockedError);
        expect(r.reason).toMatchObject({ reason: 'daily_cap_exceeded' });
      }
      expect(await rows()).toHaveLength(4);
    });

    // ==================== rkz0yBxr — OTP alohida oqim ====================

    const otp = (id: string) => ({
      to: '+998901234567',
      text: 'Elchi tasdiqlash kodi: 123456',
      messageClass: 'security' as const,
      senderProfile: 'otp' as const,
      clientMessageId: id,
    });

    it('rkz0yBxr: umumiy kvota (reklama/tranzaksion) TUGAGAN bo‘lsa ham OTP ketadi — kvotalar alohida', async () => {
      env.SMS_DAILY_CAP = '2';
      env.SMS_OTP_DAILY_CAP = '2';
      await service.enqueue([
        { ...tx, clientMessageId: 'g-1' },
        { ...tx, clientMessageId: 'g-2' },
      ]);
      await expect(
        service.enqueue([{ ...tx, clientMessageId: 'g-3' }]),
      ).rejects.toMatchObject({ reason: 'daily_cap_exceeded' });
      // Umumiy kvota to'la — OTP baribir navbatga tushadi.
      await service.enqueue([otp('otp-1')]);
      await service.enqueue([otp('otp-2')]);
      // OTP kvotasi ham o'ziniki: 3-kod rad, umumiy oqimga ta'sir yo'q.
      await expect(service.enqueue([otp('otp-3')])).rejects.toMatchObject({
        reason: 'daily_cap_exceeded',
        details: { stream: 'otp', cap: 2 },
      });
      const stored = await rows();
      expect(stored.map((row) => row.client_message_id).sort()).toEqual(
        ['g-1', 'g-2', 'otp-1', 'otp-2'].sort(),
      );
    });

    it('rkz0yBxr: OTP hujumi (OTP kvotasi to‘la) tranzaksion SMS’ni to‘xtatmaydi', async () => {
      env.SMS_DAILY_CAP = '5';
      env.SMS_OTP_DAILY_CAP = '1';
      await service.enqueue([otp('otp-a')]);
      await expect(service.enqueue([otp('otp-b')])).rejects.toMatchObject({
        reason: 'daily_cap_exceeded',
      });
      await expect(
        service.enqueue([{ ...tx, clientMessageId: 'after-otp' }]),
      ).resolves.toMatchObject({ queued: [expect.any(Object)] });
    });

    it('rkz0yBxr: OTP navbat boshida — oldinroq turgan reklama/tranzaksion qatorlardan OLDIN egallanadi', async () => {
      await service.enqueue(
        Array.from({ length: 5 }, (_, i) => ({
          ...tx,
          clientMessageId: `bulk-${i}`,
        })),
      );
      await sleep(5);
      await service.enqueue([otp('otp-late')]);
      const [first] = await service.claimDue(1);
      expect(first.client_message_id).toBe('otp-late');
      expect(first.message_class).toBe('security');
    });

    it('TC9: ikki parallel claimDue bitta qatorni ikki marta OLMAYDI (FOR UPDATE SKIP LOCKED)', async () => {
      await service.enqueue(
        Array.from({ length: 20 }, (_, i) => ({
          ...tx,
          clientMessageId: `claim-${i}`,
        })),
      );
      const [a, b] = await Promise.all([
        service.claimDue(15),
        service.claimDue(15),
      ]);
      const ids = [...a, ...b].map((row) => String(row.id));
      expect(new Set(ids).size).toBe(ids.length);
      expect(ids).toHaveLength(20);
      expect((await rows()).every((row) => row.status === 'processing')).toBe(
        true,
      );
    });

    it('TC9: ikki scheduler nusxasi bir vaqtda — advisory lock, har SMS ATIGI BIR marta yuboriladi', async () => {
      await service.enqueue(
        Array.from({ length: 5 }, (_, i) => ({
          ...tx,
          clientMessageId: `tick-${i}`,
        })),
      );
      const sent: string[] = [];
      const adapter = {
        send: async (input: { clientMessageId: string }) => {
          await sleep(30);
          sent.push(input.clientMessageId);
          return { providerMessageId: `p-${input.clientMessageId}` };
        },
      };
      const registry = {
        resolve: () => Promise.resolve(adapter),
        callbackUrl: () => null,
      };
      const make = () =>
        new SmsOutboxScheduler(
          config,
          service,
          registry as never,
          { addCronJob: jest.fn() } as never,
          db,
          consent as never,
          new SmsGateService(config, db.getRepository(SmsOutbox)),
        );
      const [first, second] = await Promise.all([make().tick(), make().tick()]);
      const results = [first, second];
      expect(results.filter((r) => r === null)).toHaveLength(1);
      expect(results.find((r) => r !== null)).toEqual({
        processed: 5,
        sent: 5,
        failed: 0,
      });
      expect(sent.sort()).toEqual(
        ['tick-0', 'tick-1', 'tick-2', 'tick-3', 'tick-4'].sort(),
      );
      // 8auPBa1O TC1 (mock adapter): provider_message_id sms_outbox ga yoziladi.
      const stored = await rows();
      expect(stored.every((row) => row.status === 'sent')).toBe(true);
      expect(stored.map((row) => row.provider_message_id).sort()).toEqual(
        sent.map((id) => `p-${id}`).sort(),
      );
      // Qulf bo'shatilgan: keyingi tick bemalol oladi.
      const [lock] = await db.query(
        `SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory'`,
      );
      expect(lock.n).toBe(0);
    });

    it('TC10: 3 marta muvaffaqiyatsiz → terminal failed, boshqa egallanmaydi', async () => {
      await service.enqueue([{ ...tx, clientMessageId: 'fail-1' }]);
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        const [claimed] = await service.claimDue(
          10,
          new Date(Date.now() + attempt * 3_600_000),
        );
        expect(claimed).toBeDefined();
        await service.markFailed(claimed, 'HTTP 503', true);
      }
      const [row] = await rows();
      expect(row).toMatchObject({
        status: 'failed',
        attempts: 3,
        next_retry_at: null,
      });
      expect(
        await service.claimDue(10, new Date(Date.now() + 86_400_000)),
      ).toEqual([]);
    });

    it("TC10/TC11: 'processing' da qotgan qator qayta olinadi, lekin urinish sanaladi — cheksiz emas", async () => {
      await service.enqueue([{ ...tx, clientMessageId: 'stuck-1' }]);
      await db.query(
        `UPDATE notification_schema.sms_outbox
            SET status = 'processing', attempts = 1, updated_at = NOW() - interval '1 hour'`,
      );
      const [recovered] = await service.claimDue(10);
      expect(recovered).toMatchObject({ attempts: 2 });
      await db.query(
        `UPDATE notification_schema.sms_outbox SET updated_at = NOW() - interval '1 hour'`,
      );
      expect(await service.claimDue(10)).toEqual([]);
      const [row] = await rows();
      expect(row).toMatchObject({ status: 'failed', attempts: 3 });
    });

    it('TC11 (shutdown): releaseClaimed urinish sarflamaydi', async () => {
      await service.enqueue([{ ...tx, clientMessageId: 'rel-1' }]);
      const [claimed] = await service.claimDue(10);
      await service.releaseClaimed([String(claimed.id)]);
      const [row] = await rows();
      expect(row).toMatchObject({ status: 'pending', attempts: 0 });
    });

    it('sVByLMnt #3: deferUntil — qator taqiq tugashigacha egallanmaydi, urinish sarflanmaydi', async () => {
      await service.enqueue([{ ...tx, clientMessageId: 'defer-1' }]);
      const [claimed] = await service.claimDue(10);
      const until = new Date(Date.now() + 3_600_000);
      await service.deferUntil(String(claimed.id), until);
      expect(await service.claimDue(10)).toEqual([]);
      const [row] = await rows();
      expect(row).toMatchObject({ status: 'pending', attempts: 0 });
      expect(new Date(row.scheduled_at as string)).toEqual(until);
      expect(
        await service.claimDue(10, new Date(until.getTime() + 1)),
      ).toHaveLength(1);
    });

    it('8auPBa1O TC11: xarajat hisoboti Toshkent kuni bo‘yicha jami SMS va so‘m', async () => {
      await service.enqueue([
        { ...tx, clientMessageId: 'r-1' },
        { ...tx, clientMessageId: 'r-2', text: 'a'.repeat(200) },
        { ...tx, clientMessageId: 'r-3' },
      ]);
      // Toshkent 13-okt 23:30 (=18:30Z) va 14-okt 00:30 (=13-okt 19:30Z) — UTC
      // bo'yicha bitta kun, Toshkent bo'yicha IKKI kun.
      await db.query(
        `UPDATE notification_schema.sms_outbox SET created_at = '2026-10-13T18:30:00Z' WHERE client_message_id = 'r-1'`,
      );
      await db.query(
        `UPDATE notification_schema.sms_outbox SET created_at = '2026-10-13T19:30:00Z', status = 'delivered' WHERE client_message_id IN ('r-2', 'r-3')`,
      );
      const report = await service.costReport(
        new Date('2026-10-12T19:00:00Z'),
        new Date('2026-10-14T19:00:00Z'),
      );
      expect(report.days).toEqual([
        expect.objectContaining({
          day: '2026-10-13',
          message_class: 'transactional',
          total: 1,
          parts: 1,
          cost: 95,
        }),
        expect.objectContaining({
          day: '2026-10-14',
          message_class: 'transactional',
          total: 2,
          delivered: 2,
          parts: 3,
          cost: 285,
        }),
      ]);
      expect(report.months).toEqual([
        expect.objectContaining({ month: '2026-10', total: 3, cost: 380 }),
      ]);
      expect(report.by_class).toEqual([
        expect.objectContaining({
          message_class: 'transactional',
          total: 3,
          delivered: 2,
        }),
      ]);
      expect(report.totals).toMatchObject({
        total: 3,
        cost: 380,
        untariffed: 0,
        tariff_configured: true,
      });
    });

    it('down(): 069 → 054 teskari tartibda jadvallarni olib tashlaydi, up qayta ishlaydi', async () => {
      const runner = db.createQueryRunner();
      try {
        for (const migration of [...MIGRATIONS].reverse())
          await migration.down(runner);
        const [left] = await db.query(
          `SELECT count(*)::int AS n FROM information_schema.tables
            WHERE table_schema = 'notification_schema'
              AND table_name IN ('sms_outbox', 'sms_provider_accounts', 'sms_templates', 'customer_consent', 'sms_campaigns')`,
        );
        expect(left.n).toBe(0);
        for (const migration of MIGRATIONS) await migration.up(runner);
      } finally {
        await runner.release();
      }
    });
  },
);
