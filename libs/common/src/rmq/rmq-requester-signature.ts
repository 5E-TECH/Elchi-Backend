import { Logger } from '@nestjs/common';
import { RpcException } from '@nestjs/microservices';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

/**
 * REQUESTER KONTEKSTI IMZOSI (gShYHHGj, P2·B).
 *
 * Muammo: servis handler'lari RMQ payload'idagi `requester` ga ishonadi —
 * RabbitMQ'ga yoza oladigan har qanday konteyner `roles: ['superadmin']` deb
 * yozib servisni chaqira oladi.
 *
 * Yechim: requester da'vosi bor HAR chiquvchi xabar `x-requester-sig` AMQP
 * sarlavhasi bilan imzolanadi (`RequestContextRmqSerializer`, ya'ni barcha
 * klientlar uchun bitta nuqta), qabul tomonida `RmqTraceInterceptor` tekshiradi
 * (hamma servisda global, `executeAndAck` ni ishlatmaydigan handler'lar ham
 * qamrab olinadi). Handler'lar va payload shakli O'ZGARMAYDI.
 *
 * Imzo: `v1.<kind>.<iat>.<hex>` = HMAC-SHA256(kind, cmd, iat, sha256(data)).
 * `cmd` ga bog'langan — boshqa buyruqqa ko'chirib bo'lmaydi; butun `data` ga
 * bog'langan — requester ham, pul summasi ham almashtirilsa imzo yiqiladi;
 * `iat` — eskirgan imzo qabul qilinmaydi.
 *
 * Xabar sinflari (qabul tomonida aniq ajratiladi):
 *   gateway  — HTTP foydalanuvchisi nomidan, gateway imzolagan;
 *   internal — servis→servis va outbox relay: da'vo bo'lsa serializer o'zi
 *              imzolaydi, relay'da imzo YUBORISH paytida qo'yiladi (`enqueue`
 *              paytida emas), shuning uchun kechikkan hodisa eskirmaydi;
 *   system   — da'vosiz (cron, tizim hodisasi): imzo talab qilinmaydi.
 *
 * ⚠️ CHEGARA: HMAC simmetrik. Sir hamma servis konteynerida turgani uchun u
 * sirni O'QIY OLGAN buzilgan konteynerni to'xtatmaydi (`docs/ops/rmq-service-users.md`).
 */

export const RMQ_REQUESTER_SIG_HEADER = 'x-requester-sig';

/**
 * Imzoning yashash muddati. ⚠️ `RMQ_RPC_TTL_MS` (navbatda kutish, 60 s) dan
 * KATTA bo'lishi shart: aks holda band navbatda turib qolgan, lekin hali
 * yaroqli xabar `enforce` da rad etiladi.
 */
export const RMQ_REQUESTER_SIG_TTL_MS = 120_000;
/** Konteynerlar soati farqi uchun: `iat` kelajakda shuncha ms gacha qabul qilinadi. */
export const RMQ_REQUESTER_SIG_SKEW_MS = 30_000;

const SIG_VERSION = 'v1';
const MIN_SECRET_LENGTH = 32;
const WARN_WINDOW_MS = 60_000;

/**
 * Identifikatsiya da'vosi bo'lgan yuqori daraja kalitlari — gateway shularni
 * yuboradi (`requester`; moliya: `requester_id`/`requester_roles`/`user`;
 * ombor: `actor`). Yuboruvchi ham, qabul qiluvchi ham shu BITTA ro'yxatga
 * qaraydi — ular ajralib keta olmaydi.
 */
const REQUESTER_CLAIM_KEYS = [
  'requester',
  'requester_id',
  'requester_roles',
  'actor',
  'user',
] as const;

export type RmqRequesterSigMode = 'off' | 'log' | 'enforce';
export type RmqSignerKind = 'gateway' | 'internal';
export type RmqRequesterSource = RmqSignerKind | 'system';
export type RmqRequesterViolation =
  'missing' | 'malformed' | 'bad_mac' | 'expired' | 'no_secret';

export type RmqRequesterVerdict =
  | { ok: true; source: RmqRequesterSource }
  | { ok: false; reason: RmqRequesterViolation };

const logger = new Logger('RmqRequesterSignature');

let signerKind: RmqSignerKind = 'internal';
let unknownModeWarned = false;
const warnWindows = new Map<string, { until: number; suppressed: number }>();

/**
 * `RMQ_REQUESTER_SIG_MODE`: `off` (sukut, xulq o'zgarmaydi) | `log` | `enforce`.
 * Noma'lum qiymat (`enforced` xatosi) — `log`: trafikni buzmaydi va jim
 * o'chiq ham qolmaydi.
 */
export function rmqRequesterSigMode(): RmqRequesterSigMode {
  const raw = String(process.env.RMQ_REQUESTER_SIG_MODE ?? '')
    .trim()
    .toLowerCase();
  if (raw === '' || raw === 'off') return 'off';
  if (raw === 'log' || raw === 'enforce') return raw;
  if (!unknownModeWarned) {
    unknownModeWarned = true;
    logger.warn(
      `RMQ_REQUESTER_SIG_MODE noma'lum qiymat ('${raw}') — log rejimida ishlaydi`,
    );
  }
  return 'log';
}

function rmqRequesterSecret(): string | undefined {
  const secret = process.env.RMQ_REQUESTER_SIG_SECRET?.trim();
  return secret && secret.length >= MIN_SECRET_LENGTH ? secret : undefined;
}

/**
 * `enforce` sirsiz yoqilsa servis YIQILADI: aks holda u jimgina hamma
 * foydalanuvchi so'rovini rad etardi. Deploy healthcheck'i shuni ushlaydi.
 */
export function assertRmqRequesterSigConfig(): void {
  if (rmqRequesterSigMode() === 'enforce' && !rmqRequesterSecret()) {
    throw new Error(
      `RMQ_REQUESTER_SIG_MODE=enforce, lekin RMQ_REQUESTER_SIG_SECRET yo'q yoki ${MIN_SECRET_LENGTH} belgidan qisqa`,
    );
  }
}

/** Gateway bootstrap'ida `'gateway'` qo'yiladi; qolgan jarayonlar — `internal`. */
export function setRmqSignerKind(kind: RmqSignerKind): void {
  signerKind = kind;
  assertRmqRequesterSigConfig();
}

/** `{cmd}` obyekti, uning JSON satri (`RmqContext.getPattern()`) yoki oddiy satr → cmd. */
export function rmqCmdOf(pattern: unknown): string {
  if (pattern && typeof pattern === 'object') {
    const cmd = (pattern as { cmd?: unknown }).cmd;
    return typeof cmd === 'string' ? cmd : JSON.stringify(pattern);
  }
  if (typeof pattern !== 'string') return '';
  if (!pattern.startsWith('{')) return pattern;
  try {
    return rmqCmdOf(JSON.parse(pattern));
  } catch {
    return pattern;
  }
}

/** Payload'da requester da'vosi bormi (`null`/bo'sh qiymat da'vo emas). */
export function hasRequesterClaim(data: unknown): boolean {
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    return false;
  }
  const record = data as Record<string, unknown>;
  return REQUESTER_CLAIM_KEYS.some((key) => {
    const value = record[key];
    return value !== null && value !== undefined && value !== '';
  });
}

/**
 * `JSON.stringify` — transport xabarni aynan shu bilan yozadi, qabul tomoni
 * esa uni parse qiladi, ya'ni ikki tomonda satr bir xil (kalit tartibi saqlanadi,
 * `undefined`/`Date` birinchi serializatsiyada normallashadi).
 */
function computeMac(
  secret: string,
  kind: RmqSignerKind,
  cmd: string,
  iat: number,
  data: unknown,
): string {
  const body = createHash('sha256')
    .update(JSON.stringify(data) ?? '')
    .digest('hex');
  return createHmac('sha256', secret)
    .update([SIG_VERSION, kind, cmd, iat, body].join('\n'))
    .digest('hex');
}

export function signRmqRequester(input: {
  cmd: string;
  data: unknown;
  secret: string;
  kind: RmqSignerKind;
  now?: number;
}): string {
  const iat = input.now ?? Date.now();
  const mac = computeMac(input.secret, input.kind, input.cmd, iat, input.data);
  return [SIG_VERSION, input.kind, iat, mac].join('.');
}

/** Sof tekshiruv: xabar qaysi sinfga tegishli yoki nega yaroqsiz. */
export function verifyRmqRequester(input: {
  cmd: string;
  data: unknown;
  header: string | undefined;
  secret: string | undefined;
  now?: number;
}): RmqRequesterVerdict {
  const { cmd, data, header, secret } = input;
  if (!header) {
    return hasRequesterClaim(data)
      ? { ok: false, reason: 'missing' }
      : { ok: true, source: 'system' };
  }
  if (!secret) return { ok: false, reason: 'no_secret' };

  const [version, kind, iatRaw, given, ...rest] = header.split('.');
  const iat = Number(iatRaw);
  if (
    version !== SIG_VERSION ||
    (kind !== 'gateway' && kind !== 'internal') ||
    !Number.isSafeInteger(iat) ||
    !given ||
    rest.length > 0
  ) {
    return { ok: false, reason: 'malformed' };
  }

  const expected = Buffer.from(computeMac(secret, kind, cmd, iat, data), 'hex');
  const actual = Buffer.from(given, 'hex');
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    return { ok: false, reason: 'bad_mac' };
  }

  const age = (input.now ?? Date.now()) - iat;
  if (age > RMQ_REQUESTER_SIG_TTL_MS || age < -RMQ_REQUESTER_SIG_SKEW_MS) {
    return { ok: false, reason: 'expired' };
  }
  return { ok: true, source: kind };
}

/** Chiquvchi xabar sarlavhasi (serializer). `off`/sirsiz/da'vosiz → `{}`. */
export function buildRmqRequesterSigHeaders(
  pattern: unknown,
  data: unknown,
): Record<string, string> {
  if (rmqRequesterSigMode() === 'off' || !hasRequesterClaim(data)) return {};
  const secret = rmqRequesterSecret();
  if (!secret) return {};
  return {
    [RMQ_REQUESTER_SIG_HEADER]: signRmqRequester({
      cmd: rmqCmdOf(pattern),
      data,
      secret,
      kind: signerKind,
    }),
  };
}

/** Bir xil (cmd, sabab) daqiqada bir marta — buzuq oqim jurnalni to'ldirmasin. */
function warnViolation(
  mode: RmqRequesterSigMode,
  cmd: string,
  reason: RmqRequesterViolation,
): void {
  const key = `${cmd}|${reason}`;
  const now = Date.now();
  const window = warnWindows.get(key);
  if (window && now < window.until) {
    window.suppressed += 1;
    return;
  }
  const suppressed = window?.suppressed ?? 0;
  warnWindows.set(key, { until: now + WARN_WINDOW_MS, suppressed: 0 });
  logger.warn(
    `RMQ requester imzosi yaroqsiz: cmd=${cmd} reason=${reason} mode=${mode}` +
      (suppressed > 0 ? ` (+${suppressed} takror)` : ''),
  );
}

interface RmqRequesterRpcContext {
  getPattern?: () => unknown;
  getChannelRef?: () => {
    nack: (message: unknown, allUpTo: boolean, requeue: boolean) => void;
  };
  getMessage?: () => unknown;
}

/**
 * Qabul tomonidagi markaziy tekshiruv. `null` — handler ishlaydi. `enforce` da
 * buzilgan xabar DLQ'ga tushadi (dalil sifatida; `requeue: false`) va
 * chaqiruvchiga 403 qaytariladi. Handler ishga tushmagani uchun xabarni shu
 * yerda nack qilish SHART — aks holda u unacked qolib prefetch'ni band qiladi.
 */
export function checkRmqRequester(
  rpcContext: unknown,
  data: unknown,
  header: string | undefined,
): RpcException | null {
  const mode = rmqRequesterSigMode();
  if (mode === 'off') return null;

  const rpc = (rpcContext ?? {}) as RmqRequesterRpcContext;
  const cmd = rmqCmdOf(rpc.getPattern?.());
  const verdict = verifyRmqRequester({
    cmd,
    data,
    header,
    secret: rmqRequesterSecret(),
  });
  if (verdict.ok) return null;

  warnViolation(mode, cmd, verdict.reason);
  if (mode !== 'enforce') return null;

  rpc.getChannelRef?.().nack(rpc.getMessage?.(), false, false);
  return new RpcException({
    statusCode: 403,
    message: "So'rov imzosi yaroqsiz",
  });
}

/** Faqat testlar uchun: jarayon holatini tiklaydi. */
export function resetRmqRequesterSigStateForTests(): void {
  signerKind = 'internal';
  unknownModeWarned = false;
  warnWindows.clear();
}
