import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Hududlarga HAQIQIY SOATO kodlarini yozish (soxta kodlar o'rniga).
 *
 * MUAMMO. Seed (`logistics-service` `onModuleInit`) SOATO kodlarini massiv
 * INDEKSIDAN yasardi: viloyatga `REG-01`, tumanga `REG-01-DIS-01`. Ular
 * haqiqiy SOATO'ga umuman o'xshamasdi — ustiga tizimning O'Z validatori
 * (`update-district-sato-code.dto.ts`) SOATO'ni `^\\d+$` deb talab qiladi,
 * ya'ni seed o'z qoidasini buzib yozardi.
 *
 * Buning narxi jonli integratsiyada ko'rindi: hamkor (BeePost) SOATO bo'yicha
 * avtomatik moslashga uringanda 184 tumandan NOLTASI mos kelmadi — bir tomonda
 * `1703224`, bizda `REG-03-DIS-02`.
 *
 * Soxta kod NULL dan ham yomon: u haqiqiydek ko'rinadi, shuning uchun moslash
 * jimgina noto'g'ri ishlaydi va xato hech qayerda ko'rinmaydi.
 *
 * NIMA QILINADI:
 *   1. `sato_code` ustunlari NULL qabul qiladigan bo'ladi. Bu seed'dagi
 *      soxta kod yasashning ASL SABABI edi — ustun NOT NULL bo'lgani uchun
 *      "noma'lum" holatini ifodalashning yo'li yo'q edi va kod o'ylab
 *      topishga majbur bo'lardi.
 *   2. Mavjud soxta kodlar (`REG-...`) haqiqiysiga almashtiriladi — nom
 *      bo'yicha, chunki id'lar muhitga qarab farq qiladi.
 *
 * MANBA: github.com/MIMAXUZ/uzbekistan-regions-data (rasmiy SOATO
 * klassifikatori). Ishonchlilik: BeePost bazasidagi mavjud 71 kodning
 * HAMMASI shu manbada topildi, 0 ta chetlashish.
 *
 * XAVFSIZLIK: faqat soxta (`REG-` bilan boshlanadigan) yoki bo'sh kodlar
 * yangilanadi. Qo'lda kiritilgan haqiqiy kod USTIDAN YOZILMAYDI.
 */
export class RealSatoCodes1716000000027 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    // 1. "Noma'lum" holatini ifodalash mumkin bo'lsin — soxta kod yasashga
    //    majburlovchi cheklov olib tashlanadi.
    await queryRunner.query(
      `ALTER TABLE "logistics_schema"."districts" ALTER COLUMN "sato_code" DROP NOT NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE "logistics_schema"."regions" ALTER COLUMN "sato_code" DROP NOT NULL`,
    );

    // 2. Viloyatlar
    await queryRunner.query(`
      WITH src(name, sato) AS (VALUES
      ('Toshkent shahri', '1726'),
      ('Toshkent', '1727'),
      ('Andijon', '1703'),
      ('Farg''ona', '1730'),
      ('Namangan', '1714'),
      ('Samarqand', '1718'),
      ('Buxoro', '1706'),
      ('Navoiy', '1712'),
      ('Xorazm', '1733'),
      ('Surxondaryo', '1722'),
      ('Qashqadaryo', '1710'),
      ('Jizzax', '1708'),
      ('Sirdaryo', '1724'),
      ('Qoraqalpog''iston Respublikasi', '1735')
      )
      UPDATE "logistics_schema"."regions" r
      SET sato_code = src.sato
      FROM src
      WHERE btrim(r.name) = src.name
        AND (r.sato_code IS NULL OR r.sato_code LIKE 'REG-%')
        AND NOT EXISTS (
          SELECT 1 FROM "logistics_schema"."regions" x WHERE x.sato_code = src.sato
        );
    `);

    // 3. Tumanlar — viloyat nomi bilan birga, chunki tuman nomi viloyatlar
    //    orasida takrorlanishi mumkin.
    await queryRunner.query(`
      WITH src(region_name, district_name, sato) AS (VALUES
      ('Toshkent shahri', 'Bektemir', '1726264'),
      ('Toshkent shahri', 'Chilonzor', '1726294'),
      ('Toshkent shahri', 'Mirobod', '1726273'),
      ('Toshkent shahri', 'Mirzo Ulug''bek', '1726269'),
      ('Toshkent shahri', 'Olmazor', '1726280'),
      ('Toshkent shahri', 'Sergeli', '1726283'),
      ('Toshkent shahri', 'Shayxontohur', '1726277'),
      ('Toshkent shahri', 'Uchtepa', '1726262'),
      ('Toshkent shahri', 'Yakkasaroy', '1726287'),
      ('Toshkent shahri', 'Yashnobod', '1726290'),
      ('Toshkent shahri', 'Yunusobod', '1726266'),
      ('Toshkent', 'Angren', '1727407'),
      ('Toshkent', 'Bekobod', '1727220'),
      ('Toshkent', 'Bo''ka', '1727228'),
      ('Toshkent', 'Bo''stonliq', '1727224'),
      ('Toshkent', 'Chinoz', '1727256'),
      ('Toshkent', 'Ohangaron', '1727212'),
      ('Toshkent', 'Olmaliq', '1727404'),
      ('Toshkent', 'Oqqo''rg''on', '1727206'),
      ('Toshkent', 'Parkent', '1727249'),
      ('Toshkent', 'Piskent', '1727250'),
      ('Toshkent', 'Quyichirchiq', '1727233'),
      ('Toshkent', 'Toshkent tumani', '1727265'),
      ('Toshkent', 'Yuqorichirchiq', '1727239'),
      ('Toshkent', 'Zangiota', '1727237'),
      ('Toshkent', 'Yangiyo''l', '1727259'),
      ('Toshkent', 'Nurafshon', '1727401'),
      ('Andijon', 'Andijon', '1703203'),
      ('Andijon', 'Asaka', '1703224'),
      ('Andijon', 'Baliqchi', '1703206'),
      ('Andijon', 'Bo''ston', '1703209'),
      ('Andijon', 'Buloqboshy', '1703210'),
      ('Andijon', 'Izboskan', '1703214'),
      ('Andijon', 'Jalaquduq', '1703211'),
      ('Andijon', 'Khojaobod', '1703236'),
      ('Andijon', 'Marhamat', '1703227'),
      ('Andijon', 'Paxtaobod', '1703232'),
      ('Andijon', 'Shahrixon', '1703230'),
      ('Andijon', 'Ulug''nor', '1703217'),
      ('Andijon', 'Xo''jaobod', '1703236'),
      ('Farg''ona', 'Beshariq', '1730215'),
      ('Farg''ona', 'Bog''dod', '1730209'),
      ('Farg''ona', 'Buvaida', '1730212'),
      ('Farg''ona', 'Dang''ara', '1730236'),
      ('Farg''ona', 'Farg''ona', '1730233'),
      ('Farg''ona', 'Furqat', '1730238'),
      ('Farg''ona', 'Marg''ilon', '1730412'),
      ('Farg''ona', 'Oltiariq', '1730203'),
      ('Farg''ona', 'Qo''qon', '1730405'),
      ('Farg''ona', 'Quva', '1730218'),
      ('Farg''ona', 'Rishton', '1730224'),
      ('Farg''ona', 'So''x', '1730226'),
      ('Farg''ona', 'Toshloq', '1730227'),
      ('Farg''ona', 'Uchko''prik', '1730221'),
      ('Farg''ona', 'Yozyovon', '1730242'),
      ('Namangan', 'Chortoq', '1714236'),
      ('Namangan', 'Chust', '1714237'),
      ('Namangan', 'Kosonsoy', '1714207'),
      ('Namangan', 'Mingbuloq', '1714204'),
      ('Namangan', 'Namangan', '1714212'),
      ('Namangan', 'Norin', '1714216'),
      ('Namangan', 'Pop', '1714219'),
      ('Namangan', 'To''raqo''rg''on', '1714224'),
      ('Namangan', 'Uchqo''rg''on', '1714234'),
      ('Namangan', 'Yangiqo''rg''on', '1714242'),
      ('Samarqand', 'Bulung''ur', '1718206'),
      ('Samarqand', 'Ishtixon', '1718212'),
      ('Samarqand', 'Jomboy', '1718209'),
      ('Samarqand', 'Kattaqo''rg''on', '1718215'),
      ('Samarqand', 'Narpay', '1718218'),
      ('Samarqand', 'Nurobod', '1718235'),
      ('Samarqand', 'Oqdaryo', '1718203'),
      ('Samarqand', 'Paxtachi', '1718230'),
      ('Samarqand', 'Payariq', '1718224'),
      ('Samarqand', 'Pastdarg''om', '1718227'),
      ('Samarqand', 'Samarqand', '1718233'),
      ('Samarqand', 'Tayloq', '1718238'),
      ('Samarqand', 'Urgut', '1718236'),
      ('Buxoro', 'Buxoro', '1706207'),
      ('Buxoro', 'G''ijduvon', '1706215'),
      ('Buxoro', 'Jondor', '1706246'),
      ('Buxoro', 'Kogon', '1706219'),
      ('Buxoro', 'Olot', '1706204'),
      ('Buxoro', 'Peshku', '1706240'),
      ('Buxoro', 'Qorako''l', '1706230'),
      ('Buxoro', 'Qorovulbozor', '1706232'),
      ('Buxoro', 'Romitan', '1706242'),
      ('Buxoro', 'Shofirkon', '1706258'),
      ('Buxoro', 'Vobkent', '1706212'),
      ('Navoiy', 'Karmana', '1712234'),
      ('Navoiy', 'Konimex', '1712211'),
      ('Navoiy', 'Navbahor', '1712230'),
      ('Navoiy', 'Navoiy', '1712401'),
      ('Navoiy', 'Nurota', '1712238'),
      ('Navoiy', 'Qiziltepa', '1712216'),
      ('Navoiy', 'Xatirchi', '1712251'),
      ('Navoiy', 'Zarafshon', '1712408'),
      ('Xorazm', 'Bog''ot', '1733204'),
      ('Xorazm', 'Gurlan', '1733208'),
      ('Xorazm', 'Hazorasp', '1733220'),
      ('Xorazm', 'Khiva', '1733226'),
      ('Xorazm', 'Qo''shko''pir', '1733212'),
      ('Xorazm', 'Shovot', '1733230'),
      ('Xorazm', 'Urganch', '1733217'),
      ('Xorazm', 'Yangiariq', '1733233'),
      ('Xorazm', 'Yangibozor', '1733236'),
      ('Surxondaryo', 'Angor', '1722202'),
      ('Surxondaryo', 'Bandixon', '1722203'),
      ('Surxondaryo', 'Boysun', '1722204'),
      ('Surxondaryo', 'Denov', '1722210'),
      ('Surxondaryo', 'Jarqo''rg''on', '1722212'),
      ('Surxondaryo', 'Qiziriq', '1722215'),
      ('Surxondaryo', 'Qumqo''rg''on', '1722214'),
      ('Surxondaryo', 'Muzrabot', '1722207'),
      ('Surxondaryo', 'Oltinsoy', '1722201'),
      ('Surxondaryo', 'Sariosiyo', '1722217'),
      ('Surxondaryo', 'Sherobod', '1722223'),
      ('Surxondaryo', 'Sho''rchi', '1722226'),
      ('Surxondaryo', 'Termiz', '1722220'),
      ('Surxondaryo', 'Uzun', '1722221'),
      ('Qashqadaryo', 'Chiroqchi', '1710242'),
      ('Qashqadaryo', 'Dehqonobod', '1710212'),
      ('Qashqadaryo', 'G''uzor', '1710207'),
      ('Qashqadaryo', 'Kamashi', '1710220'),
      ('Qashqadaryo', 'Karshi', '1710224'),
      ('Qashqadaryo', 'Kasbi', '1710237'),
      ('Qashqadaryo', 'Kitob', '1710232'),
      ('Qashqadaryo', 'Koson', '1710229'),
      ('Qashqadaryo', 'Mirishkor', '1710233'),
      ('Qashqadaryo', 'Muborak', '1710234'),
      ('Qashqadaryo', 'Nishon', '1710235'),
      ('Qashqadaryo', 'Shahrisabz', '1710405'),
      ('Qashqadaryo', 'Yakkabog''', '1710250'),
      ('Jizzax', 'Arnasoy', '1708201'),
      ('Jizzax', 'Baxmal', '1708204'),
      ('Jizzax', 'Dustlik', '1708215'),
      ('Jizzax', 'Forish', '1708235'),
      ('Jizzax', 'G''allaorol', '1708209'),
      ('Jizzax', 'Jizzax', '1708401'),
      ('Jizzax', 'Mirzacho''l', '1708223'),
      ('Jizzax', 'Paxtakor', '1708228'),
      ('Jizzax', 'Yangiobod', '1708237'),
      ('Jizzax', 'Zafarobod', '1708225'),
      ('Jizzax', 'Zarbdor', '1708220'),
      ('Sirdaryo', 'Akaltyn', '1724206'),
      ('Sirdaryo', 'Boyovut', '1724212'),
      ('Sirdaryo', 'Guliston', '1724220'),
      ('Sirdaryo', 'Mirzaobod', '1724228'),
      ('Sirdaryo', 'Oqoltin', '1724206'),
      ('Sirdaryo', 'Sayxunobod', '1724216'),
      ('Sirdaryo', 'Sardoba', '1724226'),
      ('Sirdaryo', 'Shirin', '1724410'),
      ('Sirdaryo', 'Sirdaryo', '1724231'),
      ('Sirdaryo', 'Xovos', '1724235'),
      ('Sirdaryo', 'Yangier', '1724413'),
      ('Qoraqalpog''iston Respublikasi', 'Amudaryo', '1735204'),
      ('Qoraqalpog''iston Respublikasi', 'Beruniy', '1735207'),
      ('Qoraqalpog''iston Respublikasi', 'Chimboy', '1735240'),
      ('Qoraqalpog''iston Respublikasi', 'Ellikqal''a', '1735250'),
      ('Qoraqalpog''iston Respublikasi', 'Kegeyli', '1735212'),
      ('Qoraqalpog''iston Respublikasi', 'Mo''ynoq', '1735222'),
      ('Qoraqalpog''iston Respublikasi', 'Nukus', '1735225'),
      ('Qoraqalpog''iston Respublikasi', 'Qo''ng''irot', '1735215'),
      ('Qoraqalpog''iston Respublikasi', 'Qanliko''l', '1735218'),
      ('Qoraqalpog''iston Respublikasi', 'Qorao''zak', '1735211'),
      ('Qoraqalpog''iston Respublikasi', 'Shumanay', '1735243'),
      ('Qoraqalpog''iston Respublikasi', 'Taxtako''pir', '1735230'),
      ('Qoraqalpog''iston Respublikasi', 'To''rtko''l', '1735233'),
      ('Qoraqalpog''iston Respublikasi', 'Xo''jayli', '1735236')
      )
      UPDATE "logistics_schema"."districts" d
      SET sato_code = src.sato
      FROM src
      JOIN "logistics_schema"."regions" r ON btrim(r.name) = src.region_name
      WHERE d.region_id = r.id
        AND btrim(d.name) = src.district_name
        AND (d.sato_code IS NULL OR d.sato_code LIKE 'REG-%');
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    /**
     * Kodlar QAYTARILMAYDI: soxta kodlarni tiklashning ma'nosi yo'q va
     * qaysi qator shu migratsiyada o'zgargani saqlanmaydi.
     *
     * NOT NULL ham TIKLANMAYDI: tiklansa, SOATO'si noma'lum qator bo'lsa
     * migratsiya yiqiladi — va tiklanganda yana soxta kod yozishga majbur
     * qilardi. Aynan shundan qochyapmiz.
     */
  }
}
