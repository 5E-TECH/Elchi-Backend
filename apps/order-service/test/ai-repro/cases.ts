/**
 * AI buyurtma — DETERMINISTIK qatlam uchun test to'plami (LLM chaqirilmaydi).
 *
 * Kirish = model chiqaradigan (sanitize'dan keyingi) maydonlar: region_name,
 * district_name, address, full_address. Kutilgan javob — real geografiya
 * bo'yicha to'g'ri tuman (SOATO), seed fayli
 * (apps/logistics-service/src/data/regions-districts.data.ts, 206 tuman) ga
 * nisbatan. Seed'da YO'Q tuman — `mode: 'not_in_db'` (to'g'ri xulq: jimgina
 * boshqa tumanni tanlamaslik).
 *
 * D1 (#656): seed'ga rasmiy SOATO'dagi 25 qator qo'shildi — ilgari
 * 'not_in_db' bo'lgan 7 holat endi 'auto' (rasmiy kod). Tur aytilmagan
 * yalang'och shahar nomi ("Urganch", "Yangiyo'l", "Xiva" …) endi tuman va
 * "X shahri" qatorining IKKALASIGA mos keladi — 'ask' (operator tanlaydi;
 * ikkala qator bir xil xizmat viloyatiga yo'naltiriladi).
 *
 * mode:
 *  - 'auto'      — matn yetarli aniq; to'g'ri tuman avtomatik tanlanishi kerak.
 *  - 'ask'       — haqiqiy noaniqlik (shahar/tuman bir xil nom va h.k.);
 *                  avto-tanlov YO'Q, nomzodlarda `satos` hammasi bo'lishi kerak.
 *  - 'not_in_db' — to'g'ri tuman seed'da yo'q; avto-tanlov bo'lmasligi kerak.
 *
 * Shaxsiy ma'lumot YO'Q: ismlar/telefonlar sintetik.
 */

export type Mode = 'auto' | 'ask' | 'not_in_db';

export interface DistrictCase {
  id: string;
  group: string;
  note: string;
  input: {
    region_name?: string | null;
    district_name?: string | null;
    address?: string | null;
    full_address?: string | null;
  };
  expect: {
    mode: Mode;
    /** auto: to'g'ri tuman SOATO; ask: nomzodlarda bo'lishi shart bo'lganlar. */
    satos?: string[];
    /** Kutilgan viloyat SOATO (tekshiriladi, agar berilsa). */
    regionSato?: string;
    /**
     * not_in_db: rasmiy SOATO (apps/logistics-service/src/data/sato-codes.ts)
     * dagi to'g'ri tuman kodi — "seed + rasmiy" snapshotda kutiladi.
     */
    officialSato?: string;
  };
}

const A = (s: string) => [s];

export const DISTRICT_CASES: DistrictCase[] = [
  // ── A. Toza kanonik (sanity) ──
  {
    id: 'A01',
    group: 'canonical',
    note: 'Andijon + Asaka',
    input: { region_name: 'Andijon', district_name: 'Asaka' },
    expect: { mode: 'auto', satos: A('1703224'), regionSato: '1703' },
  },
  {
    id: 'A02',
    group: 'canonical',
    note: 'Toshkent shahri + Chilonzor',
    input: { region_name: 'Toshkent shahri', district_name: 'Chilonzor' },
    expect: { mode: 'auto', satos: A('1726294'), regionSato: '1726' },
  },
  {
    id: 'A03',
    group: 'canonical',
    note: 'Samarqand + Urgut',
    input: { region_name: 'Samarqand', district_name: 'Urgut' },
    expect: { mode: 'auto', satos: A('1718236') },
  },
  {
    id: 'A04',
    group: 'canonical',
    note: "Farg'ona + Qo'qon",
    input: { region_name: "Farg'ona", district_name: "Qo'qon" },
    expect: { mode: 'auto', satos: A('1730405') },
  },

  // ── B. Apostrof variantlari ──
  {
    id: 'B01',
    group: 'apostrophe',
    note: 'U+02BB ʻ',
    input: { region_name: 'Fargʻona', district_name: 'Qoʻqon' },
    expect: { mode: 'auto', satos: A('1730405') },
  },
  {
    id: 'B02',
    group: 'apostrophe',
    note: 'U+2018 ‘',
    input: { region_name: 'Farg‘ona', district_name: 'Qo‘qon' },
    expect: { mode: 'auto', satos: A('1730405') },
  },
  {
    id: 'B03',
    group: 'apostrophe',
    note: 'backtick `',
    input: { region_name: 'Farg`ona', district_name: 'Qo`qon' },
    expect: { mode: 'auto', satos: A('1730405') },
  },
  {
    id: 'B04',
    group: 'apostrophe',
    note: 'U+2019 ’',
    input: { region_name: 'Farg’ona', district_name: 'Qo’qon' },
    expect: { mode: 'auto', satos: A('1730405') },
  },
  {
    id: 'B05',
    group: 'apostrophe',
    note: 'apostrofsiz',
    input: { region_name: 'Fargona', district_name: 'Qoqon' },
    expect: { mode: 'auto', satos: A('1730405') },
  },
  {
    id: 'B06',
    group: 'apostrophe',
    note: 'U+00B4 ´ (acute) — ayrim klaviaturalar',
    input: { region_name: 'Farg´ona', district_name: 'Qo´qon' },
    expect: { mode: 'auto', satos: A('1730405') },
  },
  {
    id: 'B07',
    group: 'apostrophe',
    note: 'U+02BC ʼ, viloyatsiz',
    input: { region_name: null, district_name: 'Xoʼjaobod' },
    expect: { mode: 'auto', satos: A('1703236') },
  },
  {
    id: 'B08',
    group: 'apostrophe',
    note: 'G‘ijduvon + Buxoro',
    input: { region_name: 'Buxoro', district_name: 'G‘ijduvon' },
    expect: { mode: 'auto', satos: A('1706215') },
  },
  {
    id: 'B09',
    group: 'apostrophe',
    note: 'U+00B4 viloyatsiz',
    input: { region_name: null, district_name: 'Bulung´ur' },
    expect: { mode: 'auto', satos: A('1718206') },
  },

  // ── C. Qo'shimchalar ──
  {
    id: 'C01',
    group: 'suffix',
    note: 'tumani',
    input: {
      region_name: 'Toshkent shahri',
      district_name: 'Chilonzor tumani',
    },
    expect: { mode: 'auto', satos: A('1726294') },
  },
  {
    id: 'C02',
    group: 'suffix',
    note: 'tuman',
    input: { region_name: 'Toshkent shahri', district_name: 'Chilonzor tuman' },
    expect: { mode: 'auto', satos: A('1726294') },
  },
  {
    id: 'C03',
    group: 'suffix',
    note: 'р-н (kirill qisqartma)',
    input: { region_name: 'Toshkent shahri', district_name: 'Chilonzor р-н' },
    expect: { mode: 'auto', satos: A('1726294') },
  },
  {
    id: 'C04',
    group: 'suffix',
    note: 'район',
    input: { region_name: 'Toshkent shahri', district_name: 'Chilonzor район' },
    expect: { mode: 'auto', satos: A('1726294') },
  },
  {
    id: 'C05',
    group: 'suffix',
    note: 't. qisqartma',
    input: { region_name: 'Toshkent shahri', district_name: 'Mirobod t.' },
    expect: { mode: 'auto', satos: A('1726273') },
  },
  {
    id: 'C06',
    group: 'suffix',
    note: '"sh." — shahar belgisi',
    input: {
      region_name: 'Samarqand',
      district_name: 'Samarqand sh.',
      full_address: "Samarqand sh. Registon ko'chasi 20",
    },
    expect: { mode: 'auto', satos: A('1718401') },
  },
  {
    id: 'C07',
    group: 'suffix',
    note: 'shahar',
    input: { region_name: 'Samarqand', district_name: 'Samarqand shahar' },
    expect: { mode: 'auto', satos: A('1718401') },
  },
  {
    id: 'C08',
    group: 'suffix',
    note: '"shaxri" (h o\'rniga x) — tez-tez imlo',
    input: {
      region_name: 'Samarqand',
      district_name: 'Samarqand shaxri',
      full_address: "Samarqand shaxri Registon ko'chasi 20",
    },
    expect: { mode: 'auto', satos: A('1718401') },
  },
  {
    id: 'C09',
    group: 'suffix',
    note: 'kirill шаҳри',
    input: { region_name: 'Самарқанд', district_name: 'Самарқанд шаҳри' },
    expect: { mode: 'auto', satos: A('1718401') },
  },
  {
    id: 'C10',
    group: 'suffix',
    note: 'ruscha "г. Самарканд"',
    input: { region_name: 'Samarqand', district_name: 'г. Самарканд' },
    expect: { mode: 'auto', satos: A('1718401') },
  },
  {
    id: 'C11',
    group: 'suffix',
    note: "kirill шахри (ҳ o'rniga х)",
    input: {
      region_name: 'Андижон',
      district_name: 'Андижон шахри',
      full_address: 'Андижон шахри, Навоий кўчаси 5',
    },
    expect: { mode: 'auto', satos: A('1703401') },
  },
  {
    id: 'C12',
    group: 'suffix',
    note: 'Kosonsoy shaharchasi — "shaharcha"ga qo\'shimcha',
    input: { region_name: null, district_name: 'Kosonsoy shaharchasi' },
    expect: { mode: 'auto', satos: A('1714207') },
  },

  // ── D. Ruscha / kirill nomlar (model o'girmay qoldirsa) ──
  {
    id: 'D01',
    group: 'russian',
    note: 'Юнусабад',
    input: { region_name: 'Toshkent shahri', district_name: 'Юнусабад' },
    expect: { mode: 'auto', satos: A('1726266') },
  },
  {
    id: 'D02',
    group: 'russian',
    note: 'Мирабад',
    input: { region_name: 'Toshkent shahri', district_name: 'Мирабад' },
    expect: { mode: 'auto', satos: A('1726273') },
  },
  {
    id: 'D03',
    group: 'russian',
    note: 'Алмазар',
    input: { region_name: 'Toshkent shahri', district_name: 'Алмазар' },
    expect: { mode: 'auto', satos: A('1726280') },
  },
  {
    id: 'D04',
    group: 'russian',
    note: 'Яккасарай',
    input: { region_name: 'Toshkent shahri', district_name: 'Яккасарай' },
    expect: { mode: 'auto', satos: A('1726287') },
  },
  {
    id: 'D05',
    group: 'russian',
    note: 'Шайхантахур',
    input: { region_name: 'Toshkent shahri', district_name: 'Шайхантахур' },
    expect: { mode: 'auto', satos: A('1726277') },
  },
  {
    id: 'D06',
    group: 'russian',
    note: 'Мирзо-Улугбек (defis)',
    input: { region_name: 'Toshkent shahri', district_name: 'Мирзо-Улугбек' },
    expect: { mode: 'auto', satos: A('1726269') },
  },
  {
    id: 'D07',
    group: 'russian',
    note: 'Коканд',
    input: { region_name: "Farg'ona", district_name: 'Коканд' },
    expect: { mode: 'auto', satos: A('1730405') },
  },
  {
    id: 'D08',
    group: 'russian',
    note: 'Маргилан',
    input: { region_name: "Farg'ona", district_name: 'Маргилан' },
    expect: { mode: 'auto', satos: A('1730412') },
  },
  {
    id: 'D09',
    group: 'russian',
    note: 'Ургенч',
    input: { region_name: 'Xorazm', district_name: 'Ургенч' },
    expect: { mode: 'ask', satos: ['1733217', '1733401'] },
  },
  {
    id: 'D10',
    group: 'russian',
    note: 'Карши (ruscha = Qarshi SHAHRI); DB tuman nomi "Karshi"',
    input: { region_name: 'Qashqadaryo', district_name: 'Карши' },
    expect: { mode: 'auto', satos: A('1710401') },
  },
  {
    id: 'D11',
    group: 'russian',
    note: 'Джизак',
    input: { region_name: 'Jizzax', district_name: 'Джизак' },
    expect: { mode: 'auto', satos: A('1708401') },
  },
  {
    id: 'D12',
    group: 'russian',
    note: 'Алмалык',
    input: { region_name: 'Toshkent viloyati', district_name: 'Алмалык' },
    expect: { mode: 'auto', satos: A('1727404') },
  },
  {
    id: 'D13',
    group: 'russian',
    note: 'Бекабад',
    input: { region_name: 'Toshkent viloyati', district_name: 'Бекабад' },
    expect: { mode: 'ask', satos: ['1727220', '1727413'] },
  },
  {
    id: 'D14',
    group: 'russian',
    note: 'Янгиюль',
    input: { region_name: 'Toshkent viloyati', district_name: 'Янгиюль' },
    expect: { mode: 'ask', satos: ['1727259', '1727424'] },
  },
  {
    id: 'D15',
    group: 'russian',
    note: 'Чирчик',
    input: { region_name: 'Toshkent viloyati', district_name: 'Чирчик' },
    expect: { mode: 'auto', satos: A('1727419') },
  },
  {
    id: 'D16',
    group: 'russian',
    note: 'Термез',
    input: { region_name: 'Surxondaryo', district_name: 'Термез' },
    expect: { mode: 'ask', satos: ['1722220', '1722401'] },
  },
  {
    id: 'D17',
    group: 'russian',
    note: 'Ташкентский район',
    input: {
      region_name: 'Toshkent viloyati',
      district_name: 'Ташкентский район',
    },
    expect: { mode: 'auto', satos: A('1727265') },
  },
  {
    id: 'D18',
    group: 'russian',
    note: 'Чиланзарский район',
    input: {
      region_name: 'Toshkent shahri',
      district_name: 'Чиланзарский район',
    },
    expect: { mode: 'auto', satos: A('1726294') },
  },
  {
    id: 'D19',
    group: 'russian',
    note: 'Юнусабадский район',
    input: {
      region_name: 'Toshkent shahri',
      district_name: 'Юнусабадский район',
    },
    expect: { mode: 'auto', satos: A('1726266') },
  },
  {
    id: 'D20',
    group: 'russian',
    note: 'Кибрай',
    input: { region_name: 'Toshkent viloyati', district_name: 'Кибрай' },
    expect: { mode: 'auto', satos: A('1727248') },
  },
  {
    id: 'D21',
    group: 'russian',
    note: 'Бухара (shahar/tuman noaniq)',
    input: { region_name: 'Buxoro', district_name: 'Бухара' },
    expect: { mode: 'ask', satos: ['1706401', '1706207'] },
  },
  {
    id: 'D22',
    group: 'russian',
    note: 'Каттакурган (shahar/tuman noaniq)',
    input: { region_name: 'Samarqand', district_name: 'Каттакурган' },
    expect: { mode: 'ask', satos: ['1718406', '1718215'] },
  },
  {
    id: 'D24',
    group: 'russian',
    note: '"Karshi" (rus-lotin yozuvi, odatda SHAHAR)',
    input: { region_name: 'Qashqadaryo', district_name: 'Karshi' },
    expect: { mode: 'auto', satos: A('1710401') },
  },
  {
    id: 'D23',
    group: 'russian',
    note: 'Сергелийский район',
    input: {
      region_name: 'Toshkent shahri',
      district_name: 'Сергелийский район',
    },
    expect: { mode: 'auto', satos: A('1726283') },
  },

  // ── E. Bir xil / o'xshash nomlar, viloyatlar kesishuvi ──
  {
    id: 'E01',
    group: 'same-name',
    note: 'Kogon viloyatsiz (shahar+tuman)',
    input: { region_name: null, district_name: 'Kogon' },
    expect: { mode: 'ask', satos: ['1706219', '1706403'] },
  },
  {
    id: 'E02',
    group: 'same-name',
    note: 'Qashqadaryo + Kogon (xato viloyat yoki Koson)',
    input: { region_name: 'Qashqadaryo', district_name: 'Kogon' },
    expect: { mode: 'ask', satos: ['1710229'] },
  },
  {
    id: 'E03',
    group: 'same-name',
    note: "yalang'och Toshkent + Toshkent",
    input: { region_name: 'Toshkent', district_name: 'Toshkent' },
    expect: { mode: 'not_in_db' },
  },
  {
    id: 'E04',
    group: 'same-name',
    note: 'district_name="Toshkent shahri" viloyatsiz',
    input: { region_name: null, district_name: 'Toshkent shahri' },
    expect: { mode: 'not_in_db' },
  },
  {
    id: 'E05',
    group: 'same-name',
    note: "Toshkent viloyati + Yangiyo'l",
    input: { region_name: 'Toshkent viloyati', district_name: "Yangiyo'l" },
    expect: { mode: 'ask', satos: ['1727259', '1727424'] },
  },
  {
    id: 'E06',
    group: 'same-name',
    note: "Yangiyo'l viloyatsiz",
    input: { region_name: null, district_name: "Yangiyo'l" },
    expect: { mode: 'ask', satos: ['1727259', '1727424'] },
  },
  {
    id: 'E07',
    group: 'same-name',
    // D1 (#656) dan keyin 'ask': rezolver tuman tanlamagani uchun model
    // aytgan viloyat (1726) qoladi; ikkala nomzod ham Toshkent viloyatida
    // (1727). Shuning uchun regionSato tekshirilmaydi (ilgari 'auto' da 1727).
    note: "model xato viloyat: Toshkent shahri + Yangiyo'l",
    input: { region_name: 'Toshkent shahri', district_name: "Yangiyo'l" },
    expect: { mode: 'ask', satos: ['1727259', '1727424'] },
  },
  {
    id: 'E08',
    group: 'same-name',
    note: 'Toshkent shahri + Qibray (Qibray — viloyatda)',
    input: { region_name: 'Toshkent shahri', district_name: 'Qibray' },
    expect: { mode: 'auto', satos: A('1727248'), regionSato: '1727' },
  },
  {
    id: 'E09',
    group: 'same-name',
    note: "yalang'och Toshkent + Qibray",
    input: { region_name: 'Toshkent', district_name: 'Qibray' },
    expect: { mode: 'auto', satos: A('1727248') },
  },
  {
    id: 'E10',
    group: 'same-name',
    note: 'Chirchiq viloyatsiz',
    input: { region_name: null, district_name: 'Chirchiq' },
    expect: { mode: 'auto', satos: A('1727419') },
  },
  {
    id: 'E11',
    group: 'same-name',
    note: 'Yuqori Chirchiq tumani (probel bilan)',
    input: {
      region_name: 'Toshkent viloyati',
      district_name: 'Yuqori Chirchiq tumani',
    },
    expect: { mode: 'auto', satos: A('1727239') },
  },
  {
    id: 'E12',
    group: 'same-name',
    note: 'Quyi Chirchiq (probel bilan)',
    input: { region_name: 'Toshkent viloyati', district_name: 'Quyi Chirchiq' },
    expect: { mode: 'auto', satos: A('1727233') },
  },
  {
    id: 'E13',
    group: 'same-name',
    note: "O'rta Chirchiq tumani (D1: seed'ga qo'shildi)",
    input: {
      region_name: 'Toshkent viloyati',
      district_name: "O'rta Chirchiq tumani",
    },
    expect: { mode: 'auto', satos: A('1727253') },
  },
  {
    id: 'E14',
    group: 'same-name',
    note: 'Olmaliq viloyatsiz',
    input: { region_name: null, district_name: 'Olmaliq' },
    expect: { mode: 'auto', satos: A('1727404') },
  },
  {
    id: 'E15',
    group: 'same-name',
    note: 'Olmazor viloyatsiz',
    input: { region_name: null, district_name: 'Olmazor' },
    expect: { mode: 'auto', satos: A('1726280') },
  },
  {
    id: 'E16',
    group: 'same-name',
    note: "Qo'qon shahri",
    input: { region_name: "Farg'ona", district_name: "Qo'qon shahri" },
    expect: { mode: 'auto', satos: A('1730405') },
  },
  {
    id: 'E17',
    group: 'same-name',
    note: "Farg'ona shahri (D1: shahar qatori seed'ga qo'shildi)",
    input: { region_name: "Farg'ona", district_name: "Farg'ona shahri" },
    expect: { mode: 'auto', satos: A('1730401') },
  },
  {
    id: 'E18',
    group: 'same-name',
    note: 'Andijon + Andijon (shahar/tuman)',
    input: { region_name: 'Andijon', district_name: 'Andijon' },
    expect: { mode: 'ask', satos: ['1703203', '1703401'] },
  },
  {
    id: 'E19',
    group: 'same-name',
    note: 'Andijon shahri',
    input: { region_name: 'Andijon', district_name: 'Andijon shahri' },
    expect: { mode: 'auto', satos: A('1703401') },
  },
  {
    id: 'E20',
    group: 'same-name',
    note: "Qarshi (yalang'och) = shahar",
    input: { region_name: 'Qashqadaryo', district_name: 'Qarshi' },
    expect: { mode: 'auto', satos: A('1710401') },
  },
  {
    id: 'E21',
    group: 'same-name',
    note: 'Qarshi tumani → DB "Karshi"',
    input: { region_name: 'Qashqadaryo', district_name: 'Qarshi tumani' },
    expect: { mode: 'auto', satos: A('1710224') },
  },
  {
    id: 'E22',
    group: 'same-name',
    note: "Quvasoy shahri (D1: seed'ga qo'shildi; Quva — boshqa tuman)",
    input: { region_name: "Farg'ona", district_name: 'Quvasoy shahri' },
    expect: { mode: 'auto', satos: A('1730408') },
  },
  {
    id: 'E23',
    group: 'same-name',
    note: "Mirobod + yalang'och Toshkent (Sirdaryo emas)",
    input: { region_name: 'Toshkent', district_name: 'Mirobod' },
    expect: { mode: 'auto', satos: A('1726273') },
  },
  {
    id: 'E24',
    group: 'same-name',
    note: "Mirzaobod viloyatsiz (by design: so'rash)",
    input: { region_name: null, district_name: 'Mirzaobod' },
    expect: { mode: 'ask', satos: ['1724228'] },
  },
  {
    id: 'E25',
    group: 'same-name',
    note: 'Toshkent viloyati + Yunusobod (model xato viloyat)',
    input: { region_name: 'Toshkent viloyati', district_name: 'Yunusobod' },
    expect: { mode: 'auto', satos: A('1726266'), regionSato: '1726' },
  },
  {
    id: 'E26',
    group: 'same-name',
    note: 'Toshkent + Toshkent tumani',
    input: { region_name: 'Toshkent', district_name: 'Toshkent tumani' },
    expect: { mode: 'auto', satos: A('1727265') },
  },
  {
    id: 'E27',
    group: 'same-name',
    note: "Kattaqo'rg'on shahri",
    input: { region_name: 'Samarqand', district_name: "Kattaqo'rg'on shahri" },
    expect: { mode: 'auto', satos: A('1718406') },
  },
  {
    id: 'E29',
    group: 'same-name',
    note: "Shahrisabz tumani (D1: tuman qatori seed'ga qo'shildi)",
    input: { region_name: 'Qashqadaryo', district_name: 'Shahrisabz tumani' },
    expect: { mode: 'auto', satos: A('1710245') },
  },
  {
    id: 'E28',
    group: 'same-name',
    note: "Urganch shahri (D1: shahar qatori seed'ga qo'shildi)",
    input: { region_name: 'Xorazm', district_name: 'Urganch shahri' },
    expect: { mode: 'auto', satos: A('1733401') },
  },

  // ── F. Manzildagi ko'cha/mahalla nomi = boshqa tuman nomi (2-usul) ──
  {
    id: 'F01',
    group: 'street-name',
    note: "Jizzax + Zomin (D1: seed'ga qo'shildi) + 'Paxtakor mahallasi'",
    input: {
      region_name: 'Jizzax',
      district_name: 'Zomin',
      address: 'Paxtakor mahallasi, 12-uy',
      full_address: 'Jizzax Zomin Paxtakor mahallasi, 12-uy',
    },
    expect: { mode: 'auto', satos: A('1708218') },
  },
  {
    id: 'F02',
    group: 'street-name',
    note: "Jizzax + 'Forsh' (Forish imlo xatosi) + 'Paxtakor ko'chasi'",
    input: {
      region_name: 'Jizzax',
      district_name: 'Forsh',
      address: "Paxtakor ko'chasi 3-uy",
      full_address: "Jizzax Forsh Paxtakor ko'chasi 3-uy",
    },
    expect: { mode: 'auto', satos: A('1708235') },
  },
  {
    id: 'F03',
    group: 'street-name',
    note: "Farg'ona + 'Margilan' + 'Furqat ko'chasi'",
    input: {
      region_name: "Farg'ona",
      district_name: 'Margilan',
      address: "Furqat ko'chasi 7-uy",
      full_address: "Farg'ona Margilan Furqat ko'chasi 7-uy",
    },
    expect: { mode: 'auto', satos: A('1730412') },
  },
  {
    id: 'F04',
    group: 'street-name',
    note: "Farg'ona + 'Kokand' + 'Furqat ko'chasi'",
    input: {
      region_name: "Farg'ona",
      district_name: 'Kokand',
      address: "Furqat ko'chasi 12",
      full_address: "Kokand, Furqat ko'chasi 12",
    },
    expect: { mode: 'auto', satos: A('1730405') },
  },
  {
    id: 'F05',
    group: 'street-name',
    note: "viloyatsiz 'Uychi tumani' (D1: seed'ga qo'shildi) + 'Navoiy ko'chasi'",
    input: {
      region_name: null,
      district_name: 'Uychi tumani',
      address: "Navoiy ko'chasi 15-uy",
      full_address: "Uychi tumani Navoiy ko'chasi 15-uy",
    },
    expect: { mode: 'auto', satos: A('1714229') },
  },
  {
    id: 'F06',
    group: 'street-name',
    note: "district yo'q; manzil 'Andijon shahri, Bo'ston ko'chasi'",
    input: {
      region_name: 'Andijon',
      district_name: null,
      address: "Bo'ston ko'chasi 12-uy",
      full_address: "Andijon shahri, Bo'ston ko'chasi 12-uy",
    },
    expect: { mode: 'auto', satos: A('1703401') },
  },
  {
    id: 'F07',
    group: 'street-name',
    note: "district yo'q; 'Navoiy ko'chasi' (place word yo'q) → faqat nomzod",
    input: {
      region_name: null,
      district_name: null,
      address: "Navoiy ko'chasi 5",
      full_address: "Navoiy ko'chasi 5",
    },
    expect: { mode: 'not_in_db' },
  },
  {
    id: 'F08',
    group: 'street-name',
    note: "Toshkent shahri + Мирабад + 'Olmazor ko'chasi'",
    input: {
      region_name: 'Toshkent shahri',
      district_name: 'Мирабад',
      address: "Olmazor ko'chasi 5-uy",
      full_address: "Toshkent shahri Мирабад Olmazor ko'chasi 5-uy",
    },
    expect: { mode: 'auto', satos: A('1726273') },
  },
  {
    id: 'F09',
    group: 'street-name',
    note: "Sirdaryo + 'Gulistan' (ruscha) + 'Sirdaryo ko'chasi'",
    input: {
      region_name: 'Sirdaryo',
      district_name: 'Gulistan',
      address: "Sirdaryo ko'chasi 4",
      full_address: "Sirdaryo Gulistan Sirdaryo ko'chasi 4",
    },
    expect: { mode: 'ask', satos: ['1724220', '1724401'] },
  },
  {
    id: 'F12',
    group: 'street-name',
    note: "prompt 4-misoli: 'xojaobd' (imlo) + 'paxtaobod mfy' (MAHALLA), viloyatsiz",
    input: {
      region_name: null,
      district_name: 'xojaobd',
      address: 'paxtaobod mfy 5-uy',
      full_address: 'xojaobd paxtaobod mfy 5-uy',
    },
    expect: { mode: 'auto', satos: A('1703236') },
  },
  {
    id: 'F13',
    group: 'street-name',
    note: "xuddi shu, viloyat 'Andijon' bilan",
    input: {
      region_name: 'Andijon',
      district_name: 'xojaobd',
      address: 'paxtaobod mfy 5-uy',
      full_address: 'xojaobd paxtaobod mfy 5-uy',
    },
    expect: { mode: 'auto', satos: A('1703236') },
  },
  {
    id: 'F14',
    group: 'street-name',
    note: "nazorat: to'g'ri yozilgan Xo'jaobod + 'Paxtaobod MFY'",
    input: {
      region_name: 'Andijon',
      district_name: "Xo'jaobod",
      address: 'Paxtaobod MFY 5-uy',
      full_address: "Andijon Xo'jaobod Paxtaobod MFY 5-uy",
    },
    expect: { mode: 'auto', satos: A('1703236') },
  },
  {
    id: 'F11',
    group: 'street-name',
    note: "Andijon + 'Andijan' (ruscha) + 'Bo'ston ko'chasi'",
    input: {
      region_name: 'Andijon',
      district_name: 'Andijan',
      address: "Bo'ston ko'chasi 9",
      full_address: "Andijan, Bo'ston ko'chasi 9",
    },
    expect: { mode: 'ask', satos: ['1703401', '1703203'] },
  },
  {
    id: 'F10',
    group: 'street-name',
    note: "Navoiy + 'Navoi' + 'Navbahor ko'chasi'",
    input: {
      region_name: 'Navoiy',
      district_name: 'Navoi',
      address: "Navbahor ko'chasi 4",
      full_address: "Navoiy shahri Navbahor ko'chasi 4",
    },
    expect: { mode: 'auto', satos: A('1712401') },
  },

  // ── G. Imlo xatolari / qisqartmalar ──
  {
    id: 'G01',
    group: 'typo',
    note: 'xojaobd viloyatsiz',
    input: { region_name: null, district_name: 'xojaobd' },
    expect: { mode: 'auto', satos: A('1703236') },
  },
  {
    id: 'G02',
    group: 'typo',
    note: 'Yunusobot',
    input: { region_name: 'Toshkent shahri', district_name: 'Yunusobot' },
    expect: { mode: 'auto', satos: A('1726266') },
  },
  {
    id: 'G03',
    group: 'typo',
    note: "Chilanzor + yalang'och Toshkent",
    input: { region_name: 'Toshkent', district_name: 'Chilanzor' },
    expect: { mode: 'auto', satos: A('1726294') },
  },
  {
    id: 'G04',
    group: 'typo',
    note: 'Shayxontoxur',
    input: { region_name: 'Toshkent shahri', district_name: 'Shayxontoxur' },
    expect: { mode: 'auto', satos: A('1726277') },
  },
  {
    id: 'G05',
    group: 'typo',
    note: "M.Ulug'bek qisqartma",
    input: { region_name: 'Toshkent shahri', district_name: "M.Ulug'bek" },
    expect: { mode: 'auto', satos: A('1726269') },
  },
  {
    id: 'G06',
    group: 'typo',
    note: 'Buloqboshi (DB: Buloqboshy)',
    input: { region_name: 'Andijon', district_name: 'Buloqboshi' },
    expect: { mode: 'auto', satos: A('1703210') },
  },
  {
    id: 'G07',
    group: 'typo',
    note: "Do'stlik (DB: Dustlik)",
    input: { region_name: 'Jizzax', district_name: "Do'stlik" },
    expect: { mode: 'auto', satos: A('1708215') },
  },
  {
    id: 'G08',
    group: 'typo',
    note: 'Qamashi (DB: Kamashi)',
    input: { region_name: 'Qashqadaryo', district_name: 'Qamashi' },
    expect: { mode: 'auto', satos: A('1710220') },
  },
  {
    id: 'G09',
    group: 'typo',
    note: 'Xiva (DB: Khiva)',
    input: { region_name: 'Xorazm', district_name: 'Xiva' },
    expect: { mode: 'ask', satos: ['1733226', '1733406'] },
  },
  {
    id: 'G10',
    group: 'typo',
    note: 'Marhamad',
    input: { region_name: 'Andijon', district_name: 'Marhamad' },
    expect: { mode: 'auto', satos: A('1703227') },
  },
  {
    id: 'G11',
    group: 'typo',
    note: 'Gijduvon viloyatsiz',
    input: { region_name: null, district_name: 'Gijduvon' },
    expect: { mode: 'auto', satos: A('1706215') },
  },
  {
    id: 'G12',
    group: 'typo',
    note: 'Yakkasaray',
    input: { region_name: 'Toshkent shahri', district_name: 'Yakkasaray' },
    expect: { mode: 'auto', satos: A('1726287') },
  },
  {
    id: 'G13',
    group: 'typo',
    note: "Bektemir + yalang'och Toshkent",
    input: { region_name: 'Toshkent', district_name: 'Bektemir' },
    expect: { mode: 'auto', satos: A('1726264') },
  },

  // ── H. O'zbek kirill ──
  {
    id: 'H01',
    group: 'uz-cyrillic',
    note: 'Андижон + Асака',
    input: { region_name: 'Андижон', district_name: 'Асака' },
    expect: { mode: 'auto', satos: A('1703224') },
  },
  {
    id: 'H02',
    group: 'uz-cyrillic',
    note: 'Наманган + Чуст',
    input: { region_name: 'Наманган', district_name: 'Чуст' },
    expect: { mode: 'auto', satos: A('1714237') },
  },
  {
    id: 'H03',
    group: 'uz-cyrillic',
    note: 'Фарғона + Қўқон',
    input: { region_name: 'Фарғона', district_name: 'Қўқон' },
    expect: { mode: 'auto', satos: A('1730405') },
  },
  {
    id: 'H04',
    group: 'uz-cyrillic',
    note: 'Тошкент шаҳри + Чилонзор тумани',
    input: { region_name: 'Тошкент шаҳри', district_name: 'Чилонзор тумани' },
    expect: { mode: 'auto', satos: A('1726294'), regionSato: '1726' },
  },
  {
    id: 'H05',
    group: 'uz-cyrillic',
    note: 'Тошкент вилояти + Зангиота тумани',
    input: { region_name: 'Тошкент вилояти', district_name: 'Зангиота тумани' },
    expect: { mode: 'auto', satos: A('1727237'), regionSato: '1727' },
  },
  {
    id: 'H06',
    group: 'uz-cyrillic',
    note: 'Хоразм + Хива',
    input: { region_name: 'Хоразм', district_name: 'Хива' },
    expect: { mode: 'ask', satos: ['1733226', '1733406'] },
  },
  {
    id: 'H07',
    group: 'uz-cyrillic',
    note: 'Қашқадарё + Шаҳрисабз',
    input: { region_name: 'Қашқадарё', district_name: 'Шаҳрисабз' },
    expect: { mode: 'ask', satos: ['1710405', '1710245'] },
  },
  {
    id: 'H08',
    group: 'uz-cyrillic',
    note: 'Тошкент шахри (х) + Миробод',
    input: { region_name: 'Тошкент шахри', district_name: 'Миробод' },
    expect: { mode: 'auto', satos: A('1726273'), regionSato: '1726' },
  },
  {
    id: 'H09',
    group: 'uz-cyrillic',
    note: 'Кукон (оғзаки)',
    input: { region_name: 'Фарғона', district_name: 'Кукон' },
    expect: { mode: 'auto', satos: A('1730405') },
  },
];

export interface RegionCase {
  id: string;
  input: string;
  /** null = ataylab noaniq (masalan yalang'och "Toshkent"). */
  expect: string | null;
  note?: string;
}

export const REGION_CASES: RegionCase[] = [
  { id: 'R01', input: 'Toshkent shahri', expect: '1726' },
  { id: 'R02', input: 'Toshkent sh.', expect: '1726' },
  { id: 'R03', input: 'Tashkent city', expect: '1726' },
  {
    id: 'R04',
    input: 'г. Ташкент',
    expect: '1726',
    note: 'ruscha "г." belgisi',
  },
  { id: 'R05', input: 'Тошкент шахри', expect: '1726', note: "ҳ o'rniga х" },
  { id: 'R06', input: 'Toshkent viloyati', expect: '1727' },
  { id: 'R07', input: 'Toshkent vil.', expect: '1727' },
  { id: 'R08', input: 'Toshkent v.', expect: '1727', note: '"v." qisqartma' },
  { id: 'R09', input: 'Ташкентская область', expect: '1727' },
  {
    id: 'R10',
    input: 'Toshkent',
    expect: null,
    note: "yalang'och — ataylab null",
  },
  { id: 'R11', input: 'Ферганская область', expect: '1730' },
  { id: 'R12', input: 'Самаркандская обл.', expect: '1718' },
  { id: 'R13', input: 'Бухарская область', expect: '1706' },
  { id: 'R14', input: 'Kashkadarya', expect: '1710' },
  { id: 'R15', input: 'Karakalpakstan', expect: '1735' },
  { id: 'R16', input: 'Хоразм вилояти', expect: '1733' },
  { id: 'R17', input: 'Andijn', expect: '1703', note: 'imlo xatosi' },
  { id: 'R18', input: 'Surxandaryo', expect: '1722', note: 'imlo xatosi' },
  { id: 'R19', input: 'Наманганская область', expect: '1714' },
  { id: 'R20', input: 'Farg‘ona viloyati', expect: '1730' },
];

/** Telefon: maskalash (Claude'ga ketishdan oldin) va normalizatsiya. */
export interface PhoneMaskCase {
  id: string;
  text: string;
  /** Kutilgan maskalangan raqamlar (E.164), tartibda. */
  phones: string[];
  /** Maskalangandan keyin ham matnda QOLISHI shart bo'lgan bo'laklar (narx). */
  keep?: string[];
  note?: string;
}

export const PHONE_MASK_CASES: PhoneMaskCase[] = [
  {
    id: 'P01',
    text: 'Ali 90 123 45 67 Asaka atir 180 ming',
    phones: ['+998901234567'],
    keep: ['180 ming'],
  },
  {
    id: 'P02',
    text: 'tel +998 (91) 234-56-78, Chust',
    phones: ['+998912345678'],
  },
  { id: 'P03', text: 'Vali 8 (90) 123-45-67 Urgut', phones: ['+998901234567'] },
  { id: 'P04', text: 'raqam 998901234567 Nurota', phones: ['+998901234567'] },
  { id: 'P05', text: 'raqam 0901234567 Nurota', phones: ['+998901234567'] },
  {
    id: 'P06',
    text: 'raqam +998 901 23 45 67 Nurota',
    phones: ['+998901234567'],
    note: '3-2-2-2 guruhlash',
  },
  { id: 'P07', text: 'raqam 90 1234567', phones: ['+998901234567'] },
  {
    id: 'P08',
    text: 'Muhayyo 93 000 95 06 Urganch sumka 200 ming',
    phones: ['+998930009506'],
    keep: ['200 ming'],
  },
  {
    id: 'P09',
    text: '90 123 45 67, 91 765 43 21 Andijon',
    phones: ['+998901234567', '+998917654321'],
  },
  {
    id: 'P10',
    text: 'Rossiya raqami +7 916 123 45 67',
    phones: [],
    note: 'UZ emas — maskalanmaydi',
  },
  { id: 'P11', text: 'chala raqam 90 123 45 6', phones: [] },
  { id: 'P12', text: 'tel: 33 0991009 Sergeli', phones: ['+998330991009'] },
  {
    id: 'P13',
    text: 'tel 20 123 45 67 (yangi kod)',
    phones: ['+998201234567'],
  },
];

export interface PhoneNormCase {
  id: string;
  input: unknown;
  expect: string | null;
  note?: string;
}

export const PHONE_NORM_CASES: PhoneNormCase[] = [
  { id: 'N01', input: '+998 90 123 45 67', expect: '+998901234567' },
  { id: 'N02', input: '8 90 123 45 67', expect: '+998901234567' },
  { id: 'N03', input: '901234567', expect: '+998901234567' },
  {
    id: 'N04',
    input: 998901234567,
    expect: '+998901234567',
    note: 'son tipida',
  },
  {
    id: 'N05',
    input: '+998901234567, +998917654321',
    expect: null,
    note: 'ikki raqam bitta maydonda',
  },
  { id: 'N06', input: '+7 916 123 45 67', expect: null },
  {
    id: 'N07',
    input: '12 345 67 89',
    expect: null,
    note: "operator kodi yo'q (12) — UZ raqami emas",
  },
  { id: 'N08', input: '+998 90 123 45 6', expect: null },
];

/** Narx: Claude'ga ketadigan matnda narx telefon deb maskalanmasligi. */
export interface AmountMaskCase {
  id: string;
  text: string;
  keep: string[];
  phones: number;
}

export const AMOUNT_MASK_CASES: AmountMaskCase[] = [
  { id: 'M01', text: "atir 150 000 so'm", keep: ['150 000'], phones: 0 },
  { id: 'M02', text: 'muzlatgich 1 500 000', keep: ['1 500 000'], phones: 0 },
  { id: 'M03', text: 'narxi 150.000', keep: ['150.000'], phones: 0 },
  { id: 'M04', text: 'narxi 150,000', keep: ['150,000'], phones: 0 },
  { id: 'M05', text: 'televizor 1.5 mln', keep: ['1.5 mln'], phones: 0 },
  { id: 'M06', text: 'pylesos 1,5 млн', keep: ['1,5 млн'], phones: 0 },
  { id: 'M07', text: 'sumka 150k', keep: ['150k'], phones: 0 },
  { id: 'M08', text: 'soat 150$', keep: ['150$'], phones: 0 },
  {
    id: 'M09',
    text: 'сто пятьдесят тысяч',
    keep: ['сто пятьдесят тысяч'],
    phones: 0,
  },
  {
    id: 'M10',
    text: 'ikki narx 90 000 95 000',
    keep: ['90 000 95 000'],
    phones: 0,
  },
  { id: 'M11', text: 'avto 20 000 000', keep: ['20 000 000'], phones: 0 },
  { id: 'M12', text: 'kvartira 900000000', keep: ['900000000'], phones: 0 },
  {
    id: 'M13',
    text: '3 ta, donasi 250 ming, jami 750 000',
    keep: ['250 ming', '750 000'],
    phones: 0,
  },
  { id: 'M14', text: 'narxi 99 000 50 ta', keep: ['99 000 50'], phones: 0 },
  {
    id: 'M15',
    text: "150 000 so'm 90 123 45 67",
    keep: ['150 000'],
    phones: 1,
  },
  { id: 'M16', text: 'narxi 120-150 ming', keep: ['120-150 ming'], phones: 0 },
  {
    id: 'M17',
    text: 'karta 8600 1234 5678 9012',
    keep: ['8600 1234 5678 9012'],
    phones: 0,
  },
];

/**
 * Narx: model QAYTARGAN qiymat (to'g'ri yoki tipik xato bilan) →
 * sanitizeExtraction → preview. Deterministik qatlam narxni TUZATA OLMAYDI;
 * o'lchanadi: xato qiymat operatorga belgi (`price_confirm`/`price_missing`)
 * bilan chiqadimi yoki jimgina "tayyor" bo'ladimi.
 */
export interface AmountModelCase {
  id: string;
  source: string;
  /** Matn bo'yicha to'g'ri jami narx (so'm) yoki null (aniqlab bo'lmaydi). */
  intended: number | null;
  /** Model qaytargan qiymat (sxema: number | null). */
  model: unknown;
  note: string;
}

export const AMOUNT_MODEL_CASES: AmountModelCase[] = [
  {
    id: 'V01',
    source: '150 ming',
    intended: 150000,
    model: 150000,
    note: "to'g'ri",
  },
  {
    id: 'V02',
    source: '1.5 mln',
    intended: 1500000,
    model: 1.5,
    note: "model ko'paytirmagan (mln)",
  },
  {
    id: 'V03',
    source: '1,5 mln',
    intended: 1500000,
    model: 15,
    note: "vergul o'nlik o'rniga minglik ajratgich deb olingan",
  },
  {
    id: 'V04',
    source: '150k',
    intended: 150000,
    model: 150,
    note: "k ko'paytirilmagan",
  },
  {
    id: 'V05',
    source: "150 000 so'm",
    intended: 150000,
    model: 15000,
    note: 'bitta 0 tushib qolgan (10x)',
  },
  {
    id: 'V06',
    source: '3 ta, donasi 250 ming',
    intended: 750000,
    model: 250000,
    note: "dona narxi songa ko'paytirilmagan",
  },
  {
    id: 'V07',
    source: 'jami 750 ming (3 ta)',
    intended: 750000,
    model: 2250000,
    note: "jami narx yana songa ko'paytirilgan",
  },
  {
    id: 'V08',
    source: '150$',
    intended: null,
    model: 150,
    note: 'valyuta $ — null kerak edi',
  },
  {
    id: 'V09',
    source: '150$',
    intended: null,
    model: 1920000,
    note: "model $ ni so'mga o'girgan",
  },
  {
    id: 'V10',
    source: 'сто пятьдесят тысяч',
    intended: 150000,
    model: 150000,
    note: "to'g'ri",
  },
  {
    id: 'V11',
    source: '120 yoki 150 ming',
    intended: null,
    model: 150000,
    note: 'noaniq — null kerak edi',
  },
  {
    id: 'V12',
    source: '4 mln 200',
    intended: 4200000,
    model: 4000200,
    note: '"4 mln 200" noto\'g\'ri talqin',
  },
  {
    id: 'V13',
    source: '150 ming',
    intended: 150000,
    model: 150000.4,
    note: 'kasr — yaxlitlanadi',
  },
  {
    id: 'V14',
    source: '0.4 (xato)',
    intended: null,
    model: 0.4,
    note: 'kichik kasr',
  },
  {
    id: 'V15',
    source: 'gallyutsinatsiya',
    intended: 150000,
    model: 150000000000,
    note: "1.5e11 — yuqori chegara yo'q",
  },
  {
    id: 'V16',
    source: '150 ming',
    intended: 150000,
    model: -150000,
    note: 'manfiy',
  },
  {
    id: 'V17',
    source: "narx yo'q",
    intended: null,
    model: null,
    note: "to'g'ri (null)",
  },
  {
    id: 'V18',
    source: '150 ming + dostavka 20 ming',
    intended: 170000,
    model: 150000,
    note: "yetkazish haqi qo'shilmagan (alohida maydon yo'q)",
  },
];
