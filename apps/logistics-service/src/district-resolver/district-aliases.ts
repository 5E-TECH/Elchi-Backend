/**
 * D3/D5 — tuman nomlarining muqobil yozuvlari (SOATO kaliti bilan).
 *
 * Kalit — tumanning SOATO kodi (`districts.sato_code`), qiymat —
 * "skelet" ko'rinishdagi muqobil nomlar: `normGeo` dan keyin harf/raqamdan
 * boshqa hamma belgi olib tashlangan (`geoSkeleton`). Rus nomlari,
 * rus-lotin yozuvi va eski nomlar. Faqat qoidaviy variantlar
 * (`geoSpellingVariants`: а→о, к→q) yetmaydigan holatlar shu yerda.
 *
 * ⚠️ SOATO kaliti: bazadagi qator nomi o'zgarsa ham alias ishlayveradi;
 * qatorning kodi bo'lmasa (NULL) alias ishlamaydi.
 */
export const DISTRICT_ALIASES: Readonly<Record<string, readonly string[]>> =
  Object.freeze({
    // Qo'qon shahri
    '1730405': ['kokand', 'kukon', 'qoqand', 'kokan'],
    // Marg'ilon shahri
    '1730412': ['margilan'],
    // Jizzax shahri
    '1708401': ['djizak', 'dzhizak', 'jizak'],
    // Olmaliq shahri
    '1727404': ['almalyk', 'almalik', 'olmalik'],
    // Mirzo Ulug'bek tumani (Toshkent sh.)
    '1726269': ['mulugbek', 'mirzaulugbek', 'mirzoulugbek'],
    // Qarshi shahri — rus nomi "Карши"
    '1710401': ['karshi'],
  });

/** `normGeo` natijasining skeleti: faqat harf va raqam. */
export function geoSkeleton(geo: string): string {
  return geo.replace(/[^a-z0-9]+/g, '');
}

/** Bir harf almashtirishlarining hamma kombinatsiyalari (chegaralangan). */
function expand(words: Set<string>, from: string, to: string, max: number) {
  for (const w of [...words]) {
    const positions: number[] = [];
    for (let i = w.indexOf(from); i >= 0; i = w.indexOf(from, i + 1)) {
      positions.push(i);
    }
    if (!positions.length || positions.length > max) continue;
    for (let mask = 1; mask < 1 << positions.length; mask++) {
      const chars = w.split('');
      positions.forEach((p, bit) => {
        if (mask & (1 << bit)) chars[p] = to;
      });
      words.add(chars.join(''));
    }
  }
}

/**
 * Rus yozuvidan o'zbek lotin yozuviga QOIDAVIY variantlar (asl so'z ham
 * kiradi): а→о (Мирабад → mirobod, Бекабад → bekobod), к→q (Karshi →
 * qarshi), y→i. ⚠️ Ko'r-ko'rona almashtirish emas — HAMMA kombinatsiya
 * (Андижан → andijon ham, ondijon ham); chaqiruvchi faqat bazadagi nomga
 * ANIQ mos keladigan variantni qabul qiladi.
 */
export function geoSpellingVariants(skeleton: string): Set<string> {
  const words = new Set<string>([skeleton]);
  if (skeleton.length < 4) return words;
  expand(words, 'a', 'o', 4);
  expand(words, 'k', 'q', 3);
  for (const w of [...words]) {
    if (w.includes('y')) words.add(w.replace(/y/g, 'i'));
    if (w.startsWith('dj')) words.add(w.slice(1));
  }
  return words;
}
