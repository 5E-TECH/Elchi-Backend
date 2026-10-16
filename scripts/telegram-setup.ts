/**
 * (uCrzrElu #5 / bOMYoOtV #6) Telegram bot sozlash: setWebhook + setMyCommands
 * + getWebhookInfo tekshiruvi. Token va sekret FAQAT env'dan.
 *
 *   TELEGRAM_BOT_TOKEN=… TELEGRAM_WEBHOOK_SECRET=… \
 *   TELEGRAM_WEBHOOK_URL=https://api.elchipochta.uz/telegram/webhook/elchi \
 *   npm run telegram:setup
 *
 * Cloudflare Tunnel 443 da TLS'ni o'zi beradi — serverda port ochish SHART
 * EMAS. Token aylantirish: BotFather → .env.production → shu skript → servis
 * restart (docs/ops/telegram-bot.md).
 */
import {
  TELEGRAM_ALLOWED_UPDATES,
  WEBHOOK_SECRET_RE,
  isUsableBotToken,
} from '../apps/notification-service/src/bot/bot-config';
import { callTelegramApi } from '../apps/notification-service/src/bot/bot-transport.service';

/** 3ZfiXuaW #5 / h9newLsd — rol reyestri bilan bir xil (qolgani inline tugma). */
export const TELEGRAM_BOT_COMMANDS: ReadonlyArray<{
  command: string;
  description: string;
}> = [
  { command: 'start', description: 'Menyu' },
  { command: 'help', description: 'Yordam' },
  { command: 'ishim', description: 'Bugungi topshiriqlar (kuryer)' },
  { command: 'kun', description: 'Kunlik hisobot (kuryer)' },
  { command: 'kassa', description: 'Kassa qoldig‘i (kuryer)' },
  { command: 'status', description: 'Buyurtma holati (market)' },
  { command: 'balans', description: 'Balans (market)' },
  { command: 'uzish', description: "Telegram'ni akkauntdan uzish" },
];

export type TelegramCall = <T>(
  method: string,
  payload?: Record<string, unknown>,
) => Promise<T>;

export interface TelegramSetupInput {
  url: string;
  secret: string;
  dropPendingUpdates?: boolean;
}

export interface TelegramSetupResult {
  webhookUrl: string;
  pendingUpdates: number;
  lastError: string | null;
}

/** Sinov qilinadigan yadro: Telegram chaqiruvlari in'ektsiya qilinadi. */
export async function runTelegramSetup(
  call: TelegramCall,
  input: TelegramSetupInput,
): Promise<TelegramSetupResult> {
  if (!/^https:\/\//.test(input.url)) {
    throw new Error(
      'TELEGRAM_WEBHOOK_URL https:// bilan boshlanishi shart (Telegram faqat 443/80/88/8443 TLS)',
    );
  }
  if (!WEBHOOK_SECRET_RE.test(input.secret)) {
    throw new Error(
      "TELEGRAM_WEBHOOK_SECRET 16–256 belgi, faqat [A-Za-z0-9_-] bo'lishi shart",
    );
  }
  await call('setWebhook', {
    url: input.url,
    secret_token: input.secret,
    allowed_updates: [...TELEGRAM_ALLOWED_UPDATES],
    drop_pending_updates: input.dropPendingUpdates ?? false,
  });
  await call('setMyCommands', { commands: TELEGRAM_BOT_COMMANDS });
  const info = await call<{
    url?: string;
    pending_update_count?: number;
    last_error_message?: string;
    allowed_updates?: string[];
  }>('getWebhookInfo', {});
  if (info?.url !== input.url) {
    throw new Error(`getWebhookInfo: url mos emas (${info?.url ?? '—'})`);
  }
  const allowed = info.allowed_updates ?? [];
  for (const type of TELEGRAM_ALLOWED_UPDATES) {
    if (!allowed.includes(type)) {
      throw new Error(`getWebhookInfo: allowed_updates da ${type} yo'q`);
    }
  }
  return {
    webhookUrl: info.url,
    pendingUpdates: Number(info.pending_update_count ?? 0),
    lastError: info.last_error_message ?? null,
  };
}

async function main(): Promise<void> {
  const token = String(process.env.TELEGRAM_BOT_TOKEN ?? '').trim();
  if (!isUsableBotToken(token)) {
    throw new Error('TELEGRAM_BOT_TOKEN berilmagan yoki placeholder');
  }
  const result = await runTelegramSetup(
    (method, payload) => callTelegramApi(token, method, payload),
    {
      url: String(process.env.TELEGRAM_WEBHOOK_URL ?? '').trim(),
      secret: String(process.env.TELEGRAM_WEBHOOK_SECRET ?? '').trim(),
      dropPendingUpdates: process.argv.includes('--drop-pending'),
    },
  );
  console.log(
    `[telegram-setup] webhook: ${result.webhookUrl}, navbatda: ${result.pendingUpdates}, oxirgi xato: ${result.lastError ?? "yo'q"}`,
  );
}

if (require.main === module) {
  main().catch((error: unknown) => {
    console.error(
      `[telegram-setup] ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  });
}
