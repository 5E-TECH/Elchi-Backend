/**
 * O'zbekiston Respublikasi viloyat va tumanlarining SOATO kodlari
 * Rasmiy manba: Davlat statistika qo'mitasining 2020-yil 22-iyuldagi 59-sonli buyrug'i
 * Excel fayl: soato-20_04_2022_p90343.xlsx
 *
 * Format: Viloyat kodi (4 raqam), Tuman kodi (7 raqam)
 */

export interface SatoRegion {
  name: string;
  sato_code: string;
  districts: {
    name: string;
    sato_code: string;
  }[];
}

export const satoRegions: SatoRegion[] = [
  {
    name: 'Andijon viloyati',
    sato_code: '1703',
    districts: [
      { name: 'Andijon shahri', sato_code: '1703401' },
      { name: 'Xonobod shahri', sato_code: '1703408' },
      { name: "Oltinko'l tumani", sato_code: '1703202' },
      { name: 'Andijon tumani', sato_code: '1703203' },
      { name: 'Baliqchi tumani', sato_code: '1703206' },
      { name: "Bo'ston tumani", sato_code: '1703209' },
      { name: 'Buloqboshi tumani', sato_code: '1703210' },
      { name: 'Jalaquduq tumani', sato_code: '1703211' },
      { name: 'Izboskan tumani', sato_code: '1703214' },
      { name: "Ulug'nor tumani", sato_code: '1703217' },
      { name: "Qo'rg'ontepa tumani", sato_code: '1703220' },
      { name: 'Asaka tumani', sato_code: '1703224' },
      { name: 'Marxamat tumani', sato_code: '1703227' },
      { name: 'Shaxrixon tumani', sato_code: '1703230' },
      { name: 'Paxtaobod tumani', sato_code: '1703232' },
      { name: "Xo'jaobod tumani", sato_code: '1703236' },
    ],
  },
  {
    name: 'Buxoro viloyati',
    sato_code: '1706',
    districts: [
      { name: 'Buxoro shahri', sato_code: '1706401' },
      { name: 'Kogon shahri', sato_code: '1706403' },
      { name: 'Olot tumani', sato_code: '1706204' },
      { name: 'Buxoro tumani', sato_code: '1706207' },
      { name: 'Vobkent tumani', sato_code: '1706212' },
      { name: "G'ijduvon tumani", sato_code: '1706215' },
      { name: 'Kogon tumani', sato_code: '1706219' },
      { name: "Qorako'l tumani", sato_code: '1706230' },
      { name: 'Qorovulbozor tumani', sato_code: '1706232' },
      { name: 'Peshku tumani', sato_code: '1706240' },
      { name: 'Romitan tumani', sato_code: '1706242' },
      { name: 'Jondor tumani', sato_code: '1706246' },
      { name: 'Shofirkon tumani', sato_code: '1706258' },
    ],
  },
  {
    name: 'Jizzax viloyati',
    sato_code: '1708',
    districts: [
      { name: 'Jizzax shahri', sato_code: '1708401' },
      { name: 'Arnasoy tumani', sato_code: '1708201' },
      { name: 'Baxmal tumani', sato_code: '1708204' },
      { name: "G'allaorol tumani", sato_code: '1708209' },
      { name: 'Sharof Rashidov tumani', sato_code: '1708212' },
      { name: "Do'stlik tumani", sato_code: '1708215' },
      { name: 'Zomin tumani', sato_code: '1708218' },
      { name: 'Zarbdor tumani', sato_code: '1708220' },
      { name: "Mirzacho'l tumani", sato_code: '1708223' },
      { name: 'Zafarobod tumani', sato_code: '1708225' },
      { name: 'Paxtakor tumani', sato_code: '1708228' },
      { name: 'Forish tumani', sato_code: '1708235' },
      { name: 'Yangiobod tumani', sato_code: '1708237' },
    ],
  },
  {
    name: 'Qashqadaryo viloyati',
    sato_code: '1710',
    districts: [
      { name: 'Qarshi shahri', sato_code: '1710401' },
      { name: 'Shahrisabz shahri', sato_code: '1710405' },
      { name: "G'uzor tumani", sato_code: '1710207' },
      { name: 'Dehqonobod tumani', sato_code: '1710212' },
      { name: 'Qamashi tumani', sato_code: '1710220' },
      { name: 'Qarshi tumani', sato_code: '1710224' },
      { name: 'Koson tumani', sato_code: '1710229' },
      { name: 'Kitob tumani', sato_code: '1710232' },
      { name: 'Mirishkor tumani', sato_code: '1710233' },
      { name: 'Muborak tumani', sato_code: '1710234' },
      { name: 'Nishon tumani', sato_code: '1710235' },
      { name: 'Kasbi tumani', sato_code: '1710237' },
      { name: "Ko'kdala tumani", sato_code: '1710240' },
      { name: 'Chiroqchi tumani', sato_code: '1710242' },
      { name: 'Shahrisabz tumani', sato_code: '1710245' },
      { name: "Yakkabog' tumani", sato_code: '1710250' },
    ],
  },
  {
    name: 'Navoiy viloyati',
    sato_code: '1712',
    districts: [
      { name: 'Navoiy shahri', sato_code: '1712401' },
      { name: 'Zarafshon shahri', sato_code: '1712408' },
      { name: "G'ozg'on shahri", sato_code: '1712412' },
      { name: 'Konimex tumani', sato_code: '1712211' },
      { name: 'Qiziltepa tumani', sato_code: '1712216' },
      { name: 'Navbahor tumani', sato_code: '1712230' },
      { name: 'Karmana tumani', sato_code: '1712234' },
      { name: 'Nurota tumani', sato_code: '1712238' },
      { name: 'Tomdi tumani', sato_code: '1712244' },
      { name: 'Uchquduq tumani', sato_code: '1712248' },
      { name: 'Xatirchi tumani', sato_code: '1712251' },
    ],
  },
  {
    name: 'Namangan viloyati',
    sato_code: '1714',
    districts: [
      { name: 'Namangan shahri', sato_code: '1714401' },
      { name: 'Mingbuloq tumani', sato_code: '1714204' },
      { name: 'Kosonsoy tumani', sato_code: '1714207' },
      { name: 'Namangan tumani', sato_code: '1714212' },
      { name: 'Norin tumani', sato_code: '1714216' },
      { name: 'Pop tumani', sato_code: '1714219' },
      { name: "To'raqo'rg'on tumani", sato_code: '1714224' },
      { name: 'Uychi tumani', sato_code: '1714229' },
      { name: "Uchqo'rg'on tumani", sato_code: '1714234' },
      { name: 'Chortoq tumani', sato_code: '1714236' },
      { name: 'Chust tumani', sato_code: '1714237' },
      { name: "Yangiqo'rg'on tumani", sato_code: '1714242' },
    ],
  },
  {
    name: 'Samarqand viloyati',
    sato_code: '1718',
    districts: [
      { name: 'Samarqand shahri', sato_code: '1718401' },
      { name: "Kattaqo'rg'on shahri", sato_code: '1718406' },
      { name: 'Oqdaryo tumani', sato_code: '1718203' },
      { name: "Bulung'ur tumani", sato_code: '1718206' },
      { name: 'Jomboy tumani', sato_code: '1718209' },
      { name: 'Ishtixon tumani', sato_code: '1718212' },
      { name: "Kattaqo'rg'on tumani", sato_code: '1718215' },
      { name: "Qo'shrabot tumani", sato_code: '1718216' },
      { name: 'Narpay tumani', sato_code: '1718218' },
      { name: 'Payariq tumani', sato_code: '1718224' },
      { name: "Pastdarg'om tumani", sato_code: '1718227' },
      { name: 'Paxtachi tumani', sato_code: '1718230' },
      { name: 'Samarqand tumani', sato_code: '1718233' },
      { name: 'Nurobod tumani', sato_code: '1718235' },
      { name: 'Urgut tumani', sato_code: '1718236' },
      { name: 'Tayloq tumani', sato_code: '1718238' },
    ],
  },
  {
    name: 'Surxondaryo viloyati',
    sato_code: '1722',
    districts: [
      { name: 'Termiz shahri', sato_code: '1722401' },
      { name: 'Oltinsoy tumani', sato_code: '1722201' },
      { name: 'Angor tumani', sato_code: '1722202' },
      { name: 'Bandixon tumani', sato_code: '1722203' },
      { name: 'Boysun tumani', sato_code: '1722204' },
      { name: 'Muzrabot tumani', sato_code: '1722207' },
      { name: 'Denov tumani', sato_code: '1722210' },
      { name: "Jarqo'rg'on tumani", sato_code: '1722212' },
      { name: "Qumqo'rg'on tumani", sato_code: '1722214' },
      { name: 'Qiziriq tumani', sato_code: '1722215' },
      { name: 'Sariosiyo tumani', sato_code: '1722217' },
      { name: 'Termiz tumani', sato_code: '1722220' },
      { name: 'Uzun tumani', sato_code: '1722221' },
      { name: 'Sherobod tumani', sato_code: '1722223' },
      { name: "Sho'rchi tumani", sato_code: '1722226' },
    ],
  },
  {
    name: 'Sirdaryo viloyati',
    sato_code: '1724',
    districts: [
      { name: 'Guliston shahri', sato_code: '1724401' },
      { name: 'Shirin shahri', sato_code: '1724410' },
      { name: 'Yangiyer shahri', sato_code: '1724413' },
      { name: 'Oqoltin tumani', sato_code: '1724206' },
      { name: 'Boyovut tumani', sato_code: '1724212' },
      { name: 'Sayxunobod tumani', sato_code: '1724216' },
      { name: 'Guliston tumani', sato_code: '1724220' },
      { name: 'Sardoba tumani', sato_code: '1724226' },
      { name: 'Mirzaobod tumani', sato_code: '1724228' },
      { name: 'Sirdaryo tumani', sato_code: '1724231' },
      { name: 'Xovos tumani', sato_code: '1724235' },
    ],
  },
  {
    name: 'Toshkent shahri',
    sato_code: '1726',
    districts: [
      { name: 'Uchtepa tumani', sato_code: '1726262' },
      { name: 'Bektemir tumani', sato_code: '1726264' },
      { name: 'Yunusobod tumani', sato_code: '1726266' },
      { name: "Mirzo Ulug'bek tumani", sato_code: '1726269' },
      { name: 'Mirobod tumani', sato_code: '1726273' },
      { name: 'Shayxontoxur tumani', sato_code: '1726277' },
      { name: 'Olmazor tumani', sato_code: '1726280' },
      { name: "Sirg'ali tumani", sato_code: '1726283' },
      { name: 'Yakkasaroy tumani', sato_code: '1726287' },
      { name: 'Yashnobod tumani', sato_code: '1726290' },
      { name: 'Yangihayot tumani', sato_code: '1726292' },
      { name: 'Chilonzor tumani', sato_code: '1726294' },
    ],
  },
  {
    name: 'Toshkent viloyati',
    sato_code: '1727',
    districts: [
      { name: 'Nurafshon shahri', sato_code: '1727401' },
      { name: 'Olmaliq shahri', sato_code: '1727404' },
      { name: 'Angren shahri', sato_code: '1727407' },
      { name: 'Bekobod shahri', sato_code: '1727413' },
      { name: 'Ohangaron shahri', sato_code: '1727415' },
      { name: 'Chirchiq shahri', sato_code: '1727419' },
      { name: "Yangiyo'l shahri", sato_code: '1727424' },
      { name: "Oqqo'rg'on tumani", sato_code: '1727206' },
      { name: 'Ohangaron tumani', sato_code: '1727212' },
      { name: 'Bekobod tumani', sato_code: '1727220' },
      { name: "Bo'stonliq tumani", sato_code: '1727224' },
      { name: "Bo'ka tumani", sato_code: '1727228' },
      { name: 'Quyichirchiq tumani', sato_code: '1727233' },
      { name: 'Zangiota tumani', sato_code: '1727237' },
      { name: 'Yuqorichirchiq tumani', sato_code: '1727239' },
      { name: 'Qibray tumani', sato_code: '1727248' },
      { name: 'Parkent tumani', sato_code: '1727249' },
      { name: 'Pskent tumani', sato_code: '1727250' },
      { name: "O'rtachirchiq tumani", sato_code: '1727253' },
      { name: 'Chinoz tumani', sato_code: '1727256' },
      { name: "Yangiyo'l tumani", sato_code: '1727259' },
      { name: 'Toshkent tumani', sato_code: '1727265' },
    ],
  },
  {
    name: "Farg'ona viloyati",
    sato_code: '1730',
    districts: [
      { name: "Farg'ona shahri", sato_code: '1730401' },
      { name: "Qo'qon shahri", sato_code: '1730405' },
      { name: 'Quvasoy shahri', sato_code: '1730408' },
      { name: "Marg'ilon shahri", sato_code: '1730412' },
      { name: 'Oltiariq tumani', sato_code: '1730203' },
      { name: "Qo'shtepa tumani", sato_code: '1730206' },
      { name: "Bog'dod tumani", sato_code: '1730209' },
      { name: 'Buvayda tumani', sato_code: '1730212' },
      { name: 'Beshariq tumani', sato_code: '1730215' },
      { name: 'Quva tumani', sato_code: '1730218' },
      { name: "Uchko'prik tumani", sato_code: '1730221' },
      { name: 'Rishton tumani', sato_code: '1730224' },
      { name: "So'x tumani", sato_code: '1730226' },
      { name: 'Toshloq tumani', sato_code: '1730227' },
      { name: "O'zbekiston tumani", sato_code: '1730230' },
      { name: "Farg'ona tumani", sato_code: '1730233' },
      { name: "Dang'ara tumani", sato_code: '1730236' },
      { name: 'Furqat tumani', sato_code: '1730238' },
      { name: 'Yozyovon tumani', sato_code: '1730242' },
    ],
  },
  {
    name: 'Xorazm viloyati',
    sato_code: '1733',
    districts: [
      { name: 'Urganch shahri', sato_code: '1733401' },
      { name: 'Xiva shahri', sato_code: '1733406' },
      { name: "Bog'ot tumani", sato_code: '1733204' },
      { name: 'Gurlan tumani', sato_code: '1733208' },
      { name: "Qo'shko'pir tumani", sato_code: '1733212' },
      { name: 'Urganch tumani', sato_code: '1733217' },
      { name: 'Xazorasp tumani', sato_code: '1733220' },
      { name: "Tuproqqal'a tumani", sato_code: '1733221' },
      { name: 'Xonqa tumani', sato_code: '1733223' },
      { name: 'Xiva tumani', sato_code: '1733226' },
      { name: 'Shovot tumani', sato_code: '1733230' },
      { name: 'Yangiariq tumani', sato_code: '1733233' },
      { name: 'Yangibozor tumani', sato_code: '1733236' },
    ],
  },
  {
    name: "Qoraqalpog'iston Respublikasi",
    sato_code: '1735',
    districts: [
      { name: 'Nukus shahri', sato_code: '1735401' },
      { name: 'Amudaryo tumani', sato_code: '1735204' },
      { name: 'Beruniy tumani', sato_code: '1735207' },
      { name: "Bo'zatov tumani", sato_code: '1735209' },
      { name: "Qorao'zak tumani", sato_code: '1735211' },
      { name: 'Kegeyli tumani', sato_code: '1735212' },
      { name: "Qo'ng'irot tumani", sato_code: '1735215' },
      { name: "Qanliko'l tumani", sato_code: '1735218' },
      { name: "Mo'ynoq tumani", sato_code: '1735222' },
      { name: 'Nukus tumani', sato_code: '1735225' },
      { name: 'Taxiatosh tumani', sato_code: '1735228' },
      { name: "Taxtako'pir tumani", sato_code: '1735230' },
      { name: "To'rtko'l tumani", sato_code: '1735233' },
      { name: "Xo'jayli tumani", sato_code: '1735236' },
      { name: 'Chimboy tumani', sato_code: '1735240' },
      { name: 'Shumanay tumani', sato_code: '1735243' },
      { name: 'Ellikkala tumani', sato_code: '1735250' },
    ],
  },
];

/**
 * SATO kodini viloyat nomi bo'yicha topish
 */
export function findRegionByName(name: string): SatoRegion | undefined {
  return satoRegions.find(
    (r) => r.name.toLowerCase().trim() === name.toLowerCase().trim(),
  );
}

/**
 * SATO kodini tuman nomi bo'yicha topish
 */
export function findDistrictByName(
  regionName: string,
  districtName: string,
): { name: string; sato_code: string } | undefined {
  const region = findRegionByName(regionName);
  if (!region) return undefined;

  return region.districts.find(
    (d) => d.name.toLowerCase().trim() === districtName.toLowerCase().trim(),
  );
}
