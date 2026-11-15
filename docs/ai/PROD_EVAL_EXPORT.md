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

Matnda nima maskalanadi (shu tartibda):

- telefonlar — allaqachon `[TEL_n]`;
- email → `[EMAIL]`; `t.me`, `telegram.me`, `instagram.com`, `instagr.am`,
  `facebook.com`, `vk.com`, `tiktok.com` havolalari → `[LINK]`;
  `@foydalanuvchi` → `@[USER]`;
- mijoz va operator ismlari (AI va operator yozgan, `#sevinch` → `#[ISM]`)
  → `[ISM]`, qo'shimcha saqlanadi: butun so'z, katta-kichik harfsiz;
  o'zbek (lotin/kirill) va rus qo'shimchalari, 3 tagacha ketma-ket
  ("Dilnozaxonga" → `[ISM]xonga`, "Дилнозанинг", "Ферузажон");
  -а/-я/-й/-ь bilan tugagan kirill ism rus kelishigida ("Малике",
  "Маликой", "Дмитрию"); apostrof ikki tomonga ixtiyoriy ("G'ulomjon" =
  "Gulomjon", "O'g'iloy" = "Ogiloy"; `'` `ʻ` `ʼ` `‘` `’` `´` va
  teskari tirnoq); ko'p so'zli ismning har
  3+ harfli so'zi alohida ham ("Abdullayev Jasur" → "Jasurga"; opa/aka/
  xon/jon/mijoz bundan mustasno). Ismga o'xshab boshlanadigan boshqa so'z
  ("Dilnozabonu") tegilmaydi;
- pasport seriyasi (2 harf + 7 raqam) → `[HUJJAT]`;
- 9+ raqam (bo'shliq, tire `-–—`, nuqta, slash, `_`, qavs bilan ham) →
  `[RAQAM]`. ⚠️ 100 mln so'mdan katta narx ham `[RAQAM]` bo'ladi;
- uy/xonadon raqami → `[N]`: "12-uy", "12a-uy", "12/3-uyda",
  "5-xonadonga", "12-уйда", "uy 12/3", "kvartiraga 5", "kv №5",
  "дом №12", "д. 15", "d.15" ("uyga 2 ta" — miqdor, tegilmaydi;
  "19-kvartal" — mavze, tegilmaydi).

Tuzatishlardan izoh, operator va telefon maskasi tashlanadi.

⚠️ **Ism ro'yxati yo'q draftlar** (outcome≠ok: ai_error, truncated, …):
AI natijasi yo'q — bunday faylda `input.text = null`, `names_masked:
false` (skript oxirida sanog'i chiqadi). Matnni ochiq olish faqat
`--include-unmasked-names` bilan — keyin ismlarni QO'LDA maskalang.

⚠️ **Ismsiz buyurtma** (`raw_extraction` dagi biror buyurtmada
`customer_name` bo'sh): boshqa ismlar maskalangan, o'sha mijozniki yo'q —
`names_masked: 'partial'` (sanog'i skript oxirida chiqadi). Bunday
faylni qo'lda tekshiring.

⚠️ Maskalanmay QOLADIGAN shaxsiy ma'lumot (belgilovchi ko'rib chiqadi):

- AI/operator yozmagan ism yoki boshqa yozuvdagi ism (AI kirill ismni
  lotinga o'girgan bo'lsa: "Дилноза" → "Dilnoza" — kirill yozuv qoladi);
- to'liq kenglikdagi raqamlar (`９０１２３…`), 7 raqamli shahar telefoni,
  vergul bilan ajratilgan raqamlar, koordinatalar, tug'ilgan sana;
- manzil (ko'cha, mahalla) — tuman xatolarini tahlil qilish uchun kerak
  (fayllar faqat serverda). Buni ega alohida tasdiqlashi kerak.

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
| `candidates/*.json`, `unedited/*.json` | ism, telefon, email, havola, @foydalanuvchi, pasport, uy raqami maskalangan; qoladi: manzil, ro'yxatda yo'q ism (`names_masked: 'partial'`), 7 raqamli/to'liq kenglikdagi/vergulli raqamlar, koordinata, tug'ilgan sana; `--include-unmasked-names` bilan — ochiq ismlar | **faqat serverda**; sintetik fixture'ga aylantiriladi |
