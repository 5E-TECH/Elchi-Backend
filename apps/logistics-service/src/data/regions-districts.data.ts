/**
 * Hudud ma'lumotlari — HAQIQIY SOATO kodlari bilan.
 *
 * ⚠️ AVVAL BU YERDA SOATO UMUMAN YO'Q EDI. Seed (`logistics-service`
 * `onModuleInit`) kodlarni massiv INDEKSIDAN yasardi: `REG-01`,
 * `REG-01-DIS-01` va hokazo. Ular haqiqiy kodga o'xshamasdi ham.
 *
 * Oqibati jonli integratsiyada ko'rindi: hamkor (BeePost) SOATO bo'yicha
 * avtomatik moslashga uringanda 184 tumandan NOLTASI mos kelmadi — chunki
 * bir tomonda `1703224`, ikkinchi tomonda `REG-03-DIS-02` turardi.
 *
 * Soxta kod NULL dan ham yomon: u haqiqiydek ko'rinadi, shuning uchun
 * moslash jimgina noto'g'ri ishlaydi va xato hech qayerda ko'rinmaydi.
 *
 * MANBA: github.com/MIMAXUZ/uzbekistan-regions-data (rasmiy SOATO
 * klassifikatori, 14 viloyat / 210 tuman).
 *
 * SHAHAR/TUMAN AJRATIMI: manbada ayrim nomlar ham tuman, ham shahar
 * sifatida bor (`Qarshi tumani` 1710224 va `Qarshi` 1710401). Ajratish
 * nomdagi "shahri" belgisiga qarab bajarilgan.
 *
 * `sato_code: null` — kod NOMA'LUM degani. Seed bunday holatda hech narsa
 * o'ylab topmaydi; tuman SOATO'siz qoladi va uni qo'lda to'ldirish kerak.
 */
export interface SeedDistrict {
  name: string;
  /** Rasmiy SOATO kodi. `null` — noma'lum (soxta kod YOZILMAYDI). */
  sato_code: string | null;
}

export interface SeedRegion {
  name: string;
  sato_code: string | null;
  districts: SeedDistrict[];
}

export const regions: SeedRegion[] = [
  {
    name: "Toshkent shahri",
    sato_code: "1726",
    districts: [
      { name: "Bektemir", sato_code: "1726264" },
      { name: "Chilonzor", sato_code: "1726294" },
      { name: "Mirobod", sato_code: "1726273" },
      { name: "Mirzo Ulug'bek", sato_code: "1726269" },
      { name: "Olmazor", sato_code: "1726280" },
      { name: "Sergeli", sato_code: "1726283" },
      { name: "Shayxontohur", sato_code: "1726277" },
      { name: "Uchtepa", sato_code: "1726262" },
      { name: "Yakkasaroy", sato_code: "1726287" },
      { name: "Yashnobod", sato_code: "1726290" },
      { name: "Yunusobod", sato_code: "1726266" },
      { name: "Yangihayot", sato_code: "1726292" },
    ],
  },
  {
    name: "Toshkent ",
    sato_code: "1727",
    districts: [
      { name: "Angren", sato_code: "1727407" },
      { name: "Bekobod", sato_code: "1727220" },
      { name: "Bo'ka", sato_code: "1727228" },
      { name: "Bo'stonliq", sato_code: "1727224" },
      { name: "Chinoz", sato_code: "1727256" },
      { name: "Ohangaron", sato_code: "1727212" },
      { name: "Olmaliq", sato_code: "1727404" },
      { name: "Oqqo'rg'on", sato_code: "1727206" },
      { name: "Parkent", sato_code: "1727249" },
      { name: "Piskent", sato_code: "1727250" },
      { name: "Quyichirchiq", sato_code: "1727233" },
      { name: "Toshkent tumani", sato_code: "1727265" },
      { name: "Yuqorichirchiq", sato_code: "1727239" },
      { name: "Zangiota", sato_code: "1727237" },
      { name: "Yangiyo'l", sato_code: "1727259" },
      { name: "Nurafshon", sato_code: "1727401" },
      { name: "Chirchiq", sato_code: "1727419" },
      { name: "Qibray", sato_code: "1727248" },
    ],
  },
  {
    name: "Andijon ",
    sato_code: "1703",
    districts: [
      { name: "Andijon", sato_code: "1703203" },
      { name: "Asaka", sato_code: "1703224" },
      { name: "Baliqchi", sato_code: "1703206" },
      { name: "Bo'ston", sato_code: "1703209" },
      { name: "Buloqboshy", sato_code: "1703210" },
      { name: "Izboskan", sato_code: "1703214" },
      { name: "Jalaquduq", sato_code: "1703211" },
      { name: "Marhamat", sato_code: "1703227" },
      { name: "Paxtaobod", sato_code: "1703232" },
      { name: "Shahrixon", sato_code: "1703230" },
      { name: "Ulug'nor", sato_code: "1703217" },
      { name: "Xo'jaobod", sato_code: "1703236" },
      { name: "Andijon shahri", sato_code: "1703401" },
      { name: "Oltinko'l", sato_code: "1703202" },
      { name: "Qo'rg'ontepa", sato_code: "1703220" },
      { name: "Xonobod", sato_code: "1703408" },
    ],
  },
  {
    name: "Farg'ona",
    sato_code: "1730",
    districts: [
      { name: "Beshariq", sato_code: "1730215" },
      { name: "Bog'dod", sato_code: "1730209" },
      { name: "Buvaida", sato_code: "1730212" },
      { name: "Dang'ara", sato_code: "1730236" },
      { name: "Farg'ona", sato_code: "1730233" },
      { name: "Furqat", sato_code: "1730238" },
      { name: "Marg'ilon", sato_code: "1730412" },
      { name: "Oltiariq", sato_code: "1730203" },
      { name: "Qo'qon", sato_code: "1730405" },
      { name: "Quva", sato_code: "1730218" },
      { name: "Rishton", sato_code: "1730224" },
      { name: "So'x", sato_code: "1730226" },
      { name: "Toshloq", sato_code: "1730227" },
      { name: "Uchko'prik", sato_code: "1730221" },
      { name: "Yozyovon", sato_code: "1730242" },
    ],
  },
  {
    name: "Namangan ",
    sato_code: "1714",
    districts: [
      { name: "Chortoq", sato_code: "1714236" },
      { name: "Chust", sato_code: "1714237" },
      { name: "Kosonsoy", sato_code: "1714207" },
      { name: "Mingbuloq", sato_code: "1714204" },
      { name: "Namangan", sato_code: "1714212" },
      { name: "Norin", sato_code: "1714216" },
      { name: "Pop", sato_code: "1714219" },
      { name: "To'raqo'rg'on", sato_code: "1714224" },
      { name: "Uchqo'rg'on", sato_code: "1714234" },
      { name: "Yangiqo'rg'on", sato_code: "1714242" },
    ],
  },
  {
    name: "Samarqand ",
    sato_code: "1718",
    districts: [
      { name: "Bulung'ur", sato_code: "1718206" },
      { name: "Ishtixon", sato_code: "1718212" },
      { name: "Jomboy", sato_code: "1718209" },
      { name: "Kattaqo'rg'on", sato_code: "1718215" },
      { name: "Narpay", sato_code: "1718218" },
      { name: "Nurobod", sato_code: "1718235" },
      { name: "Oqdaryo", sato_code: "1718203" },
      { name: "Paxtachi", sato_code: "1718230" },
      { name: "Payariq", sato_code: "1718224" },
      { name: "Pastdarg'om", sato_code: "1718227" },
      { name: "Samarqand", sato_code: "1718233" },
      { name: "Tayloq", sato_code: "1718238" },
      { name: "Urgut", sato_code: "1718236" },
      { name: "Kattaqo'rg'on shahri", sato_code: "1718406" },
      { name: "Qo'shrabot", sato_code: "1718216" },
      { name: "Samarqand shahri", sato_code: "1718401" },
    ],
  },
  {
    name: "Buxoro ",
    sato_code: "1706",
    districts: [
      { name: "Buxoro", sato_code: "1706207" },
      { name: "G'ijduvon", sato_code: "1706215" },
      { name: "Jondor", sato_code: "1706246" },
      { name: "Kogon", sato_code: "1706219" },
      { name: "Olot", sato_code: "1706204" },
      { name: "Peshku", sato_code: "1706240" },
      { name: "Qorako'l", sato_code: "1706230" },
      { name: "Qorovulbozor", sato_code: "1706232" },
      { name: "Romitan", sato_code: "1706242" },
      { name: "Shofirkon", sato_code: "1706258" },
      { name: "Vobkent", sato_code: "1706212" },
      { name: "Buxoro shahri", sato_code: "1706401" },
      { name: "Kogon shahri", sato_code: "1706403" },
    ],
  },
  {
    name: "Navoiy ",
    sato_code: "1712",
    districts: [
      { name: "Karmana", sato_code: "1712234" },
      { name: "Konimex", sato_code: "1712211" },
      { name: "Navbahor", sato_code: "1712230" },
      { name: "Navoiy", sato_code: "1712401" },
      { name: "Nurota", sato_code: "1712238" },
      { name: "Qiziltepa", sato_code: "1712216" },
      { name: "Xatirchi", sato_code: "1712251" },
      { name: "Zarafshon", sato_code: "1712408" },
    ],
  },
  {
    name: "Xorazm ",
    sato_code: "1733",
    districts: [
      { name: "Bog'ot", sato_code: "1733204" },
      { name: "Gurlan", sato_code: "1733208" },
      { name: "Hazorasp", sato_code: "1733220" },
      { name: "Khiva", sato_code: "1733226" },
      { name: "Qo'shko'pir", sato_code: "1733212" },
      { name: "Shovot", sato_code: "1733230" },
      { name: "Urganch", sato_code: "1733217" },
      { name: "Yangiariq", sato_code: "1733233" },
      { name: "Yangibozor", sato_code: "1733236" },
    ],
  },
  {
    name: "Surxondaryo ",
    sato_code: "1722",
    districts: [
      { name: "Angor", sato_code: "1722202" },
      { name: "Bandixon", sato_code: "1722203" },
      { name: "Boysun", sato_code: "1722204" },
      { name: "Denov", sato_code: "1722210" },
      { name: "Jarqo'rg'on", sato_code: "1722212" },
      { name: "Qiziriq", sato_code: "1722215" },
      { name: "Qumqo'rg'on", sato_code: "1722214" },
      { name: "Muzrabot", sato_code: "1722207" },
      { name: "Oltinsoy", sato_code: "1722201" },
      { name: "Sariosiyo", sato_code: "1722217" },
      { name: "Sherobod", sato_code: "1722223" },
      { name: "Sho'rchi", sato_code: "1722226" },
      { name: "Termiz", sato_code: "1722220" },
      { name: "Uzun", sato_code: "1722221" },
    ],
  },
  {
    name: "Qashqadaryo ",
    sato_code: "1710",
    districts: [
      { name: "Chiroqchi", sato_code: "1710242" },
      { name: "Dehqonobod", sato_code: "1710212" },
      { name: "G'uzor", sato_code: "1710207" },
      { name: "Kamashi", sato_code: "1710220" },
      { name: "Karshi", sato_code: "1710224" },
      { name: "Kasbi", sato_code: "1710237" },
      { name: "Kitob", sato_code: "1710232" },
      { name: "Koson", sato_code: "1710229" },
      { name: "Mirishkor", sato_code: "1710233" },
      { name: "Muborak", sato_code: "1710234" },
      { name: "Nishon", sato_code: "1710235" },
      { name: "Shahrisabz", sato_code: "1710405" },
      { name: "Yakkabog'", sato_code: "1710250" },
      { name: "Ko'kdala", sato_code: "1710240" },
      { name: "Qarshi shahri", sato_code: "1710401" },
    ],
  },
  {
    name: "Jizzax ",
    sato_code: "1708",
    districts: [
      { name: "Arnasoy", sato_code: "1708201" },
      { name: "Baxmal", sato_code: "1708204" },
      { name: "Dustlik", sato_code: "1708215" },
      { name: "Forish", sato_code: "1708235" },
      { name: "G'allaorol", sato_code: "1708209" },
      { name: "Jizzax", sato_code: "1708401" },
      { name: "Mirzacho'l", sato_code: "1708223" },
      { name: "Paxtakor", sato_code: "1708228" },
      { name: "Yangiobod", sato_code: "1708237" },
      { name: "Zafarobod", sato_code: "1708225" },
      { name: "Zarbdor", sato_code: "1708220" },
    ],
  },
  {
    name: "Sirdaryo ",
    sato_code: "1724",
    districts: [
      { name: "Boyovut", sato_code: "1724212" },
      { name: "Guliston", sato_code: "1724220" },
      { name: "Mirzaobod", sato_code: "1724228" },
      { name: "Oqoltin", sato_code: "1724206" },
      { name: "Sayxunobod", sato_code: "1724216" },
      { name: "Sardoba", sato_code: "1724226" },
      { name: "Shirin", sato_code: "1724410" },
      { name: "Sirdaryo", sato_code: "1724231" },
      { name: "Xovos", sato_code: "1724235" },
      { name: "Yangier", sato_code: "1724413" },
    ],
  },
  {
    name: "Qoraqalpog'iston Respublikasi",
    sato_code: "1735",
    districts: [
      { name: "Amudaryo", sato_code: "1735204" },
      { name: "Beruniy", sato_code: "1735207" },
      { name: "Chimboy", sato_code: "1735240" },
      { name: "Ellikqal'a", sato_code: "1735250" },
      { name: "Kegeyli", sato_code: "1735212" },
      { name: "Mo'ynoq", sato_code: "1735222" },
      { name: "Nukus", sato_code: "1735225" },
      { name: "Qo'ng'irot", sato_code: "1735215" },
      { name: "Qanliko'l", sato_code: "1735218" },
      { name: "Qorao'zak", sato_code: "1735211" },
      { name: "Shumanay", sato_code: "1735243" },
      { name: "Taxtako'pir", sato_code: "1735230" },
      { name: "To'rtko'l", sato_code: "1735233" },
      { name: "Xo'jayli", sato_code: "1735236" },
    ],
  },
];
