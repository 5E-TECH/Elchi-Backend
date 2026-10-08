import { maskPiiPayload } from './mask-payload';

/**
 * Xd88lHGq — webhook payload ko'rgichi. Tuzilma va tashxis maydonlari
 * qoladi, mijozning shaxsiy ma'lumoti yashiriladi.
 */
describe('maskPiiPayload', () => {
  const payload = {
    event: 'shipment.status_changed',
    shipment: {
      external_ref: 'EXT-991',
      status: 'delivered',
      cod_amount: 250000,
      buyurtma_id: '1251133',
      product_name: 'Telefon g‘ilofi',
    },
    customer: {
      name: 'Aliyev Vali',
      phone: '+998901237434',
      phones: ['998901112233', '+998 90 555 44 33'],
      email: 'vali@example.com',
      address: 'Toshkent, Chilonzor 12-kvartal, 45-uy',
      region: 'Toshkent',
      district: 'Chilonzor',
      lat: 41.28,
    },
    note: 'Qo‘ng‘iroq qiling: 90 123 45 67',
  };

  it('⭐ telefon, ism, manzil, email maskalanadi', () => {
    const masked = maskPiiPayload(payload);

    expect(masked.customer.phone).toBe('***7434');
    expect(masked.customer.phones).toEqual(['***2233', '***4433']);
    expect(masked.customer.name).toBe('A. V.');
    expect(masked.customer.email).toBe('v***@example.com');
    expect(masked.customer.address).toBe('Toshkent, ***');
    expect(masked.customer.lat).toBe('***');
    expect(masked.note).not.toContain('123 45 67');
  });

  it('tashxis maydonlari va hudud o`zgarmaydi', () => {
    const masked = maskPiiPayload(payload);

    expect(masked.event).toBe('shipment.status_changed');
    expect(masked.shipment).toEqual(payload.shipment);
    expect(masked.customer.region).toBe('Toshkent');
    expect(masked.customer.district).toBe('Chilonzor');
  });

  it('kirish o`zgartirilmaydi; null va aylanma tuzilmaga chidaydi', () => {
    const copy = JSON.parse(JSON.stringify(payload));
    maskPiiPayload(payload);
    expect(payload).toEqual(copy);

    expect(maskPiiPayload(null)).toBeNull();
    const loop: Record<string, unknown> = { a: 1 };
    loop.self = loop;
    expect(maskPiiPayload(loop).self).toBe('[chuqur]');
  });

  it('raqamli birinchi bo`lakli manzil butunlay yashiriladi', () => {
    expect(maskPiiPayload({ address: '12-uy, Chilonzor' })).toEqual({
      address: '***',
    });
  });
});
