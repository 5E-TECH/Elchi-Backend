import { matchesDeclaredType } from './file-signature';

/**
 * AUDIT S8. `file.mimetype` ni mijoz yozadi (multipart qismining
 * `Content-Type` sarlavhasi), shuning uchun ruxsat etilgan turlar ro'yxati
 * yolg'iz yetarli emas: zararli faylni `image/jpeg` deb e'lon qilib yuklash
 * mumkin edi.
 */
describe('matchesDeclaredType', () => {
  const png = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2,
  ]);
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]);
  const pdf = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d]);
  const xlsx = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0]);
  const mp4 = Buffer.from([0, 0, 0, 0x20, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73]);
  const webm = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0, 0]);
  // MZ — Windows bajariluvchi fayli.
  const exe = Buffer.from([0x4d, 0x5a, 0x90, 0x00, 0, 0]);
  const html = Buffer.from('<html><script>alert(1)</script>', 'utf8');

  it('haqiqiy fayllarni o`tkazadi', () => {
    expect(matchesDeclaredType(png, 'image/png')).toBe(true);
    expect(matchesDeclaredType(jpeg, 'image/jpeg')).toBe(true);
    expect(matchesDeclaredType(jpeg, 'image/jpg')).toBe(true);
    expect(matchesDeclaredType(pdf, 'application/pdf')).toBe(true);
    expect(
      matchesDeclaredType(
        xlsx,
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      ),
    ).toBe(true);
    expect(matchesDeclaredType(mp4, 'video/mp4')).toBe(true);
    expect(matchesDeclaredType(webm, 'video/webm')).toBe(true);
  });

  it('soxta e`lon qilingan turni rad etadi', () => {
    expect(matchesDeclaredType(exe, 'image/jpeg')).toBe(false);
    expect(matchesDeclaredType(html, 'image/png')).toBe(false);
    expect(matchesDeclaredType(png, 'application/pdf')).toBe(false);
    expect(matchesDeclaredType(jpeg, 'video/mp4')).toBe(false);
  });

  it('juda qisqa fayl imzoni qanoatlantira olmaydi', () => {
    expect(matchesDeclaredType(Buffer.from([0xff]), 'image/jpeg')).toBe(false);
    expect(matchesDeclaredType(Buffer.alloc(0), 'image/png')).toBe(false);
  });

  it('imzosi ma`lum bo`lmagan tur uchun ro`yxat qaroriga tegmaydi', () => {
    expect(matchesDeclaredType(exe, 'text/csv')).toBe(true);
  });
});
