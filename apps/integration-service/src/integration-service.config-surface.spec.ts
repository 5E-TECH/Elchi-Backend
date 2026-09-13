import {
  CreateIntegrationRequestDto,
  UpdateIntegrationRequestDto,
} from '../../api-gateway/src/dto/integration.swagger.dto';
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';

/**
 * 0-BOSQICH: KONFIGURATSIYA YUZASI.
 *
 * MUAMMO. Turlarni farqlaydigan 9 ustun entity'da bor va kod ularni O'QIYDI
 * (`receiveWebhook`, `dispatchShipment`), lekin gateway DTO'sida e'lon
 * qilinmagan edi. `main.ts` da `ValidationPipe({ whitelist: true,
 * forbidNonWhitelisted: true })` turgani uchun:
 *   • UI'dan yuborilsa  → jimgina TASHLANADI (xato ham bermaydi)
 *   • curl bilan        → 400 "property should not exist"
 *
 * Ya'ni to'g'ri forma yozilganda ham SAQLANMASDI. Shu test o'sha yuzani
 * qulflab qo'yadi: maydonlar DTO'da bor, validatsiya ishlaydi, va
 * `webhook_secret_previous` ATAYLAB tashqaridan yozilmaydi.
 */

const cfg = {
  name: 'Donoxon',
  type: 'api' as const,
  base_url: 'https://api.donoxon.uz',
  credentials: {},
  status: 'active' as const,
};

const errorsFor = async (cls: any, payload: Record<string, unknown>) => {
  const dto = plainToInstance(cls, payload, {
    excludeExtraneousValues: false,
  });
  const errs = await validate(dto as object, {
    whitelist: true,
    forbidNonWhitelisted: true,
  });
  return errs.map((e) => e.property);
};

describe('0-bosqich — konfiguratsiya maydonlari DTO da', () => {
  const FIELDS = [
    'webhook_secret',
    'webhook_signature_header',
    'webhook_signature_prefix',
    'webhook_algorithm',
    'webhook_id_header',
    'inbound_status_mapping',
    'webhook_payload_paths',
    'dispatch_config',
  ];

  it('⭐ CREATE 8 ta konfiguratsiya maydonini QABUL QILADI', async () => {
    const errs = await errorsFor(CreateIntegrationRequestDto, {
      ...cfg,
      webhook_secret: 's3cret',
      webhook_signature_header: 'x-signature',
      webhook_signature_prefix: 'sha256=',
      webhook_algorithm: 'sha256',
      webhook_id_header: 'x-delivery-id',
      inbound_status_mapping: { delivered: 'sold' },
      webhook_payload_paths: { order_id: 'data.id' },
      dispatch_config: { endpoint: '/v1/orders', method: 'POST' },
    });
    expect(errs).toEqual([]);
  });

  it("⭐ UPDATE ham hammasini qabul qiladi (tahrirlash yo'li ham ochiq)", async () => {
    const errs = await errorsFor(UpdateIntegrationRequestDto, {
      webhook_secret: 's3cret',
      webhook_signature_header: 'x-sig',
      webhook_signature_prefix: 'sha256=',
      webhook_algorithm: 'sha512',
      webhook_id_header: 'x-id',
      inbound_status_mapping: { canceled: 'cancelled' },
      webhook_payload_paths: { status: 'data.state' },
      dispatch_config: { endpoint: '/x' },
    });
    expect(errs).toEqual([]);
  });

  it('har bir maydon ALOHIDA ham qabul qilinadi', async () => {
    for (const f of FIELDS) {
      const value =
        f.endsWith('_mapping') ||
        f.endsWith('_paths') ||
        f === 'dispatch_config'
          ? { a: 'b' }
          : f === 'webhook_algorithm'
            ? 'sha256'
            : 'x';
      const errs = await errorsFor(UpdateIntegrationRequestDto, { [f]: value });
      // Jest `expect` ikkinchi argument (xabar) qabul qilmaydi — maydon nomini
      // natijaning o'ziga qo'shamiz, aks holda qaysi maydon yiqilgani
      // ko'rinmasdi.
      expect({ field: f, errors: errs }).toEqual({ field: f, errors: [] });
    }
  });

  it('⭐ `webhook_secret_previous` TASHQARIDAN yozilmaydi', async () => {
    /**
     * Rotatsiya oynasi TIZIM tomonidan boshqariladi: yangi sekret
     * qo'yilganda servis eskisini o'zi ko'chiradi. Uni DTO'ga qo'shish
     * "eski sekretni qo'lda kiritish" imkonini berardi va himoyani
     * zaiflashtirardi.
     */
    const errs = await errorsFor(UpdateIntegrationRequestDto, {
      webhook_secret_previous: 'qo-lda-kiritilgan',
    });
    expect(errs).toContain('webhook_secret_previous');
  });

  it('⭐ tizim hisoblagichlari ham yozilmaydi', async () => {
    // `last_sync_at` / `total_synced_orders` — tizim yozadi, mijoz emas.
    const errs = await errorsFor(UpdateIntegrationRequestDto, {
      last_sync_at: '2026-01-01',
      total_synced_orders: 999,
    });
    expect(errs).toContain('last_sync_at');
    expect(errs).toContain('total_synced_orders');
  });

  it('`webhook_algorithm` faqat sha256/sha512', async () => {
    // Noto'g'ri algoritm HMAC'ni jimgina buzardi.
    expect(
      await errorsFor(UpdateIntegrationRequestDto, {
        webhook_algorithm: 'md5',
      }),
    ).toContain('webhook_algorithm');
    expect(
      await errorsFor(UpdateIntegrationRequestDto, {
        webhook_algorithm: 'sha512',
      }),
    ).toEqual([]);
  });

  it('JSON maydoniga satr berilsa rad etiladi', async () => {
    expect(
      await errorsFor(UpdateIntegrationRequestDto, {
        dispatch_config: 'salom',
      }),
    ).toContain('dispatch_config');
  });

  it('sarlavha nomlari uzunligi chegaralangan', async () => {
    // Cheklovsiz satr bazaga va keyin HTTP sarlavhasiga tushardi.
    expect(
      await errorsFor(UpdateIntegrationRequestDto, {
        webhook_signature_header: 'x'.repeat(200),
      }),
    ).toContain('webhook_signature_header');
  });
});
