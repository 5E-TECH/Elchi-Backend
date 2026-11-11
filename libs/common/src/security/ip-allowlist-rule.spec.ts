import {
  canonicalIpAllowlistRule,
  normalizeIpAllowlistRules,
} from './ip-allowlist-rule';

describe('canonicalIpAllowlistRule', () => {
  it('to‘g‘ri yozuvlar kanonik shaklga keltiriladi', () => {
    expect(canonicalIpAllowlistRule(' 203.0.113.10 ')).toBe('203.0.113.10');
    expect(canonicalIpAllowlistRule('203.0.113.0/24')).toBe('203.0.113.0/24');
    expect(canonicalIpAllowlistRule('0.0.0.0/0')).toBe('0.0.0.0/0');
    expect(canonicalIpAllowlistRule('2001:0DB8:0000::0001')).toBe(
      '2001:db8::1',
    );
    expect(canonicalIpAllowlistRule('::ffff:203.0.113.10')).toBe(
      '203.0.113.10',
    );
  });

  it('⭐ moslovchi tushunmaydigan yozuv — null (jimgina saqlanmaydi)', () => {
    for (const bad of [
      '',
      '1.2.3.4,5.6.7.8',
      '2001:db8::/32', // IPv6 diapazon qo'llab-quvvatlanmaydi
      '10.0.0.0/33',
      '10.0.0.0/8/1',
      '01.2.3.4',
      '256.1.1.1',
      'example.com',
      'x'.repeat(65),
      42,
    ]) {
      expect(canonicalIpAllowlistRule(bad)).toBeNull();
    }
  });
});

describe('normalizeIpAllowlistRules', () => {
  it('bo‘sh qatorlar tashlanadi, takrorlar birlashtiriladi, xatolar ro‘yxati', () => {
    expect(
      normalizeIpAllowlistRules([
        '1.2.3.4',
        ' ',
        '1.2.3.4',
        '2001:DB8::1',
        'bad',
      ]),
    ).toEqual({ rules: ['1.2.3.4', '2001:db8::1'], invalid: ['bad'] });
  });
});

describe('ultracode review 2 — gateway moslovchisi bilan aylanma test', () => {
  // Gateway moslovchisi (apps/api-gateway/src/auth/ip-allowlist.util.ts)
  // bilan bir xil: mijoz IP'si normallashtirilib qoida bilan solishtiriladi.
  it('host bitli CIDR rad etiladi (yolg‘on keng diapazon ochilmasin)', () => {
    expect(canonicalIpAllowlistRule('203.0.113.10/3')).toBeNull();
    expect(canonicalIpAllowlistRule('203.0.113.10/0')).toBeNull();
    expect(canonicalIpAllowlistRule('203.0.113.0/24')).toBe('203.0.113.0/24');
    expect(canonicalIpAllowlistRule('0.0.0.0/0')).toBe('0.0.0.0/0');
  });

  it('hex IPv4-mapped — dotted IPv4; IPv4-compatible — rad', () => {
    expect(canonicalIpAllowlistRule('::ffff:cb00:710a')).toBe('203.0.113.10');
    expect(canonicalIpAllowlistRule('::203.0.113.10')).toBeNull();
  });
});
