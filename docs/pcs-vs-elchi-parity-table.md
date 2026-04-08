# Elchi vs PCS (Sodda Taqqoslash)

Sana: 2026-04-08
Maqsad: ichki logika va frontga ketadigan body bir xilmi, aniq ko'rsatish.

## A) Modul bo'yicha asosiy jadval

| Modul | Elchi (microservice) | PCS (monolit) | Holat |
|---|---|---|---|
| Dashboard | `/analytics/dashboard` | `/dashboard/overview` + role endpointlar | Farqli (nom + body shakli) |
| Orders | `/orders` (snake_case query ko'p) | `/order` (camelCase query ko'p) | Farqli |
| Auth | `/auth/login`, `/logout`, `/validate` | `/user/signin`, `/signout`, `telegram/signin` | Farqli |
| Users | Gateway root endpointlar (`/users`, `/admins`, `/markets`) | `/user/*` ichida jamlangan | Farqli |
| Product | Bor, lekin role va create flow boshqacha | Bor, role to'plami kengroq | Qisman mos |
| Post / Logistics | `/post/*`, `/region/*`, `/district/*` bor | `/post/*`, `/region/*`, `/district/*` bor | Qisman mos |
| Finance / Cashbox | `/finance/*` | `/cashbox/*` | Farqli |
| Integrations | `/integrations/*` ichida jamlangan | `/external-integration/*` + `/integration-sync/*` | Farqli |
| Notification / Bot | API boshqaruv kuchli (`/notification*`) | Bot listener (telegraf) oqimi kuchli | Farqli |
| File service | `/files/upload`, `/files/qr`, `/files/pdf` bor | Shu ko'rinishda yo'q | Elchi'da bor |
| Search | `/search` bor | Shu ko'rinishda yo'q | Elchi'da bor |
| Branch | `/branches/*` bor | Yo'q | Elchi'da bor |
| Investor | `/investors`, `/investments`, `/profits` bor | Yo'q | Elchi'da bor |
| Activity log | Yo'q | `/activity-log` bor | PCSda bor |
| Printer | Yo'q | `/printer/*` bor | PCSda bor |
| Socket order_update | Yo'q | Bor | PCSda bor |

## B) Frontga ketadigan body (eng muhim)

| Qism | Elchi | PCS | Holat |
|---|---|---|---|
| Umumiy envelope | `statusCode`, `message`, `data` | `statusCode`, `message`, `data` | Mos |
| Dashboard `orders` | Odatda `data.orders` | Ko'p joyda `data.orders.data` | Farqli |
| Dashboard `markets` | Odatda `data.markets` | Ko'p joyda `data.markets.data` | Farqli |
| Dashboard `couriers` | Odatda `data.couriers` | Ko'p joyda `data.couriers.data` | Farqli |
| Orders list query | `market_id`, `start_day`, `end_day` | `marketId`, `startDate`, `endDate` | Farqli |
| Orders qo'shimcha endpointlar | Ba'zilari yo'q | `check-duplicate`, `qr-code`, `export/excel` bor | Farqli |

## C) Qisqa xulosa

| Savol | Javob |
|---|---|
| 2 loyiha 100% bir xilmi? | Yo'q, 100% bir xil emas. |
| Qayeri eng katta farq? | Dashboard body nested/unnested va Orders endpoint/query contractlarida. |
| Nima qilish kerak? | Contract alignment: endpoint nomi, query nomi, va dashboard body shape ni bir xil qilish. |

