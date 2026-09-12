/**
 * IP ALLOWLIST moslash — hamkor so'rovi ruxsat etilgan manzildan kelganmi.
 *
 * NEGA ALOHIDA FAYL. Bu xavfsizlik qarori va u SINALADIGAN bo'lishi kerak:
 * guard ichida yozilsa, uni test qilish uchun butun HTTP kontekstini taqlid
 * qilish kerak bo'lardi va chekka holatlar (IPv6, `::ffff:` prefiks, xato
 * CIDR) sinovsiz qolardi.
 *
 * ⚠️ MUAMMONING TARIXI: `partners.ip_allowlist` ustuni bazada, admin API'da
 * va UI'da bor edi, lekin HECH QAYERDA TEKSHIRILMASDI. Operator uni
 * to'ldirib, kirish cheklangan deb o'ylardi — aslida har qanday IP'dan
 * ishlardi. Yolg'on xavfsizlik hissi yo'qligidan YOMONROQ, chunki u
 * boshqa choralar ko'rishni to'sadi.
 */

/**
 * IPv4 ni 32-bitli sonda ifodalaydi. Yaroqsiz bo'lsa `null`.
 *
 * `Number` emas, aniq tekshiruv: `Number('1e2')` 100 beradi, ya'nи
 * "1e2.0.0.1" kabi yozuv jimgina o'tib ketardi.
 */
function ipv4ToInt(value: string): number | null {
  const parts = value.split('.');
  if (parts.length !== 4) return null;

  let result = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const n = Number(part);
    if (n > 255) return null;
    result = result * 256 + n;
  }
  return result;
}

/**
 * Manzilni normallashtiradi.
 *
 * `::ffff:203.0.113.10` — IPv4-mapped IPv6. Node bunday shaklda berishi
 * mumkin (`trust proxy` ortida ham uchraydi), va u xom holda solishtirilsa
 * ro'yxatdagi `203.0.113.10` bilan MOS KELMASDI — ya'ni to'g'ri sozlangan
 * allowlist ham hamkorni bloklab qo'yardi.
 */
export function normalizeIp(value: unknown): string {
  const raw = String(value ?? '').trim().toLowerCase();
  if (!raw) return '';
  const mapped = raw.startsWith('::ffff:') ? raw.slice(7) : raw;
  // Portli shakl ("1.2.3.4:5678") — faqat IPv4 uchun xavfsiz kesiladi.
  const noPort =
    mapped.includes(':') && ipv4ToInt(mapped.split(':')[0]) !== null
      ? mapped.split(':')[0]
      : mapped;
  return noPort;
}

/**
 * Bitta qoidaga moslikni tekshiradi. Qoida — aniq IP yoki IPv4 CIDR
 * (`203.0.113.0/24`).
 *
 * CIDR qo'llab-quvvatlanadi, chunki hamkorlar odatda diapazondan chiqadi va
 * aks holda operator 256 ta qator yozishi kerak bo'lardi.
 */
function matchesRule(ip: string, rule: string): boolean {
  const clean = rule.trim().toLowerCase();
  if (!clean) return false;

  if (!clean.includes('/')) {
    // Aniq moslik. IPv6 ham shu yo'l bilan (satr tengligi) ishlaydi.
    return normalizeIp(clean) === ip;
  }

  const [network, bitsRaw] = clean.split('/');
  const bits = Number(bitsRaw);
  if (!/^\d{1,2}$/.test(bitsRaw ?? '') || bits < 0 || bits > 32) return false;

  const netInt = ipv4ToInt(normalizeIp(network));
  const ipInt = ipv4ToInt(ip);
  if (netInt === null || ipInt === null) return false;

  // `/0` — hammasi. `>>> 0` ishorasiz siljish: `<<32` aniqlanmagan xulq.
  if (bits === 0) return true;
  const mask = (0xffffffff << (32 - bits)) >>> 0;
  return (netInt & mask) === (ipInt & mask);
}

/**
 * So'rov IP'si ruxsat etilganmi.
 *
 * ⚠️ RO'YXAT BO'SH/NULL bo'lsa `true` — cheklov YO'Q degani. Bu ataylab:
 * hamkorlarning ko'pchiligida statik IP bo'lmaydi va bo'sh ro'yxatni
 * "hech kimga ruxsat yo'q" deb tushunish barcha mavjud integratsiyani
 * bir zumda o'chirib qo'yardi.
 *
 * ⚠️ IP ANIQLANMASA (bo'sh) va ro'yxat BOR bo'lsa — `false`. Bu ham
 * ataylab: cheklov qo'yilgan joyda "IP'ni bilmadim, o'tkazib yuboraman"
 * degan xulq cheklovni ma'nosiz qilardi.
 */
export function isIpAllowed(
  ip: unknown,
  allowlist: string[] | null | undefined,
): boolean {
  const list = (allowlist ?? []).filter(
    (item) => typeof item === 'string' && item.trim(),
  );
  if (!list.length) return true;

  const normalized = normalizeIp(ip);
  if (!normalized) return false;

  return list.some((rule) => matchesRule(normalized, rule));
}
