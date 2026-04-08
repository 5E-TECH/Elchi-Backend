# Elchi vs Post Control System

| Elchi | Post Control System |
|---|---|
| 1. Dashboard: `GET /analytics/dashboard`, body ko‘proq tekis (`data.orders`) | 1. Dashboard: `GET /dashboard/overview`, body ko‘proq nested (`data.orders.data`) |
| 2. Orders route: `/orders` | 2. Orders route: `/order` |
| 3. Orders query: `market_id`, `start_day`, `end_day` | 3. Orders query: `marketId`, `startDate`, `endDate` |
| 4. Auth: `/auth/login`, `/auth/logout`, `/auth/validate` | 4. Auth: `/user/signin`, `/user/signout`, `/user/refresh`, `telegram/signin` |
| 5. Product create role: asosan `MARKET, ADMIN, SUPERADMIN` | 5. Product create role: `SUPERADMIN, ADMIN, REGISTRATOR, MARKET, OPERATOR` |
| 6. Finance: `/finance/*` | 6. Finance: `/cashbox/*` |
| 7. Integrations: `/integrations/*` (jamlangan) | 7. Integrations: `/external-integration/*` + `/integration-sync/*` |
| 8. Elchi’da bor: `branches`, `investor`, `search`, `files` | 8. PCS’da yo‘q: shu modullar bu ko‘rinishda yo‘q |
| 9. Elchi’da yo‘q: `activity-log`, `printer`, `socket order_update` | 9. PCS’da bor: yuqoridagilar mavjud |
| 10. Umumiy xulosa: asosiy oqimlar o‘xshash, lekin contract 100% bir xil emas | 10. Umumiy xulosa: tarixiy endpointlar va qo‘shimcha modullar ko‘proq |

