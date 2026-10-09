import { of } from 'rxjs';
import { AuditGatewayController } from './audit-gateway.controller';
import { AuditEnrichmentService } from './audit/audit-enrichment.service';

/**
 * 2WRzdWpZ TC12 — `GET /activity-logs` javobida `description` qaytadi
 * (servis qatoridan enrichment orqali o'zgarmay o'tadi), eski NULL qatorda
 * esa `description: null` (frontend amal yorlig'iga qaytadi). f2Ud5tju:
 * metadata'dagi ip/qurilma ham o'zgarmay o'tadi (frontend chiplari uchun).
 */
describe('AuditGatewayController.list — description (2WRzdWpZ)', () => {
  const rows = [
    {
      id: '2',
      entity_type: 'Order',
      entity_id: '100439',
      action: 'order.cancel',
      description: 'Buyurtma #100439 bekor qilindi',
      metadata: {
        ip: '203.0.113.7',
        device_name: 'Telefon · Android · Chrome',
      },
      created_at: '2026-10-09T10:00:00.000Z',
    },
    {
      id: '1',
      entity_type: 'Order',
      entity_id: '100438',
      action: 'status_change',
      description: null,
      metadata: null,
      created_at: '2026-10-09T09:00:00.000Z',
    },
  ];

  function makeController() {
    const empty = { send: jest.fn(() => of({ data: { items: [] } })) };
    const order = {
      send: jest.fn((pattern: { cmd: string }) =>
        pattern.cmd === 'order.activity_log.find_all'
          ? of({ items: rows, meta: { total: rows.length } })
          : of(null),
      ),
    };
    const enrichment = new AuditEnrichmentService(
      empty as never,
      order as never,
      empty as never,
      empty as never,
      empty as never,
    );
    const controller = new AuditGatewayController(
      empty as never,
      order as never,
      empty as never,
      empty as never,
      empty as never,
      empty as never,
      empty as never,
      empty as never,
      empty as never,
      enrichment,
    );
    return { controller, order };
  }

  it('TC12 description va metadata (ip/qurilma) javobda qaytadi', async () => {
    const { controller, order } = makeController();
    const res = await controller.list({ search: 'bekor' });
    // Qidiruv so'zi servisga uzatiladi (description ILIKE servisda).
    expect(order.send).toHaveBeenCalledWith(
      { cmd: 'order.activity_log.find_all' },
      expect.objectContaining({
        query: expect.objectContaining({ search: 'bekor' }),
      }),
    );
    const items = res.data.items as Array<Record<string, unknown>>;
    expect(items[0]).toMatchObject({
      description: 'Buyurtma #100439 bekor qilindi',
      metadata: {
        ip: '203.0.113.7',
        device_name: 'Telefon · Android · Chrome',
      },
    });
    // TC8 backend tomoni: eski qatorda description NULL, `action` saqlanadi —
    // frontend shu `action` dan yorliq yasaydi.
    expect(items[1]).toMatchObject({
      description: null,
      action: 'status_change',
    });
  });
});
