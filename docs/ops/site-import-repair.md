# Sayt importini tiklash (2026-11-24 hodisasi)

2026-11-24 kechqurun «Tashqi saytlar» skanidan qabul qilingan 58 ta buyurtma (Lidershop 49, Alion 7, Inhayat 2) bitta tumanga (Bektemir) va Toshkent shahri pochtasiga tushdi. Sabab va tuzatish — PR #780. Yangi qabullar tuzatilgan, lekin eski 58 tasi o'zi tuzalmaydi — buning uchun shu skript.

## Nima qiladi

Har buyurtma uchun, bitta tranzaksiyada:

- saytdagi haqiqiy tuman va uning xizmat viloyati yoziladi;
- buyurtma o'sha viloyatning YANGI pochtasiga o'tadi (pochta bo'lmasa ochiladi);
- mijoz kartasidagi tuman, agar hali o'sha xato tuman bo'lsa, to'g'rilanadi;
- tegilgan pochtalar sanog'i va summasi qayta hisoblanadi;
- `order_schema.activity_logs` ga audit yoziladi (`metadata.reason = 'site_import_district_repair'`, `run_id`).

**Allaqachon jo'natilgan, lekin to'g'ri viloyat pochtasidagi** buyurtmada (masalan 2026-11-25 da xodimlar qo'lda ajratib jo'natgan 9 ta Toshkent shahri buyurtmasi) faqat tuman va viloyat to'g'rilanadi — pochta, holat va egalik o'zgarmaydi. Hisobotda «joyida» deb chiqadi.

Narx, pul, holat va egalik (custody) hech qachon o'zgarmaydi.

## Nimaga tegmaydi

Buyurtma o'tkazib yuboriladi va sababi hisobotda chiqadi, agar:

- allaqachon jo'natilgan va **boshqa viloyatga** ketgan, yoki tumanga boshqa filial xizmat qiladi;
- o'chirilgan;
- viloyati allaqachon to'g'ri (qayta yurgizish xavfsiz);
- sayt, saytdagi id yoki viloyat kodi ro'yxatga mos emas.

## Ishga tushirish

Avval shu skriptli reliz o'sha serverga deploy bo'lishi kerak. Actions → **Site import repair** → *Run workflow*:

1. `target=production`, `mode=dry-run` — hisobotni ko'ring: «Tuzatiladi» soni va viloyatlar.
2. `mode=apply`, `confirm=YOZISH` — avval bazaning nusxasi olinadi (`./backups/pre-deploy/pre-repair-*`), keyin yoziladi.

Hisobot oxirida «Ro'yxatda YO'Q, lekin xuddi shunday buzilgan» chiqsa, relizgacha yana buyurtma qabul qilingan. Ularning tuman kodini saytdan olib, `extra` ga yozing: `4100:lidershop:56800:1703211` (buyurtma : sayt : saytdagi id : SOATO), bir nechtasi vergul bilan.
