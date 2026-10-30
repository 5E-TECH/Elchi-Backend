# RabbitMQ: requester imzosi va servis foydalanuvchilari (gShYHHGj, P2·B)

Muammo: servis handler'lari RMQ payload'idagi `requester` ga ishonadi, hamma
servis bitta `elchi` foydalanuvchisi bilan ulanadi. RabbitMQ'ga yoza oladigan
konteyner `roles: ['superadmin']` deb yozib istalgan servisni chaqira oladi.

| Qism | Holat |
|---|---|
| Imzo kodi (`libs/common`), `off`/`log`/`enforce` | tayyor |
| Test serverda `log` (`docker-compose.staging.yml`) | tayyor, sir qo'lda (§1) |
| Serverdagi sirlar | **qo'lda** |
| Servis bo'yicha RabbitMQ foydalanuvchilari | **qo'lda**, ro'yxat §4 da |
| Prod'da `enforce` | **yoqilmagan**, avval §3 ni o'qing |

## 1. Imzo qanday ishlaydi

Da'vo kalitlari: `requester`, `requester_id`, `requester_roles`, `actor`, `user`.
`user_id`, `created_by` da'vo emas (imzo talab qilinmaydi).

| Sinf | Qaysi xabar | Imzo |
|---|---|---|
| `gateway` | HTTP foydalanuvchisi nomidan | `api-gateway` serializer'i |
| `internal` | servis→servis, outbox relay | yuboruvchi servis serializer'i (relay'da yuborish paytida) |
| `system` | da'vosiz (cron, tizim hodisasi) | talab qilinmaydi |

Sarlavha: `x-requester-sig: v1.<kind>.<iat>.<hmac>`, HMAC-SHA256
(kind + cmd + iat + butun `data` ning sha256 si). Muddat 120 s
(`RMQ_RPC_TTL_MS` = 60 s dan katta bo'lishi shart). Payload o'zgarmaydi.

| Kalit | Qiymat |
|---|---|
| `RMQ_REQUESTER_SIG_MODE` | `off` (sukut): sarlavha ham, tekshiruv ham yo'q. `log`: imzolaydi, yaroqsizini faqat ogohlantiradi. `enforce`: yaroqsizi 403, xabar DLQ'ga. |
| `RMQ_REQUESTER_SIG_SECRET` | kamida 32 belgi. Test server va prod'da HAR XIL. |

`enforce` sirsiz yoqilsa servis ishga tushmaydi. Noma'lum rejim qiymati `log`
sifatida ishlaydi.

Jurnal (bir xil cmd + sabab daqiqada bir marta):
`RMQ requester imzosi yaroqsiz: cmd=… reason=missing|malformed|bad_mac|expired|no_secret mode=…`

## 2. Yoqish tartibi

1. `.env.staging` ga `RMQ_REQUESTER_SIG_SECRET=$(openssl rand -hex 32)`, servislar
   qayta yaratiladi. Sirsiz `log` da gateway imzolamaydi va har da'voli xabar
   `reason=missing` bo'lib ko'rinadi — bu sozlanmagan server belgisi, xato emas.
2. Test serverda to'liq regressiya, keyin jurnalda `RMQ requester imzosi yaroqsiz`
   qatorlari 0 bo'lishi kerak.
3. Prod: `.env.production` ga alohida sir, `RMQ_REQUESTER_SIG_MODE=log`, kamida
   bir ish kuni kuzatish.
4. Jurnal toza bo'lsa `enforce`.

Rollback: `off` (yoki `log`), servislarni qayta yaratish; migratsiya yo'q.

Sir almashtirish: avval `log`, keyin yangi sir bilan hamma servis, keyin `enforce`.
Ikki sirni birga qabul qilish yo'q: `enforce` da almashtirilsa o'tish paytidagi
xabarlar rad etiladi.

## 3. Chegaralar (`enforce` dan oldin o'qing)

- **HMAC simmetrik.** Tekshiruvchi sirni bilishi shart, ya'ni bugungi sxemada
  (`env_file` hammaga bitta) sir har servis konteynerida turadi. `enforce` faqat
  RMQ yoziladigan, lekin sirni o'qiy olmagan kirishni to'xtatadi. `process.env` ni
  o'qiy oladigan buzilgan konteyner imzoni soxtalashtira oladi va kartadagi
  xavf shu holatda **to'liq yopilmaydi**. Yopish uchun alohida ish kerak: gateway
  imzosini assimetrik (Ed25519) qilish yoki har nishon uchun alohida kalit, va
  `internal` sinfiga cmd ro'yxati.
- **`internal` da'vosi kuchsizroq.** U "sir egasi yubordi" degani, "gateway
  tekshirdi" degani emas. Kod hozir ikkalasini bir xil qabul qiladi, sinf imzo
  ichida turadi va keyingi siyosat uchun tayyor.
- **Da'vosiz chaqiruv.** Ba'zi handler'lar requester'siz chaqiruvni tizim
  chaqiruvi deb qabul qiladi. Buzilgan konteyner da'voni tashlab yuborsa imzo
  talab qilinmaydi. Buni yopish uchun "qaysi servis qaysi cmd'ni chaqira oladi"
  ro'yxati kerak.
- **Gateway'ning o'z iste'molchisi** (`gateway_queue`, realtime) tekshirilmaydi:
  u `RmqTraceInterceptor` dan o'tmaydi va requester olmaydi.
- **DLQ'dan qayta yuborish.** Asl sarlavha bilan qaytarilgan xabar `expired`
  bo'ladi. DLQ'ni avtomatik qayta o'ynatuvchi vosita hozir yo'q.

## 4. Servis bo'yicha foydalanuvchilar (qo'lda)

Hozir hamma servis `elchi` bilan ulanadi (to'liq ruxsat). Reja: har servisga
alohida foydalanuvchi. `elchi` faqat operator va `scripts/rmq-cleanup-queues.sh`
uchun qoladi.

Shablon (`Q` — servis navbatlari):

```
configure  ^(Q)(_dlq|_dlx)?$
write      ^(amq\.default|Q_dlx|Q_dlq)$
read       ^(Q)(_dlq|_dlx)?$
```

Nega bunday:

- `configure` — `setupDlqTopology` va transport o'z navbati, DLQ va DLX ni e'lon qiladi.
- `write`: `amq.default` — hamma `sendToQueue` va RPC javoblari; `_dlq` —
  `queue.bind`; `_dlx` — `x-dead-letter-exchange` e'loni.
- `read` — o'z navbati, DLQ va `queue.bind` uchun DLX.
- `amq.rabbitmq.reply-to` uchun alohida ruxsat kerak emas.

| Foydalanuvchi | `Q` | Yuboradigan navbatlari (ma'lumot uchun) |
|---|---|---|
| `svc_gateway` | `gateway_queue\|notification_bot_queue` | ai, analytics, branch, c2c, catalog, file, finance, identity, integration, investor, logistics, notification, notification_bot, order, search |
| `svc_identity` | `identity_queue` | branch, catalog, finance, gateway, logistics, notification, order, search |
| `svc_order` | `order_queue` | ai, branch, catalog, file, finance, identity, integration, logistics, notification, search |
| `svc_finance` | `finance_queue` | file, gateway, identity, integration, notification, order |
| `svc_logistics` | `logistics_queue` | branch, catalog, identity, notification, order, search |
| `svc_catalog` | `catalog_queue` | branch, identity, logistics, search |
| `svc_branch` | `branch_queue` | file, finance, identity, logistics, order |
| `svc_notification` | `notification_queue\|notification_bot_queue` | file, gateway, identity, notification, order |
| `svc_integration` | `integration_queue` | catalog, finance, identity, logistics, notification, order |
| `svc_analytics` | `analytics_queue` | branch, finance, identity, order |
| `svc_investor` | `investor_queue` | finance |
| `svc_ai` | `ai_queue` | analytics, branch, finance, notification |
| `svc_file` | `file_queue` | faqat RPC javobi |
| `svc_c2c` | `c2c_queue` | faqat RPC javobi |
| `svc_search` | `search_queue` | faqat RPC javobi |

`svc_gateway` da `notification_bot_queue`: gateway `ensureQueue('NOTIFICATION_BOT')`
bilan navbatni publisher tomonida ham e'lon qiladi.

Misol (parol stdin orqali, faylga yozilmaydi):

```bash
rabbitmqctl add_user svc_finance
rabbitmqctl set_permissions -p / svc_finance \
  '^finance_queue(_dlq|_dlx)?$' \
  '^(amq\.default|finance_queue_dlx|finance_queue_dlq)$' \
  '^finance_queue(_dlq|_dlx)?$'
```

So'ng servisga o'z `RABBITMQ_URI` si: compose'da `environment:` bilan
(`env_file` dagi umumiy qiymat ustidan), parollar `.env.*` da. Servislar birma-bir
o'tkaziladi, `rabbitmqctl list_connections user` bilan kuzatiladi. Tayyor bo'lgach
ilovalarda `elchi` ulanishi qolmasligi kerak. Rollback: `RABBITMQ_URI` ni qaytarish.

⚠️ **Foydalanuvchilar yuborishni cheklamaydi.** Kod `sendToQueue` ishlatadi, ya'ni
default exchange'ga yozadi, RabbitMQ esa `write` ni exchange bo'yicha tekshiradi.
`amq.default` ga ruxsat bor foydalanuvchi ISTALGAN navbatga yoza oladi. Ajratish
o'qishni (boshqa navbatni tinglash) va `configure` ni (navbatni o'chirish,
qayta e'lon qilish) yopadi, yuborish uchun himoya — imzo. Yuborishni ham cheklash
uchun nomli exchange'larga ko'chish kerak, bu alohida ish.

### Tekshirilgan (2026-10-30)

Lokal `rabbitmq:3.13-management-alpine`, `svc_finance` shablon bo'yicha, haqiqiy
Nest servis va `ClientRMQ`, `enforce`:

- servis ishga tushdi (DLQ topologiyasi, iste'molchi, reply-to);
- imzolangan xabar va da'vosiz xabar o'tdi;
- imzosiz superadmin: handler ishlamadi, javob 403, xabar `finance_queue_dlq` da;
- `order_queue`: consume, declare, delete — `ACCESS_REFUSED`;
- `order_queue` ga `sendToQueue` — **o'tdi** (yuqoridagi ogohlantirish).

Qolgan foydalanuvchilar shu shablon asosida kodda (`RmqModule.register`,
`getOptions`, `ensureQueue`) yozilgan, broker'da alohida sinalmagan. Test serverda
birinchi navbatda sinab ko'ring.
