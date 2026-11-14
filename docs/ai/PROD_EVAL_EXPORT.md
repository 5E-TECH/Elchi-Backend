# AI buyurtma aniqligi — prod eksport yo'riqnomasi (Dilshod uchun)

Maqsad: AI buyurtma ekstraksiyasining prod'dagi xatolarini o'lchash va eval
to'plami uchun maskalangan nomzodlar yig'ish. Hammasi **faqat o'qish**
(READ ONLY tranzaksiya), natija **serverda qoladi** — repo, chat yoki
tikketga ko'chirilmaydi. Repo'ga faqat agregat jadval (sanoqlar) yoki
qo'lda sintetik ko'rinishga keltirilgan fixture tushadi.

> ⏰ Muddat: draft matni (`source_text`) 30 kunda tozalanadi. Nomzodlarni
> yig'ish (2- va 3-qadam) matn bor paytda foydali — iloji boricha tezroq.
> Tuzatishlarning shaxsiy bo'lmagan qismi (tuman/viloyat/summa/mahsulot)
> 365 kun saqlanadi, shuning uchun 1-qadam (agregatlar) keyin ham ishlaydi.

Parol, kalit yoki `.env.production` qiymati hech qayerga yozilmaydi —
quyidagi buyruqlar ulanishni konteyner ichidagi env'dan oladi.

## 0. Tayyorgarlik (serverda, repo katalogida)

```sh
cd <prod repo katalogi>         # docker-compose.prod.yml turgan joy
git log -1 --oneline            # shu yo'riqnoma kirgan commit deploy qilinganini tekshiring
install -d -m 700 /root/ai-eval
chown 1000:1000 /root/ai-eval   # ops konteyneri USER node (uid 1000) bilan yozadi
```

## 1. Agregatlar (shaxsiy ma'lumotsiz)

`scripts/ai/eval-aggregates.sql` — oxirgi `days` kun:

1. maydon bo'yicha tuzatilgan va AI bo'sh qoldirgan ulush, `model × prompt_version` kesimida;
2. tuman chalkashlik juftlari (AI → operator) va `same_region` / boshqa viloyat / AI bo'sh jami;
3. narx tuzatishlari sinflari: `ai_null`, `×1000`, `×10/×100`, `|farq| ≤ 60k` (dostavka?), butun karrali (miqdor/dona narxi?), boshqa;
4. tashlab ketilgan draftlar (preview bor, birorta tasdiq yo'q);
5. tasdiqdan keyingi drift: `orders.district_id` / `total_price` hozir operator tasdiqlagan qiymatdan farq qiladimi;
6. kunlik model × outcome aralashmasi; funksiya bo'yicha outcome, `stop_reason`, keshdan o'qish ulushi va xarajat.

```sh
docker exec -i elchi-postgres sh -c \
  'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v days=30 -X -q -P pager=off -f -' \
  < scripts/ai/eval-aggregates.sql > /root/ai-eval/aggregates-$(date +%F).txt
```

Natija faylida faqat sanoqlar, model/prompt nomlari va tuman nomlari bor —
uni FE/backend sessiyaga yuborish mumkin (qolgan fayllar emas).

## 2. Xato va tuzatilgan draftlar — eval nomzodlari (maskalangan)

```sh
docker compose -f docker-compose.prod.yml run --rm --no-deps \
  -v /root/ai-eval:/out migration-runner \
  node -r ts-node/register -r tsconfig-paths/register \
  scripts/ai-eval-collect.ts --out=/out/candidates --days=30 --limit=2000
```

Har draft — bitta JSON: matnda telefonlar `[TEL_n]`, ismlar `[ISM]`, 9+
raqam `[RAQAM]`, uy/xonadon raqami `[N]`. ⚠️ Manzil (ko'cha, mahalla)
maskalanMAYDI — tuman xatolarini tahlil qilish uchun kerak. Shuning uchun
fayllar faqat serverda ko'rib chiqiladi; repo'ga kiradigan fixture qo'lda
sintetik qilinadi (`apps/ai-service/test/fixtures/order-extract/`,
`source: 'prod-masked'`).

## 3. Tahrirlanmagan tasdiqlardan 5% namuna

Operator hech narsani o'zgartirmagan tasdiqlar — "jim xato" ulushini
o'lchash uchun (AI xato qildi, operator ko'rmadi):

```sh
docker compose -f docker-compose.prod.yml run --rm --no-deps \
  -v /root/ai-eval:/out migration-runner \
  node -r ts-node/register -r tsconfig-paths/register \
  scripts/ai-eval-collect.ts --out=/out/unedited --days=30 --limit=2000 \
  --sample-unedited=0.05
```

Har faylda `evidence.confirmed_preview` — operator o'zgartirmay tasdiqlagan
AI taklifi (maskalangan). Belgilovchi uni matn bilan solishtiradi.

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
| `candidates/*.json`, `unedited/*.json` | manzil qoldig'i | **faqat serverda**; sintetik fixture'ga aylantiriladi |
