import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpStatus,
} from '@nestjs/common';
import type { Response } from 'express';
import { STATUS_CODES } from 'http';
import { AllExceptionsFilter } from '@app/common';
import { toCarrierOrderView } from './carrier-order-view';

/**
 * CARRIER API — OLCHA USLUBI (ega 2026-11-27: «Carrier integratsiyasi
 * endpointlarini https://api.olchamarket.uz/swagger dagi endpointlar bilan
 * bir xil qilish kerak, faqat Elchinikini»).
 *
 * Olcha'ning yetkazuvchiga tegishli qismi ikki endpoint:
 *   POST /auth/token     {username, password} → {access_token, token_type, expires_in}
 *   POST /qrorder/find   {qr_code} (Bearer)   → {success, msg, data: {...}}
 * Elchi'da ular `/carrier/` ostida: `{BASE_URL}/carrier` ni baza manzili qilib
 * olgan mijoz uchun yo'l, metod, maydon nomlari va javob shakli AYNAN Olcha'niki.
 * Olcha (Yii2) xato shakllari ham takrorlanadi — `CarrierOlchaExceptionFilter`.
 *
 * Eski `/carrier/*` endpointlari o'zgarmagan (faqat Bearer tokenni ham qabul
 * qiladi). Kontrakt: docs/public/CARRIER_API.md §10.
 */

/** `POST /carrier/qrorder/find` → `data` (Olcha `QrOrderResponse.data`). */
export type CarrierQrOrderData = {
  id: number;
  full_name: string;
  /** Faqat raqamlar, 998 bilan: `998901234567` (Olcha namunasi kabi). */
  phone: string;
  additional_phone: string;
  /** Viloyat SOATO kodi (4 xona) — Olcha `GET /regions` dagi `code` kabi. */
  region: number | null;
  /** Tuman SOATO kodi (7 xona). */
  district: number | null;
  address: string;
  comment: string;
  /**
   * Elchi'da mijozdan alohida yetkazish haqi olinmaydi — u `total_price`
   * ichida. Olcha mijozi naqdni `total_price + delivery_price` deb hisoblaydi,
   * shuning uchun doim 0.
   */
  delivery_price: number;
  /** Mijozdan olinadigan naqd (onlayn to'langan qism ayirilgan). */
  total_price: number;
  total_count: number;
  /** `YYYY-MM-DD HH:mm:ss`, Toshkent vaqti (Olcha namunasi kabi). */
  created_at: string;
  /** `Nomi x 2 = 250 000 so'm` (bitta mahsulot) yoki `A x 1, B x 2`. */
  items: string;
  /** Elchi qo'shimchasi (Olcha'da yo'q): `waiting` va h.k. — §6. */
  status: string;
  /** Elchi qo'shimchasi: oldindan onlayn to'langan qism (so'm). */
  paid_online_amount: number;
};

/** `POST qrorder/find` muvaffaqiyatli javobi (Olcha `QrOrderResponse`). */
export type CarrierQrOrderResult = {
  success: true;
  msg: string;
  data: CarrierQrOrderData;
};

/** Olcha `qrorder/find` muvaffaqiyat matni. */
export const QR_ORDER_FOUND_MSG = 'Buyurtma topildi';
/** Elchi: shu so'rovda posilka sizga qabul qilindi (`waiting`). */
export const QR_ORDER_RECEIVED_MSG = 'Buyurtma topildi va sizga qabul qilindi';

type Row = Record<string, unknown>;

const TASHKENT_OFFSET_MS = 5 * 60 * 60 * 1000;

/** `2026-11-09T10:00:00Z` → `2026-11-09 15:00:00` (Toshkent). */
export function tashkentDateTime(value: unknown): string {
  const date =
    value instanceof Date
      ? value
      : typeof value === 'string' || typeof value === 'number'
        ? new Date(value)
        : null;
  if (!date || Number.isNaN(date.getTime())) return '';
  return new Date(date.getTime() + TASHKENT_OFFSET_MS)
    .toISOString()
    .slice(0, 19)
    .replace('T', ' ');
}

/** Olcha telefon shakli: faqat raqam, `998` bilan (9 xonali milliy — 998 qo'shiladi). */
export function olchaPhone(value: string | null | undefined): string {
  const digits = String(value ?? '').replace(/\D/g, '');
  return digits.length === 9 ? `998${digits}` : digits;
}

/** `250000` → `250 000` (butun so'm, minglik bo'shliq bilan). */
export function formatSom(amount: number): string {
  return String(Math.round(amount)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
}

const soato = (code: string | null | undefined): number | null =>
  code && /^\d+$/.test(code) ? Number(code) : null;

/**
 * Elchi buyurtmasi → Olcha `qrorder/find` `data`. Manba — `toCarrierOrderView`
 * (allowlist): ichki maydonlar bu yerga ham sizmaydi.
 *
 * `items` matni Elchi'ning o'z import qoidasi (`external-items-text.ts`) bilan
 * o'qiladigan shaklda. Elchi'da har qatorning narxi saqlanmaydi, shuning uchun
 * `= summa` faqat bitta mahsulotli buyurtmada (buyurtma summasi); bir nechta
 * mahsulotda narx O'YLAB TOPILMAYDI — `A x 1, B x 2`.
 */
export function toCarrierQrOrderData(row: Row): CarrierQrOrderData {
  const view = toCarrierOrderView(row);
  const idNum = Number(view.id);
  const lines = view.items.map((item) => ({
    name: item.name ?? 'Mahsulot',
    quantity: item.quantity,
  }));
  const items =
    lines.length === 1
      ? `${lines[0].name} x ${lines[0].quantity} = ${formatSom(view.total_price)} so'm`
      : lines.map((line) => `${line.name} x ${line.quantity}`).join(', ');
  const totalCount = lines.reduce(
    (sum, line) =>
      sum + (Number.isFinite(line.quantity) ? Math.max(line.quantity, 0) : 0),
    0,
  );

  return {
    id: Number.isSafeInteger(idNum) ? idNum : 0,
    full_name: view.customer?.name ?? '',
    phone: olchaPhone(view.customer?.phone_number),
    additional_phone: olchaPhone(view.customer?.extra_number),
    region: soato(view.region?.soato_code),
    district: soato(view.district?.soato_code),
    address: view.address ?? '',
    comment: view.comment ?? '',
    delivery_price: 0,
    total_price: view.cod_amount,
    total_count: totalCount,
    created_at: tashkentDateTime(row.createdAt ?? row.created_at),
    items,
    status: view.status,
    paid_online_amount: view.paid_online_amount,
  };
}

/**
 * Olcha (Yii2) auth qatlami xatolari shu shaklda — HTTP holati bilan bir xil:
 * `{"name":"Unauthorized","message":"…","code":0,"status":401}`.
 */
const TRANSPORT_STATUSES: ReadonlySet<number> = new Set([
  HttpStatus.UNAUTHORIZED,
  HttpStatus.FORBIDDEN,
  HttpStatus.METHOD_NOT_ALLOWED,
  HttpStatus.PAYLOAD_TOO_LARGE,
  HttpStatus.TOO_MANY_REQUESTS,
]);

/**
 * Olcha `qrorder/find`: «aks holda `{success: false, msg, status: 400|404}`»
 * — Swagger'da 400/404 HTTP javobi sifatida YO'Q (faqat 200/401/403), ya'ni
 * HTTP 200 tanasida keladi. Elchi ham shunday: 400/404 → HTTP 200.
 */
const IN_BODY_STATUSES: ReadonlySet<number> = new Set([
  HttpStatus.BAD_REQUEST,
  HttpStatus.NOT_FOUND,
]);

type CapturedError = { status: number; body: Record<string, unknown> };

/**
 * OLCHA SHAKLIDAGI XATO. Holat va matn global `AllExceptionsFilter` dan
 * olinadi (RPC xatosi, timeout → 504, Sentry, 5xx log, `Retry-After`,
 * `trace_id` — hammasi AYNAN eski yo'ldagidek), faqat tana qayta shakllanadi:
 *
 *  - `auth` (`/carrier/auth/token`) va har qanday 401/403/413/429 —
 *    `{name, message, code: 0, status}` (Yii2), HTTP = `status`;
 *  - `result` (`/carrier/qrorder/find`) — `{success: false, msg, status}`;
 *    400/404 HTTP 200 bilan (Olcha kabi), qolgani (5xx) o'z HTTP holati bilan.
 *
 * Elchi qo'shimchasi: mashina kodi `error_code` (Olcha `code` doim 0 — u
 * band) va `trace_id` (murojaat uchun).
 */
@Catch()
export class CarrierOlchaExceptionFilter implements ExceptionFilter {
  private readonly base = new AllExceptionsFilter();

  constructor(private readonly mode: 'auth' | 'result') {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const response = http.getResponse<Response>();
    const { status, body } = this.capture(exception, host, response);

    const message =
      typeof body.message === 'string' && body.message
        ? body.message
        : (STATUS_CODES[status] ?? 'Xatolik');
    const extras = {
      ...(typeof body.code === 'string' ? { error_code: body.code } : {}),
      ...(typeof body.trace_id === 'string' ? { trace_id: body.trace_id } : {}),
    };

    if (this.mode === 'auth' || TRANSPORT_STATUSES.has(status)) {
      response.status(status).json({
        name: STATUS_CODES[status] ?? 'Error',
        message,
        code: 0,
        status,
        ...extras,
      });
      return;
    }
    response
      .status(IN_BODY_STATUSES.has(status) ? HttpStatus.OK : status)
      .json({ success: false, msg: message, status, ...extras });
  }

  /** `AllExceptionsFilter` javobini tutib oladi (sarlavhalar haqiqiy javobga). */
  private capture(
    exception: unknown,
    host: ArgumentsHost,
    response: Response,
  ): CapturedError {
    const captured: CapturedError = {
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      body: {},
    };
    const sink = {
      status(code: number) {
        captured.status = code;
        return sink;
      },
      json(payload: unknown) {
        captured.body =
          payload && typeof payload === 'object'
            ? (payload as Record<string, unknown>)
            : {};
        return sink;
      },
      setHeader: (name: string, value: string): void => {
        response.setHeader(name, value);
      },
      getHeader: (name: string): unknown => response.getHeader(name),
    };
    const http = host.switchToHttp();
    this.base.catch(exception, {
      getType: () => 'http',
      switchToHttp: () => ({
        getRequest: (): unknown => http.getRequest<unknown>(),
        getResponse: () => sink,
        getNext: (): unknown => http.getNext<unknown>(),
      }),
    } as unknown as ArgumentsHost);
    return captured;
  }
}
