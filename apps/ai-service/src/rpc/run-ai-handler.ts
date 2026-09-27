import { AI_MIN_BUDGET_MS, maskPhonesForLog } from '@app/common';

/** runAiHandler faqat shu ikki metodni ishlatadi (Nest Logger ham mos). */
export interface AiHandlerLogger {
  warn(message: string): void;
  error(message: string): void;
}

/** Handler xato bersa yoki xabar eskirgan bo'lsa qaytadigan natija. */
export type AiHandlerNetworkFailure = { ok: false; reason: 'network' };

const LOG_ERROR_MAX_CHARS = 300;

function describeError(err: unknown): string {
  if (err instanceof Error) {
    const name = err.constructor?.name || err.name;
    // Xato matnida ham telefon bo'lishi mumkin (masalan JSON.parse xatosi
    // kirish bo'lagini matnga qo'shadi) — raqamlar maskalanadi.
    return maskPhonesForLog(`${name}: ${err.message}`).slice(
      0,
      LOG_ERROR_MAX_CHARS,
    );
  }
  return 'non-error throw';
}

/** Logger'ning o'zi xato bersa ham runAiHandler throw qilmasligi kerak. */
function safeLog(write: () => void): void {
  try {
    write();
  } catch {
    // log yozilmadi — natija baribir qaytadi
  }
}

/**
 * `ai.*` RMQ handler'lari uchun o'ram (Gy8Lt6KT, bVeyEuIR).
 *
 * 1) ESKIRGAN XABAR: `deadline_at` berilgan va `now > deadline_at -
 *    AI_MIN_BUDGET_MS` bo'lsa — `fn` UMUMAN chaqirilmaydi va
 *    `{ok:false, reason:'network'}` qaytadi. Xabar navbatda kutib qolgan,
 *    gateway javobni baribir kutmaydi — Anthropic'ga borish faqat pul sarflaydi.
 * 2) HECH QACHON THROW QILMAYDI: har qanday xato ERROR darajasida loglanadi
 *    (payload'SIZ — unda mijoz matni/rasmi bor) va `{ok:false,
 *    reason:'network'}` qaytadi.
 *
 * ⚠️ Nega throw yo'q: `executeAndAck` throw'da xabarni nack qiladi — oddiy
 * xato bir marta REQUEUE bo'ladi va handler Anthropic'ni YANA chaqiradi (pul
 * ikki marta yechiladi). Shuning uchun ai.* handler'lar doim ack bo'ladi.
 * `executeIdempotent` ham ATAYLAB ishlatilmaydi (AI natijasi keshlanmaydi).
 *
 * @param payload RMQ payload — faqat `deadline_at` o'qiladi (epoch ms)
 * @param fn asosiy ish; `deadlineAt` ClaudeService'ga uzatiladi
 * @param logger Nest Logger (yoki shu shakldagi obyekt)
 * @param label log uchun buyruq nomi (masalan 'ai.order.extract')
 */
export async function runAiHandler<T>(
  payload: { deadline_at?: number } | null | undefined,
  fn: (deadlineAt?: number) => Promise<T>,
  logger: AiHandlerLogger,
  label = 'ai.handler',
): Promise<T | AiHandlerNetworkFailure> {
  try {
    const raw: unknown = payload?.deadline_at;
    const deadlineAt =
      typeof raw === 'number' && Number.isFinite(raw) ? raw : undefined;

    if (
      deadlineAt !== undefined &&
      Date.now() > deadlineAt - AI_MIN_BUDGET_MS
    ) {
      safeLog(() =>
        logger.warn(
          `ai_stale_message cmd=${label} — muddat tugagan yoki ` +
            `${AI_MIN_BUDGET_MS}ms dan kam qolgan, AI chaqirilmadi`,
        ),
      );
      return { ok: false, reason: 'network' };
    }

    return await fn(deadlineAt);
  } catch (err) {
    // ⚠️ Payload LOGGA YOZILMAYDI — faqat buyruq nomi va xato turi.
    safeLog(() =>
      logger.error(`ai_handler_failed cmd=${label}: ${describeError(err)}`),
    );
    return { ok: false, reason: 'network' };
  }
}

// ───────────────────────────────────────────────────────────────────────────
// ai_queue DLQ tozalagichi (HD5zOyBp #11/#16 — rasm va xom matn SAQLANMAYDI)
// ───────────────────────────────────────────────────────────────────────────

/** amqplib'ning drain ishlatadigan qismi (paketda TS tiplari yo'q). */
export interface DlqDrainMessage {
  content: Buffer;
  properties?: { headers?: Record<string, unknown> | null } | null;
}

export interface DlqDrainChannel {
  prefetch(count: number): Promise<unknown>;
  consume(
    queue: string,
    onMessage: (msg: DlqDrainMessage | null) => void,
    options: { noAck: boolean },
  ): Promise<unknown>;
  ack(msg: DlqDrainMessage): void;
  on(event: 'error' | 'close', listener: (err?: unknown) => void): unknown;
}

export interface DlqDrainConnection {
  createChannel(): Promise<DlqDrainChannel>;
  on(event: 'error' | 'close', listener: (err?: unknown) => void): unknown;
  close(): Promise<void>;
}

export interface AiDlqDrainLogger extends AiHandlerLogger {
  log?(message: string): void;
}

export interface AiDlqDrainOptions {
  /** Yangi AMQP ulanishi (main.ts'da `amqplib.connect(RABBITMQ_URI)`). */
  connect: () => Promise<DlqDrainConnection>;
  /** Tozalanadigan navbat — `ai_queue_dlq`. */
  queue: string;
  logger: AiDlqDrainLogger;
  /** Qayta ulanish kechikishi: base * 2^(n-1), `retryMaxMs` bilan cheklangan. */
  retryBaseMs?: number;
  retryMaxMs?: number;
  /** Tashlangan xabarlar hisoboti shu oraliqda BITTA log qatoriga yig'iladi. */
  flushMs?: number;
}

export interface AiDlqDrain {
  stop(): Promise<void>;
}

/** Ack darhol bo'ladi — bir vaqtda xotirada ko'pi bilan 1 ta xabar (≤~32 MB). */
export const AI_DLQ_DRAIN_PREFETCH = 1;
const DLQ_DRAIN_RETRY_BASE_MS = 5_000;
const DLQ_DRAIN_RETRY_MAX_MS = 60_000;
const DLQ_DRAIN_FLUSH_MS = 10_000;
/** Nest RMQ paketi `{"pattern":"{\"cmd\":\"ai.…\"}","data":…}` — cmd boshida. */
const DLQ_HEAD_BYTES = 256;
const DLQ_CMD_RE = /cmd\\*"\s*:\s*\\*"([A-Za-z0-9._-]{1,64})/;
const DLQ_REASON_RE = /^[a-z_]{1,32}$/;

/**
 * DLQ xabaridan FAQAT buyruq nomi va o'lim sababini oladi.
 *
 * ⚠️ `data` (mijoz matni, telefonlar, base64 rasmlar) O'QILMAYDI va
 * LOGGA CHIQMAYDI — faqat kontentning boshidagi 256 bayt regex bilan
 * ko'riladi, natija `[A-Za-z0-9._-]` bilan cheklangan.
 */
export function describeDeadLetter(msg: DlqDrainMessage): {
  cmd: string;
  reason: string;
} {
  let cmd = 'unknown';
  try {
    const head = Buffer.isBuffer(msg.content)
      ? msg.content.subarray(0, DLQ_HEAD_BYTES).toString('utf8')
      : '';
    cmd = DLQ_CMD_RE.exec(head)?.[1] ?? 'unknown';
  } catch {
    cmd = 'unknown';
  }

  const headers = msg.properties?.headers ?? {};
  let reason: unknown = headers['x-first-death-reason'];
  if (typeof reason !== 'string') {
    const deaths = headers['x-death'];
    const first: unknown = Array.isArray(deaths) ? deaths[0] : undefined;
    reason =
      first && typeof first === 'object'
        ? (first as { reason?: unknown }).reason
        : undefined;
  }
  return {
    cmd,
    reason:
      typeof reason === 'string' && DLQ_REASON_RE.test(reason)
        ? reason
        : 'unknown',
  };
}

/**
 * `ai_queue_dlq` iste'molchisi: har xabarni DARHOL ack qilib tashlaydi.
 *
 * NEGA KERAK. `ai_queue` rmq.service.ts'da `x-message-ttl` (RMQ_RPC_TTL_MS,
 * 60 s) + DLX bilan e'lon qilinadi, DLQ esa TTL'siz durable navbat va unga
 * hech kim ulanmagan. ai-service o'chiq/qayta ishga tushayotgan paytda
 * (har deploy) yoki 8 ta prefetch slot 60 s+ band bo'lsa, `ai.order.extract`
 * xabari muddati o'tib DLQ'ga tushadi — ichida XOM mijoz matni (maskalash
 * faqat ai-service ichida) va 3 tagacha base64 rasm. Ular RabbitMQ diskida
 * MUDDATSIZ qolardi — bu "rasm saqlanmaydi" qizil chizig'ini buzadi.
 * `runAiHandler`ning eskirgan-xabar tekshiruvi bunday xabarni ko'rmaydi:
 * muddati o'tgan xabar iste'molchiga umuman yetkazilmaydi.
 *
 * QOIDALAR:
 * - Navbat argumentlari, TTL, rmq.service.ts O'ZGARTIRILMAYDI (2026-09-14
 *   PRECONDITION_FAILED hodisasi) — bu oddiy iste'molchi, navbatni e'lon
 *   qilmaydi.
 * - Qayta ishlash / requeue YO'Q (ai.* da retry yo'q) — faqat ack.
 * - Logda faqat cmd, o'lim sababi (expired/rejected) va soni; payload YO'Q.
 * - Hech qachon throw qilmaydi: ulanish uzilsa backoff bilan qayta ulanadi,
 *   servis boot'ini to'xtatmaydi.
 * - ai-service o'chiq paytda DLQ'ga tushgan xabarlar servis qaytganda
 *   tozalanadi. O'sha oraliqni ham yopish uchun ops siyosati tavsiya
 *   qilinadi: `rabbitmqctl set_policy --apply-to queues ai-dlq-drop
 *   '^ai_queue_dlq$' '{"message-ttl":0}'` (bu kod bilan to'qnashmaydi).
 */
export function startAiDlqDrain(opts: AiDlqDrainOptions): AiDlqDrain {
  const retryBaseMs = opts.retryBaseMs ?? DLQ_DRAIN_RETRY_BASE_MS;
  const retryMaxMs = opts.retryMaxMs ?? DLQ_DRAIN_RETRY_MAX_MS;
  const flushMs = opts.flushMs ?? DLQ_DRAIN_FLUSH_MS;

  let stopped = false;
  let connection: DlqDrainConnection | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let flushTimer: ReturnType<typeof setTimeout> | null = null;
  let failures = 0;
  let total = 0;
  const pending = new Map<string, number>();

  const flush = (): void => {
    if (flushTimer) clearTimeout(flushTimer);
    flushTimer = null;
    if (pending.size === 0) return;
    const parts = [...pending].map(([key, n]) => `${key}=${n}`).join(' ');
    pending.clear();
    safeLog(() =>
      opts.logger.warn(
        `ai_dlq_dropped queue=${opts.queue} ${parts} total=${total} — ` +
          `muddati o'tgan/rad etilgan AI xabarlari tashlandi (payload saqlanmaydi)`,
      ),
    );
  };

  const closeQuietly = (conn: DlqDrainConnection | null): void => {
    if (!conn) return;
    try {
      void conn.close().catch(() => undefined);
    } catch {
      // ulanish allaqachon yopilgan
    }
  };

  const scheduleRetry = (why: string): void => {
    if (stopped || retryTimer) return;
    const conn = connection;
    connection = null;
    closeQuietly(conn);
    failures += 1;
    const delay = Math.min(
      retryMaxMs,
      retryBaseMs * 2 ** Math.min(failures - 1, 10),
    );
    safeLog(() =>
      opts.logger.warn(
        `ai_dlq_drain_unavailable queue=${opts.queue} (${why}) — ` +
          `${delay}ms dan keyin qayta ulanadi`,
      ),
    );
    retryTimer = setTimeout(() => {
      retryTimer = null;
      void connectOnce();
    }, delay);
    retryTimer.unref?.();
  };

  const handleMessage = (
    channel: DlqDrainChannel,
    conn: DlqDrainConnection,
    msg: DlqDrainMessage | null,
  ): void => {
    if (msg === null) {
      // Broker iste'molchini bekor qildi (masalan navbat o'chirildi).
      if (connection === conn) scheduleRetry('consumer_cancelled');
      return;
    }
    const { cmd, reason } = describeDeadLetter(msg);
    try {
      channel.ack(msg);
    } catch {
      // Kanal yopilgan — xabar navbatda qoladi va qayta ulanganda tashlanadi.
      return;
    }
    total += 1;
    const key = `${cmd}/${reason}`;
    pending.set(key, (pending.get(key) ?? 0) + 1);
    if (!flushTimer) {
      flushTimer = setTimeout(flush, flushMs);
      flushTimer.unref?.();
    }
  };

  const connectOnce = async (): Promise<void> => {
    if (stopped) return;
    let conn: DlqDrainConnection;
    try {
      conn = await opts.connect();
    } catch (err) {
      scheduleRetry(describeError(err));
      return;
    }
    if (stopped) {
      closeQuietly(conn);
      return;
    }
    connection = conn;
    // 'error' tinglovchisi SHART: aks holda EventEmitter xatosi jarayonni
    // yiqitadi. Keyin baribir 'close' keladi — qayta ulanish o'sha yerda.
    conn.on('error', () => undefined);
    conn.on('close', () => {
      if (connection === conn) scheduleRetry('connection_closed');
    });
    try {
      const channel = await conn.createChannel();
      channel.on('error', () => undefined);
      channel.on('close', () => {
        if (connection === conn) scheduleRetry('channel_closed');
      });
      await channel.prefetch(AI_DLQ_DRAIN_PREFETCH);
      await channel.consume(
        opts.queue,
        (msg) => handleMessage(channel, conn, msg),
        { noAck: false },
      );
      failures = 0;
      safeLog(() =>
        opts.logger.log?.(`ai_dlq_drain_ready queue=${opts.queue}`),
      );
    } catch (err) {
      if (connection === conn) scheduleRetry(describeError(err));
    }
  };

  try {
    void connectOnce();
  } catch {
    // connectOnce async — sinxron throw bo'lmaydi, lekin boot baribir himoyada
  }

  return {
    stop(): Promise<void> {
      stopped = true;
      if (retryTimer) clearTimeout(retryTimer);
      retryTimer = null;
      flush();
      const conn = connection;
      connection = null;
      if (!conn) return Promise.resolve();
      try {
        return conn.close().catch(() => undefined);
      } catch {
        return Promise.resolve();
      }
    },
  };
}
