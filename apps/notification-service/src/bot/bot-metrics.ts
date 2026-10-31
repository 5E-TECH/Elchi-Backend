import { Counter, Gauge, Histogram } from 'prom-client';

/**
 * (9HIaV80X #6) Bot metrikalari. Global registry'ga EMAS — notification-service
 * `registerMetrics(app, …, BOT_METRICS)` orqali o'z `/metrics` iga ulaydi.
 *
 * Alert: `libs/common/src/metrics/alerts/telegram-bot.rules.yml` —
 * `bot_token_healthy == 0` va `bot_linked_users == 0` ("readiness ok, bot
 * o'lik" holati takrorlanmasin).
 */
export const botUpdatesTotal = new Counter({
  name: 'bot_updates_total',
  help: 'Kiruvchi Telegram update lari (type: message|callback_query|my_chat_member|dropped_*)',
  labelNames: ['bot', 'type'],
  registers: [],
});

export const botSendTotal = new Counter({
  name: 'bot_send_total',
  help: "Chiquvchi Telegram urinishlari natija bo'yicha (sent|retry|blocked|failed)",
  labelNames: ['result'],
  registers: [],
});

/**
 * (zDUUxyH2) Yakuniy dead-letter (`telegram_outbox.status='dead'`) — alohida
 * counter: `bot_send_total` URINISH natijasini sanaydi (blocked/failed), dead
 * u yerga qo'shilsa bitta xabar ikki marta sanalib nisbat buzilardi.
 */
export const botOutboxDeadTotal = new Counter({
  name: 'bot_outbox_dead_total',
  help: "telegram_outbox da yakuniy dead-letter bo'lgan xabarlar",
  registers: [],
});

export const botSendLatencyMs = new Histogram({
  name: 'bot_send_latency_ms',
  help: 'Telegram sendMessage kechikishi (ms)',
  buckets: [50, 100, 250, 500, 1000, 2500, 5000, 10000],
  registers: [],
});

export const botLinkedUsers = new Gauge({
  name: 'bot_linked_users',
  help: "Telegram'ga ulangan foydalanuvchilar rol bo'yicha",
  labelNames: ['role'],
  registers: [],
});

export const botTokenHealthy = new Gauge({
  name: 'bot_token_healthy',
  help: "Bot tokeni getMe dan o'tdimi (1) yoki yo'q (0)",
  labelNames: ['bot'],
  registers: [],
});

/**
 * (2crjWf7v — "yozildi ≠ yetadi") Shaxsiy Telegram bildirishnomalari tur va
 * holat bo'yicha: `planned` (chat ulangan, navbatga), `skipped` (ulanmagan /
 * bloklagan / shaxsiy chat emas), `sent` (Telegram qabul qildi), `failed`.
 * Kvitansiya yetkazish nisbati: `sent / planned` (`type="finance.payment_received"`)
 * — recording rule `bot:dm_delivery_ratio` (telegram-bot.rules.yml).
 */
export const botDmDeliveryTotal = new Counter({
  name: 'bot_dm_delivery_total',
  help: 'Shaxsiy Telegram bildirishnomalari (type, status: planned|skipped|no_provider|sent|failed)',
  labelNames: ['type', 'status'],
  registers: [],
});

export const BOT_METRICS = [
  botUpdatesTotal,
  botSendTotal,
  botOutboxDeadTotal,
  botSendLatencyMs,
  botLinkedUsers,
  botTokenHealthy,
  botDmDeliveryTotal,
];
