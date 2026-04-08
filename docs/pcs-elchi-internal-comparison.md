# Elchi-Backend vs post_control_system (Ichki Solishtirish)

Sana: 2026-04-08
Taqqoslangan joylar: `post_control_system/server/src/api/*` va `Elchi-Backend/apps/api-gateway/src/*` + tegishli service/entity lar.

## 1) Dashboard

| Yo'nalish | post_control_system (PCS) | Elchi-Backend | Holat |
|---|---|---|---|
| Dashboard endpointlari | `GET /dashboard/overview`, `overview/courier`, `overview/market`, `revenue` ([dashboard.controller.ts:17](/home/dilshodbek/Desktop/post_control_system/server/src/api/dashboard/dashboard.controller.ts:17)) | Asosiy endpoint `GET /analytics/dashboard`, qo'shimcha `revenue`, `kpi`, `reports/*` ([analytics-gateway.controller.ts:30](/home/dilshodbek/Desktop/Elchi-Backend/apps/api-gateway/src/analytics-gateway.controller.ts:30)) | Farqli (Elchi qo'shimcha analytics beradi) |
| Dashboard ichki yig'ish | `DashboardService` to'g'ridan-to'g'ri `OrderService` metodlarini chaqiradi ([dashboard.service.ts:42](/home/dilshodbek/Desktop/post_control_system/server/src/api/dashboard/dashboard.service.ts:42)) | Gateway -> analytics-service -> RMQ orqali order/finance/identity ga chiqadi ([analytics-service.service.ts:287](/home/dilshodbek/Desktop/Elchi-Backend/apps/analytics-service/src/analytics-service.service.ts:287)) | Farqli (microservice chain) |
| Sana normalizatsiyasi | UZ timestamp (`toUzbekistanTimestamp`) ([dashboard.service.ts:29](/home/dilshodbek/Desktop/post_control_system/server/src/api/dashboard/dashboard.service.ts:29)) | ISO date range normalizatsiya ([analytics-service.service.ts:42](/home/dilshodbek/Desktop/Elchi-Backend/apps/analytics-service/src/analytics-service.service.ts:42)) | Farqli |
| Frontga body wrapping | `successRes({ orders, markets, ... })` ([dashboard.service.ts:51](/home/dilshodbek/Desktop/post_control_system/server/src/api/dashboard/dashboard.service.ts:51)) va `orders/markets/couriers` ichida yana `statusCode/message/data` bo'lishi mumkin | `unwrap()` bilan ichki `data` ochiladi ([analytics-service.service.ts:31](/home/dilshodbek/Desktop/Elchi-Backend/apps/analytics-service/src/analytics-service.service.ts:31), [analytics-service.service.ts:297](/home/dilshodbek/Desktop/Elchi-Backend/apps/analytics-service/src/analytics-service.service.ts:297)) | Farqli (nested wrapper PCSda ko'proq) |

### Dashboard body formatidagi eng katta farq

| Qism | PCS | Elchi |
|---|---|---|
| `orders` | Ko'pincha `data.orders.data` (ichki service `successRes` qaytargani uchun) | `data.orders` (`unwrap` qilingan) |
| `markets` | `data.markets.data` | `data.markets` |
| `couriers` | `data.couriers.data` | `data.couriers` |

## 2) Orders (eng chuqur taqqoslash)

| Yo'nalish | PCS | Elchi | Holat |
|---|---|---|---|
| Base route | `/order` ([order.controller.ts:44](/home/dilshodbek/Desktop/post_control_system/server/src/api/order/order.controller.ts:44)) | `/orders` ([order-gateway.controller.ts:52](/home/dilshodbek/Desktop/Elchi-Backend/apps/api-gateway/src/order-gateway.controller.ts:52)) | Farqli |
| List query naming | `marketId`, `regionId`, `startDate`, `endDate` ([order.controller.ts:92](/home/dilshodbek/Desktop/post_control_system/server/src/api/order/order.controller.ts:92)) | `market_id`, `region_id`, `start_day`, `end_day` ([order-gateway.controller.ts:452](/home/dilshodbek/Desktop/Elchi-Backend/apps/api-gateway/src/order-gateway.controller.ts:452)) | Farqli |
| Enriched list fallback | Yo'q | `order.find_all_enriched` -> fallback `order.find_all` ([order-gateway.controller.ts:489](/home/dilshodbek/Desktop/Elchi-Backend/apps/api-gateway/src/order-gateway.controller.ts:489)) | Elchi'da bor |
| Market yangi order endpointi | `/order/markets/new-orders`, `/order/market/my-new-orders` ([order.controller.ts:120](/home/dilshodbek/Desktop/post_control_system/server/src/api/order/order.controller.ts:120)) | `/orders/markets/new`, `/orders/markets/:marketId/new` ([order-gateway.controller.ts:593](/home/dilshodbek/Desktop/Elchi-Backend/apps/api-gateway/src/order-gateway.controller.ts:593)) | Nomlanish farqli |
| QR order read | `/order/qr-code/:token` ([order.controller.ts:186](/home/dilshodbek/Desktop/post_control_system/server/src/api/order/order.controller.ts:186)) | Bu endpoint gatewayda yo'q | PCSda bor, Elchi'da yo'q |
| External order list/create | `POST /order/receive/external` ([order.controller.ts:252](/home/dilshodbek/Desktop/post_control_system/server/src/api/order/order.controller.ts:252)) | `POST /orders/external/receive`, `GET/POST /orders/external` ([order-gateway.controller.ts:287](/home/dilshodbek/Desktop/Elchi-Backend/apps/api-gateway/src/order-gateway.controller.ts:287)) | Elchi'da kengroq |
| Duplicate check | `POST /order/check-duplicate` ([order.controller.ts:240](/home/dilshodbek/Desktop/post_control_system/server/src/api/order/order.controller.ts:240)) | Gatewayda alohida duplicate endpoint yo'q | PCSda bor, Elchi'da yo'q |
| Telegram bot orqali order create | `POST /order/telegram/bot/create` ([order.controller.ts:396](/home/dilshodbek/Desktop/post_control_system/server/src/api/order/order.controller.ts:396)) | Gatewayda yo'q | PCSda bor |
| Excel export | `GET /order/export/excel` ([order.controller.ts:415](/home/dilshodbek/Desktop/post_control_system/server/src/api/order/order.controller.ts:415)) | Gatewayda yo'q | PCSda bor |
| Legacy courier payload conversion | Yo'q | snake_case legacy shaping (`toLegacyShape`) ([order-gateway.controller.ts:67](/home/dilshodbek/Desktop/Elchi-Backend/apps/api-gateway/src/order-gateway.controller.ts:67)) | Elchi'da bor |
| Update endpoint | `PATCH /order/:id`, `PATCH /order/:id/address` ([order.controller.ts:199](/home/dilshodbek/Desktop/post_control_system/server/src/api/order/order.controller.ts:199)) | `PATCH /orders/:id`, `PATCH /orders/:id/full` ([order-gateway.controller.ts:755](/home/dilshodbek/Desktop/Elchi-Backend/apps/api-gateway/src/order-gateway.controller.ts:755)) | Farqli |

### Orders entity (model) farqlari

| Field/Constraint | PCS `OrderEntity` | Elchi `Order` | Holat |
|---|---|---|---|
| Jadval nomi | `order` ([order.entity.ts:9](/home/dilshodbek/Desktop/post_control_system/server/src/core/entity/order.entity.ts:9)) | `orders` ([order.entity.ts:11](/home/dilshodbek/Desktop/Elchi-Backend/apps/order-service/src/entities/order.entity.ts:11)) | Farqli |
| ID turi bilan bog'liq FKlar | Ko'p joy `uuid` (`user_id`, `post_id`, `customer_id`) ([order.entity.ts:25](/home/dilshodbek/Desktop/post_control_system/server/src/core/entity/order.entity.ts:25)) | Ko'p joy `bigint` (`market_id`, `post_id`, `customer_id`) ([order.entity.ts:13](/home/dilshodbek/Desktop/Elchi-Backend/apps/order-service/src/entities/order.entity.ts:13)) | Farqli |
| Qo'shimcha fieldlar | `operator_phone`, `parent_order_id`, `market_tariff`, `courier_tariff`, `deleted`, `return_requested`, `create_bot_messages` ([order.entity.ts:52](/home/dilshodbek/Desktop/post_control_system/server/src/core/entity/order.entity.ts:52)) | `source` (`internal/external`) bor, lekin yuqoridagi fieldlar yo'q ([order.entity.ts:70](/home/dilshodbek/Desktop/Elchi-Backend/apps/order-service/src/entities/order.entity.ts:70)) | PCSda bor/Elchi'da yo'q (ba'zilari) |
| Order item table | `order_item`, `productId/orderId` ([order-item.entity.ts:7](/home/dilshodbek/Desktop/post_control_system/server/src/core/entity/order-item.entity.ts:7)) | `order_items`, `product_id/order_id` ([order-item.entity.ts:5](/home/dilshodbek/Desktop/Elchi-Backend/apps/order-service/src/entities/order-item.entity.ts:5)) | Farqli |

## 3) Auth va User

| Yo'nalish | PCS | Elchi | Holat |
|---|---|---|---|
| Auth endpoint nomlari | `/user/signin`, `/user/signout` ([users.controller.ts:240](/home/dilshodbek/Desktop/post_control_system/server/src/api/users/users.controller.ts:240)) | `/auth/login`, `/auth/logout` ([auth-gateway.controller.ts:29](/home/dilshodbek/Desktop/Elchi-Backend/apps/api-gateway/src/auth-gateway.controller.ts:29)) | Farqli |
| Telegram login | `/user/telegram/signin` bor ([users.controller.ts:250](/home/dilshodbek/Desktop/post_control_system/server/src/api/users/users.controller.ts:250)) | Auth gatewayda yo'q | PCSda bor |
| JWT validate/profile | PCSda alohida `validate`, `my-profile` endpoint ko'rinmadi | `/auth/validate`, `/auth/my-profile` bor ([auth-gateway.controller.ts:57](/home/dilshodbek/Desktop/Elchi-Backend/apps/api-gateway/src/auth-gateway.controller.ts:57)) | Elchi'da bor |
| User base route | `/user/*` ([users.controller.ts:56](/home/dilshodbek/Desktop/post_control_system/server/src/api/users/users.controller.ts:56)) | Identity endpointlar gateway rootda (`/users`, `/admins`, `/markets`, ...) ([api-gateway.controller.ts:68](/home/dilshodbek/Desktop/Elchi-Backend/apps/api-gateway/src/api-gateway.controller.ts:68)) | Farqli |

## 4) Product/Katalog

| Yo'nalish | PCS | Elchi | Holat |
|---|---|---|---|
| Route | `/product` | `/product` | O'xshash |
| Create product role | PCS: `SUPERADMIN, ADMIN, REGISTRATOR, MARKET, OPERATOR` ([product.controller.ts:80](/home/dilshodbek/Desktop/post_control_system/server/src/api/product/product.controller.ts:80)) | Elchi: `MARKET, ADMIN, SUPERADMIN` ([catalog-gateway.controller.ts:58](/home/dilshodbek/Desktop/Elchi-Backend/apps/api-gateway/src/catalog-gateway.controller.ts:58)) | Farqli |
| Multipart handling | PCS local disk storage (`home/ubuntu/uploads`) ([product.controller.ts:42](/home/dilshodbek/Desktop/post_control_system/server/src/api/product/product.controller.ts:42)) | Gateway `AnyFilesInterceptor` + catalog-service RPC ([catalog-gateway.controller.ts:64](/home/dilshodbek/Desktop/Elchi-Backend/apps/api-gateway/src/catalog-gateway.controller.ts:64)) | Farqli |
| My products | `/product/my-products` ikkisida ham bor | bor ([catalog-gateway.controller.ts:145](/home/dilshodbek/Desktop/Elchi-Backend/apps/api-gateway/src/catalog-gateway.controller.ts:145)) | O'xshash |
| Technical issue | Yo'q | Fayl oxirida ortiqcha `console.log();` bor ([catalog-gateway.controller.ts:211](/home/dilshodbek/Desktop/Elchi-Backend/apps/api-gateway/src/catalog-gateway.controller.ts:211)) | Elchi'da ortiqcha kod |

## 5) Logistics/Post/Region/District

| Yo'nalish | PCS | Elchi | Holat |
|---|---|---|---|
| Post endpointlar | `/post/*` to'liq bor ([post.controller.ts:33](/home/dilshodbek/Desktop/post_control_system/server/src/api/post/post.controller.ts:33)) | `/post/*` gatewayda deyarli mos ([logistics-gateway.controller.ts:145](/home/dilshodbek/Desktop/Elchi-Backend/apps/api-gateway/src/logistics-gateway.controller.ts:145)) | Asosan o'xshash |
| Return requests | `return-requests/list`, `approve`, `reject` bor ([post.controller.ts:103](/home/dilshodbek/Desktop/post_control_system/server/src/api/post/post.controller.ts:103)) | Gateway controllerda bu endpointlar yo'q | PCSda bor |
| Reassign post | `PATCH /post/reassign/:id` bor ([post.controller.ts:166](/home/dilshodbek/Desktop/post_control_system/server/src/api/post/post.controller.ts:166)) | Gatewayda ko'rinmadi | PCSda bor |
| Region extra stats | PCSda `region/stats/*`, `region/with-logist`, `main-courier` bor ([region.controller.ts:44](/home/dilshodbek/Desktop/post_control_system/server/src/api/region/region.controller.ts:44)) | Gatewayda bu endpointlar yo'q | PCSda bor |
| District merge/courier ops | `district/merge`, `district/courier/:districtId` bor ([district.controller.ts:126](/home/dilshodbek/Desktop/post_control_system/server/src/api/district/district.controller.ts:126)) | Gatewayda yo'q | PCSda bor |

## 6) Finance/Cashbox

| Yo'nalish | PCS | Elchi | Holat |
|---|---|---|---|
| Main cashbox | `GET cashbox/main` bor | `GET finance/cashbox/main` bor ([finance-gateway.controller.ts:110](/home/dilshodbek/Desktop/Elchi-Backend/apps/api-gateway/src/finance-gateway.controller.ts:110)) | O'xshash |
| Excel export | `cashbox/main/export`, `shift/export` bor ([cash-box.controller.ts:83](/home/dilshodbek/Desktop/post_control_system/server/src/api/cash-box/cash-box.controller.ts:83)) | Gatewayda alohida export endpointlar yo'q | PCSda bor |
| Financial balance deep analytics | `financial-balanse/history`, `financial-balanse/analytics` bor ([cash-box.controller.ts:255](/home/dilshodbek/Desktop/post_control_system/server/src/api/cash-box/cash-box.controller.ts:255)) | Gatewayda faqat `financial-balanse` bor ([finance-gateway.controller.ts:188](/home/dilshodbek/Desktop/Elchi-Backend/apps/api-gateway/src/finance-gateway.controller.ts:188)) | PCSda kengroq |
| Shift route | `shift/current`, `open`, `close`, `history` ([cash-box.controller.ts:332](/home/dilshodbek/Desktop/post_control_system/server/src/api/cash-box/cash-box.controller.ts:332)) | `finance/shift` list + `open/close` ([finance-gateway.controller.ts:251](/home/dilshodbek/Desktop/Elchi-Backend/apps/api-gateway/src/finance-gateway.controller.ts:251)) | Farqli |
| Salary | `/cashbox/salary` bor | `/finance/salary` `POST/PATCH/GET` bor ([finance-gateway.controller.ts:286](/home/dilshodbek/Desktop/Elchi-Backend/apps/api-gateway/src/finance-gateway.controller.ts:286)) | Elchi'da update ham bor |

## 7) Integrations

| Yo'nalish | PCS | Elchi | Holat |
|---|---|---|---|
| Base | `/external-integration` ([external-integration.controller.ts:22](/home/dilshodbek/Desktop/post_control_system/server/src/api/external-integration/external-integration.controller.ts:22)) | `/integrations` ([integration-gateway.controller.ts:39](/home/dilshodbek/Desktop/Elchi-Backend/apps/api-gateway/src/integration-gateway.controller.ts:39)) | Nom farqi |
| Sync management | PCSda alohida `/integration-sync/*` controller bor ([integration-sync.controller.ts:21](/home/dilshodbek/Desktop/post_control_system/server/src/api/integration-sync/integration-sync.controller.ts:21)) | Elchida sync funksiyalar bitta `/integrations/:id/sync*` ichida ([integration-gateway.controller.ts:177](/home/dilshodbek/Desktop/Elchi-Backend/apps/api-gateway/src/integration-gateway.controller.ts:177)) | Farqli |
| External proxy | `POST /external-proxy/:slug/login`, `.../qrorder/find` ([external-proxy.controller.ts:26](/home/dilshodbek/Desktop/post_control_system/server/src/api/external-proxy/external-proxy.controller.ts:26)) | `/integrations/:slug/search-by-qr` va universal `/:slug/request` ([integration-gateway.controller.ts:219](/home/dilshodbek/Desktop/Elchi-Backend/apps/api-gateway/src/integration-gateway.controller.ts:219)) | Elchi'da umumlashgan |

## 8) Notifications/Bot

| Yo'nalish | PCS | Elchi | Holat |
|---|---|---|---|
| Telegram bot update class | `nestjs-telegraf` update listener bor (`@Update`, `@Start`, token capture) ([bot.update.ts:18](/home/dilshodbek/Desktop/post_control_system/server/src/api/bots/notify-bot/bot.update.ts:18)) | Gatewayda bu listener yo'q | PCSda bor |
| Telegram config CRUD | PCS bot service ichida group/token bog'lash bor ([bot.service.ts:34](/home/dilshodbek/Desktop/post_control_system/server/src/api/bots/notify-bot/bot.service.ts:34)) | Elchi `notification/notifications` controller orqali full CRUD + `connect-by-token` + `send` ([notification-gateway.controller.ts:38](/home/dilshodbek/Desktop/Elchi-Backend/apps/api-gateway/src/notification-gateway.controller.ts:38)) | Elchi'da API boshqaruvi kengroq |

## 9) PCS'da bor, Elchi'da yo'q (yiriklari)

| Modul/funksiya | Dalil |
|---|---|
| Activity log API (`/activity-log`) | [activity-log.controller.ts:11](/home/dilshodbek/Desktop/post_control_system/server/src/api/activity-log/activity-log.controller.ts:11) |
| Printer API (`/printer/print`, `/receipt`, `/thermal-pdf`) | [printer.controller.ts:21](/home/dilshodbek/Desktop/post_control_system/server/src/api/printer/printer.controller.ts:21) |
| Socket gateway (`order_update`) | [order.gateaway.ts:13](/home/dilshodbek/Desktop/post_control_system/server/src/api/socket/order.gateaway.ts:13) |
| Dashboard route nomlari (`/dashboard/*`) | [dashboard.controller.ts:13](/home/dilshodbek/Desktop/post_control_system/server/src/api/dashboard/dashboard.controller.ts:13) |
| Order QR read, duplicate check, telegram create, excel export | [order.controller.ts:186](/home/dilshodbek/Desktop/post_control_system/server/src/api/order/order.controller.ts:186) |

## 10) Elchi'da bor, PCS'da yo'q (yiriklari)

| Modul/funksiya | Dalil |
|---|---|
| Branch management (`/branches/*`) | [branch-gateway.controller.ts:41](/home/dilshodbek/Desktop/Elchi-Backend/apps/api-gateway/src/branch-gateway.controller.ts:41) |
| Investor/Invesment/Profit API (`/investors`, `/investments`, `/profits`) | [investor-gateway.controller.ts:42](/home/dilshodbek/Desktop/Elchi-Backend/apps/api-gateway/src/investor-gateway.controller.ts:42) |
| Global search API (`/search`) | [search-gateway.controller.ts:7](/home/dilshodbek/Desktop/Elchi-Backend/apps/api-gateway/src/search-gateway.controller.ts:7) |
| File service API (`/files/upload`, `/files/qr`, `/files/pdf`) | [file-gateway.controller.ts:48](/home/dilshodbek/Desktop/Elchi-Backend/apps/api-gateway/src/file-gateway.controller.ts:48) |
| KPI va reports endpointlari (`/analytics/kpi`, `/analytics/reports/*`) | [analytics-gateway.controller.ts:80](/home/dilshodbek/Desktop/Elchi-Backend/apps/api-gateway/src/analytics-gateway.controller.ts:80) |

## 11) Frontga ketadigan body bo'yicha xulosa

| Qatlam | Xulosa |
|---|---|
| Response envelope (`statusCode/message/data`) | Ikkalasida `successRes` bir xil shakl beradi ([PCS](/home/dilshodbek/Desktop/post_control_system/server/src/infrastructure/lib/response/index.ts:14), [Elchi](/home/dilshodbek/Desktop/Elchi-Backend/libs/common/helpers/response/index.ts:36)) |
| Dashboard `orders/markets/couriers` ichki shape | To'liq bir xil emas: PCSda ko'proq nested `data.*.data`, Elchida `unwrap()` sabab tekisroq |
| Orders query/body nomlari | To'liq bir xil emas (`camelCase` vs `snake_case`, route nomlar ham farq qiladi) |
| Feature parity | Core oqimlar o'xshash (create/list/sell/cancel), lekin qo'shimcha endpoint va fieldlar aniq farq qiladi |

