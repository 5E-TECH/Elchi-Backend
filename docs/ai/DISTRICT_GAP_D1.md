# D1 — yetishmagan tumanlar va shahar/tuman juftlari (ops qarori uchun)

**Holat:** QAROR QILINDI (ega, 2026-11-14) va amalga oshirildi (migratsiya
227, `feat/district-coverage-review`): 25 birlikning HAMMASI seed'ga
qo'shildi (rasmiy nomlari bilan — «Farg'ona shahri», «Zomin tumani»);
mavjud qatorlar qayta nomlanmaydi va kodi o'zgarmaydi (variant (a), faqat
yangi qator).

**Biriktirish — VILOYAT qoidasi** (anKpzwxk, `libs/common/src/logistics/
district-coverage.ts`). `districts.serving_branch_id` 2026-11-03 dan beri
qamrovga ta'sir QILMAYDI (prod'da hamma joyda NULL): buyurtmani tumanning
xizmat viloyati (`assigned_region ?? region_id`) dagi HAR QANDAY faol
REGIONAL/HYBRID filial ko'radi. Shuning uchun servis ishga tushganda
(`onModuleInit`) har yangi qator avvalo VILOYATGA biriktiriladi:

- shahar/tuman jufti bor bo'lsa — juftning `assigned_region`i ko'chiriladi
  (masalan «Yangiyo'l» Toshkent shahriga o'tkazilgan bo'lsa, «Yangiyo'l
  shahri» ham o'sha yerga yo'naltiriladi);
- `serving_branch_id` — faqat ishora: juftniki (juft shu viloyatda qolgan
  bo'lsa) yoki xizmat viloyati shu viloyat bo'lgan qo'shnilarda eng ko'p
  uchragani; odatda `NULL`.

Har qator «tekshirilmagan» (`assignment_review_required`, sabab
`auto_assigned_D1`). «Hududlar» sahifasida superadmin/admin ogohlantirish
ko'radi (`GET /region/district-coverage`): `serving_branch` va
`region_branches` CHAQIRUV paytida viloyat qoidasidan hisoblanadi
(branch-service `branch.dispatch_destinations`; javob bermasa — 503),
`no_branch_found` — faqat xizmat viloyatida faol filial yo'q bo'lsa. Belgini
tasdiq (`POST /region/district/:id/confirm-assignment`), viloyatni
o'zgartirish (`PATCH /district/:id` — «O'zgartirish» tugmasi) yoki eski
`PUT /branches/:id/districts` tushiradi; filial o'chirilishi
(`clear_serving_branch`) tushirmaydi.

### Deploy tartibi

1. **Deploy'dan OLDIN** — prod'da faqat o'qish: `scripts/logistics/
   district-gap-report.sql` (shu PR'da, alohida merge kutilmaydi; buyruq
   pastda, «1-qadam»). Ko'rib chiqiladigan bo'limlar:
   - **1-bo'lim** — har birlik uchun prod'da shu SOATO bilan yoki o'xshash
     nom bilan QO'LDA qo'shilgan qator bormi. `sato_code` NULL yoki boshqa
     yozilishdagi («Zomin sh.», «Xiva shahar») qator bo'lsa, seed yangi
     qator qo'shadi va tuman IKKI marta ko'rinadi — deploy'dan oldin o'sha
     qatorga SOATO kodini yozing (`PATCH /district/sato/:id`) yoki
     qo'shilgandan keyin birlashtiring.
   - **3-bo'lim** — 9 juft qatorining `assigned_region`i: juft boshqa
     viloyatga o'tkazilgan bo'lsa, yangi qator ham o'sha viloyatga
     yo'naltiriladi — kutilganmi, tekshiring.
2. Migratsiya **227** — logistics-service qayta ishga tushishidan OLDIN.
3. logistics-service + api-gateway deploy (seed qatorlarni qo'shadi, WARN
   log har qator uchun).
4. «Hududlar» → `GET /region/district-coverage`: 25 qator, har birida
   `region_branches`; tasdiqlash yoki viloyatni o'zgartirish.

Quyidagi bo'limlar — qarordan oldingi tahlil (tarix uchun).

## Muammo

`apps/logistics-service/src/data/regions-districts.data.ts` (seed) da 181
birlik, rasmiy SOATO (`sato-codes.ts`) da 206. Yo'q **25** birlik (pastda).
AI tuman rezolveri bazadagi qatorlar bilan ishlaydi, shuning uchun:

- «Farg'ona shahri» → `normGeo` «shahri»ni olib tashlaydi → yagona moslik
  «Farg'ona» (1730233, **tuman** kodi) → ogohlantirishsiz avto-tanlov.
- «Zomin» + «Paxtakor mahallasi» → Zomin bazada yo'q → Paxtakor tumani.

⚠️ **Seed avtomatik qo'shadi.** `LogisticsService.onModuleInit` har ishga
tushishda seed'dagi yetishmagan tumanni `serving_branch_id = NULL` bilan
qo'shadi. Shuning uchun seed'ga qator faqat biriktirish qarori bilan birga
kiradi. CI qulfi: `apps/logistics-service/src/data/sato-coverage.D1.spec.ts`
(`PENDING_OPS_DECISION` — qaror qilingan birlik undan olib tashlanadi).

## 1-qadam: prod holati (Dilshod, faqat o'qish)

```sh
docker exec -i elchi-postgres sh -c \
  'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -X -q -P pager=off -f -' \
  < scripts/logistics/district-gap-report.sql > /root/district-gap-$(date +%F).txt
```

Hisobot: har birlik uchun prod'da shu SOATO yoki o'xshash nomli qator bormi
(seed'dan tashqari qo'lda qo'shilgan bo'lishi mumkin), filial biriktirishi,
oxirgi 90 kun buyurtmalari, filial/foydalanuvchi bog'lanishlari. Natijada
shaxsiy ma'lumot yo'q — backend sessiyaga yuborish mumkin.

## 2-qadam: qaror — A) yalang'och shahar nomli 9 juft

Bazada shahar nomi **tuman SOATO**'si bilan turibdi va amalda shaharga ham
xizmat qilayotgan bo'lishi mumkin. Ega qarori (2026-11-14): shahar va tuman —
alohida qatorlar, alohida filial/kuryer bo'lishi mumkin.

| Bazadagi qator | Hozirgi SOATO | Rasmiy shahar | Qaror (a/b/c) |
|---|---|---|---|
| Namangan | 1714212 (tuman) | Namangan shahri 1714401 |  |
| Termiz | 1722220 (tuman) | Termiz shahri 1722401 |  |
| Guliston | 1724220 (tuman) | Guliston shahri 1724401 |  |
| Bekobod | 1727220 (tuman) | Bekobod shahri 1727413 |  |
| Ohangaron | 1727212 (tuman) | Ohangaron shahri 1727415 |  |
| Yangiyo'l | 1727259 (tuman) | Yangiyo'l shahri 1727424 |  |
| Farg'ona | 1730233 (tuman) | Farg'ona shahri 1730401 |  |
| Urganch | 1733217 (tuman) | Urganch shahri 1733401 |  |
| Nukus | 1735225 (tuman) | Nukus shahri 1735401 |  |

Har juft uchun bittasini tanlang:

- **(a) yangi qator** — mavjud qator «X tumani» deb qayta nomlanadi (kod
  o'zgarmaydi), «X shahri» yangi qator, **filial biriktirishi bilan**. Agar
  hozirgi qator buyurtmalari asosan shahardan bo'lsa, ular tarixda qoladi
  (eski buyurtmalar o'zgartirilmaydi).
- **(b) qayta nomlash + kod** — mavjud qator aslida shahar: «X shahri» deb
  nomlanadi va SOATO shahar kodiga o'zgaradi; tuman uchun yangi qator
  (biriktirish bilan) yoki hozircha yo'q. ⚠️ Partner SOATO moslashuvi
  (BeePost) eski kodni kutayotgan bo'lishi mumkin — integratsiya
  sozlamasini tekshirish kerak.
- **(c) hozircha o'zgarmaydi** — faqat alias (rezolver «X shahri» va
  «X tumani» ni shu qatorga bog'laydi) va qaror keyinga.

Bundan tashqari: **Shahrisabz** bazada 1710405 (shahar kodi) bilan bare nom;
«Shahrisabz tumani» 1710245 yo'q — B guruhida.

## 2-qadam: qaror — B) bazada umuman yo'q 16 birlik

| SOATO | Viloyat | Birlik |
|---|---|---|
| 1708212 | Jizzax | Sharof Rashidov tumani |
| 1708218 | Jizzax | Zomin tumani |
| 1710245 | Qashqadaryo | Shahrisabz tumani |
| 1712412 | Navoiy | G'ozg'on shahri |
| 1712244 | Navoiy | Tomdi tumani |
| 1712248 | Navoiy | Uchquduq tumani |
| 1714229 | Namangan | Uychi tumani |
| 1727253 | Toshkent vil. | O'rtachirchiq tumani |
| 1730408 | Farg'ona | Quvasoy shahri |
| 1730206 | Farg'ona | Qo'shtepa tumani |
| 1730230 | Farg'ona | O'zbekiston tumani |
| 1733406 | Xorazm | Xiva shahri |
| 1733221 | Xorazm | Tuproqqal'a tumani |
| 1733223 | Xorazm | Xonqa tumani |
| 1735209 | Qoraqalpog'iston | Bo'zatov tumani |
| 1735228 | Qoraqalpog'iston | Taxiatosh tumani |

Har biri uchun: qaysi filial xizmat qiladi (`serving_branch_id`) yoki
«xizmat yo'q» (qo'shilmaydi, rezolver `unsupported_district` deb ko'rsatadi —
noto'g'ri qo'shni tumanga avto-tanlamaydi). Avval 1-qadam hisobotida
qo'lda qo'shilgan qator borligini tekshiring.

## 3-qadam: backend (qarordan keyin)

1. Migratsiya: tasdiqlangan qatorlar (nom, SOATO, `serving_branch_id`,
   `assigned_region`) — bitta tranzaksiyada, idempotent.
2. Seed'ga shu birliklar qo'shiladi, `PENDING_OPS_DECISION` dan olib
   tashlanadi (CI shuni majburlaydi).
3. Rezolver (D2–D5): SOATO kalitli alias jadvali (uz lotin/kirill, rus, eski
   nomlar, shahar/tuman turi); matnda tur aytilgan, bazada faqat boshqa tur
   bo'lsa — avto-tanlov emas, `kind_mismatch` nomzodlari.
