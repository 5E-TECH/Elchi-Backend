// Credential key is read at service construction — set before importing.
process.env.INTEGRATION_CREDENTIAL_SECRET =
  process.env.INTEGRATION_CREDENTIAL_SECRET ?? 'x'.repeat(40);

import { IntegrationServiceService } from './integration-service.service';
import { computeHmacSignature } from '@app/common';

// Use the REAL hmac functions (pure crypto) but stub the rest of @app/common
// so we don't drag in TypeORM entity metadata.
jest.mock('@app/common', () => {
  const hmac = jest.requireActual('@app/common/webhook/hmac');
  return {
    verifyHmacSignature: hmac.verifyHmacSignature,
    computeHmacSignature: hmac.computeHmacSignature,
    ActivityAction: { WEBHOOK_RECEIVED: 'webhook_received' },
    ActivityLogService: class {},
    Order_status: {},
  };
});

jest.mock('./entities/external-integration.entity', () => ({
  ExternalIntegration: class ExternalIntegration {},
}));
jest.mock('./entities/sync-queue.entity', () => ({
  SyncQueue: class SyncQueue {},
}));
jest.mock('./entities/sync-history.entity', () => ({
  SyncHistory: class SyncHistory {},
}));
jest.mock('./entities/provider-webhook-log.entity', () => ({
  ProviderWebhookLog: class ProviderWebhookLog {},
}));
jest.mock('./entities/provider-shipment.entity', () => ({
  ProviderShipment: class ProviderShipment {},
}));

const SECRET = 'provider-shared-secret';
const BODY = JSON.stringify({ event: 'package.delivered', order_id: '1001' });

function makeService(integration: Record<string, unknown> | null) {
  const integrationRepo: any = {
    findOne: jest.fn().mockResolvedValue(integration),
  };
  const webhookLogRepo: any = {
    findOne: jest.fn().mockResolvedValue(null),
    create: jest.fn((dto: any) => dto),
    save: jest.fn(async (e: any) => ({ id: 'log1', ...e })),
  };
  const syncQueueRepo: any = {};
  const syncHistoryRepo: any = {};
  const shipmentRepo: any = {
    findOne: jest.fn().mockResolvedValue(null),
    findAndCount: jest.fn(),
    create: jest.fn((dto: any) => ({ ...dto })),
    save: jest.fn(async (e: any) => ({ id: 'shp1', ...e })),
  };
  const activityLog: any = { log: jest.fn().mockResolvedValue(undefined) };
  const noClient: any = {};

  const service = new IntegrationServiceService(
    integrationRepo,
    syncQueueRepo,
    syncHistoryRepo,
    webhookLogRepo,
    shipmentRepo,
    activityLog,
    noClient,
    noClient,
    noClient,
    noClient,
  );
  return { service, integrationRepo, webhookLogRepo, shipmentRepo, activityLog };
}

function baseIntegration(overrides: Record<string, unknown> = {}) {
  return {
    id: '5',
    slug: 'acme-cargo',
    isDeleted: false,
    webhook_secret: SECRET, // plaintext → decryptCredential returns as-is
    webhook_secret_previous: null,
    webhook_signature_header: 'x-signature',
    webhook_signature_prefix: null,
    webhook_algorithm: 'sha256',
    webhook_id_header: 'x-delivery-id',
    ...overrides,
  };
}

function bodyToInput(
  slug: string,
  body: string,
  headers: Record<string, string>,
) {
  return {
    slug,
    raw_body_base64: Buffer.from(body, 'utf8').toString('base64'),
    headers,
  };
}

describe('IntegrationServiceService.receiveWebhook', () => {
  it('accepts a correctly signed webhook and logs it', async () => {
    const { service, webhookLogRepo, activityLog } =
      makeService(baseIntegration());
    const sig = computeHmacSignature(BODY, SECRET);

    const res = await service.receiveWebhook(
      bodyToInput('acme-cargo', BODY, {
        'x-signature': sig,
        'x-delivery-id': 'evt_1',
      }),
    );

    expect(res).toMatchObject({ ok: true, code: 200, reason: 'accepted' });
    expect(webhookLogRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({ signature_valid: true, status: 'verified' }),
    );
    expect(activityLog.log).toHaveBeenCalled();
  });

  it('rejects a tampered body (signature mismatch)', async () => {
    const { service, webhookLogRepo } = makeService(baseIntegration());
    const sig = computeHmacSignature(BODY, SECRET);
    const tampered = BODY.replace('1001', '9999');

    const res = await service.receiveWebhook(
      bodyToInput('acme-cargo', tampered, { 'x-signature': sig }),
    );

    expect(res).toMatchObject({
      ok: false,
      code: 401,
      reason: 'invalid_signature',
    });
    expect(webhookLogRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({ signature_valid: false, status: 'rejected' }),
    );
  });

  it('rejects an unknown provider slug', async () => {
    const { service, webhookLogRepo } = makeService(null);

    const res = await service.receiveWebhook(
      bodyToInput('does-not-exist', BODY, { 'x-signature': 'whatever' }),
    );

    expect(res).toMatchObject({
      ok: false,
      code: 401,
      reason: 'unknown_provider',
    });
    expect(webhookLogRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'rejected',
        error: 'integration not found',
      }),
    );
  });

  it('rejects when no webhook secret is configured', async () => {
    const { service } = makeService(baseIntegration({ webhook_secret: null }));

    const res = await service.receiveWebhook(
      bodyToInput('acme-cargo', BODY, { 'x-signature': 'sig' }),
    );

    expect(res).toMatchObject({
      ok: false,
      code: 401,
      reason: 'not_configured',
    });
  });

  it('treats a duplicate delivery_id as an idempotent replay', async () => {
    const { service, webhookLogRepo } = makeService(baseIntegration());
    webhookLogRepo.findOne.mockResolvedValueOnce({ id: 'existing' });
    const sig = computeHmacSignature(BODY, SECRET);

    const res = await service.receiveWebhook(
      bodyToInput('acme-cargo', BODY, {
        'x-signature': sig,
        'x-delivery-id': 'evt_1',
      }),
    );

    expect(res).toMatchObject({ ok: true, reason: 'duplicate', replay: true });
    // No new log written for the replay
    expect(webhookLogRepo.save).not.toHaveBeenCalled();
  });

  it('accepts a signature signed with the previous secret during rotation', async () => {
    const { service } = makeService(
      baseIntegration({
        webhook_secret: 'new-secret',
        webhook_secret_previous: 'old-secret',
      }),
    );
    const sig = computeHmacSignature(BODY, 'old-secret');

    const res = await service.receiveWebhook(
      bodyToInput('acme-cargo', BODY, {
        'x-signature': sig,
        'x-delivery-id': 'evt_2',
      }),
    );

    expect(res).toMatchObject({ ok: true, reason: 'accepted' });
  });

  it('honours a custom signature header and prefix', async () => {
    const { service } = makeService(
      baseIntegration({
        webhook_signature_header: 'x-acme-sign',
        webhook_signature_prefix: 'sha256=',
      }),
    );
    const sig = computeHmacSignature(BODY, SECRET);

    const res = await service.receiveWebhook(
      bodyToInput('acme-cargo', BODY, {
        'x-acme-sign': `sha256=${sig}`,
        'x-delivery-id': 'evt_3',
      }),
    );

    expect(res).toMatchObject({ ok: true, reason: 'accepted' });
  });

  it('extracts the event type from the JSON body', async () => {
    const { service, webhookLogRepo } = makeService(baseIntegration());
    const sig = computeHmacSignature(BODY, SECRET);

    await service.receiveWebhook(
      bodyToInput('acme-cargo', BODY, {
        'x-signature': sig,
        'x-delivery-id': 'evt_4',
      }),
    );

    expect(webhookLogRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({ event_type: 'package.delivered' }),
    );
  });
});

describe('IntegrationServiceService provider shipments', () => {
  it('creates a shipment on first upsert', async () => {
    const { service, shipmentRepo } = makeService(baseIntegration());
    shipmentRepo.findOne.mockResolvedValueOnce(null);

    const res = await service.upsertShipment({
      order_id: '1001',
      integration_id: '5',
      provider_slug: 'acme-cargo',
      external_ref: 'ACME-9',
      tracking_number: 'TRK-9',
      provider_status: 'CREATED',
    });

    expect(res.statusCode).toBe(200);
    expect(shipmentRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({
        order_id: '1001',
        external_ref: 'ACME-9',
        tracking_number: 'TRK-9',
        provider_status: 'CREATED',
      }),
    );
  });

  it('updates the existing shipment row (idempotent on order_id)', async () => {
    const { service, shipmentRepo } = makeService(baseIntegration());
    const existing = {
      id: 'shp1',
      order_id: '1001',
      integration_id: '5',
      send_attempts: 1,
      external_ref: 'ACME-9',
    };
    shipmentRepo.findOne.mockResolvedValueOnce(existing);

    await service.upsertShipment({
      order_id: '1001',
      integration_id: '5',
      provider_status: 'DELIVERED',
      increment_attempt: true,
    });

    const saved = shipmentRepo.save.mock.calls[0][0];
    expect(saved.id).toBe('shp1'); // same row, not a new one
    expect(saved.provider_status).toBe('DELIVERED');
    expect(saved.send_attempts).toBe(2); // incremented
    expect(saved.external_ref).toBe('ACME-9'); // untouched field preserved
  });

  it('finds a shipment by external_ref, falling back to tracking_number', async () => {
    const { service, shipmentRepo } = makeService(baseIntegration());
    shipmentRepo.findOne
      .mockResolvedValueOnce(null) // external_ref miss
      .mockResolvedValueOnce({ id: 'shp1', tracking_number: 'TRK-9' }); // tracking hit

    const found = await service.findShipmentByRef({
      external_ref: 'missing',
      tracking_number: 'TRK-9',
    });
    expect(found).toMatchObject({ id: 'shp1' });
  });

  describe('mapProviderStatus', () => {
    const integration = {
      inbound_status_mapping: {
        DELIVERED: { status: 'sold', action: 'sell' },
        CANCELLED: { status: 'cancelled', action: 'cancel' },
        IN_TRANSIT: { status: 'waiting' },
      },
    } as any;

    it('maps a known terminal status to internal status + action', () => {
      const { service } = makeService(baseIntegration());
      expect(service.mapProviderStatus(integration, 'DELIVERED')).toEqual({
        status: 'sold',
        action: 'sell',
      });
    });

    it('maps an intermediate status with no action', () => {
      const { service } = makeService(baseIntegration());
      expect(service.mapProviderStatus(integration, 'IN_TRANSIT')).toEqual({
        status: 'waiting',
      });
    });

    it('is case-insensitive on the provider code', () => {
      const { service } = makeService(baseIntegration());
      expect(service.mapProviderStatus(integration, 'delivered')).toEqual({
        status: 'sold',
        action: 'sell',
      });
    });

    it('returns null for an unmapped status', () => {
      const { service } = makeService(baseIntegration());
      expect(service.mapProviderStatus(integration, 'WEIRD')).toBeNull();
    });
  });
});
