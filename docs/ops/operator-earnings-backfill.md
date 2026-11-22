# O'tgan sotuvlarga operator komissiyasi (bir martalik backfill)

**Ega qarori (2026-11-21):** o'tgan sotuvlarga ham operator haqi **joriy stavka** bo'yicha hisoblansin.

Komissiya sotuv paytida yoziladi (`finance.operator.earning.record`). Operatorga stavka keyin belgilangan bo'lsa, undan oldingi sotuvlarga komissiya yozilmay qolgan.

Market panelida «Operatorlar» sahifasida shu ishni qiladigan tugma bor: qator menyusi «Amallar» → «O'tgan sotuvlarga hisoblash». Lekin bu tugma:

- faqat **market akkauntida** chiqadi;
- har operator uchun **alohida** bosiladi.

Bu skript **barcha marketlarning barcha operatorlari** uchun shu ishni bir yo'la qiladi.

## Nima qiladi

Quyidagi shartlarning **hammasi** bajarilgan buyurtmalarga `finance_schema.operator_earnings` qatori qo'shiladi:

- holati `sold`, `paid` yoki `partly_paid`, o'chirilmagan;
- `operator_id` — roli `market_operator` bo'lgan foydalanuvchi (o'chirilgan operator ham; hisobotda «(o'chirilgan)» deb ko'rsatiladi);
- operatorda **hozir** stavka bor (`commission_type` va `commission_value > 0`);
- shu buyurtma uchun komissiya qatori **umuman yo'q** (rollback qilingani ham yo'q).

Summa jonli yo'ldagi qoida bo'yicha hisoblanadi, lekin aniq `numeric` hisobida:

- foiz bo'lsa: `round(narx × foiz / 100, 2)`;
- belgilangan summa bo'lsa: shu summa;
- natija 0 bo'lsa (masalan narx 0), qator yozilmaydi.

Stavka surati qatorning o'zida saqlanadi: `commission_type`, `commission_value`, `order_total_price`.

Har (market, operator) uchun `finance_schema.activity_logs` ga audit yoziladi:

- `entity_type = 'OperatorEarning'`;
- `metadata.reason = 'backfill'`, `metadata.source = 'ops-script'`;
- `metadata.run_id` va `metadata.order_ids`, `metadata.earning_ids` ro'yxatlari.

## Nima qilmaydi (xavfsizlik)

- **Mavjud qatorga tegmaydi.** Hech narsa yangilanmaydi va o'chirilmaydi. Faqat `INSERT … ON CONFLICT DO NOTHING` ishlatiladi.
- **Kassa, daftar, buyurtma va to'lovlarga ta'siri yo'q.** Faqat operatorning «Ishlab topdi» summasi oshadi.
- **Qayta yurgizish xavfsiz.** Yozilgan buyurtmalar endi nomzod emas. Shu paytda sotuv yoki market tugmasi ham yozsa, unique indeks (`UQ_OPERATOR_EARNING_ORDER`) ikkinchi qatorni yozdirmaydi.
- **Jonli ishni to'xtatmaydi.**
  - Har paket (sukut bo'yicha 1000 ta buyurtma) o'z tranzaksiyasida ishlaydi.
  - `lock_timeout` 5 soniya: qulf olinmasa paket qaytariladi, qayta yurgizish qolganidan davom etadi.
  - Bir vaqtda faqat bitta nusxa ishlaydi (`pg_try_advisory_lock`).
- **Migratsiya yo'q.** Sxema o'zgarmaydi.
- **Matnli operator bog'lanmaydi.** Operator faqat matn bo'lib yozilgan (`operator_id` yo'q) buyurtmalar avtomatik bog'lanmaydi. Hisobotda ular soni ko'rsatiladi; market ularni «Operatorlar» sahifasidagi «Biriktirish» orqali o'zi bog'laydi, shunda komissiya darhol yoziladi.
- **Tekshirish uchun qoldiriladi.** Faqat rollback qilingan (o'chirilgan) qatori bor sotilgan buyurtmalarga tegilmaydi. Ular hisobotda alohida sanaladi va qo'lda ko'riladi.

## Ishga tushirish

Skript serverdagi deploy qilingan ops image'dan ishlaydi. Shuning uchun avval shu skriptni o'z ichiga olgan reliz o'sha serverga deploy bo'lishi kerak:

- staging uchun — `test` branch;
- prod uchun — `main` branch.

### GitHub Actions orqali (tavsiya)

Actions → **Operator earnings backfill** → *Run workflow*.

1. **Hisobot.** `target = staging`, `mode = dry-run` bilan ishga tushiring. Natija run sahifasining *Summary* qismida chiqadi:
   - jami nechta buyurtma va qancha summa yoziladi;
   - har market va operator bo'yicha qatorlar;
   - nima uchun yozilmaydiganlar soni.
2. **Yozish.** Hisobot to'g'ri bo'lsa, `mode = apply` va `confirm = YOZISH` bilan qayta ishga tushiring.
   - Yozishdan oldin bazaning to'liq nusxasi olinadi: `./backups/pre-backfill`, oxirgi 3 tasi saqlanadi.
   - Nusxa olinmasa, hech narsa yozilmaydi.
3. **Tekshirish.** Market panelida «Operatorlar» sahifasini oching: «Ishlab topdi» summasi oshgan bo'lishi kerak. Yana bir marta `dry-run` qilinsa, «yoziladi: 0 ta» chiqishi kerak.
4. **Prod.** Prod uchun ham xuddi shu tartib: `target = production`. Avval `dry-run`, keyin `apply`.

### Server'da qo'lda

```bash
# prod (staging: -f docker-compose.prod.yml -f docker-compose.staging.yml)
docker compose -f docker-compose.prod.yml run --rm --no-deps -T migration-runner \
  npm run -s db:backfill-operator-earnings                 # DRY-RUN
docker compose -f docker-compose.prod.yml run --rm --no-deps -T migration-runner \
  npm run -s db:backfill-operator-earnings -- --apply      # yozish
```

Bayroqlar:

- `--apply` — yozish;
- `--dry-run` — `--apply` dan ustun turadi;
- `--batch=<n>` — bitta paketdagi buyurtmalar soni (≤5000);
- `--report-limit=<n>` — hisobotdagi qatorlar soni.

Chiqish kodlari:

- 0 — muvaffaqiyat;
- 1 — xato (yozilgan paketlar qoladi, qayta yurgizish davom ettiradi);
- 2 — sozlama xatosi.

## Qaytarish (kerak bo'lsa)

Faqat aniq bir yurgizishda yozilgan qatorlarni o'chirish mumkin. `run_id` hisobotning boshida chiqadi.

Avval ko'rib chiqing:

```sql
SELECT e.id, e.order_id, e.operator_id, e.amount, e."createdAt", e."updatedAt"
FROM finance_schema.operator_earnings e
JOIN (
  SELECT jsonb_array_elements_text(metadata->'earning_ids')::bigint AS id
  FROM finance_schema.activity_logs
  WHERE entity_type = 'OperatorEarning'
    AND metadata->>'source' = 'ops-script'
    AND metadata->>'run_id' = '<run_id>'
) x ON x.id = e.id;
```

`"updatedAt" > "createdAt"` bo'lgan qatorlarni o'chirmang. Bu buyurtma keyin qayta sotilgan va qatorni jonli yo'l yangilagan bo'ladi.

Qolganlari uchun:

```sql
BEGIN;
DELETE FROM finance_schema.operator_earnings e
USING (
  SELECT jsonb_array_elements_text(metadata->'earning_ids')::bigint AS id
  FROM finance_schema.activity_logs
  WHERE entity_type = 'OperatorEarning'
    AND metadata->>'source' = 'ops-script'
    AND metadata->>'run_id' = '<run_id>'
) x
WHERE e.id = x.id AND e."updatedAt" = e."createdAt";
-- soni to'g'ri bo'lsa COMMIT; aks holda ROLLBACK;
```

## Kod

- Skript: `scripts/backfill-operator-earnings.ts` (`npm run db:backfill-operator-earnings`).
- Mantiq: `apps/finance-service/src/operator-earning-backfill/` — `*.ts` (hisobot), `*.runner.ts` (SQL).
- Testlar: `*.spec.ts` va `*.pg.spec.ts` (haqiqiy Postgres, CI'da).
- Workflow: `.github/workflows/operator-earnings-backfill.yml`.
