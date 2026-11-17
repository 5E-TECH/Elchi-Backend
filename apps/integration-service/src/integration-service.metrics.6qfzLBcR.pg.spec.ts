import { randomUUID } from 'crypto';
import { DataSource } from 'typeorm';
import { IntegrationServiceService } from './integration-service.service';
import { ExternalIntegration } from './entities/external-integration.entity';
import { SyncQueue } from './entities/sync-queue.entity';
import { SyncHistory } from './entities/sync-history.entity';
import { ProviderWebhookLog } from './entities/provider-webhook-log.entity';
import { ProviderShipment } from './entities/provider-shipment.entity';
import {
  ProviderReceivable,
  ReceivableStatus,
} from './entities/provider-receivable.entity';
import {
  ProviderRemittance,
  RemittanceStatus,
} from './entities/provider-remittance.entity';
import { PartnerShipmentRef } from './entities/partner-shipment-ref.entity';
import { PartnerWebhookOutbox } from './entities/partner-webhook-outbox.entity';

/**
 * 6qfzLBcR — integratsiya metrikasining yangi bloklari HAQIQIY Postgres'da
 * (INTEGRATION_PG_TEST_URI bo'lmasa skip). Unit spec SQL matnini qulflaydi,
 * bu yerda esa SQL'ning o'zi bajariladi: `COUNT(*) FILTER`, `:...delivered`
 * ro'yxati, `jsonb` xaritalar (`:status_maps`) va oyna chegarasi.
 * Alohida vaqtinchalik BAZA, sxema entity'lardan (`synchronize`).
 */
const pgUri = process.env.INTEGRATION_PG_TEST_URI;
const describePg = pgUri ? describe : describe.skip;

describePg('integrationMetrics bloklari (6qfzLBcR) — haqiqiy Postgres', () => {
  const dbName = `spec_metrics_${randomUUID().replace(/-/g, '').slice(0, 10)}`;
  let admin: DataSource;
  let db: DataSource;
  let svc: any;
  const table = (name: string) => `"integration_schema"."${name}"`;

  beforeAll(async () => {
    admin = new DataSource({ type: 'postgres', url: pgUri });
    await admin.initialize();
    await admin.query(`CREATE DATABASE "${dbName}"`);
    const url = new URL(pgUri!);
    url.pathname = `/${dbName}`;
    const bootstrap = new DataSource({ type: 'postgres', url: url.toString() });
    await bootstrap.initialize();
    await bootstrap.query('CREATE SCHEMA IF NOT EXISTS "integration_schema"');
    await bootstrap.destroy();
    db = new DataSource({
      type: 'postgres',
      url: url.toString(),
      schema: 'integration_schema',
      entities: [
        ExternalIntegration,
        SyncQueue,
        SyncHistory,
        ProviderWebhookLog,
        ProviderShipment,
        ProviderReceivable,
        ProviderRemittance,
        PartnerShipmentRef,
        PartnerWebhookOutbox,
      ],
      synchronize: true,
    });
    await db.initialize();

    svc = Object.create(IntegrationServiceService.prototype);
    svc.integrationRepo = db.getRepository(ExternalIntegration);
    svc.syncQueueRepo = db.getRepository(SyncQueue);
    svc.syncHistoryRepo = db.getRepository(SyncHistory);
    svc.webhookLogRepo = db.getRepository(ProviderWebhookLog);
    svc.shipmentRepo = db.getRepository(ProviderShipment);
    svc.receivableRepo = db.getRepository(ProviderReceivable);
    svc.remittanceRepo = db.getRepository(ProviderRemittance);
    svc.partnerShipmentRefRepo = db.getRepository(PartnerShipmentRef);
    svc.partnerWebhookOutboxRepo = db.getRepository(PartnerWebhookOutbox);

    const integrations = db.getRepository(ExternalIntegration);
    const integration = (
      slug: string,
      role: ExternalIntegration['role'],
      mapping: ExternalIntegration['inbound_status_mapping'],
    ) =>
      integrations.save(
        integrations.create({
          name: slug,
          slug,
          role,
          api_url: 'https://example.test',
          inbound_status_mapping: mapping,
        }),
      );
    const mapped = await integration('kargo-a', 'carrier', {
      delivered: { status: 'sold', action: 'sell' },
      in_transit: { status: 'on_the_road' },
    });
    const unmapped = await integration('kargo-b', 'carrier', null);
    const payment = await integration('payme', 'payment', null);
    expect([mapped.id, unmapped.id, payment.id]).toEqual(['1', '2', '3']);

    const shipments = db.getRepository(ProviderShipment);
    const shipment = (
      order: string,
      integrationId: string,
      fields: Partial<ProviderShipment>,
    ) =>
      shipments.save(
        shipments.create({
          order_id: order,
          integration_id: integrationId,
          ...fields,
        }),
      );
    // Kargo A (xarita bor), hammasi oynada:
    await shipment('101', '1', {
      provider_status: 'DELIVERED',
      internal_status: 'sold',
    }); // yetkazildi, mos
    await shipment('102', '1', {
      provider_status: 'delivered',
      internal_status: 'on_the_road',
    }); // nomuvofiq (registrga sezgir emas)
    await shipment('103', '1', { last_error: 'HTTP 500' }); // yiqilgan
    await shipment('104', '1', {
      provider_status: 'UNKNOWN_CODE',
      internal_status: 'on_the_road',
    }); // xaritada yo'q — nomuvofiq EMAS
    await shipment('105', '1', {
      internal_status: 'paid',
      status_changed_at: new Date(),
    }); // eski, lekin holati oynada o'zgargan — sanaladi
    await shipment('106', '1', { internal_status: 'sold' }); // eski — sanalmaydi
    // Kargo B (xaritasiz) — nomuvofiqlik `null`.
    await shipment('201', '2', {
      provider_status: 'DELIVERED',
      internal_status: 'on_the_road',
    });
    await shipment('202', '2', { isDeleted: true }); // o'chirilgan — sanalmaydi
    await db.query(
      `UPDATE ${table('provider_shipments')}
          SET "createdAt" = now() - interval '3 days'
        WHERE order_id IN ('105', '106')`,
    );
    await db.query(
      `UPDATE ${table('provider_shipments')}
          SET status_changed_at = now() - interval '3 days'
        WHERE order_id = '106'`,
    );

    const logs = db.getRepository(ProviderWebhookLog);
    const log = (fields: Partial<ProviderWebhookLog>) =>
      logs.save(logs.create({ integration_id: '1', ...fields }));
    await log({ status: 'processed', signature_valid: true });
    await log({ status: 'processed', signature_valid: true });
    await log({ status: 'rejected', signature_valid: false });
    await log({ status: 'failed', signature_valid: true });
    await log({ status: 'verified', signature_valid: true }); // hali qo'llanmagan
    const old = await log({ status: 'processed', signature_valid: true });
    await log({ integration_id: null, status: 'rejected' }); // noma'lum slug
    await db.query(
      `UPDATE ${table('provider_webhook_logs')}
          SET "createdAt" = now() - interval '3 days' WHERE id = $1`,
      [old.id],
    );

    const receivables = db.getRepository(ProviderReceivable);
    const receivable = (
      order: string,
      integrationId: string,
      amount: string,
      status: ReceivableStatus,
    ) =>
      receivables.save(
        receivables.create({
          order_id: order,
          integration_id: integrationId,
          amount,
          status,
        }),
      );
    await receivable('101', '1', '1200000.00', ReceivableStatus.PENDING);
    await receivable('105', '1', '800000.50', ReceivableStatus.SETTLED);
    await receivable('107', '1', '300000.00', ReceivableStatus.CANCELLED);
    await receivable('201', '2', '50000.00', ReceivableStatus.PENDING);
    // Eski qarz — COD butun vaqt, oyna bilan kesilmaydi.
    await db.query(
      `UPDATE ${table('provider_receivables')}
          SET "createdAt" = now() - interval '90 days' WHERE order_id = '105'`,
    );

    const remittances = db.getRepository(ProviderRemittance);
    await remittances.save(
      remittances.create({ integration_id: '1', amount: '1000000.50' }),
    );
    await remittances.save(
      remittances.create({
        integration_id: '1',
        amount: '400000.00',
        status: RemittanceStatus.CANCELLED,
      }),
    );

    const refs = db.getRepository(PartnerShipmentRef);
    for (const external of ['A-1', 'A-2', 'A-3']) {
      await refs.save(
        refs.create({
          partner_id: '7',
          external_order_id: external,
          order_id: '900',
        }),
      );
    }
    await db.query(
      `UPDATE ${table('partner_shipment_refs')}
          SET "createdAt" = now() - interval '3 days'
        WHERE external_order_id = 'A-3'`,
    );
  }, 60_000);

  afterAll(async () => {
    if (db?.isInitialized) await db.destroy();
    if (admin?.isInitialized) {
      await admin.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
      await admin.destroy();
    }
  });

  const metrics = async () => (await svc.integrationMetrics(24)).data;
  const byUid = (d: any, uid: string) =>
    d.connections.find((c: any) => c.uid === uid);

  it('posilkalar: oyna, yetkazildi, yiqilgan va xarita bo‘yicha nomuvofiqlik', async () => {
    const d = await metrics();

    expect(byUid(d, 'integration:1').shipments).toEqual({
      total: 5,
      delivered: 2,
      failed: 1,
      mismatch: 1,
    });
    expect(byUid(d, 'integration:2').shipments).toEqual({
      total: 1,
      delivered: 0,
      failed: 0,
      mismatch: null,
    });
  });

  it('kiruvchi webhooklar: oyna ichida, Hodisalar pillari bilan bir xil holatlar', async () => {
    expect(byUid(await metrics(), 'integration:1').webhooks).toEqual({
      success: 2,
      failed: 2,
      invalid_signature: 1,
    });
  });

  it("COD: butun vaqt, qarz = receivable-balance qoldig'i", async () => {
    const d = await metrics();

    expect(byUid(d, 'integration:1').cod).toEqual({
      dispatched: null,
      collected: 2_000_000.5,
      remitted: 1_000_000.5,
      debt: 1_200_000,
    });
    const balance = (await svc.getProviderBalance('1')).data;
    expect(byUid(d, 'integration:1').cod.debt).toBe(balance.outstanding_amount);
    expect(byUid(d, 'integration:2').cod.debt).toBe(
      (await svc.getProviderBalance('2')).data.outstanding_amount,
    );
  });

  it("hodisasiz ulanishlar ham ro'yxatda; to'lov integratsiyasi — qatorsiz, yo'q", async () => {
    const d = await metrics();

    // Tartib GROUP BY natijasiga bog'liq — to'plam solishtiriladi.
    expect(d.connections.map((c: any) => c.uid).sort()).toEqual([
      'integration:1',
      'integration:2',
      'partner:7',
    ]);
    expect(byUid(d, 'partner:7').shipments).toEqual({
      total: 2,
      delivered: null,
      failed: null,
      mismatch: null,
    });
    expect(byUid(d, 'partner:7').cod).toBeNull();
    expect(d.totals).toEqual({ events: 0, failed: 0, queued: 0 });
  });
});
