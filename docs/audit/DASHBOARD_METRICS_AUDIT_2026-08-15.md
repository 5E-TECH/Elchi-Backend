# Dashboard metrikalari auditi — yakuniy hisobot

**Repo:** `/home/shodiyor/Desktop/Elchi-Backend` (+ `../Elchi-Frontend`) · **Sana:** 2026-08-15
**Qamrov:** overview, courier, market, branch, kpi/revenue, region-logistics dashboardlari
**Natija:** 9 ta HIGH, 20 ta MEDIUM, 12 ta LOW tasdiqlangan defekt (root-cause bo'yicha deduplikatsiya qilingan); 3 ta da'vo rad etilgan; 30+ metrika tekshirilib to'g'ri deb topildi.

**Metod:** 6 ta mustaqil auditor agent (har biri bitta dashboard yuzasi) → har bir topilma bo'yicha
adversarial (rad etishga urinuvchi) verifikator → sintez. Eng og'ir topilmalar (R-01, R-02, R-03,
R-06, R-07, R-09, R-27) qo'lda, kodni ochib qayta tasdiqlandi — quyidagi "Qo'lda tasdiqlangan
dalillar" bo'limiga qarang.

---

## 0. Qo'lda tasdiqlangan dalillar

**Empirik reproduksiya (lokal Postgres, rollback qilingan tranzaksiya).** `getOverviewStats` ning
aynan ikkita SQL so'rovi realistik ma'lumot ustida ishga tushirildi:

| Ssenariy (2026-07 oynasi) | accepted | sold |
|---|---|---|
| Iyulda qabul + iyulda sotilgan 6 ta | 6 | 6 |
| Iyulda qabul, hali sotilmagan 2 ta | 2 | 0 |
| **Iyunda** qabul, **iyulda** sotilgan 7 ta | 0 | 7 |
| 1 parent → 3 child, hammasi iyulda qabul + sotilgan | 1 | 3 |
| Filial batch'idan o'tmagan 2 ta sotuv | 0 | 2 |
| **JAMI** | **9** | **18** |

```
successRate = 100 * 18 / 9 = 200.0 %
inProgress  = 9 - 18 - 0   = -9      (frontend Math.max(0,…) bilan 0 ga yashiradi)
```

Skript: [`docs/audit/dashboard_success_rate_repro.sql`](./dashboard_success_rate_repro.sql)
(BEGIN … ROLLBACK — DB'ga hech narsa yozilmadi; qayta ishga tushirish:
`psql -h localhost -U postgres -d elchipochta_db -f docs/audit/dashboard_success_rate_repro.sql`).

**Kod bo'yicha tasdiqlangan asosiy faktlar:**

| Fakt | Tekshiruv |
|---|---|
| `'branch_batch_received'` butun repoda faqat **2 joyda** yoziladi | `branch-transfer-batch.service.ts:1907, :2146` — boshqa hech qayerda |
| Oddiy qabul yo'li bu action'ni yozmaydi | `inferTrackingAction` (`order-custody.service.ts:26-66`) RECEIVED uchun `'received'` qaytaradi, hech qachon `'branch_batch_received'` emas |
| Partly-sell haqiqatan 2-qator yasaydi | `order-lifecycle.service.ts:4313` — `parent_order_id: String(order.id)` bilan CANCELLED child |
| `executeAndAck` envelope qo'shmaydi | `libs/common/src/rmq/execute-and-ack.helper.ts:16` — handler natijasini xom qaytaradi; `getOverviewStats` esa `successRes` ishlatmaydi |
| Shu sababli branch `total` doim 0 | `branch-service.service.ts:689` — `response?.data?.acceptedCount` → `undefined` |
| Shu sababli `averageOrderValue` doim 0 | `unwrap()` (`analytics-service.service.ts:64-69`) `{data, summary}` dan faqat `data` ni oladi → `revenueData?.summary` `undefined` (`:785`) |
| `fetch_all` = cheksiz emas | `order-service.service.ts:328` — `MAX_FETCH_ALL = 5000`, `disable_pagination` yo'q → eng yangi 5000 qator |
| Market obyekti sanitizatsiya qilinmaydi | `user-service.service.ts:52-55` faqat `password` + `refresh_token` ni olib tashlaydi; `findMarketsByIds:1509` qolgan hamma maydonni qaytaradi |

> Izoh (R-27 aniqlashtirish): `onTimeRate` "har doim 100%" — bu **defolt (bugungi) ko'rinish** uchun
> to'g'ri, chunki kogorta `createdAt >= bugun 00:00` va `sold_at <= hozir`, ya'ni `diff < 24h`
> matematik jihatdan kafolatlangan. Tarixiy bir kunlik oyna so'ralganda 24 soatdan uzun yetkazishlar
> ham tushadi, shuning uchun u yerda 100% shart emas. Defekt real, lekin faqat defolt ko'rinishda
> absolyut.

---

## 1. Nega 188%?

`successRate` — bu **bir-biriga bog'liq bo'lmagan ikki so'rov natijasining bo'linmasi**. Numerator butun order populyatsiyasidan, denominator esa uning kichik qismidan olinadi, ustiga hech qanday clamp yo'q.

```
successRate = 100 * soldAndPaid / acceptedCount
              ^^^^^^^^^^^^^^^^^   ^^^^^^^^^^^^^
              hamma sotilgan      faqat branch-batch
              orderlar            qabul qilinganlar
```

### Sabablar, inflyatsiya kuchi bo'yicha tartiblangan

| # | Sabab | Fayl:qator | Inflyatsiya |
|---|---|---|---|
| **1** | **Denominator faqat `t.action = 'branch_batch_received'` ni sanaydi.** Bu string butun kodbazada faqat 2 joyda yoziladi: `branch-transfer-batch.service.ts:1907` va `:2146`. Asosiy qabul yo'li — `receiveNewOrders()` (`order-lifecycle.service.ts:2740-2763`) NEW→RECEIVED qiladi, lekin tracking'ga `action` yozmaydi (note: `'Order assigned to post'` → `inferTrackingAction` → `'received'`). Tashqi integratsiya orderlari to'g'ridan-to'g'ri `status: RECEIVED` bilan yaratiladi (`:2950`) — umuman tracking qatori yo'q. | `order-analytics.service.ts:270-271` | **10x–∞** (HQ-only tenantda denominator = 0) |
| **2** | **Numerator boshqa sana o'qida.** accepted → `t.created_at` (`:286`), sold → `o.sold_at` (`:606`), cancelled → `t.created_at` (`:246`). Defolt oraliq — bitta Toshkent kuni (`analytics-service.service.ts:115`), yetkazish esa 1-3 kun. Kecha qabul qilinib bugun sotilgan order numeratorda bor, denominatorda yo'q. | `:286` vs `:606` | **1.3x–3x** |
| **3** | **Dedup granularligi turlicha.** accepted: `COUNT(DISTINCT COALESCE(o.parent_order_id, o.id))` (`:272`), sold: `soldOrders.length` (`:617`), cancelled: `COUNT(DISTINCT t.order_id)` (`:198`). Partly-sell bitta posilkadan 1 parent (SOLD) + 1 child (CANCELLED) yasaydi (`order-lifecycle.service.ts:4258-4321`) → 1 accepted, 1 sold **va** 1 cancelled. | `:272` / `:198` / `:617` | **1.0x–2.0x** |
| **4** | **Branch-scope predikatlari nomutanosib.** `cancelled` `parent_o.branch_id`/`parent_o.holder_branch_id`/parent custody orqali ham mos keladi (`:191, :205-208`), `accepted` (`:275-282`) va `sold` (`:308-315`) esa yo'q. | `:191-208` | cancelRate uchun 1.1x–1.5x |
| **5** | **Teskari yo'nalish:** RETURN partiyasini qabul qilish ham `branch_batch_received` yozadi (`branch-transfer-batch.service.ts:2138-2152`), ya'ni denominatorni shishiradi va rate'ni pasaytiradi. | — | 0.6x–1.0x |
| **6** | **Hech qayerda clamp yo'q.** `ratio()` oddiy bo'lish (`designSystem.ts:141-142`), `formatPercent` clamp qilmaydi (`:123`), `SuccessGauge.tsx:86` xom qiymatni chop etadi — faqat yoy `Math.min(100,…)` bilan cheklangan (`:45`). | frontend | ko'rinishga chiqaradi |

### Raqamli misol (aynan 188%)

2026-08-14, HQ + 1 filial:

| Hodisa | Yozuv | accepted | sold |
|---|---|---|---|
| HQ 400 ta yangi orderni qabul qildi (`order.receive` → `receiveNewOrders`) | tracking `action = NULL` | **0** | — |
| Filial 60 ta orderlik batch qabul qildi | `action = 'branch_batch_received'` | **60** | — |
| Shu kuni HQ + filiallarda 113 ta order sotildi (69 tasi kechagi partiyadan) | `status IN (sold,paid,partly_paid)`, `sold_at` = bugun | — | **113** |

```
successRate = ratio(113, 60) = 188.3%
```

- SuccessGauge: **"188.3%"** to'liq yashil yoy ustida
- "Delivered" karta badge'i: **"↗ 188.3% Success rate"**
- Donut markazi: **60**, "sold" segmenti **113 · 188%**
- inProgress = `max(0, 60 − 113 − 12)` = **0** ("Yo'lda 0 dona") — aslida ~400 posilka kuryerlarda

**Xuddi shu sinf, boshqa ekranlarda:** kuryer dashboardi 187.5% (`30/16`, `order-analytics.service.ts:1137-1144, 1170`), market `sellingRate` 800% (`:687` vs `:700`), KPI `cancellationRate` 160% (`analytics-service.service.ts:782, 798`), branch header "Delivered 19 / Total 10" (`branchDashboardAdapter.ts:106, 119`).

> Diqqat: hozirgi noto'g'ri xatti-harakat **unit test bilan qulflangan** — `order-service.filter.spec.ts:397-421` ("counts dashboard accepted orders only from branch batch receive events"). Tuzatishda bu test qayta yozilishi shart.

---

## 2. Tasdiqlangan defektlar (severity bo'yicha, root-cause deduplikatsiya qilingan)

### HIGH

| # | Metrika | Fayl:qator (barcha saytlar) | Nima noto'g'ri | Ta'sir |
|---|---|---|---|---|
| **R-01** | successRate, Delivered badge, donut markazi, cancelRate, inProgress | `order-analytics.service.ts:270-272, 286`<br>yozuvchilar: `branch-transfer-batch.service.ts:1907, 2146`<br>chetda qolgan: `order-lifecycle.service.ts:2740-2763`, `:2950`<br>test: `order-service.filter.spec.ts:397-421` | Denominator faqat branch-transfer-batch qabuliga tayanadi; asosiy HQ qabul yo'li va tashqi orderlar ko'rinmaydi | 188% gauge; HQ-only tenantda 0.0% (qizil) |
| **R-02** | successRate, cancelRate, sellingRate, inProgress, "Delivered > Total", region delivered/revenue | overview: `:286` vs `:606`<br>courier: `:1137-1140` vs `:1141-1144` vs `:1149`(`:246`)<br>market: `:687` vs `:700` (`:722`)<br>KPI: `analytics-service.service.ts:782, 798`<br>topBranches: `order-analytics.service.ts:983-989`<br>branch UI: `branchDashboardAdapter.ts:106, 119`<br>region: `order-service.service.ts:623-645` vs `order-analytics.service.ts:603-610` | Numerator va denominator turli populyatsiya + turli sana ustunida (`t.created_at` / `o.sold_at` / `COALESCE(assigned_at,createdAt)` / `updatedAt` / `createdAt`). Numerator denominatorning kichik to'plami emas | Cheklanmagan >100% qiymatlar; bitta kun uchun ikki ekranda 3 vs 30 yetkazish; kogorta oralig'idagi orderlar hech qaysi davrga tushmaydi |
| **R-03** | totalOrders, cancelled, successRate, sellingRate, top-N, region/district/courier statistikasi | dedup **bor**: `order-analytics.service.ts:272`<br>dedup **yo'q**: `:198`, `:617`, `:1116/1148`, `:806`, `:938`, `:855`, `:983`, `:1192-1198`<br>`logistics-service.service.ts:4075-4094`<br>manba: `order-lifecycle.service.ts:4258-4321` | Partly-sell 1 posilkadan 2 order qatori yasaydi (parent SOLD + child CANCELLED, bir xil `post_id`/`district_id`/`assigned_at`/`home_branch_id`). Sanoqlarning bir qismi parent bo'yicha dedup qiladi, qolgani yo'q | Bitta posilka = 1 accepted, 1 sold, 1 cancelled; district successRate 100% → 50%; donut segmentlari 200% gacha yig'iladi |
| **R-04** | "Sof foyda" (overview), kuryer `profit` / `totalAmount` / `salaryEstimate` | `order-analytics.service.ts:640-655`, `:1159-1168`<br>snapshotlar: `order.entity.ts:56-113`<br>ledger: `order-lifecycle.service.ts:951-958`, `domain/order-money.ts:22, 36-44` | Foyda hisobot vaqtida **tirik** market/kuryer tarifidan qayta hisoblanadi; `courier_share`, `branch_share`, `CourierCompensationMode.SALARY_ONLY` e'tiborsiz. Snapshot ustunlari so'rovga hatto `select` ham qilinmagan | Tarif o'zgarsa yopilgan oyning foydasi retroaktiv o'zgaradi (misol: 8M → 13M); PARTNER filial sotuvi HQ foydasi sifatida ortiqcha ko'rsatiladi; SELL_PROFIT ledger bilan mos kelmaydi |
| **R-05** | delivered, cancelled, inProgress, pending, statusDistribution | `branch-service.service.ts:2985-2991`, `:3099-3106`<br>`order-analytics.service.ts:148-158`<br>`logistics-service.service.ts:4061-4069, 4096-4099`<br>`analytics-service.service.ts:847-857`<br>kanonik: `order-analytics.service.ts:136-138` | Har bir servis o'z status to'plamini qo'lda yozadi: branch `delivered` ichida WAITING (rollback holati) va CLOSED/RETURNED_TO_MARKET bor; `activeMarketStatuses` ichida terminal RETURNED_TO_MARKET bor; statusDistribution 13 statusdan 9 tasini sanaydi | Har kuni `delivered` shishadi (deyarli har bir kuryerdagi order WAITING); rollback qilingan sotuv "yetkazilgan"; market kartasida abadiy "Jarayonda 20"; hisobot bo'limlari o'zaro kelishmaydi |
| **R-06** | olinishi_kerak (pul), region/district/courier statistikasi, finance report, KPI SLA, byRegion, topProducts, packages/couriers kartalari | **pul:** `branch-service.service.ts:2570-2597` (5000 cap) vs `:2727-2755` (to'liq tarix)<br>**region:** `logistics-service.service.ts:4054, 3926, 456-493`<br>`analytics-service.service.ts:932-933, 961` (20 qator!), `:333-349` (10k cap)<br>`branch-service.service.ts:741-744`<br>`order-analytics.service.ts:1192-1198, 1220/1227/1236/1243` (65535 param cliff)<br>`logistics-service.service.ts:862` (100 cap)<br>cap manbasi: `order-service.service.ts:326-337, 647-650` | Agregatlar paginatsiyalangan entity fetch ustidan hisoblanadi; `total` javobdan tashlab yuboriladi, `truncated` flag yo'q | **Filial→HQ qarzi (5000 eng yangi order) to'liq to'lov tarixidan ayiriladi → `max(x,0)` bilan 0 ga tushadi** — HQ ~300M so'm qarzni ko'rmaydi. Region sahifasi butun repo bo'yicha eng yangi 5000 orderdan (~18 kun) hisoblanadi. Finance hisoboti ~140x xato |
| **R-07** | branch `cards.orders.total`, `today_orders_count`, `week_orders_count`, KPI `averageOrderValue`, "Yo'qotilgan daromad", `/analytics/revenue` chart | `branch-service.service.ts:689` (`response?.data?.acceptedCount`)<br>`analytics-service.service.ts:64-69` (`unwrap()`)<br>manba: `execute-and-ack.helper.ts:10-26`, `order-analytics.service.ts:657-668`, `:1315-1329`<br>noto'g'ri mocklar: `analytics-service.service.spec.ts:252-257`, `branch-service.service.spec.ts:551` | order-service analytics handlerlari **bare object** qaytaradi (successRes envelope yo'q). Bir consumer `response.data` kutadi (→ `undefined` → 0), boshqasi `data` kaliti borligi uchun ortiqcha unwrap qiladi (→ `summary` yo'qoladi) | Branch dashboardida `total` **doim 0** ("Total 0 / Delivered 180"); `averageOrderValue` va `lostRevenue` **doim 0 so'm**. CI yashil, chunki spec'lar hech qachon yuborilmaydigan shaklni mock qiladi |
| **R-08** | donut "Total accepted", successRate, inProgress + **order state integrity** | `branch-transfer-batch.service.ts:2117-2133, 2138-2152`, `1841-1877, 1896-1912`<br>direction-aware kod: `:2199-2216`<br>machine: `domain/order-status.machine.ts:59-63`<br>bloklanadi: `order-lifecycle.service.ts:2158-2170` | RETURN partiyasini qabul qilish `batch.direction` ni e'tiborsiz qoldiradi: `status`ni so'zsiz RECEIVED ga o'zgartiradi va `branch_batch_received` yozadi. CANCELLED→RECEIVED status mashinasida mavjud emas — raw query builder uni chetlab o'tadi | Qaytgan posilka accepted'da ikkinchi marta sanaladi; **posilka qotib qoladi** — marketga qaytarish oqimi `status=CANCELLED` + `holder_type=HQ` talab qiladi, endi u yana yetkaziladigan orderlar poolida |
| **R-09** | market dashboard `topMarkets` + `markets[]` | `analytics-service.service.ts:523-527, 528-532, 543-544`<br>render: `MarketDashboardPage.tsx:185`<br>sanitize: `identity user-service.service.ts:1494-1511, 52-55` | MARKET / MARKET_OPERATOR tarmog'ida faqat `market_stat` scope qilingan; `market_stats` va `top_markets` scope'siz yuboriladi va javobga qaytadi | Market raqobatchilarining nomi, hajmi, success_rate'ini ko'radi; `markets[]` esa **to'liq market obyektini** uzatadi — `phone_number`, `address`, `salary`, `telegram_id`, **`market_tg_token`** (Telegram bot tokeni). Cross-tenant PII + credential leak |

### MEDIUM

| # | Metrika | Fayl:qator | Nima noto'g'ri | Ta'sir |
|---|---|---|---|---|
| R-10 | Cancelled karta, cancelRate, donut, Lost revenue | `order-analytics.service.ts:167-170, 195-198, 246`<br>echo yozuvchilar: `logistics-service.service.ts:574/1762/3035/3083/3213/3260/3386`, `order-lifecycle.service.ts:2185-2199` | Bitta bekor qilish 3-4 tracking qatori yasaydi (CANCELLED, CANCELLED_SENT, CLOSED); faqat `cancelled_post_received` chiqarib tashlangan. DISTINCT faqat oyna **ichida** ishlaydi | Iyulda bekor qilingan 100 order avgustda marketga topshirilganda avgust `cancelled`ga qayta tushadi → cancelRate yolg'iz o'zi 120% |
| R-11 | Branch cancelled / cancelRate / Lost revenue | `order-analytics.service.ts:214-218`<br>test: `order-service.filter.spec.ts:423-441` | `branchId && !courierId` bo'lganda `LOWER(t.changed_by_role) != 'courier'` — ya'ni maydonda kuryer bekor qilgan hamma order tashlanadi. Sotuvda simmetrik filtr yo'q | Filialda haqiqiy 37.5% cancelRate o'rniga 2.5% ko'rinadi; Lost revenue ~14x kam; inProgress 75 ta "yo'lda" |
| R-12 | Kuryer totalOrders/soldOrders/successRate, `/reports/couriers` | `order-analytics.service.ts:318-343`, qo'llanishi `:1116`, `:1124`<br>custody: `order-lifecycle.service.ts:2227, 4694` | Scope `oce.from_courier_id` ni ham, sanasiz ham mos keladi → bir marta ushlab, qaytarib bergan kuryer o'sha orderga abadiy "bog'lanadi" | Bir sotuv ikki kuryerga yoziladi (har biriga +1 order va +12 000 tarif) |
| R-13 | "Jarayonda / On the road" + donut apelsin segmenti | `DashboardStatistics.tsx:90`, `branchDashboardAdapter.ts:106`<br>mavjud to'g'ri manba: `order-analytics.service.ts:148-158, 1233-1238`, normalizer `entities/dashboard/index.ts:413-422` | `max(0, accepted − sold − cancelled)` — uchta mos kelmaydigan populyatsiya ayiriladi, manfiy natija 0 ga clamp qilinadi | "Yo'lda 0 dona" — aslida ~400 posilka kuryerlarda; dispetcher ish tugadi deb o'ylaydi |
| R-14 | SuccessGauge rangi va qiymati, cancelRate, donut legend | `designSystem.ts:141-142`, `SuccessGauge.tsx:31-32, 43-45, 86`<br>qarama-qarshi: `OrderStatusDonut.tsx:38` | `total <= 0` → 0 qaytariladi: "ma'lumot yo'q" va "0 foiz muvaffaqiyat" farqlanmaydi; `gaugeTone(0)` qizil | Yonma-yon: gauge "0.0%" (qizil, ostida "50 Sold"), donut markazi "54 · sold 93%" |
| R-15 | "O'rtacha buyurtma qiymati", "Yo'qotilgan daromad" | `DashboardPage.tsx:89-93, 160`, `DashboardStatistics.tsx:93, 115`<br>gate: `analytics-gateway.controller.ts:123-125` | KPI faqat SUPERADMIN/ADMIN uchun va all-time'da o'chirilgan; `kpi?.averageOrderValue ?? 0` soxta nol yasaydi ("unavailable" holati yo'q) | MANAGER: "Daromad 480M / Foyda 62M / O'rtacha 0 / Yo'qotilgan 0" (yonida 420 bekor qilingan order). R-07 bilan birga hatto admin uchun ham 0 |
| R-16 | "Barchasi / All time" ostidagi barcha raqamlar | `analytics-service.service.ts:462-468, 483-487, 517-522, 552-569`<br>o'lik kod: `order-analytics.service.ts:584-586`, `:1105-1107`<br>clamp: `:43-44, 120-131`<br>market hech qachon yubormaydi: `dateRange.ts:64-67`, `MarketDashboardPage.test.tsx:88` | `all` flagi RPC payload'iga qo'shilmaydi; o'rniga `1970-01-01` yuboriladi va `MAX_ANALYTICS_SPAN_MS = 768 kun` clamp'iga tushadi (faqat `logger.warn`) | "Metrics for all time" sarlavhasi ostida faqat oxirgi 2.1 yil; javobda hech qanday belgi yo'q |
| R-17 | Revenue chart bar'lari va yorliqlari, `avgRevenue`, region "bugun" | `order-analytics.service.ts:383-405` vs `:345-363`<br>`order-service.service.ts:623-645`<br>`Dockerfile` / `docker-compose.prod.yml` da `TZ` yo'q | `periodStart` local (konteynerda UTC) mutatorlardan, yorliq esa `timeZone: 'Asia/Tashkent'` dan. `findAll` esa start uchun UTC-midnight, end uchun local `setHours(23,59,59)` | Bir kunlik so'rov 2 ta bar beradi, `avgRevenue` yarmiga bo'linadi; 00:00-05:00 sotuvlari kechagi kunga tushadi; region sahifasi va dashboard "bugun" tugmasidan 5 soatga farq qiladigan oyna oladi (310 vs 350) |
| R-18 | "By markets" chart, "Active packages", "Couriers" — "tanlangan davr uchun" yorliq ostida | `analytics-service.service.ts:425-429`, `branch-service.controller.ts:79-84`, `branch-service.service.ts:2936-2954, 3010-3063`<br>locale: `branchDashboard.json` | `branch.dashboard` payload'ida `startDate`/`endDate` umuman yo'q; hammasi `new Date()` dan | Iyul tanlansa KPI kartalari o'zgaradi, markets chart esa bugungi qatorlarni ko'rsatadi → 09:00 da "Market statistikasi hali yo'q" |
| R-19 | ActivePackagesCard "Qabul kutilmoqda" / "Yo'ldagi paketlar" | `branch-service.service.ts:3031-3047`<br>state: `branch-transfer-batch.service.ts:374-390, 1682-1702, 1841-1857` | Predikat (`status=RECEIVED` + `current_batch_id != null`) faqat **shu filialda yig'ilayotgan PENDING chiquvchi** partiyaga mos keladi; qabul qilingach `current_batch_id` tozalanadi va `branch_id` ko'chadi | Filial 3 ta kelgan partiyani (120 order) ushlab tursa ham "Qabul kutilmoqda: 0"; o'rniga o'zining 1 ta qoralama partiyasi ko'rsatiladi |
| R-20 | CourierActivityCard "Bugun faol" | `branch-service.service.ts:3049-3058`, `:699-727` | `courier_id` Set'i `createdAt >= todayStart` orderlaridan olinadi; `assigned_at`/`sold_at` `extractOrderRows`da umuman ko'chirilmaydi | 12 kuryer 300 order yetkazgan kuni "Filial kuryerlari 12 / Bugun faol 0" |
| R-21 | "By markets" bar balandligi va UZS yorlig'i, today bucket'lari | `branch-service.service.ts:729-757, 759-776`<br>`order-service.service.ts:539-548` | Har bir filial id uchun alohida `order.find_all`, natija `rows.flat()` — dedup yo'q. order-service filtri `branch_id OR holder_branch_id OR home_branch_id` | HQ/parent manager uchun har bir market bar'i va pul yorlig'i ~2x |
| R-22 | "Top filiallar" leaderboard | `order-analytics.service.ts:976-977, 1013`<br>`order.entity.ts:169-176`, `order-lifecycle.service.ts:216-258, 2399` | `COALESCE(o.home_branch_id, …)` bo'yicha guruhlash — `home_branch_id` **yaratuvchi** filial va hech qachon yangilanmaydi; market/bot orderlari HQ fallback'ga tushadi, keyin HQ qatori `:1013` da o'chiriladi | 4 000 yetkazilgan market orderi leaderboardda umuman ko'rinmaydi; panel ko'pincha bo'sh |
| R-23 | "Top marketlar" / "Top filiallar" / courier ranking ro'yxati | `order-analytics.service.ts:880, 960, 1013`<br>eskirgan izoh: `TopPerformers.tsx:14-17` | `total_orders >= 30` absolyut chegara 30 kunlik defolt uchun yozilgan, endi tanlangan har qanday oynaga (jumladan 1 kunga) qo'llanadi | Defolt "bugun" ko'rinishida panel "ma'lumot yo'q" holatiga tushadi, yonida KPI yuzlab orderni ko'rsatib turadi |
| R-24 | Market "Sof foyda / Net profit" kartasi | `order-analytics.service.ts:1239-1253`<br>`order-lifecycle.service.ts:3125, 3142-3143, 4224`<br>`MarketDashboardPage.tsx:283-291`, `locales/*/dashboard.json:69` | `profit = SUM(to_be_paid)` — bu market'ning **brutto COD receivable**'i (`total_price − market_tariff`), marja emas. Hint esa "Market tarifi − kuryer tarifi" deb yozilgan | 100 orderda karta 18 000 000 ko'rsatadi, hint ta'riflagan qiymat 500 000 — 36x noto'g'ri talqin |
| R-25 | Market "Bekor qilingan" kartasi | `order-analytics.service.ts:1228`<br>`base.entity.ts:15-16`, `order-lifecycle.service.ts:2185-2192` | Bekor qilish `updatedAt` (oxirgi teginish) bo'yicha filtrlanadi — bu bekor qilish vaqti emas | Yopilgan oyning bekor qilish soni vaqt o'tgani sari kamayadi; oyna ichida yaratilib keyin bekor qilingan order hech qaysi bucket'ga tushmaydi |
| R-26 | Foyda, kuryer statistikasi, top filiallar, butun dashboard | `order-analytics.service.ts:466`, `:494/497`, `:519-528`<br>`order-lookup.service.ts:86, 104`<br>`analytics-service.service.ts:590-614, 666-672` | Har bir RMQ oyog'i `.catch(() => …)` bilan yutiladi va **soxta qiymatga** aylanadi: `tariff ?? 0`, bo'sh posts sahifasi + `totalPages = 1`, `branch = undefined` | logistics tushsa foyda 20M (2.5x, yashil), identity tushsa 0 (qizil) — bir davr uchun 3 xil raqam; order-service restart paytida "biznes bugun hech narsa qilmadi" dashboardi; HQ qatori "Filial 1" nomi bilan leaderboardga sizib chiqadi |
| R-27 | KPI `onTimeRate`, `averageFulfillmentHours` | `analytics-service.service.ts:744-752, 759-769, 794-797`<br>`order-service.service.ts:620-641` | Kogorta `createdAt` bo'yicha tanlanadi, keyin `sold_at − createdAt <= 24h` o'lchanadi. Defolt oyna eni 86 399 999 ms < SLA 86 400 000 ms | Defolt (bugungi) ko'rinishda `onTimeRate` **matematik jihatdan doim 100.00** (§0 dagi aniqlashtirishga qarang); 70+ soatlik yetkazishlar kogortaga umuman tushmaydi |
| R-28 | `/reports/orders` byRegion, topProducts; KPI SLA | `analytics-service.service.ts:333-349, 744-752, 870-895` vs `:859-861` | `collectOrders` 100 ta sahifada `page > 100` da to'xtaydi (10 000 qator), `truncated` belgisi yo'q; `statusDistribution` esa alohida COUNT so'rovlaridan | 47 000 orderlik hisobotda ikki bo'lim 27 000 orderga farq qiladi |
| R-29 | branch `cards.orders.{total,new,on_the_road,delivered,returned}` | `branch-service.service.ts:2995-3007` vs `:2952-2954` | `total` — tracking accepted (`t.created_at`), bo'laklar esa `createdAt >= todayStart`. Qism butundan katta bo'lishi mumkin | R-07 tufayli amalda `total` doim 0 → har doim "Total 0 / Delivered N" |

### LOW

| # | Metrika | Fayl:qator | Nima noto'g'ri | Ta'sir |
|---|---|---|---|---|
| R-30 | `kpi.marketRating`, `/reports/orders.topMarkets`, `/reports/couriers.ranking` | `analytics-service.service.ts:731-734, 841-844, 1035-1038`<br>`order-analytics.service.ts:847-849, 903-911`<br>`order-service.controller.ts:877-885` | Sana uzatilmaydi; `getTopCouriers` esa umuman sana parametrini qabul qilmaydi (hardcoded 30 kun) va branch scope'siz | Javobda `range: normalized` yonida butunlay boshqa oyna uchun ranking |
| R-31 | `/reports/couriers` items[] | `analytics-service.service.ts:1050-1092` | Detail RPC `.catch(() => null)` bo'lganda `cancelledOrders = max(0, total − sold)` sintez qilinadi; `totalAmount` va `salaryEstimate` bir xil `profit`; qator ichida ikki xil sana o'qi; degradatsiya 30s cache'ga yoziladi | Yo'ldagi 35 order "bekor qilingan" deb ko'rsatiladi (4% → 42%) |
| R-32 | `/reports/finance.payables` | `analytics-service.service.ts:282-285, 997-1001`<br>`finance-service.service.ts:2587, 2589-2592` | `payables.couriers` aslida branch receivable; `payables.markets` manfiy | "Kuryerlarga 84M qarzdormiz, marketlar bizga 35M qarzdor" — ikkalasi ham teskari |
| R-33 | `branchReceivable`, `currentSituation` | `analytics-service.service.ts:246-258, 666-671, 946-951`<br>`branch-service.service.ts:276, 2350-2352` | Faqat `status: 'active'` filiallar; `limit: 1000` identity/branch clamp'ida 100 ga tushadi; `meta.total` tekshirilmaydi | O'chirilgan filialning to'lanmagan qarzi balansdan yo'qoladi |
| R-34 | `topOperators[].operator_name` | `order-analytics.service.ts:1067-1091, 549-578`<br>`order-lifecycle.service.ts:2356-2359`<br>`identity user-service.service.ts:311-313, 982-983` | Nom hal qilish uchun tizimdagi **barcha** market_operator'lar sahifalab yuklanadi (limit 200 → 100 clamp, ketma-ket RPC); `operator_id` REGISTRATOR uchun ham yoziladi, lekin so'rov faqat MARKET_OPERATOR ni oladi | Registrator kiritgan orderlar `operator_name: null` qatori; har bir market dashboard yuklanishida ~30 ketma-ket RPC |
| R-35 | Region "Sizning tumaningiz statistikasi" (MANAGER) | `logistics-gateway.controller.ts:757-766`, `logistics-service.controller.ts:384-395`<br>frontend yuboradi: `RegionStatsCard.tsx:159-166`, `pages/region/index.tsx:170-178` | Frontend `courier_id`/`branch_id` yuboradi, gateway ularni tashlab yuboradi, `getRegionDetailedStats` scope parametrini bilmaydi | Manager scope'siz butun viloyat raqamlarini "filial tumani statistikasi" yorlig'i ostida ko'radi (kuryer uchun widget umuman render qilinmaydi) |
| R-36 | Region xarita tooltip "Kuryerlar" | `logistics-service.service.ts:3993-4004`<br>`entities/region/index.ts:100-102`, `UzbekistanRegionMap.tsx:438, 540` | `getAllRegionsStats` qatorida kuryer soni maydoni umuman yo'q; frontend 4 ta mavjud bo'lmagan kalitni qidiradi | Har bir viloyat uchun abadiy "Kuryerlar: 0" |
| R-37 | Scoped region widget "Kuryerlar" hisoblagichi | `entities/region/index.ts:272-275, 321-323`<br>`logistics-service.service.ts:4146-4152` vs `4168-4170` | `activeCouriers` fallback sifatida `couriers.length` (status filtri yo'q) olinadi; `??` o'rniga `||` ishlatilgani uchun backend'ning haqiqiy `0` qiymati bosib ketiladi | Barcha kuryerlari nofaol viloyat "Kuryerlar: 5" ko'rsatadi |
| R-38 | Market dashboard barcha 5 karta | `order-analytics.service.ts:1192-1198, 1220/1227/1236/1243`<br>`analytics-service.service.ts:522` | Kogorta id'lari materializatsiya qilinib `o.id IN (:...orderIds)` orqali bind qilinadi — Postgres 65535 parametr chegarasi | ~65k orderdan keyin 4 ta so'rov ham xato beradi → `myStat = null` → butun sahifa nol ko'rsatadi (xato holati yo'q) |
| R-39 | "Kutilmoqda / Pending" kartasi | `logistics-service.service.ts:4096-4099` | `pending = total − delivered − cancelled` — RETURNED_TO_MARKET va CLOSED (terminal muvaffaqiyatsizliklar) shu bucket'ga tushadi. `Math.max(0,…)` clamp'i erishib bo'lmaydigan o'lik kod | 20 ta marketga qaytarilgan posilka "yo'lda" deb ko'rsatiladi |

---

## 3. Rad etilgan da'volar (3)

1. **"analytics-service finance-service'ning avtoritet `currentSituation`ini bosib ketadi"** — `/financial-balance` sahifasi `finance.cashbox.financial_balance` ni **umuman o'qimaydi**; u `finance-gateway.controller.ts:1554-1636` dan aynan bir xil manbalar bilan hisoblaydi. Ziddiyat mavjud emas.
2. **"branch subtree bo'ylab `today_orders_count` 3x sanaladi"** — mexanizm kodda bor, lekin R-07 (envelope) tufayli har bir hissa 0; yig'indi doim 0, hech qachon 300 emas.
3. **"Integration `success_rate` status filtri bilan 0%/100% bo'ladi"** — `{...where, status:'success'}` da keyingi kalit avvalgisini **almashtiradi** (AND emas). Xatti-harakat allaqachon to'g'ri.

---

## 4. Tasdiqlangan to'g'ri metrikalar

**Ratio strukturasi (numerator ⊂ denominator, >100% mumkin emas)**
`getCourierStats:824-827`, `getTopCouriers:948-950`, `getTopMarkets:884-887`, `getTopBranches:983-986`, `getTopOperatorsByMarket:1082-1085`, `getMarketStat.successRate:1254-1257` (numerator aynan `orderIds` ichida), `onTimeRate:794-797`, `logistics successRate:4100-4101`. Bularda numerator va denominator bitta so'rov/bitta massivdan.

**Nol bo'luvchi / NaN / Infinity**
Barcha bo'lishlar musbat-maxraj guard'i bilan; `designSystem.ts:141-142`, `formatPercent:123-124`, `parseNumber:241-244`, `toNumber` (`entities/dashboard/index.ts:170-173`). Hech qanday NaN/Infinity DOM'ga chiqmaydi.

**Vaqt zonasi helperlari (mantiq to'g'ri)**
`analytics-service.service.ts:161-190` (`tashkentBoundaryToUtc`), `order-analytics.service.ts:58-134`, `branch-service.service.ts:651-667`. UTC+5 fiksirlangan, DST yo'q; ISO instant'lar ikki marta siljitilmaydi (`:83-85`); hafta/oy presetlari siljitilgan soatdan olinadi. (Muammo — R-17 da: konteynerda TZ o'rnatilmagani va `periodStart` bu helperlardan foydalanmagani.)

**Ma'lumotlar butunligi**
`sold_at` — bigint ms; barcha yozuvchilar `String(Date.now())`, barcha o'qishlar ms bilan taqqoslaydi (leksikografik emas). Qo'lda `innerJoin` qilingan so'rovlarda `o.isDeleted = false` aniq qo'yilgan (`:193, :269, :592`). Custody scope `EXISTS` orqali (JOIN emas) → qator fan-out yo'q (`:293-343`). Bekor qilingan sotuvda `sold_at: null` yoziladi → sotilgan kogortadan toza chiqadi (`order-lifecycle.service.ts:3556-3562, 1597/1614/1627`). Bir oyna ichidagi ko'p bosqichli bekor qilish `COUNT(DISTINCT t.order_id)` bilan bir marta sanaladi.

**Populyatsiya izchilligi**
`profit`, `totalRevenue`, `soldAndPaid` — bitta `soldOrders` massividan (`:612-617, 640-655`) → sanoq va pul hech qachon ajralmaydi (formula noto'g'ri, populyatsiya to'g'ri). `getMarketStat` bucket'lari o'zaro kesishmaydi va 13 statusni to'liq qoplaydi. Branch dashboard'dagi Set-asosli sanoqlar (batches, couriers) fan-out duplikatsiyasiga chidamli (`branch-service.service.ts:2966-2975, 3031-3058`). `resolveAnalyticsBranchIds` CTE'si root+tirik avlodlarni to'g'ri qaytaradi.

**Xavfsizlik / ruxsat**
`assertFinancialAccess` RMQ chegarasida (`:53-62`, chaqiriladi `:644, :703, :832, :922`), rolni lowercase qiladi. `sanitizeDashboardOverview` (`:214-226`) faqat `profit`/`totalRevenue` ni olib tashlaydi, sanoqlarga tegmaydi; frontend ham mustaqil ravishda yashiradi.

**Biznes mantiqi**
PARTLY_PAID ni revenue'ga to'liq `total_price` bilan kiritish to'g'ri (bu **marketga** qisman to'lov, mijoz to'lovi emas — `order-lifecycle.service.ts:3160-3166, 4050-4061`). `extractBranchReceivable` HQ ni to'g'ri chiqarib tashlaydi (HQ'da `olinishi_kerak` boshqa ma'noga ega — `branch-service.service.ts:2762-2775`). CLOSED ni bekor qilingan deb hisoblash bugungi kod yo'llari uchun to'g'ri. Revenue chart bucket generatsiyasi hech qanday order tushirmaydi (monotone `periodStart`, oylik overflow yo'q). `collectOrders` sahifalash gap/overlap yasamaydi (faqat cap muammo — R-06).

---

## 5. Tuzatish rejasi

### Faza 0 — successRate ta'rifi (avval bu, keyin qolgani)

**Qaror: hisoblash BACKEND'da, `getOverviewStats` ichida bo'lsin.** Frontend uchta mustaqil sonni oladi va ularning populyatsiyasini bila olmaydi; bitta SQL'da `FILTER` bilan bir o'tishda hisoblansa `sold <= accepted` invarianti server tomonida kafolatlanadi va assert qilinadi.

**1. Migratsiya:** `orders.accepted_at timestamptz NULL` + indeks.
Backfill: `UPDATE orders o SET accepted_at = (SELECT MIN(t.created_at) FROM order_tracking t WHERE t.order_id = o.id AND t.to_status = 'received')`; qolganlariga (tashqi orderlar) `createdAt`.
Stamp qilinadigan joylar: `order-lifecycle.service.ts:2744` (`receiveNewOrders`), `:2950` (`receiveExternalOrders`), `branch-transfer-batch.service.ts:1907` va `:2146` — **faqat `direction = FORWARD`** (R-08).

**2. Aniq ta'rif** (bitta populyatsiya, bitta sana o'qi, bitta dedup granularligi):

```
birlik      = posilka = COALESCE(o.parent_order_id, o.id)
kogorta     = o.accepted_at BETWEEN :start AND :end   -- yagona sana o'qi
              AND o.isDeleted = false
              AND <branch scope: bir xil predikat uchala sanoq uchun>

accepted    = COUNT(DISTINCT COALESCE(o.parent_order_id, o.id))
delivered   = COUNT(DISTINCT COALESCE(o.parent_order_id, o.id))
                FILTER (WHERE o.status IN ('sold','paid','partly_paid'))
cancelled   = COUNT(DISTINCT COALESCE(o.parent_order_id, o.id))
                FILTER (WHERE o.status IN ('cancelled','cancelled (sent)','closed')
                        AND o.parent_order_id IS NULL)   -- partly-sell child sanalmaydi
inProgress  = accepted - delivered - cancelled           -- endi hech qachon manfiy emas

successRate = accepted > 0 ? 100.0 * delivered / accepted : null
cancelRate  = accepted > 0 ? 100.0 * cancelled / accepted : null
```

- `soldInPeriod` (`o.sold_at` bo'yicha oqim) **alohida maydon** sifatida qaytarilsin, lekin hech qachon `accepted`ga bo'linmasin.
- Server `assert(delivered + cancelled <= accepted)` qilsin va buzilganda `logger.error` + `partial: true` qaytarsin.
- Frontend: `DashboardStatistics.tsx:88-90` dagi qayta hisoblash **o'chirilsin**, `orders.successRate / cancelRate / inProgress` to'g'ridan-to'g'ri ishlatilsin; `null` → "—" + neytral ton (`SuccessGauge`, `MetricCard`, `OrderStatusDonut`); `branchDashboardAdapter.ts:106` dagi `Math.max(0,…)` olib tashlansin.
- `order-service.filter.spec.ts:397-421` va `:423-441` yangi ta'rifga qayta yozilsin.

### Faza 1 — P0 (pul, xavfsizlik, state)

3. **R-09** — `analytics-service.service.ts:523-532` dagi scope'siz `market_stats` / `top_markets` chaqiruvlarini olib tashlash yoki `marketId` bilan cheklash. `market_tg_token` hech qachon dashboard javobiga chiqmasin (identity sanitize'ga qo'shish).
4. **R-06 (pul oyog'i)** — `branch-service.service.ts:2570` dagi `fetch_all` ro'yxatini olib tashlab, order-service'da `SUM(courier_share) / SUM(branch_share) / SUM(total_price) / COUNT` qaytaradigan agregat komandasi qo'shish; qarz va to'lov oyoqlari **bir xil oynada** (yoki `BRANCH_SETTLED` bo'lmaganlar bo'yicha) hisoblansin.
5. **R-04** — `soldOrdersQuery`ga `market_tariff, courier_tariff, courier_share, branch_share` qo'shish va `computeSellProfit(...)` (ledger bilan **bir xil helper**) ishlatish; market/post/courier RMQ fan-out'i (`:622-636`) butunlay olib tashlanadi. Kuryer tomonida `SUM(COALESCE(courier_share, courier_tariff, 0))`, maydon nomi `courierEarnings`.
6. **R-08** — ikkala receive yo'lida `batch.direction === RETURN` bo'lsa `action: 'branch_batch_returned'` yozish va statusni **o'zgartirmaslik**; CANCELLED→RECEIVED status mashinasi orqali bloklansin. Qotib qolgan posilkalarni topib tuzatuvchi bir martalik skript.
7. **R-07** — order-service analytics handlerlarini `successRes()` bilan o'rash (yoki barcha consumerlarni bare-object'ga moslashtirish) + `unwrap()` ni envelope-aware qilish (`statusCode` va `message` mavjudligini tekshirish); `analytics-service.service.spec.ts:252-257`, `branch-service.service.spec.ts:551` mocklari haqiqiy shaklga keltirilsin.

### Faza 2 — P1 (metrika to'g'riligi)

8. **R-03** — barcha sanoqlarda `COUNT(DISTINCT COALESCE(parent_order_id, id))`; logistics `summarizeOrders`da `COALESCE(parent_order_id, id)` kaliti bo'yicha guruhlash (guruh biror a'zosi sotilgan bo'lsa — delivered); yoki `order.find_all`ga `exclude_child_orders` flagi.
9. **R-05** — `soldStatuses / cancelledStatuses / activeStatuses / returnedStatuses` ni `libs/common` ga chiqarish va order-, branch-, logistics-service'da import qilish. WAITING → in-progress, CLOSED/RETURNED_TO_MARKET → alohida `returned` bucket. `statusDistribution` = `Object.values(Order_status)`.
10. **R-10** — faqat kirish tranzitsiyasini sanash: `t.to_status = CANCELLED AND (t.from_status IS NULL OR t.from_status NOT IN (cancel-family))`; CANCELLED_SENT/CLOSED ro'yxatdan olib tashlansin.
11. **R-11** — `:214-218` predikati o'chirilsin (yoki sotuvga ham simmetrik qo'llansin).
12. **R-12** — sotuv atributsiyasi `order_settlement.courier_id` orqali; `totalOrders` uchun faqat `oce.to_courier_id` + `oce.created_at BETWEEN :start AND :end`.
13. **R-16** — `all: true` payload'ga qo'shilsin (`:552-569`, `:483-487`, `:517-522`); javobda `from/to/clamped/effectiveFrom` qaytarilsin va UI sarlavhada ko'rsatsin.
14. **R-17** — `TZ=Asia/Tashkent` ni `docker-compose.prod.yml` va Dockerfile'ga qo'shish; `periodStart`ni `tashkentBoundaryToUtc` orqali qayta yozish; `order-service.service.ts:623-645` sana parsingi umumiy helperga o'tkazilsin; `avgRevenue` faqat oyna ichidagi bucket'larga bo'linsin.
15. **R-06 (qolgan saytlar)** — agregat RPC'lar: `order.analytics.region_breakdown` (GROUP BY region/district/courier + FILTER), `order.analytics.courier_stats_batch`, `finance.cashbox.range_totals`; `getMarketStat` bitta FILTER-so'roviga (65535 cliff yo'qoladi); paginatsiyalangan yo'llarda `truncated: true` qaytarilsin.
16. **R-26/R-31** — degradatsiya ko'rinadigan bo'lsin: `partial: true, failedSources: [...]`; sintetik fallback'lar (`max(0, total − sold)`, `tariff ?? 0`, `totalPages = 1`) olib tashlansin; `getAllPostsForAnalytics`ga `page > 100` guard; `getBranchesByIds` fail bo'lganda qator **tushirilsin** (HQ leak).

### Faza 3 — P2 (UI, yorliqlar, ranking)

17. R-13/R-14/R-15: null-holat ("—", neytral ton), KPI kartalari uchun "mavjud emas" holati.
18. R-24: market kartasi `receivable` deb qayta nomlansin, market'ga xos hint.
19. R-18: `branch.dashboard` payload'iga sana; R-19/R-20: predikatlar `BranchTransferBatch` va `assigned_at/sold_at` ga ko'chirilsin; R-21: fan-out'dan keyin `Map(id → row)` dedup yoki bitta `branch_ids` so'rovi.
20. R-22: `COALESCE(o.holder_branch_id, o.branch_id, o.home_branch_id)` bo'yicha guruhlash; scope'li chaqiruvda o'z filiali qatori kafolatlansin.
21. R-23/R-30: chegara oynaga moslashtirilsin (`max(1, round(30 * spanDays / 30))`), `startDate/endDate` barcha top-N chaqiruvlariga uzatilsin, `getTopCouriers` imzosi `getTopMarkets` bilan tenglashtirilsin.
22. R-25/R-27/R-28/R-32/R-33/R-34/R-35/R-36/R-37/R-38/R-39.

### Regressiya testlari (har bir fazadan keyin)

Invariantlar: `delivered <= accepted`, `cancelled <= accepted`, `delivered + cancelled + inProgress == accepted`, `rate ∈ [0,100] ∪ {null}`, `dashboard.profit == SUM(SELL_PROFIT ledger)` shu oyna uchun.
Ssenariylar: partly-sell (parent+child), RETURN batch qabuli, kecha tayinlanib bugun sotilgan order, HQ-only tenant (0 branch batch), rollback→resell, RMQ oyog'i tushishi.