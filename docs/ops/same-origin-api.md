# Bir domenli API (same-origin) — deploy va orqaga qaytish

> **Holat (2026-11-21):** **staging** (`test-admin.elchipochta.uz`) — ishlayapti, brauzerda kirib tekshirilgan
> (§5). **Production** (`admin.elchipochta.uz`) — Elchi-Frontend #400 (sozlama), merge'dan oldin egasi §7.1 ni
> bajaradi.
>
> PR'lar: Elchi-Frontend #396 (Worker, staging), #400 (production); Elchi-Backend #750.

## 1. Nega

Kabinet API'ga boshqa domendan `Authorization` bilan murojaat qiladi → brauzer **har yangi URL** uchun CORS
preflight (`OPTIONS`) yuboradi: har qidiruv, sahifa, buyurtma ID — 2 ta borib-kelish. O'lchov (2026-11-20,
O'zbekistondan): bo'sh so'rov ~390 ms median (ba'zan 1–2 s), BeePost (bir domen, preflight yo'q) ~200 ms.
Bundan tashqari Cloudflare/tunnel xato sahifalari (502, 530/1033) CORS sarlavhasisiz keladi va JS'da
«Network Error» («Internet aloqasi yo'q») bo'lib ko'rinadi.

## 2. Qanday ishlaydi

```
brauzer ──► test-admin.elchipochta.uz ──┬─ /api/*        ─► Worker ─► https://test-api.elchipochta.uz/*  (prefiks olinadi)
                                        ├─ /socket.io/*  ─► Worker ─► https://test-api.elchipochta.uz/socket.io/*
                                        └─ qolgan hammasi ─► statik fayllar (SPA), Worker chaqirilmaydi
```

Elchi-Frontend `wrangler.jsonc` → `env.staging`: `main: worker/index.ts`, `assets.run_worker_first:
["/api/*", "/socket.io/*"]`, `vars.API_ORIGIN`. Birga o'zgaradigan to'rt narsa:

| # | Narsa | Qayerda hal qilingan |
|---|---|---|
| 1 | Refresh cookie (`Path=/auth`, host-only, `SameSite=Lax`) | Worker `Set-Cookie` ni qayta yozadi: `Path=/auth` → `/api/auth`, `Domain` olinadi (nginx `proxy_cookie_path` kabi). Backend o'zgarmaydi (`refresh-cookie.ts` izohi) — to'g'ridan-to'g'ri API mijozlari ham avvalgidek. **Cutover'da har foydalanuvchi bir marta qayta kiradi** (eski cookie `test-api` hostida, `/api/auth` ga yuborilmaydi). |
| 2 | Mijoz IP'si (`CF-Connecting-IP` — rate-limit, audit) | Bir zonadagi Worker subrequest'ida Cloudflare `CF-Connecting-IP` ni Worker qo'ygan `x-real-ip` dan oladi. Worker ikkalasini ham kiruvchi so'rovning Cloudflare yozgan `CF-Connecting-IP` iga **majburan** tenglaydi (mijozning soxta `X-Real-IP` si o'tmaydi). `API_ORIGIN` **boshqa** zonada bo'lsa Cloudflare hammaga `2a06:98c0:3600::103` yozadi → hamma bitta login chegarasida (10/daq). Backend buni aniqlab `ClientIp` ogohlantirishini yozadi (5 daqiqada bir marta; `client-ip-throttler.guard.ts`). |
| 3 | socket.io (`/realtime`) | Frontend `realtimeUrl` o'zgarmadi: nisbiy `BASE_URL` da kabinet origin'i + `/realtime`, yo'l `/socket.io/` — Worker proksi qiladi (WebSocket 101 ham). Backend `CORS_ORIGINS` da `https://test-admin.elchipochta.uz` bor (Origin tekshiruvi o'sha). |
| 4 | `VITE_BASE_URL` va CSP | `.env.<muhit>`: `VITE_BASE_URL=/api/`, `VITE_PUBLIC_API_URL=<API hosti>` (Carrier API havolalari API hostida qoladi). CSP `connect-src` da kabinetning o'z `wss://` hosti (`public/_headers` — `admin`, staging build — `test-admin`); `npm run check:target -- <muhit>` Worker sozlamasi bilan mosligini tekshiradi (Worker'siz bir domenli build chiqmaydi). |

Qo'shimcha: API yetib bo'lmasa yoki Cloudflare HTML 5xx qaytarsa, Worker o'sha status bilan JSON beradi
(`code: "UPSTREAM_UNAVAILABLE"`) — ilova «Internet aloqasi yo'q» emas, server xatosini ko'radi.

## 3. Oldindan (bir marta)

1. `test-api.elchipochta.uz` — kabinet bilan **bir Cloudflare zonasida** (`elchipochta.uz`) va unga Worker
   marshruti biriktirilmagan (aks holda halqa). Cloudflare Access bilan yopilmagan bo'lsin (Worker subrequest'i
   Access tokenisiz o'tolmaydi; `test-admin` ni Access bilan yopish mumkin — cookie bir domenda).
2. Backend `.env.staging`: `CORS_ORIGINS` da `https://test-admin.elchipochta.uz` (bor — `staging.md` §4).
   Backend env'ida boshqa o'zgarish yo'q.
3. Zonada IP bo'yicha Cloudflare **Rate limiting rules** bo'lsa: bir zonadagi Worker subrequest'lari alohida
   so'rov sifatida qayta sanalishi mumkin. Qoidaga qo'shing:
   `and (cf.worker.upstream_zone == "" or cf.worker.upstream_zone != "elchipochta.uz")`.
4. Workers tarifi: `/api/*` dagi har so'rov — Worker chaqiruvi (statik fayllar — yo'q). Free: kuniga 100 000
   so'rov, 10 ms CPU (proksiga yetadi). Staging uchun yetarli; production uchun §7.1.

## 4. Staging deploy

Tartib muhim emas: backend o'zgarishi faqat ogohlantirish logi, frontend backend'ga bog'liq emas.

1. **Backend:** `feat/same-origin-api-staging` → PR → `dev` → `test` → «deploy-staging» (`staging.md` §6.2).
2. **Frontend:** `feat/same-origin-api-staging` → PR → `dev` → `test` → CI (`STAGING_ENABLED=true`):
   `npm run build:staging` → `npm run check:target -- staging` → `npx wrangler deploy --env staging`.
   Qo'lda (Node 22): o'sha uch buyruq Elchi-Frontend ildizida.
3. Lokal sinov (deploy'siz, Node 22): `npm run build:staging && npx wrangler dev --env staging --port 8799`
   → `http://127.0.0.1:8799/api/health`. 2026-11-20 da shunday tekshirilgan: GET/POST, socket.io polling va
   WebSocket test-api'gacha yetdi, API yetib bo'lmaganda 502 JSON. **Mijoz IP'si va cookie faqat haqiqiy
   deploy'da tekshiriladi** (lokal Worker oldida Cloudflare yo'q).

## 5. Staging'da tekshirish (deploy'dan keyin)

| Tekshiruv | Kutilgan |
|---|---|
| DevTools → Network, qidiruv / sahifalash | So'rovlar `test-admin.elchipochta.uz/api/...`, **`OPTIONS` yo'q** |
| Kirish → `POST /api/auth/login` javobi | `Set-Cookie: refreshToken=…; Path=/api/auth; HttpOnly; Secure; SameSite=Lax` |
| Application → Cookies | `refreshToken` — host `test-admin.elchipochta.uz`, path `/api/auth` |
| Sahifani yangilash (F5) | `POST /api/auth/refresh` 201, qayta kirish so'ralmaydi |
| Chiqish | `refreshToken` o'chiriladi (o'sha path bilan) |
| Profil → Sessiyalar (joriy qurilma IP) | Sizning ommaviy IP'ingiz (`https://www.cloudflare.com/cdn-cgi/trace` → `ip=`), `2a06:98c0:3600::103` emas |
| `$DC logs api-gateway \| grep ClientIp` | Bo'sh (ogohlantirish yo'q) |
| DevTools → WS | `wss://test-admin.elchipochta.uz/socket.io/?EIO=4&transport=websocket` — 101; bildirishnoma keladi |
| Konsol (CSP Report-Only) | `connect-src` buzilishi yo'q |
| Integratsiyalar → Carrier API akkaunti | «Base URL» — `https://test-api.elchipochta.uz` |
| Telegram Mini App (test bot, `/tg/scan`) | Skan ishlaydi (`/api/tg/*` — Worker orqali; cookie ishlatmaydi) |
| (ixtiyoriy) gateway'ni qisqa to'xtatish | `curl -s https://test-admin.elchipochta.uz/api/health` → JSON, `code: "UPSTREAM_UNAVAILABLE"` (502/530); ilovada server xatosi, «Internet aloqasi yo'q» emas |

**2026-11-21 natijasi (staging, egasi kirgan brauzerda):** login `POST /api/auth/login` 201; yangi tabda
(`sessionStorage` bo'sh) `POST /api/auth/refresh` 201 — cookie `/api/auth` ga yetadi; barcha so'rovlar bir
domenda, `test-api` ga to'g'ridan-to'g'ri so'rov yo'q; Sessiyalar'dagi «Shu qurilma» IP = Cloudflare
`/cdn-cgi/trace` dagi `ip=`; brauzerdan `wss://test-admin…/socket.io/` ochiladi; `connect-src` buzilishi yo'q.
Cloudflare Web Analytics beacon'i Report-Only `script-src` ga to'g'ri kelmaydi — bu production'da ham bor, bu ishga
bog'liq emas (CSP majburiy qilinganda hal qilinadi).

## 6. Orqaga qaytish

Backend'da qaytariladigan narsa yo'q (faqat ogohlantirish logi; cookie / env o'zgarmagan).

1. **Eng tez (bir necha daqiqa):** oldingi Worker versiyasi (statik fayllar, sozlama va `vars` bilan birga):
   Cloudflare → Workers & Pages → `elchi-frontend-test` → Deployments → oldingi versiya → Rollback.
   Yoki: `npx wrangler deployments list --env staging` → `npx wrangler rollback <version-id> --env staging`.
2. **Kod bilan:** `test` da frontend commit'ini `git revert` → CI qayta deploy qiladi. Yoki faqat rejimni
   o'chirish: `.env.staging` → `VITE_BASE_URL=https://test-api.elchipochta.uz/` (skriptlar ikkala rejimni
   qo'llaydi), `wrangler.jsonc` `env.staging` dan `main`, `binding`, `run_worker_first`, `vars` ni olib tashlash
   (testlar shu holatga mos yangilanadi).
3. Natija: so'rovlar yana `test-api.elchipochta.uz` ga (CORS). Foydalanuvchilar yana bir marta qayta kirishi
   mumkin (`/api/auth` dagi cookie endi ishlatilmaydi). Ochiq socketlar qayta ulanadi.

## 7. Production

Kod tomoni Elchi-Frontend #400 da: `wrangler.jsonc` yuqori darajasi (`main`, `assets.binding`,
`run_worker_first`, `vars.API_ORIGIN=https://api.elchipochta.uz`), `.env.production` (`VITE_BASE_URL=/api/`,
`VITE_PUBLIC_API_URL`), `public/_headers` (`wss://admin.elchipochta.uz`). `check:target production` Worker
sharti bajarilmasa deploy'ni to'xtatadi. Backend o'zgarishi shart emas (`CORS_ORIGINS` da
`https://admin.elchipochta.uz` bor).

### 7.1 Merge'dan OLDIN — faqat egasi (Cloudflare dashboard)

1. **Workers tarifi.** Har `/api/*` so'rovi — Worker chaqiruvi. Workers Free: kuniga 100 000 (UTC yarim tunda
   yangilanadi); oshsa kabinet API'si `1027` xatosi bilan to'xtaydi. Cloudflare → `api.elchipochta.uz` →
   Analytics → kunlik so'rovlar (hozirgi hisobda `OPTIONS` ham bor; keyin ular yo'qoladi). Yaqin bo'lsa —
   Workers Paid ($5/oy). Staging Worker ham shu akkaunt limitidan oladi.
2. **Rate limiting rules** (Security → WAF): IP bo'yicha qoida bo'lsa — §3.3 dagi `cf.worker.upstream_zone`
   shartini qo'shing.
3. **Vaqt va ogohlantirish:** deploy'dan keyin har foydalanuvchi bir marta qayta kiradi (eski refresh cookie
   `api.elchipochta.uz` hostida). Kam yuklama payti; kuryer va marketlarni oldindan ogohlantiring.

### 7.2 Deploy

`dev` (#400 merge) → `test` (staging deploy; frontend `main` darvozasi aynan shu tree'ning «Deploy (staging)»
natijasini talab qiladi) → `main` → production deploy (`check:target production` → `wrangler deploy`). Tavsiya:
backend #750 (`ClientIp` ogohlantirishi) ham shu payt yoki oldinroq backend `main` ga chiqsin.

### 7.3 Deploy'dan keyin (`admin.elchipochta.uz`)

§5 jadvali (`test-admin` → `admin`, `test-api` → `api`), ayniqsa: `/api/*` so'rovlari va `OPTIONS` yo'qligi,
yangi tabda refresh 201, Sessiyalar'dagi IP, WebSocket, Carrier «Base URL» = `https://api.elchipochta.uz`,
Telegram Mini App (`/tg/scan`), `$DC logs api-gateway | grep ClientIp` bo'sh. Bir kun Workers → `elchi-frontend`
→ Metrics: so'rovlar soni va xatolar.

### 7.4 Orqaga qaytish

Cloudflare → Workers & Pages → `elchi-frontend` → Deployments → oldingi versiya → Rollback (yoki
`npx wrangler deployments list` → `npx wrangler rollback <version-id>`). Ilova yana `api.elchipochta.uz` ga
to'g'ridan-to'g'ri (CORS) murojaat qiladi; foydalanuvchilar yana bir marta qayta kirishi mumkin. Kod bilan —
`main` da #400 ni `git revert`.

`api.elchipochta.uz` hech qachon o'chirilmaydi: Carrier / hamkor API, webhook'lar, Telegram bot, mobil mijozlar.

## 8. Ma'lum cheklovlar

- Worker yangi deploy'ida ochiq WebSocket'lar ≤ 20 daqiqada uziladi — socket.io o'zi qayta ulanadi.
- Lokal `npm run dev` o'zgarmagan (`.env.development` — absolyut API). `wrangler` Node 22 talab qiladi.
- Javob siqilgan (`br`) holda o'tadi; brauzerlar qo'llaydi.
