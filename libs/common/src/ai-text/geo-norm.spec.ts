import {
  GEO_FUZZY_MIN,
  GEO_FUZZY_NEAR_DELTA,
  GEO_REGION_FUZZY_MARGIN,
  GEO_SUBSTRING_MIN,
  REGION_ALIASES,
  lightNorm,
  normGeo,
  regionAlias,
} from './';

/**
 * I73soTpf. Geografik normalizatsiya: `lightNorm` shahar/viloyat
 * qo'shimchasini SAQLAYDI, `normGeo` uni OLIB TASHLAYDI; `regionAlias`
 * viloyat nomini SOATO'ga bog'laydi (yalang'och "Toshkent" — ATAYLAB null).
 */
describe('lightNorm', () => {
  it('I73soTpf #2: lightNorm("Toshkent shahri") !== lightNorm("Toshkent viloyati") — qo`shimcha saqlanadi', () => {
    expect(lightNorm('Toshkent shahri')).not.toBe(
      lightNorm('Toshkent viloyati'),
    );
    expect(lightNorm('Toshkent shahri')).toBe('toshkent shahri');
    expect(lightNorm('Toshkent viloyati')).toBe('toshkent viloyati');
  });

  it('translit qiladi, "kh" ni "x" ga, bo`shliqlarni bittaga keltiradi', () => {
    expect(lightNorm('  Тошкент   шаҳри ')).toBe('toshkent shahri');
    expect(lightNorm('Khorazm')).toBe('xorazm');
  });
});

describe('normGeo', () => {
  it('I73soTpf #3: normGeo("Toshkent shahri") === normGeo("Toshkent viloyati") === "toshkent"', () => {
    expect(normGeo('Toshkent shahri')).toBe('toshkent');
    expect(normGeo('Toshkent viloyati')).toBe('toshkent');
    expect(normGeo('Toshkent shahri')).toBe(normGeo('Toshkent viloyati'));
  });

  it('I73soTpf #3 himoyasi: "Shahrixon" / "Shahrisabz" ichidagi "shahri" tegilmaydi', () => {
    expect(normGeo('Shahrixon')).toBe('shahrixon');
    expect(normGeo('Shahrixon tumani')).toBe('shahrixon');
    expect(normGeo('Shahrisabz')).toBe('shahrisabz');
    expect(normGeo('Shahrisabz shahri')).toBe('shahrisabz');
    expect(normGeo('Шаҳрисабз тумани')).toBe('shahrisabz');
  });

  it('I73soTpf #4: normGeo seed`dagi 11 ta ortiqcha probelli nomni tozalaydi', () => {
    // apps/logistics-service/src/data/regions-districts.data.ts dagi
    // trailing probelli viloyat nomlari (jonli API trimlangan qaytaradi —
    // bu test seed/migratsiya yo'lini himoya qiladi).
    expect(normGeo('Toshkent ')).toBe('toshkent');
    expect(normGeo('Andijon ')).toBe('andijon');
    expect(normGeo('Namangan ')).toBe('namangan');
    expect(normGeo('Samarqand ')).toBe('samarqand');
    expect(normGeo('Buxoro ')).toBe('buxoro');
    expect(normGeo('Navoiy ')).toBe('navoiy');
    expect(normGeo('Xorazm ')).toBe('xorazm');
    expect(normGeo('Surxondaryo ')).toBe('surxondaryo');
    expect(normGeo('Qashqadaryo ')).toBe('qashqadaryo');
    expect(normGeo('Jizzax ')).toBe('jizzax');
    expect(normGeo('Sirdaryo ')).toBe('sirdaryo');
  });

  it('boshqa qo`shimchalarni ham olib tashlaydi (tuman, shaharcha, respublikasi, sh., t.)', () => {
    expect(normGeo('Chirchiq tuman')).toBe('chirchiq');
    expect(normGeo('Chirchiq sh.')).toBe('chirchiq');
    expect(normGeo('Chinoz t.')).toBe('chinoz');
    expect(normGeo('Toshkent shahar')).toBe('toshkent');
    expect(normGeo('Yangiyer shaharcha')).toBe('yangiyer');
    expect(normGeo('Toshkent viloyat')).toBe('toshkent');
    expect(normGeo("Qoraqalpog'iston Respublikasi")).toBe('qoraqalpogiston');
  });

  it('"kh" = "x" (Khiva = Xiva) va satr bo`lmagan qiymatda bo`sh satr', () => {
    expect(normGeo('Khiva')).toBe(normGeo('Xiva'));
    expect(normGeo(null)).toBe('');
    expect(normGeo(undefined)).toBe('');
  });
});

describe('REGION_ALIASES', () => {
  // apps/logistics-service/src/data/sato-codes.ts dagi rasmiy nomlar.
  const official: Record<string, string> = {
    '1703': 'Andijon viloyati',
    '1706': 'Buxoro viloyati',
    '1708': 'Jizzax viloyati',
    '1710': 'Qashqadaryo viloyati',
    '1712': 'Navoiy viloyati',
    '1714': 'Namangan viloyati',
    '1718': 'Samarqand viloyati',
    '1722': 'Surxondaryo viloyati',
    '1724': 'Sirdaryo viloyati',
    '1726': 'Toshkent shahri',
    '1727': 'Toshkent viloyati',
    '1730': "Farg'ona viloyati",
    '1733': 'Xorazm viloyati',
    '1735': "Qoraqalpog'iston Respublikasi",
  };

  it('14 qator, SOATO takrorlanmaydi, canonical — rasmiy nom', () => {
    expect(REGION_ALIASES).toHaveLength(14);
    expect(new Set(REGION_ALIASES.map((r) => r.sato)).size).toBe(14);
    for (const row of REGION_ALIASES) {
      expect(official[row.sato]).toBe(row.canonical);
      expect(row.bases.length).toBeGreaterThan(0);
    }
  });

  it('o`zgartirib bo`lmaydi (frozen)', () => {
    expect(Object.isFrozen(REGION_ALIASES)).toBe(true);
    expect(Object.isFrozen(REGION_ALIASES[0])).toBe(true);
    expect(Object.isFrozen(REGION_ALIASES[0].bases)).toBe(true);
  });
});

describe('regionAlias', () => {
  it('I73soTpf #10: "Toshkent viloyati" -> 1727, "Toshkent shahri" -> 1726, "Toshkent" -> null', () => {
    expect(regionAlias('Toshkent viloyati')).toBe('1727');
    expect(regionAlias('Toshkent shahri')).toBe('1726');
    expect(regionAlias('Toshkent')).toBeNull();
  });

  it('I73soTpf #10: 14 ta rasmiy (canonical) nom o`z SOATO`sini beradi', () => {
    expect(regionAlias('Andijon viloyati')).toBe('1703');
    expect(regionAlias('Buxoro viloyati')).toBe('1706');
    expect(regionAlias('Jizzax viloyati')).toBe('1708');
    expect(regionAlias('Qashqadaryo viloyati')).toBe('1710');
    expect(regionAlias('Navoiy viloyati')).toBe('1712');
    expect(regionAlias('Namangan viloyati')).toBe('1714');
    expect(regionAlias('Samarqand viloyati')).toBe('1718');
    expect(regionAlias('Surxondaryo viloyati')).toBe('1722');
    expect(regionAlias('Sirdaryo viloyati')).toBe('1724');
    expect(regionAlias('Toshkent shahri')).toBe('1726');
    expect(regionAlias('Toshkent viloyati')).toBe('1727');
    expect(regionAlias("Farg'ona viloyati")).toBe('1730');
    expect(regionAlias('Xorazm viloyati')).toBe('1733');
    expect(regionAlias("Qoraqalpog'iston Respublikasi")).toBe('1735');
    for (const row of REGION_ALIASES) {
      expect(regionAlias(row.canonical)).toBe(row.sato);
    }
  });

  it('I73soTpf #10: Elchi DB`dagi yalang`och nomlar (jonli trimlangan va seed probelli)', () => {
    // Jonli GET /region (trimlangan).
    expect(regionAlias('Toshkent shahri')).toBe('1726');
    expect(regionAlias('Toshkent')).toBeNull();
    expect(regionAlias('Andijon')).toBe('1703');
    expect(regionAlias("Farg'ona")).toBe('1730');
    expect(regionAlias('Namangan')).toBe('1714');
    expect(regionAlias('Samarqand')).toBe('1718');
    expect(regionAlias('Buxoro')).toBe('1706');
    expect(regionAlias('Navoiy')).toBe('1712');
    expect(regionAlias('Xorazm')).toBe('1733');
    expect(regionAlias('Surxondaryo')).toBe('1722');
    expect(regionAlias('Qashqadaryo')).toBe('1710');
    expect(regionAlias('Jizzax')).toBe('1708');
    expect(regionAlias('Sirdaryo')).toBe('1724');
    expect(regionAlias("Qoraqalpog'iston Respublikasi")).toBe('1735');
    // Seed (regions-districts.data.ts) — trailing probel bilan.
    expect(regionAlias('Toshkent ')).toBeNull();
    expect(regionAlias('Andijon ')).toBe('1703');
    expect(regionAlias('Namangan ')).toBe('1714');
    expect(regionAlias('Samarqand ')).toBe('1718');
    expect(regionAlias('Buxoro ')).toBe('1706');
    expect(regionAlias('Navoiy ')).toBe('1712');
    expect(regionAlias('Xorazm ')).toBe('1733');
    expect(regionAlias('Surxondaryo ')).toBe('1722');
    expect(regionAlias('Qashqadaryo ')).toBe('1710');
    expect(regionAlias('Jizzax ')).toBe('1708');
    expect(regionAlias('Sirdaryo ')).toBe('1724');
  });

  it('Toshkent: faqat shahar/viloyat markeri hal qiladi (kirill, qisqartma, ru/en)', () => {
    expect(regionAlias('Toshkent sh.')).toBe('1726');
    expect(regionAlias('Toshkent sh')).toBe('1726');
    expect(regionAlias('Toshkent shahar')).toBe('1726');
    expect(regionAlias('Тошкент шаҳри')).toBe('1726');
    expect(regionAlias('Tashkent city')).toBe('1726');
    expect(regionAlias('Ташкент город')).toBe('1726');
    expect(regionAlias('Toshkent vil.')).toBe('1727');
    expect(regionAlias('Toshkent viloyat')).toBe('1727');
    expect(regionAlias('Тошкент вилояти')).toBe('1727');
    expect(regionAlias('Tashkent oblast')).toBe('1727');
    expect(regionAlias('Ташкент обл.')).toBe('1727');
    // Markersiz yoki ikkala marker birga — NOANIQ.
    expect(regionAlias('Тошкент')).toBeNull();
    expect(regionAlias('Tashkent')).toBeNull();
    expect(regionAlias('Toshkent shahri viloyati')).toBeNull();
  });

  it('Toshkentga fuzzy HECH QACHON qo`llanmaydi', () => {
    expect(regionAlias('Toshknt shahri')).toBeNull();
    expect(regionAlias('Toshkennt viloyati')).toBeNull();
  });

  it('o`zbek kirill va rus/ingliz shakllari', () => {
    expect(regionAlias('Андижон')).toBe('1703');
    expect(regionAlias('Andijan')).toBe('1703');
    expect(regionAlias('Bukhara')).toBe('1706');
    expect(regionAlias('Бухара')).toBe('1706');
    expect(regionAlias('Jizzakh')).toBe('1708');
    expect(regionAlias('Джизак')).toBe('1708');
    expect(regionAlias('Kashkadarya')).toBe('1710');
    expect(regionAlias('Қашқадарё вилояти')).toBe('1710');
    expect(regionAlias('Navoi')).toBe('1712');
    expect(regionAlias('Samarkand')).toBe('1718');
    expect(regionAlias('Самарканд')).toBe('1718');
    expect(regionAlias('Surkhandarya')).toBe('1722');
    expect(regionAlias('Сурхандарья')).toBe('1722');
    expect(regionAlias('Syrdarya')).toBe('1724');
    expect(regionAlias('Сырдарья')).toBe('1724');
    expect(regionAlias('Fargona')).toBe('1730');
    expect(regionAlias('Fergana')).toBe('1730');
    expect(regionAlias('Фарғона')).toBe('1730');
    expect(regionAlias('Фергана')).toBe('1730');
    expect(regionAlias('Khorezm')).toBe('1733');
    expect(regionAlias('Хорезм')).toBe('1733');
    expect(regionAlias('Хоразм')).toBe('1733');
    expect(regionAlias('Karakalpakstan')).toBe('1735');
    expect(regionAlias('Каракалпакстан')).toBe('1735');
    expect(regionAlias('Qoraqalpogiston')).toBe('1735');
    // U+02BB (o'zbek lotin rasmiy apostrofi).
    expect(regionAlias('Qoraqalpo\u02bbg\u02bbiston')).toBe('1735');
  });

  it('imlo xatosi — aniq g`olib bo`lsa fuzzy topadi', () => {
    expect(regionAlias('Andijn')).toBe('1703');
    expect(regionAlias('Samarkant viloyati')).toBe('1718');
    expect(regionAlias('Namangn')).toBe('1714');
  });

  it('viloyat emas yoki bo`sh bo`lsa null; "Shahrixon" shahar markeri emas', () => {
    expect(regionAlias('Shahrixon')).toBeNull();
    expect(regionAlias('Yunusobod tumani')).toBeNull();
    expect(regionAlias('Chirchiq')).toBeNull();
    expect(regionAlias('')).toBeNull();
    expect(regionAlias('   ')).toBeNull();
    expect(regionAlias(null)).toBeNull();
    expect(regionAlias(undefined)).toBeNull();
  });
});

describe('geo konstantalari', () => {
  it('bo`sag`alar hardcode emas — eksport qilingan konstantalar', () => {
    expect(GEO_FUZZY_MIN).toBe(0.72);
    expect(GEO_FUZZY_NEAR_DELTA).toBe(0.08);
    expect(GEO_REGION_FUZZY_MARGIN).toBe(0.1);
    expect(GEO_SUBSTRING_MIN).toBe(0.82);
  });
});
