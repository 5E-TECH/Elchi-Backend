# AI buyurtma aniqligi — prod eksport yo'riqnomasi (Dilshod uchun)

Maqsad: AI buyurtma ekstraksiyasining prod'dagi xatolarini o'lchash va eval
to'plami uchun maskalangan nomzodlar yig'ish. Hammasi **faqat o'qish**:
REPEATABLE READ READ ONLY tranzaksiya, `default_transaction_read_only=on`,
`statement_timeout` va `lock_timeout` bilan. Natija **serverda qoladi** —
repo, chat yoki tikketga ko'chirilmaydi. Repo'ga faqat agregat jadval
(sanoqlar) yoki qo'lda sintetik ko'rinishga keltirilgan fixture tushadi.

> ⏰ Muddat: draft matni (`source_text`) 30 kunda tozalanadi. Nomzodlarni
> yig'ish (2- va 3-qadam) matn bor paytda foydali.
>
> ⚠️ Tuzatishlarning shaxsiy bo'lmagan qismi (tuman/viloyat/summa/mahsulot)
> 365 kun saqlanishi **#640 merge + deploy qilingandan keyingina** to'g'ri.
> Undan oldin eski kod 30 kunda butun tuzatishni o'chiradi — #640 birinchi.

**Qachon:** ish vaqtidan tashqari (Toshkent 22:00 dan keyin), deploy yoki
migratsiya paytida EMAS. So'rovlar 60 s (SQL) / 120 s (skript) dan oshsa
o'zi to'xtaydi va qulf kutmaydi (2 s).

Parol, kalit yoki `.env.production` qiymati hech qayerga yozilmaydi —
quyidagi buyruqlar ulanishni konteyner ichidagi env'dan oladi.

## 0. Tayyorgarlik (serverda, repo katalogida)

```sh
cd <prod repo katalogi>          # docker-compose.prod.yml turgan joy
git pull                         # shu yo'riqnoma va skriptlar kirgan commit
git log -1 --oneline
install -d -m 700 /root/ai-eval
chown 1000:1000 /root/ai-eval    # ops konteyneri USER node (uid 1000) bilan yozadi
```

⚠️ `migration-runner` image'i faqat `migrations/`, `libs/`, `package*.json`
o'zgarganda qayta quriladi — ichidagi `scripts/` ESKI bo'lishi mumkin.
Shuning uchun 2–3-qadamlarda checkout'dagi `scripts/` katalogi image ustiga
**faqat o'qish** uchun ulanadi (`-v "$PWD/scripts:/app/scripts:ro"`).
Tekshiruv (`1` chiqishi kerak):

```sh
grep -c 'export const UNEDITED_SAMPLE_SQL' scripts/ai-eval-collect.ts
```

## 1. Agregatlar (shaxsiy ma'lumotsiz)

`scripts/ai/eval-aggregates.sql` — oxirgi `days` kun:

1. maydon bo'yicha tuzatilgan va AI bo'sh qoldirgan ulush, `model × prompt_version` kesimida (preview bilan solishtirib bo'lmagan qatorlar chiqarilgan). Shaxsiy maydonlar (`customer_name`, `phone_number`, `extra_number`, `address`, `comment`, `operator`) tuzatishi 30 kunda tozalanadi — ular uchun `ai_null` faqat oxirgi 30 kundan sanaladi, maxraj `ai_null_base` ustunida (days > 30 da `confirmed` dan kichik bo'ladi);
2. tuman chalkashlik juftlari (AI → operator) va `same_region` / boshqa viloyat / AI bo'sh jami (AI tuman bermagan qator ikkala jadvalda ham `ai_null`);
3. narx tuzatishlari sinflari: `ai_null`, `×1000`, `×10/×100`, butun karrali (miqdor/dona narxi?), `|farq| ≤ 60k` (dostavka?), boshqa — shu tartibda tekshiriladi;
4. tashlab ketilgan draftlar (preview bor, birorta tasdiq yo'q, 1 kundan eski — shuning uchun `days` kamida 2 bo'lsin);
5. tasdiqdan keyingi drift: `orders.district_id` / `total_price` hozir operator tasdiqlagan qiymatdan farq qiladimi (o'chirilgan/yo'q buyurtmalar alohida sanaladi; qisman sotilgan — `partly_sell_original_total_price` yoki o'chirilmagan bola buyurtmasi bor — narx drifti hisoblanmaydi);
6. kunlik model × outcome aralashmasi; funksiya bo'yicha outcome, `stop_reason`, keshdan o'qish ulushi va xarajat.

```sh
docker exec -i \
  -e PGOPTIONS='-c default_transaction_read_only=on -c statement_timeout=60s -c lock_timeout=2s -c application_name=ai-eval' \
  elchi-postgres sh -c \
  'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v days=30 -X -q -P pager=off -f -' \
  < scripts/ai/eval-aggregates.sql > /root/ai-eval/aggregates-$(date +%F).txt
```

Natija faylida faqat sanoqlar, model/prompt nomlari va tuman nomlari bor —
uni FE/backend sessiyaga yuborish mumkin (qolgan fayllar emas).

## 2. Xato va tuzatilgan draftlar — eval nomzodlari (maskalangan)

```sh
docker compose -f docker-compose.prod.yml run --rm --no-deps \
  -e PGOPTIONS='-c default_transaction_read_only=on' \
  -v "$PWD/scripts:/app/scripts:ro" \
  -v /root/ai-eval:/out migration-runner \
  node -r ts-node/register -r tsconfig-paths/register \
  scripts/ai-eval-collect.ts --out=/out/candidates --days=30 --limit=2000
```

Har draft — bitta JSON (katalog 0700, fayllar 0600, nomi `prod-<to'liq
draft_id>.json`). `--out` katalogi **bo'sh** bo'lishi kerak (aks holda
2-kod; mavjud fayl hech qachon qayta yozilmaydi). `--days` (1–90) va
`--limit` (1–2000) butun son bo'lmasa ham 2-kod — jim sukut yo'q.

Matnda nima maskalanadi (shu tartibda) — faqat shu ro'yxat, boshqasi yo'q:

- telefonlar — allaqachon `[TEL_n]`;
- email → `[EMAIL]`;
- havolalar → `[LINK]` (`https://` bilan ham, `www.` va boshqa
  subdomen bilan ham): ijtimoiy tarmoq — `t.me`, `telegram.me`,
  `instagram.com`, `instagr.am`, `facebook.com`, `fb.com`, `vk.com`,
  `tiktok.com`; messenjer — `wa.me`, `whatsapp.com`; xarita —
  `maps.app.goo.gl` va boshqa `goo.gl`, `google.<tld>/maps`,
  `maps.google.<tld>`, `yandex.<tld>/maps`, `2gis.<tld>` (`go.2gis.com`
  ham). Havola ichidagi koordinata ham ketadi
  (`google.com/maps?q=41.31,69.24`, `…/@41.31,69.23,17z/…` — yo'lda
  vergul faqat raqamlaridan keyin bo'shliqsiz belgi kelsa havolaga
  kiradi, shuning uchun "[LINK], [LINK]" tinish belgisi saqlanadi).
  Havoladan keyin vergul/tire bilan kelgan telefon havolaga yutilmaydi:
  "instagram.com/shop,90 742 90 47" → "[LINK],[RAQAM]",
  ".../AbC1-90 931 38 51" → "[LINK]-[RAQAM]";
- `@foydalanuvchi` (`@` + 3–32 lotin harf/raqam/`_`/`.`) → `@[USER]`;
- mijoz va operator ismlari (AI va operator yozgan, `#sevinch` → `#[ISM]`)
  → `[ISM]`, qo'shimcha saqlanadi: butun so'z, katta-kichik harfsiz;
  o'zbek (lotin/kirill) va rus qo'shimchalari, 3 tagacha ketma-ket
  ("Dilnozaxonga" → `[ISM]xonga`, "Dilnozachaga" → `[ISM]chaga`,
  "Дилнозанинг", "Ферузажон");
  -а/-я/-й/-ь bilan tugagan kirill ism rus kelishigida ("Малике",
  "Маликой", "Дмитрию"); apostrof ikki tomonga ixtiyoriy ("G'ulomjon" =
  "Gulomjon", "O'g'iloy" = "Ogiloy"; `'` `ʻ` `ʼ` `‘` `’` `´` va
  teskari tirnoq); ko'p so'zli ismning har
  3+ harfli so'zi alohida ham ("Abdullayev Jasur" → "Jasurga"; opa/aka/
  xon/jon/mijoz bundan mustasno); ismga yopishgan murojaat
  (xonim/honim/xon/hon/jon/opa/aka, хоним/хон/жон/опа/ака; oldidagi
  tire bilan — "Dilnoza-xon") olib tashlangan o'zak ham, agar 3+ harf
  qolsa (AI "Dilnozaxon"/"Dilnozahon"/"Dilnoza-xon" desa, matndagi
  "Dilnoza", "Dilnozaning" ham → `[ISM]`; "Dilnozahonga" → `[ISM]honga`). Ismga o'xshab boshlanadigan boshqa so'z
  ("Dilnozabonu") tegilmaydi;
- pasport seriyasi (2 harf + 7 raqam; "AA1234567", "AA 1234567",
  "AA-1234567", "AA №1234567", "AA № 1234567") → `[HUJJAT]`. Oldida
  umumiy 2 harfli so'z (ta, va, uy, kv, da, ga, ni, bu, to, та, ва)
  bo'lsa seriya hisoblanmaydi ("1 ta - 1500000", "uy-1234567");
- 9+ raqam (bo'shliq, tire `-–—`, nuqta, slash, `_`, qavs bilan ham) →
  `[RAQAM]` (JShShIR, karta raqami ham). ⚠️ 100 mln so'mdan katta narx
  ham `[RAQAM]` bo'ladi;
- uy/xonadon raqami → `[N]` — FAQAT kalit so'z (uy, xonadon, kvartira,
  kv, kv-ra, dom, д./d., уй, хонадон, квартира/квартире/квартиру/
  квартиры, кв, кв-ра, дом/доме/дома/дому) yonida:
  - raqam kalit so'zdan oldin: "12-uy", "12a-uy", "12-a uy", "12 A uy",
    "12/3-uyda", "5-xonadonga", "12-uyi", "5-xonadoni", "12-uyida",
    "45-xonadonida", "12-уйда", "12-уйи", "5-хонадони", "#7 uy";
  - raqam kalit so'zdan keyin: "uy 12/3", "uyi 12", "xonadoni 45",
    "kvartirasi 7", "kvartiraga 5", "kvartirasiga 5", "kv-ra 5",
    "kv №5", "дом №12", "д. 15", "d.15", "uy N 4", "в доме 5",
    "квартире 7", "в квартиру 9";
  - tegilmaydi: "uyga 2 ta", "квартиры 2 шт" (miqdor); "uyiga 25 000",
    "uyigacha 20 000 so'm", "Narxi 1 586 000 uyiga" (narx — raqamdan
    keyin bo'shliq/nuqta + 3 raqam kelsa yoki kalit so'z oldidagi "000"
    narxning oxirgi guruhi bo'lsa); "19-kvartal", "4-мавзе" (mavze).

Tuzatishlardan izoh, operator va telefon maskasi tashlanadi.

⚠️ **Ism ro'yxati yo'q draftlar** (outcome≠ok: ai_error, truncated, …):
AI natijasi yo'q — bunday faylda `input.text = null`, `names_masked:
false` (skript oxirida sanog'i chiqadi). Matnni ochiq olish faqat
`--include-unmasked-names` bilan — keyin ismlarni QO'LDA maskalang.

⚠️ **Ismsiz buyurtma** (`raw_extraction` dagi biror buyurtmada
`customer_name` bo'sh): boshqa ismlar maskalangan, o'sha mijozniki yo'q —
`names_masked: 'partial'` (sanog'i skript oxirida chiqadi). Bunday
faylni qo'lda tekshiring. `'partial'` FAQAT ismsiz buyurtmani bildiradi;
`names_masked: true` matnda ism qolmaganini KAFOLATLAMAYDI (pastdagi
ro'yxatga qarang).

⚠️ Maskalanmay QOLADIGAN shaxsiy ma'lumot (har faylni belgilovchi ko'rib
chiqadi, `names_masked` qiymatidan qat'i nazar):

- ro'yxatda yo'q ism: AI/operator `customer_name`/`operator` maydoniga
  yozmagan ism (qarindosh, qabul qiluvchi, ota ismi — "Ali Valiyevich"
  dagi "Valiyevich"); operator FAQAT erkin matnda (izohda) yozgan ism;
  boshqa yozuvdagi ism (AI kirill ismni lotinga o'girgan bo'lsa:
  "Дилноза" → "Dilnoza" — kirill yozuv qoladi); 1 harfli ism;
- `@` siz foydalanuvchi nomi ("Instagram: dilnoza92", "telegram
  dilnoza_shop"); so'zga yopishgan `@` ("insta@dilnoza_92"); kirill
  `@handle` ("@дилноза_шоп"); 32 belgidan uzun handle'ning dumi
  (birinchi 32 belgi `@[USER]`, qolgani ochiq);
- domensiz yoki bo'shliqli email ("dilnoza92@mail", "dilnoza92 @
  mail.ru", "dilnoza92(at)mail.ru");
- ro'yxatda yo'q domen havolasi (`ok.ru`, `youtube.com`, `bit.ly` va
  boshqa qisqartiruvchilar, do'kon sayti); havoladan tashqaridagi
  koordinata ("41.311081, 69.240562");
- kalit so'z yonida bo'lmagan uy raqami ("Chilonzor 9-kvartal 12",
  "uy raqami 12"), podezd/qavat, 1-/2-shaxs egaligi ("uyimiz 12",
  "xonadonim 7"), harfi tirnoqda (`12-"a" uy`), uy raqamidan keyin
  darhol 3 raqamli guruh kelsa ("kvartira 7 200 ming" — 7 ochiq, narx
  deb hisoblanadi), boshqa tildagi kalit so'z;
- boshqa formatdagi hujjat raqami (2 harf + 7 raqamdan farqli);
- to'liq kenglikdagi raqamlar (`９０１２３…`), 7 raqamli shahar telefoni,
  8 va undan kam raqamli ketma-ketlik, vergul bilan ajratilgan raqamlar,
  tug'ilgan sana;
- manzil (ko'cha, mahalla, mo'ljal) — tuman xatolarini tahlil qilish
  uchun kerak (fayllar faqat serverda). Buni ega alohida tasdiqlashi
  kerak.

Ortiqcha maskalash ham bo'ladi (maxfiylik uchun xavfsiz, lekin matn
o'zgaradi): murojaatsiz o'zak umumiy so'z bo'lsa ("Gulxon" → "gul"
so'zi ham `[ISM]`), ismga teng umumiy so'z, 100 mln dan katta narx.

📝 **Belgilovchi uchun:** mahsulot/tovar o'rnidagi `[ISM]` mahsulot
so'zi bo'lishi mumkin — ism o'zagi mahsulot nomiga teng: "Asaljon" →
"asal", "Olmaxon" → "olma", "Shakarxon" → "shakar", "Kumushxon" →
"kumush". Kutilgan natijani (`items[].name`) to'ldirishda buni hisobga
oling.

Repo'ga kiradigan fixture qo'lda sintetik qilinadi
(`apps/ai-service/test/fixtures/order-extract/`, `source: 'prod-masked'`).
Noma'lum yoki xato yozilgan bayroqda skript 2-kod bilan to'xtaydi.

## 3. Tahrirlanmagan tasdiqlardan 5% namuna

Operator hech narsani o'zgartirmagan tasdiqlar — "jim xato" ulushini
o'lchash uchun. "Tahrirlanmagan" = draftning HAR bog'langan buyurtmasi
preview bilan solishtirilgan va o'zgarish yo'q. Namuna `--seed` bilan
deterministik — bir xil seed bir xil to'plamni beradi (seed'ni yozib qo'ying):

```sh
docker compose -f docker-compose.prod.yml run --rm --no-deps \
  -e PGOPTIONS='-c default_transaction_read_only=on' \
  -v "$PWD/scripts:/app/scripts:ro" \
  -v /root/ai-eval:/out migration-runner \
  node -r ts-node/register -r tsconfig-paths/register \
  scripts/ai-eval-collect.ts --out=/out/unedited --days=30 --limit=2000 \
  --sample-unedited=0.05 --seed=2026-11
```

Har faylda `evidence.confirmed_preview` — operator o'zgartirmay tasdiqlagan
AI takliflari (faqat tasdiqlangan buyurtmalar; telefon xeshi/maskasi, izoh,
operator YO'Q). Belgilovchi uni matn bilan solishtiradi.

## 4. Tozalash

Tahlil tugagach (yoki eng kechi 30 kundan keyin):

```sh
rm -rf /root/ai-eval/candidates /root/ai-eval/unedited
```

`aggregates-*.txt` qolishi mumkin (shaxsiy ma'lumot yo'q).

## Kimga nima yuboriladi

| Fayl | Shaxsiy ma'lumot | Qayerga |
|---|---|---|
| `aggregates-*.txt` | yo'q | backend/FE sessiyaga, PR/Trello'ga |
| `candidates/*.json`, `unedited/*.json` | maskalangan (2-bo'limdagi ro'yxat bo'yicha): ro'yxatdagi ism (AI/operator yozgan, qo'shimchalari va murojaatsiz o'zagi bilan), telefon, email, ro'yxatdagi ijtimoiy tarmoq/xarita/WhatsApp havolasi, `@foydalanuvchi`, pasport (2 harf + 7 raqam), 9+ raqam, kalit so'z yonidagi uy/xonadon raqami. Qoladi: ro'yxatda yo'q ism — `names_masked: true` bo'lsa ham bo'lishi mumkin; `'partial'` faqat ismsiz buyurtmani bildiradi; `@` siz, so'zga yopishgan `@` li yoki kirill foydalanuvchi nomi; domensiz/bo'shliqli email; operator faqat erkin matnda yozgan ism; boshqa domen havolasi; havoladan tashqari koordinata; kalit so'zsiz uy raqami; manzil; mahsulot o'rnidagi `[ISM]` mahsulot so'zi bo'lishi mumkin (Asaljon → asal); 7 raqamli/to'liq kenglikdagi/vergulli raqamlar; tug'ilgan sana; `--include-unmasked-names` bilan — ochiq ismlar | **faqat serverda**; sintetik fixture'ga aylantiriladi |
